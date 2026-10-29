"""Generate a video for a conversation plugin and persist it as an artifact.

The service intentionally reuses the model catalog and transport used by the
public media proxy.  Plugins therefore select a user's configured video model
without receiving a provider key, while the result is stored in the regular
attachment object store and can be consumed by the desktop output index.
"""
from __future__ import annotations

import asyncio
import base64
import binascii
import math
import ipaddress
import json
import os
import re
import socket
import time
from urllib.parse import quote, urlparse

import httpx
from httpcore._backends.auto import AutoBackend
from sqlalchemy.ext.asyncio import AsyncSession

from .. import models
from ..config import get_settings
from . import model_catalog, model_transport, storage, video_files, video_jobs
from .model_errors import UpstreamError

MAX_PROMPT_CHARS = 12_000
MAX_ARGUMENT_CHARS = 200_000
# ``video_max_mb`` is the source of truth for both provider response reads and
# the final attachment.  Keep this constant only as a defensive upper bound in
# case an old settings object is injected by a test or a partially upgraded
# process.
MAX_PROVIDER_RESPONSE_BYTES = 2 * 1024 * 1024 * 1024
MIN_TIMEOUT_SECONDS = 30
MAX_TIMEOUT_SECONDS = 300
POLL_INTERVAL_SECONDS = 2
VIDEO_EXTENSIONS = {
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/quicktime": ".mov",
    "video/ogg": ".ogv",
}
VIDEO_EXTENSION_SET = frozenset(VIDEO_EXTENSIONS.values())
VIDEO_STATUSES = {
    "queued", "pending", "created", "running", "processing", "in_progress",
    "submitted", "starting", "started", "waiting",
}


class VideoJobFailed(ValueError):
    """The provider reports a terminal job failure."""


SUCCESS_STATUSES = {
    "succeeded", "success", "completed", "complete", "done", "finished", "ready",
}
FAILURE_STATUSES = {
    "failed", "failure", "error", "cancelled", "canceled", "rejected", "expired",
}


def _video_max_bytes() -> int:
    """Return the one byte cap used for every video network/storage boundary."""
    try:
        configured = int(getattr(get_settings(), "video_max_mb", 256) or 256)
    except (TypeError, ValueError):
        configured = 256
    # Settings validates this range, but keep a safe floor/ceiling for callers
    # that provide a lightweight settings object in tests or during migration.
    configured = max(20, min(configured, 2048))
    # Attachment.size is a PostgreSQL signed INTEGER. Keep even a 2048 MB
    # deployment configuration representable without a schema change.
    return min(configured * 1024 * 1024, (1 << 31) - 1)


def _unsafe_address(value: str) -> bool:
    try:
        address = ipaddress.ip_address(str(value).split("%", 1)[0])
    except ValueError:
        return True
    # ``is_private`` covers RFC1918 and the current Python definitions for
    # unique-local IPv6.  ``not is_global`` additionally rejects shared,
    # documentation and other non-routable ranges which are equally unsafe for
    # a provider result fetch.
    return bool(
        address.is_private
        or address.is_loopback
        or address.is_link_local
        or address.is_reserved
        or address.is_unspecified
        or address.is_multicast
        or not address.is_global
    )


async def _resolve_public_addresses(url: str) -> tuple[str, ...]:
    """Resolve and pin every A/AAAA answer before opening a result connection.

    The returned addresses are passed to ``_PinnedNetworkBackend`` so the
    connection cannot perform a second DNS lookup after validation.  If any
    answer is unsafe we reject the host rather than choosing a seemingly safe
    sibling record; this closes the common DNS-rebinding/dual-stack bypass.
    """
    parsed = urlparse(url)
    host = (parsed.hostname or "").strip().lower().rstrip(".")
    if not host:
        raise ValueError("视频服务返回了无效的下载地址")
    if host in {
        "localhost", "metadata.google.internal", "metadata", "host.docker.internal",
        "100.100.100.200",
    } or host.endswith(".localhost"):
        raise ValueError("视频服务返回了不可访问的内部地址")
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        literal = None
    if literal is not None:
        if _unsafe_address(host):
            raise ValueError("视频服务返回了不可访问的内部地址")
        return (host,)

    try:
        records = await asyncio.to_thread(
            socket.getaddrinfo,
            host,
            parsed.port or (443 if parsed.scheme == "https" else 80),
            socket.AF_UNSPEC,
            socket.SOCK_STREAM,
        )
    except OSError as exc:
        raise ValueError("视频服务返回的下载域名无法解析") from exc
    addresses: list[str] = []
    unsafe = False
    for record in records or ():
        try:
            candidate = str(record[4][0]).split("%", 1)[0]
            ipaddress.ip_address(candidate)
        except (IndexError, KeyError, TypeError, ValueError):
            continue
        if _unsafe_address(candidate):
            unsafe = True
        elif candidate not in addresses:
            addresses.append(candidate)
    if unsafe or not addresses:
        raise ValueError("视频服务返回了不可访问的内部地址")
    return tuple(addresses)


