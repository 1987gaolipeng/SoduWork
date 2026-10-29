"""Route image input safely across native and text-only gateways.

Declared-capable selected models receive native pixels. A vision transcription
adapter is optional and must be explicitly configured by the server. Authentication,
malformed images and transient failures are never disguised as a lack of
vision, and no retry happens once streaming has begun.
"""
from __future__ import annotations

import json
import logging
import re

from . import model_transport, model_errors, responses_vision
from .vision_policy import adapter_configured, IMAGE_UNSUPPORTED

log = logging.getLogger('uvicorn.error')


def image_rejected(error: model_errors.UpstreamError) -> bool:
    if error.status not in (400, 415, 422):
        return False
    # Inspect only an upstream error message, never arbitrary echoed input.
    try:
        body = json.loads(error.body)
        err = body.get('error', body)
        message = err.get('message', '') if isinstance(err, dict) else ''
    except (ValueError, AttributeError, TypeError):
        message = ''
    message = str(message).lower()[:2000]
    if re.search(r'\b(?:format|mime|base64|decode|corrupt|resolution|dimensions|too large|size limit)\b', message):
        return False
    return bool(re.search(
        r'(?:model|gateway).{0,100}(?:does not support|doesn.t support|not support|unsupported).{0,40}(?:image|vision|multimodal)'
        r'|(?:image(?:_url| input|s)?|vision|multimodal).{0,60}(?:not supported|unsupported|only supported by certain models)'
        r'|(?:模型|网关).{0,30}不支持.{0,20}(?:图片|图像|多模态)', message))


async def open_request(conf: dict, path: str, payload: dict, analyze):
    """Open a response without consuming it; caller owns streaming and close."""
    field = 'messages' if path == '/chat/completions' else 'input'

    async def send(body):
        return await model_transport.open_response(
            conf, path,
            json.dumps(body, ensure_ascii=False).encode('utf-8'),
            stream=bool(payload.get('stream')))

    has_images = responses_vision.has_images({field: payload.get(field)})
    # Ignore caller-side capability flags; only the server can enable an adapter.
    fallback_available = adapter_configured() if has_images else False
    if has_images and conf.get('imageRouting') != 'native':
        if not fallback_available:
            raise model_errors.UpstreamError(400, '', IMAGE_UNSUPPORTED)
        try:
            converted, info = await responses_vision.prepare(
                {field: payload.get(field)}, analyze, strict=True,
                text_type='text' if field == 'messages' else 'input_text')
        except ValueError as failure:
            raise model_errors.UpstreamError(400, '', str(failure)) from failure
        if info['imageBlocks']:
            log.info('[ai-proxy] vision fallback route=%s images=%s',
                     path, info['imageBlocks'])
            return await send({**payload, field: converted[field]})

    try:
        return await send(payload)
    except model_errors.UpstreamError as error:
        if not image_rejected(error):
            raise
        if not has_images:
            raise
        if not fallback_available:
            raise model_errors.UpstreamError(
                400, '', '当前所选模型服务拒绝图片输入，请手动选择支持图片的模型后重试；原图已保留，未自动更换模型。') from error
        # Restrict conversion to message content, never tool schemas or metadata.
        try:
            converted, info = await responses_vision.prepare(
                {field: payload.get(field)}, analyze, strict=True,
                text_type='text' if field == 'messages' else 'input_text')
        except ValueError as failure:
            raise model_errors.UpstreamError(400, '', str(failure)) from error
        if not info['imageBlocks']:
            raise
        log.info('[ai-proxy] explicit image rejection; vision fallback path=%s images=%s',
                 path, info['imageBlocks'])
        return await send({**payload, field: converted[field]})
