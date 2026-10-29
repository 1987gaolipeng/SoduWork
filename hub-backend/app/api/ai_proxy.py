"""Device-authenticated OpenAI-compatible proxy for desktop chat. Resolve the user's authorized
model and credentials through model_catalog; reject unavailable named models without
substitution. New clients use purpose-bound short-lived tickets; legacy device secrets require
explicit migration support. Forward streaming and non-streaming responses with upstream errors.
"""
from __future__ import annotations

import asyncio
import json
import logging
import inspect
import time
from urllib.parse import quote

import anyio
from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from starlette.background import BackgroundTask
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..config import get_settings
from ..deps import current_ai_client, enforce_client_quota
from ..models import Client
from ..services import (
    device_auth,
    local_context_policy,
    model_catalog,
    model_runtime,
    model_transport,
    model_errors,
    multimodal_proxy,
    vision_router,
    model_capabilities,
)

log = logging.getLogger("uvicorn.error")


async def _resolve_catalog(session, client, model_name="", modality="chat", *, available=None):
    """Resolve a catalog row without repeating admission queries.

    A few isolated integrations replace ``model_catalog.resolve`` with a
    narrow test double. Keep that supported while the real resolver receives
    the already-admitted rows and avoids a second provider/model query.
    """
    resolver = model_catalog.resolve
    try:
        parameters = inspect.signature(resolver).parameters.values()
        supports_available = any(
            parameter.name == "available" or
            parameter.kind == inspect.Parameter.VAR_KEYWORD
            for parameter in parameters
        )
    except (TypeError, ValueError):
        supports_available = True
    if supports_available:
        try:
            return await resolver(session, client, model_name, modality, available=available)
        except TypeError as error:
            # AsyncMock exposes **kwargs even when its side effect has the
            # legacy narrow signature. Retry only that compatibility case;
            # never hide a TypeError raised by the resolver itself.
            if "unexpected keyword argument 'available'" not in str(error):
                raise
    return await resolver(session, client, model_name, modality)
settings = get_settings()

router = APIRouter(prefix="/api/v1/ai-proxy", tags=["ai-proxy"])

# Client proxy URL prefix; keep client/main.js consistent when changing it.
PROXY_PATH = "/api/v1/ai-proxy/v1"


def _upstream_message(status: int, detail: str, *, responses: bool = False) -> str:
    """Return a stable product error; never expose the upstream envelope."""
    if status in (502, 503, 504):
        return f"模型服务暂时不可用（HTTP {status}），上游连接超时或被重置，请稍后重试"
    if status == 429:
        return "模型服务当前繁忙或额度受限，请稍后重试"
    hint = {
        401: "密钥不对或已过期",
        403: "这把密钥没有这个模型的权限",
        404: "网关地址、模型名或接口不对" if responses else "网关地址或模型名不对",
        405: "当前模型网关尚未开放 Responses 接口",
    }.get(status, "")
    return (str(detail or f"HTTP {status}") + ("：" + hint if hint else "")).strip()

def _err(status: int, msg: str, upstream: str = "") -> JSONResponse:
    """Return an OpenAI-shaped error whose error.message can be displayed by pi-ai."""
    body: dict = {"error": {"message": msg, "type": "soduwork_proxy_error", "code": status,
                          "status": status}}
    # Keep a machine-readable context error across the proxy boundary while
    # suppressing the raw envelope (which may contain keys or internal URLs).
    diagnostic = str(upstream or "")[:65536]
    if status in (400, 413, 422) and local_context_policy.OVERFLOW.search(diagnostic):
        window = local_context_policy.error_window(diagnostic)
        message = "Context length exceeded."
        if window:
            message += f" maximum context length is {window} tokens."
        body["error"] = {"message": message, "type": "soduwork_proxy_error",
                         "code": "context_length_exceeded", "status": status}
    if upstream:
        # The raw body can contain internal gateway data and is not a client
        # diagnostic contract. Keep only a size signal in server logs.
        log.warning("[ai-proxy] upstream error suppressed: status=%s bytes=%s",
                    status, len(upstream.encode("utf-8", "replace")))
    return JSONResponse(status_code=status, content=body)


