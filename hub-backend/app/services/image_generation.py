"""One image generation path for conversations and signed plugin tool calls.

Uses the user's effective model catalog, governed transport and attachment
ledger. A repeated generationId never blindly resubmits a billable request.
"""
from __future__ import annotations

import asyncio
import base64
import binascii
import json
import re
import time
from io import BytesIO
from urllib.parse import urlparse

import httpx
from PIL import Image, UnidentifiedImageError

from . import model_catalog, model_transport, storage, video_files, video_jobs
from . import video_generation as media_network
from .model_errors import UpstreamError

MAX_BYTES = 32 * 1024 * 1024
MAX_RESPONSE_BYTES = MAX_BYTES * 4 // 3 + 65536
EXTENSIONS = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}


def validate_image(raw):
    if not raw or len(raw) > MAX_BYTES:
        raise ValueError("图片文件无效或超过 32MB")
    try:
        with Image.open(BytesIO(raw), formats=["PNG", "JPEG", "WEBP"]) as picture:
            if picture.width * picture.height > 32_000_000 or getattr(picture, "n_frames", 1) != 1:
                raise ValueError("图片分辨率超过 3200 万像素或包含多帧，请调整图片模型输出参数")
            mime = Image.MIME[picture.format]
            picture.verify()
        # verify checks the container; load also detects incomplete pixel data.
        with Image.open(BytesIO(raw), formats=["PNG", "JPEG", "WEBP"]) as picture:
            picture.load()
        return mime
    except (UnidentifiedImageError, OSError, SyntaxError, Image.DecompressionBombError) as exc:
        raise ValueError("图片文件无效或不完整，仅支持 PNG、JPEG、WebP") from exc


def media_type(raw: bytes) -> str:
    if raw.startswith(b"\x89PNG\r\n\x1a\n") and raw.endswith(b"\x00\x00\x00\x00IEND\xaeB`\x82"):
        return "image/png"
    if raw.startswith(b"\xff\xd8\xff") and raw.endswith(b"\xff\xd9"):
        return "image/jpeg"
    if len(raw) >= 20 and raw[:4] == b"RIFF" and raw[8:12] == b"WEBP" and \
            int.from_bytes(raw[4:8], "little") + 8 == len(raw):
        return "image/webp"
    return ""


def _payload(arguments, conf):
    prompt = arguments.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 12000:
        raise ValueError("请填写 1 到 12000 字的图片描述")
    config = model_catalog.model_config(conf.get("config"), "image")
    payload = dict(config.get("defaults") or {})
    for key in ("size", "quality", "style", "background", "output_format", "seed",
                "watermark", "response_format", "negative_prompt"):
        if arguments.get(key) not in (None, ""):
            payload[key] = arguments[key]
    extra = arguments.get("extra", {})
    if not isinstance(extra, dict) or set(extra) & {"model", "prompt", "stream", "n"}:
        raise ValueError("extra 必须是对象，且不能覆盖模型、描述、stream 或 n")
    payload.update(extra)
    # Deliver every paid result. This tool deliberately requests a single image;
    # a plugin can invoke it with distinct generationIds for additional variants.
    if arguments.get("n", 1) != 1 or payload.get("n", 1) != 1:
        raise ValueError("每次生成一张图片；多张图片请分次生成")
    payload.update(model=conf["model"], prompt=prompt.strip(), n=1)
    payload.pop("stream", None)
    encoded = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode()
    if len(encoded) > 200000:
        raise ValueError("图片生成参数过大")
    return payload, encoded, config.get("endpointPath") or "/images/generations"


async def _collect(chunks, limit):
    parts, size = [], 0
    async for chunk in chunks:
        size += len(chunk)
        if size > limit:
            raise ValueError("图片服务返回的文件超过大小限制")
        parts.append(chunk)
    return b"".join(parts)


async def _provider_request(conf, path, body, timeout):
    response = None
    try:
        response = await model_transport.open_response(conf, path, body, timeout=timeout)
        return await _collect(response.chunks(), MAX_RESPONSE_BYTES)
    finally:
        if response is not None:
            await response.aclose()


async def _download(url, conf, timeout):
    # Reuse the video boundary's validated/pinned DNS connection. No provider
    # credentials go to a result CDN; relative paths use governed transport.
    try:
        url = media_network._safe_remote_url(url, conf.get("base") or "")
        if not urlparse(url).scheme:
            return await _provider_request(conf, url, None, timeout)
        addresses = await media_network._resolve_public_addresses(url)
        async with httpx.AsyncClient(
            transport=media_network._PinnedHTTPTransport(addresses), trust_env=False,
            follow_redirects=False, timeout=httpx.Timeout(timeout),
        ) as http:
            async with http.stream("GET", url) as response:
                if response.status_code >= 300:
                    raise ValueError(f"图片下载失败（HTTP {response.status_code}）")
                return await _collect(response.aiter_bytes(1024 * 1024), MAX_BYTES)
    except ValueError as exc:
        raise ValueError(str(exc).replace("视频", "图片")) from exc