class _PinnedNetworkBackend:
    """httpcore backend that connects only to the already validated IPs."""

    def __init__(self, addresses: tuple[str, ...]):
        self._addresses = addresses
        self._backend = AutoBackend()

    async def connect_tcp(self, host, port, timeout=None, local_address=None,
                          socket_options=None):
        last_error = None
        for address in self._addresses:
            try:
                return await self._backend.connect_tcp(
                    address, port, timeout=timeout, local_address=local_address,
                    socket_options=socket_options)
            except Exception as exc:  # pragma: no cover - backend-specific errors
                last_error = exc
        if last_error is not None:
            raise last_error
        raise OSError("no validated network address")

    async def connect_unix_socket(self, path, timeout=None, socket_options=None):
        return await self._backend.connect_unix_socket(
            path, timeout=timeout, socket_options=socket_options)

    async def sleep(self, seconds):
        return await self._backend.sleep(seconds)


class _PinnedHTTPTransport(httpx.AsyncHTTPTransport):
    """HTTPX transport retaining the hostname for TLS while pinning TCP IPs."""

    def __init__(self, addresses: tuple[str, ...]):
        super().__init__(
            trust_env=False,
            retries=0,
            limits=httpx.Limits(max_connections=1, max_keepalive_connections=0),
        )
        # AsyncHTTPTransport intentionally keeps this as a private httpcore
        # pool.  Replacing only the network backend preserves the original URL
        # (and therefore Host/SNI/certificate validation) while preventing a
        # second resolver call that could be rebound to an internal address.
        self._pool._network_backend = _PinnedNetworkBackend(addresses)


def _clean(value, limit: int) -> str:
    return str(value or "").replace("\x00", "").strip()[:limit]


def _safe_filename(value: str, extension: str = ".mp4") -> str:
    extension = str(extension or ".mp4").lower()
    if extension not in VIDEO_EXTENSION_SET:
        extension = ".mp4"
    name = os.path.basename(_clean(value, 180))
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip(" .")
    if not name:
        name = "soduwork-video-" + time.strftime("%Y%m%d-%H%M%S")
    current_extension = os.path.splitext(name)[1].lower()
    if current_extension != extension:
        if current_extension:
            name = name[:-len(current_extension)]
        name = name.rstrip(" .") + extension
    # Keep the media suffix after truncating an overlong user supplied name.
    stem = name[:-len(extension)] if name.lower().endswith(extension) else name
    return (stem[:max(1, 200 - len(extension))] + extension).strip(" .")


def _normalized_key(value) -> str:
    return re.sub(r"[^a-z0-9]", "", str(value or "").lower())


def _find(value, keys: set[str]):
    wanted = {_normalized_key(key) for key in keys}
    if isinstance(value, dict):
        for key, item in value.items():
            if _normalized_key(key) in wanted and item not in (None, "", []):
                return item
        for item in value.values():
            found = _find(item, keys)
            if found not in (None, "", []):
                return found
    elif isinstance(value, list):
        for item in value:
            found = _find(item, keys)
            if found not in (None, "", []):
                return found
    return None


def _as_json(raw: bytes):
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None


def _status(value) -> str:
    raw = _find(value, {"status", "state", "phase"})
    return _normalized_key(raw)


def _job_id(value) -> str:
    raw = _find(value, {"id", "task_id", "taskId", "job_id", "jobId", "generation_id", "generationId"})
    if isinstance(raw, (str, int)):
        return _clean(raw, 240)
    return ""


def _url(value) -> str:
    raw = _find(value, {
        "video_url", "videoUrl", "download_url", "downloadUrl", "file_url", "fileUrl",
        "result_url", "resultUrl", "uri", "url",
    })
    return _clean(raw, 4000) if isinstance(raw, str) else ""