async def _stream_upstream_response(resp):
    """Forward bytes unchanged; never pretend a truncated stream completed."""
    try:
        async for chunk in resp.chunks():
            yield chunk
    except model_errors.UpstreamError as exc:
        yield _in_stream_error_frame(exc)
    finally:
        await resp.aclose()









OPEN_KEEPALIVE_INTERVAL = 15.0
OPEN_KEEPALIVE_COMMENT = b": soduwork-keepalive\n\n"


def _error_message(exc, *, responses=False):
    """Stable product message shared by the JSON and in-stream error shapes."""
    if isinstance(exc, model_runtime.CapacityError):
        # Streaming has already sent HTTP 200. Some SDKs preserve only the
        # message, so retain the safe status there as well as in code/status.
        return f"{exc.detail}（HTTP {exc.status}）"
    return _upstream_message(exc.status, exc.detail, responses=responses)


def _in_stream_error_frame(exc, *, responses=False):
    # Keep context overflow and sanitized upstream errors identical to the JSON
    # path; clients use the machine code to compact context and recover.
    return b"\n\ndata: " + _proxy_error(exc, responses=responses).body + b"\n\n"


# Normalize supported usage aliases without inventing unavailable token details.

# Source object, source value candidates, chat key, Responses key, and standard value key.
_USAGE_DETAIL_MAP = (
    ("inputTokensDetails", ("cached_tokens", "cachedTokens"),
     "prompt_tokens_details", "input_tokens_details", "cached_tokens"),
    ("outputTokensDetails", ("reasoning_tokens", "reasoningTokens"),
     "completion_tokens_details", "output_tokens_details", "reasoning_tokens"),
)


def _standardize_usage_object(usage: dict) -> dict | None:
    """Map camelCase usage details to OpenAI snake_case for chat and Responses. Preserve existing
    standard values, including zero; return None when no normalization is needed.
    """
    out = dict(usage)
    chat_like = "prompt_tokens" in usage or "prompt_tokens_details" in usage
    responses_like = "input_tokens" in usage or "input_tokens_details" in usage
    changed = False
    for camel_key, source_keys, chat_key, responses_key, value_key in _USAGE_DETAIL_MAP:
        std_key = responses_key if (responses_like and not chat_like) else chat_key
        details = out.get(std_key)
        if isinstance(details, dict) and details:
            continue
        source = out.get(camel_key)
        if not isinstance(source, dict):
            continue
        for key in source_keys:
            value = source.get(key)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                merged = dict(details) if isinstance(details, dict) else {}
                merged.setdefault(value_key, int(value))
                out[std_key] = merged
                changed = True
                break
    return out if changed else None


def _usage_observation(usage: dict) -> dict:
    """Read usage observations from chat or Responses fields; return None for missing values."""
    def num(value):
        return int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None

    prompt_details = usage.get("prompt_tokens_details") or usage.get("input_tokens_details") \
        or usage.get("promptTokensDetails") or {}
    completion_details = usage.get("completion_tokens_details") or usage.get("output_tokens_details") \
        or usage.get("completionTokensDetails") or {}
    camel_prompt = usage.get("inputTokensDetails") or {}
    camel_completion = usage.get("outputTokensDetails") or {}
    cached = num(prompt_details.get("cached_tokens")) if isinstance(prompt_details, dict) else None
    if cached is None:
        cached = num(camel_prompt.get("cached_tokens", camel_prompt.get("cachedTokens"))) \
            if isinstance(camel_prompt, dict) else None
    reasoning = num(completion_details.get("reasoning_tokens")) if isinstance(completion_details, dict) else None
    if reasoning is None:
        reasoning = num(camel_completion.get("reasoning_tokens",
                                              camel_completion.get("reasoningTokens"))) \
            if isinstance(camel_completion, dict) else None
    return {"prompt": num(usage.get("prompt_tokens", usage.get("input_tokens"))),
            "completion": num(usage.get("completion_tokens", usage.get("output_tokens"))),
            "total": num(usage.get("total_tokens")),
            "cached": cached, "reasoning": reasoning}