async def _image_bytes(raw, conf, timeout):
    if media_type(raw):
        return raw
    try:
        value = json.loads(raw)
    except (ValueError, UnicodeDecodeError) as exc:
        raise ValueError("图片服务没有返回有效的 PNG、JPEG 或 WebP 图片") from exc
    data = value.get("data") if isinstance(value, dict) else None
    if not isinstance(data, list) or len(data) != 1 or not isinstance(data[0], dict):
        raise ValueError("图片服务响应应包含 data 中的一张图片，请核对图片接口配置")
    item = data[0]
    if isinstance(item.get("b64_json"), str):
        try:
            return base64.b64decode(item["b64_json"], validate=True)
        except (ValueError, binascii.Error) as exc:
            raise ValueError("图片服务返回的 Base64 数据不完整") from exc
    url = item.get("url")
    if isinstance(url, str) and url.strip() and len(url) <= 8000:
        return await _download(url, conf, timeout)
    raise ValueError("图片服务没有返回图片内容或下载地址")


async def generate_image(session, client, arguments, *, conversation_id="", timeout_seconds=240):
    if not isinstance(arguments, dict):
        raise ValueError("图片生成参数必须是对象")
    client_id = str(client.id)
    user_id = str(getattr(client, "user_ref", None) or "")
    if not user_id:
        raise ValueError("请先登录账号后生成图片")
    requested = str(arguments.get("model") or "").strip()
    conf = await model_catalog.resolve(session, client, requested, "image",
        provider_id=str(arguments.get("providerId") or "").strip())
    if not conf:
        raise ValueError("所选图片模型不可用，请在「我的模型」中检查图片模型、地址与密钥")
    if conf.get("kind") != "openai-compat":
        raise ValueError("图片生成需要 OpenAI 兼容的图片接口")
    payload, encoded, endpoint = _payload(arguments, conf)
    generation_id = str(arguments.get("generationId") or "").strip()
    if len(generation_id) > 120:
        raise ValueError("generationId 不能超过 120 字符")
    ref = video_jobs.conversation_ref(conversation_id)
    digest = video_jobs.fingerprint(conf, payload, generation_id)
    timeout = max(1, min(float(timeout_seconds), 300))
    # Do not hold a database connection while waiting for an image provider.
    await session.rollback()
    job, created = await video_jobs.claim(session, client_id, ref, digest, "soduwork-image.png", {
        "kind": "conversation_image", "model": conf["model"], "provider": conf.get("provider"),
        "generationId": generation_id,
    }, timeout, kind="image", user_id=user_id)
    if job["storage_key"] and job["size"] > 0:
        return {"ok": True, "artifact": video_jobs.artifact(job), "reused": True}
    if not created:
        raise ValueError("上次图片生成结果尚未确认，请先检查成果，避免重复扣费")
    key = ""
    stored = False
    backend = storage.backend_name()
    try:
        deadline = time.monotonic() + timeout
        async with asyncio.timeout(timeout):
            raw = await _provider_request(conf, endpoint, encoded, timeout)
            raw = await _image_bytes(raw, conf, max(.1, deadline - time.monotonic()))
            mime = await video_files.disk_call(validate_image, raw)
            name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', str(arguments.get("filename") or "soduwork-image"))
            name = re.sub(r"\.[^.]+$", "", name).strip(" .")[:160] or "soduwork-image"
            name += EXTENSIONS[mime]
            key = f"conversation-media/{job['id']}/{name}"

            async def deliver():
                nonlocal stored
                await video_files.disk_call(storage.put, key, raw, mime)
                await video_jobs.change(session, job, meta={"status": "completed", "leaseUntil": 0},
                    filename=name, content_type=mime, size=len(raw), storage_key=key, backend=backend)
                stored = True

            delivery = asyncio.create_task(deliver())
            try:
                await asyncio.shield(delivery)
            except asyncio.CancelledError:
                await delivery
                raise
        return {"ok": True, "artifact": video_jobs.artifact(job), "model": conf["model"]}
    except BaseException as exc:
        if not stored:
            # Keep an uncertain submission in the ledger; retries must not send
            # another billable POST when the original outcome is unknown.
            await asyncio.shield(video_jobs.change(session, job,
                meta={"status": "interrupted", "leaseUntil": 0}))
            if key:
                await video_files.disk_call(storage.delete, key, backend)
        if isinstance(exc, UpstreamError):
            raise ValueError(f"图片模型服务调用失败（HTTP {exc.status}），请检查模型权限和图片接口参数") from exc
        if isinstance(exc, TimeoutError):
            raise ValueError("图片生成等待超时，请先检查服务端生成记录，避免重复扣费") from exc
        if isinstance(exc, httpx.HTTPError):
            raise ValueError("图片服务连接失败，请检查服务地址和网络；重新生成前请先检查服务端生成记录") from exc
        raise