def _inline_video(value) -> bytes | None:
    if not isinstance(value, dict):
        return None
    for key, raw in value.items():
        normalized = _normalized_key(key)
        if normalized not in {"data", "base64", "videobase64", "videodata", "contentbase64"}:
            continue
        if not isinstance(raw, str):
            continue
        encoded = raw.split(",", 1)[1] if raw.startswith("data:") and "," in raw else raw
        if len(encoded) > video_files.JSON_MAX_BYTES:
            continue
        try:
            data = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error):
            continue
        if data and len(data) <= _video_max_bytes():
            return data
    for child in value.values():
        found = _inline_video(child)
        if found:
            return found
    return None


def _is_binary_video(raw, content_type: str = "") -> bool:
    return bool(video_files.media_type(raw))


def _assert_video_bytes(raw: bytes, content_type: str = "") -> None:
    """Reject a successful response that is actually HTML or JSON."""
    if not raw or not _is_binary_video(raw, content_type):
        raise ValueError("视频服务返回的内容不是可识别的视频文件")


def _platform_defaults(platform: str) -> dict:
    raw = str(platform or "").strip().lower()
    aliases = {
        "抖音": "douyin", "快手": "douyin", "小红书": "xiaohongshu",
        "视频号": "weixin", "微信视频号": "weixin", "哔哩哔哩": "bilibili",
        "b站": "bilibili", "油管": "youtube",
    }
    key = _normalized_key(aliases.get(raw, raw))
    if key in {"douyin", "tiktok", "xiaohongshu", "weixin"}:
        return {"aspect_ratio": "9:16", "resolution": "1080p"}
    if key in {"bilibili", "youtube"}:
        return {"aspect_ratio": "16:9", "resolution": "1080p"}
    return {}