def _fmt_observation(obs: dict) -> str:
    return " ".join(f"{key}={obs[key] if obs[key] is not None else '-'}"
                    for key in ("prompt", "completion", "total", "cached", "reasoning"))


def _usage_passthrough(raw: bytes, *, model: str, provider: str, mode: str) -> bytes:
    """Normalize supported token-detail aliases, preserving unknown values.

    Do not synthesize zero counts when the upstream does not report details.
    Return the original bytes unless normalization adds a supported field.
    """
    try:
        obj = json.loads(raw)
    except Exception:  # noqa: BLE001  Preserve non-JSON upstream responses, including error pages.
        return raw
    if not isinstance(obj, dict) or not isinstance(obj.get("usage"), dict):
        return raw
    usage = obj["usage"]
    fixed = _standardize_usage_object(usage)
    if fixed is not None:
        obj["usage"] = fixed
        usage = fixed
        raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    log.info("[ai-proxy] usage model=%s provider=%s mode=%s %s",
             model, provider, mode, _fmt_observation(_usage_observation(usage)))
    return raw


class _OwnedStreamingResponse(StreamingResponse):
    async def stream_response(self, send):
        try:
            await super().stream_response(send)
        finally:
            # A disconnect can interrupt ASGI send while the generator is
            # suspended at yield. Starlette's background hook may be skipped,
            # so explicitly settle upstream ownership before returning.
            await self.body_iterator.aclose()


async def _open_then_stream(request: Request, open_call, *, responses: bool = False) -> StreamingResponse:
    """Emit SSE heartbeats while opening upstream, then forward its body unchanged. Disconnects
    cancel opening; cleanup releases sockets and capacity leases idempotently. Opening failures
    become in-stream errors under HTTP 200. Record opening timings in logs because
    admission/header Server-Timing fields are unavailable on this path.
    """
    holder: dict = {}
    started = time.perf_counter()

    async def gen():
        task = asyncio.create_task(open_call())
        upstream = None
        completed = False
        try:
            yield OPEN_KEEPALIVE_COMMENT
            while True:
                try:
                    opened = await asyncio.wait_for(asyncio.shield(task), OPEN_KEEPALIVE_INTERVAL)
                    break
                except asyncio.TimeoutError:
                    yield OPEN_KEEPALIVE_COMMENT
            holder["resp"] = opened
            if request is not None and getattr(opened, "timing", None):
                request.state.model_timing = opened.timing
                opened.timing["mode"] = "stream"
            log.info("[ai-proxy] upstream open ok openMs=%.1f",
                     (time.perf_counter() - started) * 1000)
            upstream = _stream_upstream_response(opened)
            async for chunk in upstream:
                yield chunk
            completed = True
        except model_errors.UpstreamError as exc:
            log.warning("[ai-proxy] upstream open failed status=%s after %.1fs",
                        exc.status, time.perf_counter() - started)
            yield _in_stream_error_frame(exc, responses=responses)
        except HTTPException as exc:
            if exc.status_code != 499:
                yield _in_stream_error_frame(model_errors.UpstreamError(exc.status_code, ""),
                                             responses=responses)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001  Convert unexpected upstream-opening failures to stream errors.
            log.warning("[ai-proxy] upstream open crashed after %.1fs: %s",
                        time.perf_counter() - started, type(exc).__name__)
            yield _in_stream_error_frame(model_errors.UpstreamError(502, ""), responses=responses)
        finally:
            async def settle():
                if not task.done():
                    task.cancel()
                await asyncio.gather(task, return_exceptions=True)
                # Open can finish while the first heartbeat is being sent,
                # before holder receives ownership. Reclaim that result too.
                opened = holder.get("resp")
                if opened is None and not task.cancelled() and task.exception() is None:
                    opened = task.result()
                if opened is not None:
                    if not completed and getattr(opened, "outcome", None) == "completed":
                        opened.outcome = "cancelled"
                    try:
                        if upstream is not None:
                            await upstream.aclose()
                    finally:
                        await opened.aclose()

            cleanup = asyncio.create_task(settle())
            cancelled = False
            with anyio.CancelScope(shield=True):
                while not cleanup.done():
                    try:
                        await asyncio.shield(cleanup)
                    except asyncio.CancelledError:
                        cancelled = True
            cleanup.result()
            if cancelled:
                raise asyncio.CancelledError

    async def _bg():
        resp = holder.get("resp")
        if resp is not None:
            await resp.aclose()

    return _OwnedStreamingResponse(gen(), media_type="text/event-stream",
                             background=BackgroundTask(_bg),
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no",       # Disable nginx buffering.
                                      "Connection": "keep-alive"})


def _proxy_error(exc, *, responses=False):
    result = _err(exc.status if 400 <= exc.status < 600 else 502,
                  _error_message(exc, responses=responses), exc.body)
    if getattr(exc, "retry_after", 0):
        result.headers["Retry-After"] = str(exc.retry_after)
    return result


async def _release_catalog_connection(session):
    # Catalog/auth is read-only. Do not reserve a DB connection for a long SSE
    # response or a capacity queue. Vision fallback may open a new transaction.
    if session is not None:
        await session.close()


async def _client_by_bearer(
    authorization: str | None = Header(default=None),
    x_soduwork_device: str | None = Header(default=None, alias="X-Soduwork-Device"),
    x_soduwork_secret: str | None = Header(default=None, alias="X-Soduwork-Secret"),
    session: AsyncSession = Depends(get_session),
) -> Client:
    """Prefer a purpose-bound AI proxy ticket.

    The legacy device-key shape is available only when the explicit rollout
    flag is enabled. This endpoint never enrolls an unknown device.
    """
    dev, sec = (x_soduwork_device or "").strip(), (x_soduwork_secret or "").strip()
    if not dev and authorization and authorization.lower().startswith("bearer "):
        raw = authorization[7:].strip()
        try:
            client = await device_auth.client_from_proxy_ticket(session, raw)
        except device_auth.DeviceAuthError as exc:
            if not settings.device_auth_compat:
                raise HTTPException(status_code=exc.status, detail=str(exc)) from exc
        else:
            await enforce_client_quota(session, client)
            return client
        dev, _, sec = raw.partition(":")
        dev, sec = dev.strip(), sec.strip()
    if not settings.device_auth_compat:
        raise HTTPException(status_code=401, detail="A valid AI proxy ticket is required")
    if not dev or not sec:
        raise HTTPException(status_code=401, detail="需要有效的 AI 对话凭证")
    try:
        client = await device_auth.client_from_secret(session, dev, sec)
    except device_auth.DeviceAuthError as exc:
        raise HTTPException(status_code=exc.status, detail=str(exc)) from exc
    await enforce_client_quota(session, client)
    return client