def _payload(arguments: dict, conf: dict) -> tuple[dict, str, str]:
    prompt = _clean(
        arguments.get("prompt") or arguments.get("script") or arguments.get("description"),
        MAX_PROMPT_CHARS,
    )
    if not prompt:
        raise ValueError("视频生成需要 prompt；请描述主题、画面、动作和风格")
    config = model_catalog.model_config(conf.get("config"), "video")
    payload = dict(config.get("defaults") or {})
    payload.update(_platform_defaults(arguments.get("platform")))
    allowed = {
        "duration", "aspect_ratio", "aspectRatio", "resolution", "fps", "seed",
        "watermark", "generate_audio", "generateAudio", "camera_fixed", "cameraFixed",
        "size", "quality", "style", "voice", "negative_prompt", "negativePrompt",
    }
    for key in allowed:
        if key in arguments and arguments[key] not in (None, ""):
            payload[key] = arguments[key]
    extra = arguments.get("extra")
    if extra is not None:
        if not isinstance(extra, dict):
            raise ValueError("extra 必须是 JSON 对象")
        reserved = {"model", "prompt", "content", "stream"}
        blocked = [str(key)[:80] for key in extra if str(key).strip() in reserved]
        if blocked:
            raise ValueError("extra 不能覆盖模型、提示词、content 或 stream 参数")
        payload.update({str(key)[:80]: value for key, value in extra.items()})
    for key, low, high in (("duration", 1, 180), ("fps", 12, 60)):
        if key not in payload or payload[key] in (None, ""):
            continue
        try:
            numeric = float(payload[key])
        except (TypeError, ValueError) as exc:
            raise ValueError(f"{key} 必须是 {low} 到 {high} 之间的数字") from exc
        if not math.isfinite(numeric) or numeric < low or numeric > high:
            raise ValueError(f"{key} 必须是 {low} 到 {high} 之间的数字")
    # The bundled Seedance 2.0 route currently produces one 4-15 second clip
    # per task.  Reject an impossible duration locally so the user gets a
    # useful answer instead of spending a provider request on an HTTP 400.
    if str(conf.get("provider") or "").strip() == "volcengine" and \
            str(conf.get("model") or "").strip() == "doubao-seedance-2-0":
        duration = payload.get("duration")
        if duration in (None, ""):
            payload["duration"] = 10
        elif float(duration) < 4 or float(duration) > 15:
            raise ValueError(
                "内置 Seedance 2.0 单次支持 4 到 15 秒；请缩短时长，"
                "或改用支持更长视频的模型")
    payload["model"] = conf["model"]
    endpoint = str(config.get("endpointPath") or "/videos/generations")
    # Ark/Seedance uses a content array instead of the OpenAI-style prompt.
    # Use the endpoint as the discriminator: a custom Volcengine model can
    # still be exposed through a normal OpenAI-compatible /videos endpoint.
    is_ark = "/contents/" in endpoint.lower()
    if is_ark:
        content = arguments.get("content")
        if content is None:
            content = [{"type": "text", "text": prompt}]
        if not isinstance(content, list) or not content:
            raise ValueError("视频 content 必须是非空数组")
        payload["content"] = content[:20]
        payload.pop("prompt", None)
        # Ark's video API calls the aspect-ratio field `ratio`; forwarding the
        # generic `aspect_ratio` spelling makes otherwise valid requests fail
        # with HTTP 400.  Preserve an explicit provider default/extra `ratio`.
        if "ratio" not in payload:
            ratio = payload.pop("aspect_ratio", None)
            if ratio in (None, ""):
                ratio = payload.pop("aspectRatio", None)
            if ratio not in (None, ""):
                payload["ratio"] = ratio
        else:
            payload.pop("aspect_ratio", None)
            payload.pop("aspectRatio", None)
    else:
        payload["prompt"] = prompt
    payload.pop("stream", None)
    try:
        encoded = json.dumps(payload, ensure_ascii=False, allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise ValueError("视频生成参数不是有效 JSON") from exc
    if len(encoded.encode("utf-8")) > MAX_ARGUMENT_CHARS:
        raise ValueError("视频生成参数过大，请缩短脚本或分段生成")
    return payload, prompt, endpoint


async def _provider_request(conf: dict, path: str, body: bytes | None, timeout: float):
    response = None
    try:
        async with asyncio.timeout(max(0.1, float(timeout or 0))):
            response = await model_transport.open_response(conf, path, body, timeout=timeout)
            data = await video_files.collect(response.chunks(), _video_max_bytes())
            return data, str(response.headers.get("content-type") or "")
    finally:
        if response is not None:
            await response.aclose()


def _safe_remote_url(raw: str, base: str) -> str:
    parsed = urlparse(raw)
    if not parsed.scheme:
        # A provider-relative result path must go back through model_transport
        # so the configured provider credential and concurrency policy remain
        # in force.  Returning an absolute URL here would make _download_url
        # perform an unauthenticated direct GET instead.
        if parsed.netloc or str(raw).startswith("//"):
            raise ValueError("视频服务返回了不安全的下载地址")
        path = "/" + str(raw or "").lstrip("/")
        if path == "/":
            raise ValueError("视频服务没有返回有效的下载地址")
        return path
    if parsed.scheme not in {"http", "https"} or parsed.username or parsed.password:
        raise ValueError("视频服务返回了不安全的下载地址")
    host = (parsed.hostname or "").lower().strip("[]")
    if not host:
        raise ValueError("视频服务返回了无效的下载地址")
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        address = None
    if (host in {"localhost", "localhost.", "metadata", "metadata.google.internal",
                 "100.100.100.200"} or host.endswith(".localhost")
            or (address is not None and _unsafe_address(host))):
        raise ValueError("视频服务返回了不可访问的内部地址")
    return raw


async def _download_url(raw_url: str, conf: dict, timeout: float):
    url = _safe_remote_url(raw_url, conf.get("base") or "")
    if not urlparse(url).scheme:
        return await _provider_request(conf, url, None, timeout)
    async with asyncio.timeout(max(0.1, float(timeout or 0))):
        addresses = await _resolve_public_addresses(url)
        async with httpx.AsyncClient(
                transport=_PinnedHTTPTransport(addresses), trust_env=False,
                follow_redirects=False, timeout=httpx.Timeout(max(0.1, timeout))) as http:
            async with http.stream("GET", url) as response:
                if response.status_code >= 300:
                    raise ValueError(f"视频文件下载失败（HTTP {response.status_code}）")
                try:
                    advertised = int(response.headers.get("content-length", "0"))
                except ValueError:
                    advertised = 0
                if advertised > _video_max_bytes():
                    raise ValueError("视频文件超过平台允许的大小")
                data = await video_files.collect(response.aiter_bytes(chunk_size=1024 * 1024),
                                                  _video_max_bytes(), json_allowed=False)
                return data, str(response.headers.get("content-type") or "")


async def _resolve_bytes(conf: dict, config: dict, raw: bytes, content_type: str,
                         deadline: float, *, job_id_override: str = "") -> tuple[bytes, str]:
    # Resolve an inline, URL, or asynchronous provider result. resultPath may
    # be the only polling route; query it until the shared deadline.
    if _is_binary_video(raw, content_type):
        return raw, content_type
    value = _as_json(raw) if raw else None
    if value is not None:
        inline = _inline_video(value)
        if inline:
            return inline, content_type
        url = _url(value)
        if url:
            return await _download_url(url, conf, max(0.1, deadline - time.monotonic()))
    job_id = _clean(job_id_override, 240) or _job_id(value)
    status_path = str(config.get("statusPath") or "")
    result_path = str(config.get("resultPath") or "")
    if not job_id:
        raise ValueError("视频服务没有返回任务 ID 或视频文件")
    if not status_path and not result_path:
        raise ValueError("请在模型配置中填写任务查询或结果下载路径")
    latest = value if isinstance(value, dict) else {"id": job_id, "status": "pending"}
    encoded_id = quote(job_id, safe="")
    while time.monotonic() < deadline:
        state = _status(latest)
        if state in FAILURE_STATUSES:
            raise VideoJobFailed("视频服务返回任务失败，请核对模型配置或调整内容后重新生成")
        inline = _inline_video(latest)
        if inline:
            return inline, content_type
        url = _url(latest)
        if url:
            return await _download_url(url, conf, max(0.1, deadline - time.monotonic()))

        if result_path and (not status_path or state in SUCCESS_STATUSES):
            try:
                result_raw, result_type = await _provider_request(
                    conf, result_path.replace("{id}", encoded_id), None,
                    max(0.1, deadline - time.monotonic()))
            except UpstreamError as exc:
                if not status_path and getattr(exc, "status", 0) in {404, 409, 425}:
                    result_raw, result_type = b"", ""
                else:
                    raise
            if result_raw:
                if _is_binary_video(result_raw, result_type):
                    return result_raw, result_type
                result_value = _as_json(result_raw)
                if result_value is None:
                    raise ValueError("视频服务的结果响应格式无法识别")
                inline = _inline_video(result_value)
                if inline:
                    return inline, result_type
                result_url = _url(result_value)
                if result_url:
                    return await _download_url(
                        result_url, conf, max(0.1, deadline - time.monotonic()))
                latest = result_value if isinstance(result_value, dict) else latest
                state = _status(latest)
                if state in FAILURE_STATUSES:
                    raise VideoJobFailed("视频服务返回任务失败，请核对模型配置或调整内容后重新生成")

        if status_path:
            status_raw, status_type = await _provider_request(
                conf, status_path.replace("{id}", encoded_id), None,
                max(0.1, deadline - time.monotonic()))
            if _is_binary_video(status_raw, status_type):
                return status_raw, status_type
            latest = _as_json(status_raw)
            if latest is None:
                raise ValueError("视频服务的任务状态不是有效 JSON")
        if time.monotonic() >= deadline:
            break
        await asyncio.sleep(min(POLL_INTERVAL_SECONDS,
                                max(0.1, deadline - time.monotonic())))
    raise TimeoutError("视频仍在生成；使用相同参数继续可取回本次结果")


async def generate_video(session: AsyncSession, client: models.Client, arguments: dict,
                         *, conversation_id: str = "", timeout_seconds: int = 240) -> dict:
    if not isinstance(arguments, dict):
        raise ValueError("视频生成参数必须是 JSON 对象")
    client_id = str(client.id)
    user_id = str(getattr(client, "user_ref", None) or "")
    if not user_id:
        raise ValueError("请先登录账号后生成视频")
    conf = await model_catalog.resolve(session, client, _clean(arguments.get("model"), 200), "video")
    if not conf:
        raise ValueError("当前用户尚未配置可用的视频模型或 API Key")
    if conf.get("kind") != "openai-compat":
        raise ValueError("当前视频模型暂不支持 SoduWork 媒体生成通道")
    payload, prompt, endpoint = _payload(arguments, conf)
    config = model_catalog.model_config(conf.get("config"), "video")
    generation_id = arguments.get("generationId", "")
    if not isinstance(generation_id, str) or len(generation_id) > 120:
        raise ValueError("generationId 必须是 120 个字符以内的字符串")
    digest = video_jobs.fingerprint(conf, payload, generation_id)
    ref = video_jobs.conversation_ref(conversation_id)
    timeout = max(MIN_TIMEOUT_SECONDS, min(MAX_TIMEOUT_SECONDS, int(timeout_seconds or 240)))
    metadata = {
        "kind": "conversation_video", "conversationId": ref,
        "model": str(conf.get("model") or "")[:200],
        "provider": str(conf.get("provider") or "")[:80],
        "platform": _clean(arguments.get("platform"), 32), "prompt": prompt[:1000],
        "duration": payload.get("duration"),
        "aspectRatio": payload.get("aspect_ratio") or payload.get("aspectRatio") or payload.get("ratio"),
        "resolution": payload.get("resolution") or payload.get("size"), "fps": payload.get("fps"),
    }
    # Authentication and model resolution used this session only for reads.
    # Snapshot all needed values before rollback expires ORM client attributes.
    await session.rollback()
    job, is_new = await video_jobs.claim(
        session, client_id, ref, digest, _safe_filename(arguments.get("filename")),
        metadata, timeout, user_id=user_id)
    if job["storage_key"] and int(job["size"] or 0) > 0:
        return _result(job, arguments, prompt, conf)
    data = None
    key = ""
    backend = ""
    stored = False
    try:
        deadline = time.monotonic() + timeout
        job_id = str(job["evidence_meta"].get("jobId") or "")
        if is_new:
            raw, content_type = await _provider_request(
                conf, endpoint, json.dumps(payload, ensure_ascii=False, allow_nan=False).encode(), timeout)
            data = raw if isinstance(raw, video_files.VideoBody) else None
            initial = None if _is_binary_video(raw) else _as_json(raw)
            job_id = _job_id(initial)
            if job_id:
                await video_jobs.save_job_id(session, job, job_id)
        else:
            raw, content_type = json.dumps({"id": job_id, "status": "pending"}).encode(), "application/json"
        data, result_type = await _resolve_bytes(
            conf, config, raw, content_type, deadline, job_id_override=job_id)
        _assert_video_bytes(data, result_type)
        if len(data) > _video_max_bytes():
            raise ValueError("视频文件超过平台允许的大小")
        normalized_type = video_files.media_type(data)
        filename = _safe_filename(arguments.get("filename") or job["filename"],
                                  VIDEO_EXTENSIONS[normalized_type])
        client_ref = video_jobs.conversation_ref(client_id)
        owner = job["evidence_meta"]["leaseOwner"]
        key = f"conversation-media/{client_ref[:40]}/{ref[:40]}/{job['id']}/{owner}/{filename}"
        async def deliver():
            nonlocal backend, stored
            backend = await video_files.store_body(storage, key, data, normalized_type)
            await video_jobs.change(
                session, job, filename=filename, content_type=normalized_type, size=len(data),
                storage_key=key, backend=backend, meta={"status": "completed", "leaseUntil": 0})
            stored = True
        delivery = asyncio.create_task(deliver())
        try:
            await asyncio.shield(delivery)
        except asyncio.CancelledError:
            await delivery
            raise
        return _result(job, arguments, prompt, conf)
    except BaseException as exc:
        if stored:
            raise
        # Save only an error category; never persist provider bodies or secrets.
        async def release():
            await session.rollback()
            await video_jobs.change(session, job, meta={
                "status": "failed" if isinstance(exc, VideoJobFailed) else "interrupted",
                "leaseUntil": 0, "lastError": type(exc).__name__,
            })
        finishing = asyncio.create_task(release())
        try:
            await asyncio.shield(finishing)
        except asyncio.CancelledError:
            await finishing
        except Exception:
            await session.rollback()
        raise
    finally:
        if isinstance(data, video_files.VideoBody):
            data.close()
        if key and not stored:
            await video_files.disk_call(storage.delete, key, backend or storage.backend_name())


def _result(job: dict, arguments: dict, prompt: str, conf: dict) -> dict:
    hashtags = arguments.get("hashtags") or []
    if not isinstance(hashtags, list):
        hashtags = []
    return {
        "ok": True, "artifact": video_jobs.artifact(job), "model": str(conf.get("model") or ""),
        "platform": _clean(arguments.get("platform"), 32), "prompt": prompt,
        "caption": _clean(arguments.get("caption"), 2000),
        "hashtags": [str(item)[:80] for item in hashtags if str(item).strip()][:30],
        "publishReady": True,
        "message": "视频已生成并保存为会话成果，可预览、下载后发布到外部平台。",
    }