@router.get("/config")
async def proxy_config(
    model: str = "",
    agent: str = "pi",
    client: Client = Depends(current_ai_client),
    session: AsyncSession = Depends(get_session),
):
    """Resolve the execution endpoint and model before the desktop opens an AI conversation. Return
    only revocable, purpose-scoped short-lived key and mcpKey tickets; these tickets do not
    reveal device or shared-provider credentials."""
    from ..services.agent_execution_options import GATEWAY_MODEL_KINDS

    cli = str(agent or "pi").strip().lower().removeprefix("local:")
    # A configuration selector, not an executable ID. Personal ACP declarations
    # stay on their device; the Hub still authenticates this client and resolves
    # only its usable models. No company key or arbitrary runtime is registered.
    custom_acp = cli == "custom-acp"
    if not custom_acp and "local:" + cli not in GATEWAY_MODEL_KINDS:
        return {"ok": False, "path": PROXY_PATH,
                "reason": "此底座不使用企业模型配置，请检查执行底座"}
    # Match controlled dispatch: explicit choice > Agent preference > company
    # default. A removed preference is an actionable error, never a silent swap.
    want = str(model or "").strip() or ("" if custom_acp else model_catalog.agent_model(client, cli))
    usable = await model_catalog.usable(session, client)
    if want and not any(item["name"] == want for item in usable):
        return {"ok": False, "path": PROXY_PATH,
                "reason": f"你选择的模型「{want}」现在不可用，请重新选择"}
    conf = await _resolve_catalog(session, client, want, available=usable)
    if not conf:
        return {"ok": False, "path": PROXY_PATH,
                "reason": "还没有可用的模型：去「我的模型」配一把自己的密钥，或让管理员配好共享模型服务"}
    if conf.get("kind") != "openai-compat":
        return {"ok": False, "path": PROXY_PATH,
                "reason": f"默认模型「{conf['model']}」不是 OpenAI 兼容接口，AI 对话暂时用不了它"}
    hit = next((m for m in usable if m["name"] == conf["model"]), {})
    image_models = await model_catalog.usable(session, client, "image")
    video_models = await model_catalog.usable(session, client, "video")
    proxy_key, expires_in = device_auth.issue_proxy_ticket(client)
    mcp_key, mcp_expires_in = device_auth.issue_mcp_ticket(client)
    image_routing = model_catalog.normalize_image_routing(conf.get("imageRouting"))
    # Catalog values may come from an administrator-edited JSON payload. Keep
    # a malformed optional value from breaking the whole config handshake.
    context_window = 0
    for candidate in (hit.get("ctxWindow"), conf.get("contextWindow")):
        try:
            context_window = max(0, int(candidate or 0))
        except (TypeError, ValueError):
            continue
        if context_window:
            break
    resolved_context = model_catalog.context_window.resolve({
        "contextWindow": context_window,
        "modelName": conf.get("model"),
        "providerId": conf.get("provider"),
    })
    thinking_config = model_catalog.model_config(
        hit.get("config") or conf.get("config") or {}, "chat")
    thinking_fields = {
        key: thinking_config[key]
        for key in ("reasoning", "thinkingMode", "thinkingFormat",
                    "supportsReasoningEffort", "thinkingLevelMap")
        if key in thinking_config
    }
    if thinking_config.get("thinkingMode") == "always":
        thinking_fields["thinkingAlwaysOn"] = True
    return {"ok": True, "path": PROXY_PATH,
            "key": proxy_key, "expiresIn": expires_in,
            "mcpKey": mcp_key, "mcpExpiresIn": mcp_expires_in,
            "model": conf["model"],
            # Native pixels stay with the selected, declared-capable model.
            # A non-native route needs a separately configured optional adapter.
            "input": ["text", "image"] if image_routing == "native" else ["text"],
            "imageRouting": image_routing,
            "visionFallbackAvailable": bool(conf.get("visionFallbackAvailable")),
            "capabilityProfile": conf.get("capabilityProfile") or {},
            "maxOutputTokens": conf.get("maxOutputTokens") or model_capabilities.DEFAULT_OUTPUT,
            "configRevision": conf.get("configRevision") or "",
            "runtimeRevision": conf.get("runtimeRevision") or "",
            "label": hit.get("label") or conf["model"],
            "providerName": hit.get("providerName") or conf.get("provider") or "",
            "keyFrom": conf.get("keyFrom") or "",
            "contextWindow": resolved_context["contextWindow"],
            "contextWindowKnown": resolved_context["contextWindowKnown"],
            "contextWindowEstimated": resolved_context["contextWindowEstimated"],
            "contextWindowSource": resolved_context["contextWindowSource"],
            **thinking_fields,
            "mediaModels": {"image": image_models, "video": video_models}}


@router.get("/media/config")
async def media_config(
    client: Client = Depends(current_ai_client),
    session: AsyncSession = Depends(get_session),
):
    """Return a short-lived media proxy ticket and this user's usable generators."""
    image_models = await model_catalog.usable(session, client, "image")
    video_models = await model_catalog.usable(session, client, "video")
    proxy_key, expires_in = device_auth.issue_proxy_ticket(client)
    return {
        "ok": bool(image_models or video_models),
        "path": PROXY_PATH,
        "key": proxy_key,
        "expiresIn": expires_in,
        "models": {"image": image_models, "video": video_models},
        "reason": "" if image_models or video_models else (
            "还没有可用的图片或视频模型，请先在模型配置中添加并配置凭据"),
    }


@router.get("/v1/models")
async def list_models(
    client: Client = Depends(_client_by_bearer),
    session: AsyncSession = Depends(get_session),
):
    """Return an OpenAI-shaped list containing only models this user can use."""
    lst = await model_catalog.usable(session, client)
    return {"object": "list",
            "data": [{"id": m["name"], "object": "model", "created": 0,
                      "owned_by": m.get("providerName") or ""} for m in lst
                     if m.get("providerId")]}


@router.post("/vision/analyze")
async def analyze_vision(
    request: Request,
    client: Client = Depends(current_ai_client),
    session: AsyncSession = Depends(get_session),
):
    """Apply explicitly enabled image transcription; default to disabled and never silently discard
    images on failure.
    """
    raw = bytearray()
    async for chunk in request.stream():
        if len(raw) + len(chunk) > vision_router.MAX_REQUEST_BYTES:
            return JSONResponse(
                status_code=413, content={"ok": False, "reason": "本次图片请求超过 28 MB"})
        raw.extend(chunk)
    try:
        body = json.loads(bytes(raw))
    except Exception:  # noqa: BLE001
        return JSONResponse(status_code=400, content={"ok": False, "reason": "请求体不是合法 JSON"})
    if not isinstance(body, dict):
        return JSONResponse(status_code=400, content={"ok": False, "reason": "请求体应当是 JSON 对象"})
    result = await model_transport.until_disconnect(request, vision_router.analyze(
        session, client, body.get("images"), str(body.get("context") or "")))
    status = int(result.pop("status", 200))
    return JSONResponse(status_code=status, content=result)


async def _generate_media(
    modality: str,
    request: Request,
    client: Client,
    session: AsyncSession,
):
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return _err(400, "请求体不是合法 JSON")
    if not isinstance(body, dict):
        return _err(400, "请求体应当是一个 JSON 对象")

    want = str(body.get("model") or "").strip()
    usable = await model_catalog.usable(session, client, modality)
    if want and not any(item["name"] == want for item in usable):
        return _err(400, f"模型「{want}」不是当前可用的{('图片' if modality == 'image' else '视频')}模型")
    conf = await _resolve_catalog(session, client, want, modality, available=usable)
    if not conf:
        return _err(400, f"还没有可用的{('图片' if modality == 'image' else '视频')}模型")
    if conf.get("kind") != "openai-compat":
        return _err(400, f"模型「{conf['model']}」当前不支持这条媒体生成通道")

    config = model_catalog.model_config(conf.get("config"), modality)
    payload = dict(config.get("defaults") or {})
    payload.update(body)
    payload["model"] = conf["model"]
    payload.pop("stream", None)
    endpoint = config["endpointPath"]
    log.info("[ai-proxy:%s] %s -> %s (%s)", modality, client.id,
             conf["model"], conf.get("provider") or "")
    await _release_catalog_connection(session)
    try:
        response = await model_transport.until_disconnect(request,
            model_transport.open_response(conf, endpoint,
                json.dumps(payload, ensure_ascii=False).encode("utf-8")))
        raw = await model_transport.until_disconnect(request, response.read(64 * 1024 * 1024))
        return Response(content=raw, media_type=response.headers.get("content-type", "application/json"))
    except model_errors.UpstreamError as exc:
        return _proxy_error(exc)


@router.post("/v1/images/generations")
async def image_generations(
    request: Request,
    client: Client = Depends(_client_by_bearer),
    session: AsyncSession = Depends(get_session),
):
    return await _generate_media("image", request, client, session)


@router.post("/v1/videos/generations")
async def video_generations(
    request: Request,
    client: Client = Depends(_client_by_bearer),
    session: AsyncSession = Depends(get_session),
):
    return await _generate_media("video", request, client, session)


async def _video_job_request(
    request: Request,
    job_id: str,
    model: str,
    config_key: str,
    client: Client,
    session: AsyncSession,
):
    """Read an asynchronous video job or its configured result stream."""
    wanted = str(model or "").strip()
    usable = await model_catalog.usable(session, client, "video")
    if wanted and not any(item["name"] == wanted for item in usable):
        return _err(400, f"模型「{wanted}」不是当前可用的视频模型")
    if not wanted and len(usable) > 1:
        return _err(400, "配置了多个视频模型，查询任务时需要传 model 参数")
    conf = await _resolve_catalog(session, client, wanted, "video", available=usable)
    if not conf:
        return _err(400, "还没有可用的视频模型")
    if conf.get("kind") != "openai-compat":
        return _err(400, f"模型「{conf['model']}」当前不支持视频任务查询")
    config = model_catalog.model_config(conf.get("config"), "video")
    template = str(config.get(config_key) or "")
    if not template:
        label = "任务查询路径" if config_key == "statusPath" else "结果下载路径"
        return _err(400, f"视频模型「{conf['model']}」还没有配置{label}")
    task_id = str(job_id or "").strip()
    if not task_id or len(task_id) > 240:
        return _err(400, "视频任务 ID 无效")
    endpoint = template.replace("{id}", quote(task_id, safe=""))
    await _release_catalog_connection(session)
    try:
        response = await model_transport.until_disconnect(request,
            model_transport.open_response(conf, endpoint, None))
        raw = await model_transport.until_disconnect(request, response.read(64 * 1024 * 1024))
        return Response(content=raw, media_type=response.headers.get("content-type", "application/json"))
    except model_errors.UpstreamError as exc:
        return _proxy_error(exc)


@router.get("/v1/videos/generations/{job_id}")
async def video_generation_status(
    request: Request,
    job_id: str,
    model: str = "",
    client: Client = Depends(_client_by_bearer),
    session: AsyncSession = Depends(get_session),
):
    return await _video_job_request(
        request, job_id, model, "statusPath", client, session)


@router.get("/v1/videos/generations/{job_id}/content")
async def video_generation_content(
    request: Request,
    job_id: str,
    model: str = "",
    client: Client = Depends(_client_by_bearer),
    session: AsyncSession = Depends(get_session),
):
    return await _video_job_request(
        request, job_id, model, "resultPath", client, session)

@router.post("/v1/chat/completions")
async def chat_completions(
    request: Request,
    client: Client = Depends(_client_by_bearer),
    session: AsyncSession = Depends(get_session),
):
    """Forward a chat request as a stream or complete response according to its requested mode."""
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return _err(400, "请求体不是合法 JSON")
    if not isinstance(body, dict):
        return _err(400, "请求体应当是一个 JSON 对象")

    want = str(body.get("model") or "").strip()
    lst = await model_catalog.usable(session, client)
    if want and not any(m["name"] == want for m in lst):
        names = "、".join(m["name"] for m in lst[:8]) or "（一个都没有）"
        return _err(400, f"模型「{want}」现在用不了（没开放，或者没有可用的密钥）。当前能用的：{names}")
    conf = await _resolve_catalog(session, client, want, available=lst)
    if not conf:
        return _err(400, "还没有可用的模型：去「我的模型」配一把自己的密钥，或让管理员配好共享模型服务")
    if conf.get("kind") != "openai-compat":
        return _err(400, f"模型「{conf['model']}」不是 OpenAI 兼容接口，这条通道用不了它")

    payload = dict(body)
    payload["model"] = conf["model"]
    stream = bool(body.get("stream"))
    log.info("[ai-proxy] %s → %s（%s，%s）", client.id, conf["model"],
             conf.get("provider") or "", "流式" if stream else "整包")
    async def _observe(images, context):
        try:
            return await vision_router.analyze(session, client, images, context)
        finally:
            await _release_catalog_connection(session)

    await _release_catalog_connection(session)
    if stream:
        # Send SSE heartbeats while awaiting upstream headers; see _open_then_stream.
        return await _open_then_stream(request, lambda: model_transport.until_disconnect(
            request, multimodal_proxy.open_request(conf, "/chat/completions", payload, _observe)))

    try:
        resp = await model_transport.until_disconnect(request,
            multimodal_proxy.open_request(conf, "/chat/completions", payload, _observe))
    except model_errors.UpstreamError as e:
        return _proxy_error(e)
    if getattr(resp, "timing", None):
        request.state.model_timing = resp.timing
        resp.timing["mode"] = "complete"
    try:
        raw = await model_transport.until_disconnect(request, resp.read())
        raw = _usage_passthrough(raw, model=conf["model"],
                                 provider=conf.get("provider") or "", mode="complete")
        return Response(content=raw, media_type="application/json")
    except model_errors.UpstreamError as exc:
        return _proxy_error(exc)


@router.post("/v1/responses")
async def responses(
    request: Request,
    client: Client = Depends(_client_by_bearer),
    session: AsyncSession = Depends(get_session),
):
    """Proxy native Codex Harness Responses requests to the device's authorized gateway without
    protocol conversion or Pi-session reuse. Pi continues using /chat/completions.
    """
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return _err(400, "请求体不是合法 JSON")
    if not isinstance(body, dict):
        return _err(400, "请求体应当是一个 JSON 对象")

    want = str(body.get("model") or "").strip()
    usable = await model_catalog.usable(session, client)
    if want and not any(item["name"] == want for item in usable):
        names = "、".join(item["name"] for item in usable[:8]) or "（一个都没有）"
        return _err(
            400,
            f"模型「{want}」现在用不了（没开放，或者没有可用的密钥）。当前能用的：{names}",
        )
    conf = await _resolve_catalog(session, client, want, available=usable)
    if not conf:
        return _err(400, "还没有可用的模型：去「我的模型」配一把自己的密钥，或让管理员配好共享模型服务")
    if conf.get("kind") != "openai-compat":
        return _err(400, f"模型「{conf['model']}」不是 OpenAI 兼容接口，这条通道用不了它")

    async def _observe(images: list[dict[str, str]], context: str) -> dict:
        try:
            return await vision_router.analyze(session, client, images, context)
        finally:
            await _release_catalog_connection(session)

    payload = dict(body)
    payload["model"] = conf["model"]
    stream = bool(body.get("stream"))
    log.info("[ai-proxy:responses] %s → %s（%s，%s）", client.id, conf["model"],
             conf.get("provider") or "", "流式" if stream else "整包")
    await _release_catalog_connection(session)
    if stream:
        # Keep ingress active with SSE heartbeats during long upstream prefill.
        return await _open_then_stream(request, lambda: model_transport.until_disconnect(
            request, multimodal_proxy.open_request(conf, "/responses", payload, _observe)),
            responses=True)

    try:
        resp = await model_transport.until_disconnect(request,
            multimodal_proxy.open_request(conf, "/responses", payload, _observe))
    except model_errors.UpstreamError as exc:
        return _proxy_error(exc, responses=True)
    if getattr(resp, "timing", None):
        request.state.model_timing = resp.timing
        resp.timing["mode"] = "complete"
    try:
        raw = await model_transport.until_disconnect(request, resp.read())
        raw = _usage_passthrough(raw, model=conf["model"],
                                 provider=conf.get("provider") or "", mode="responses")
        return Response(content=raw, media_type="application/json")
    except model_errors.UpstreamError as exc:
        return _proxy_error(exc)
