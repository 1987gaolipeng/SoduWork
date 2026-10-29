"""Short-lived capability URLs for browser-rendered task resources."""
from __future__ import annotations

import re
import time
from urllib.parse import quote

from ..auth import sign_claims, verify_claims


ATTACHMENT_TTL_SECONDS = 10 * 60
_STABLE_WINDOW_SECONDS = 5 * 60
_ATTACHMENT_URL = re.compile(r"^/(?:api/v1/)?attachments/([A-Za-z0-9-]{8,64})(?:\?.*)?$")
SAFE_INLINE_IMAGE_TYPES = frozenset({
    "image/png", "image/jpeg", "image/gif", "image/webp",
    "image/bmp", "image/avif", "image/x-icon",
})
SAFE_INLINE_PREVIEW_TYPES = SAFE_INLINE_IMAGE_TYPES | frozenset({
    "application/pdf", "application/json",
    "text/plain", "text/markdown", "text/csv",
})



def is_inline_image(content_type: str) -> bool:
    return str(content_type or "").strip().lower() in SAFE_INLINE_IMAGE_TYPES

def is_inline_preview(content_type: str) -> bool:
    normalized = str(content_type or "").split(";", 1)[0].strip().lower()
    return normalized in SAFE_INLINE_PREVIEW_TYPES



def issue_attachment(aid: str) -> str:
    # Trace/detail views poll frequently and use their rendered HTML as the
    # repaint signature.  A random URL on every poll would destroy that
    # stability and make the UI flicker.  The five-minute bucket is identical
    # across Hub workers while still expiring in at most ten minutes.
    bucket = int(time.time()) // _STABLE_WINDOW_SECONDS
    issued_at = bucket * _STABLE_WINDOW_SECONDS
    return sign_claims(
        {"aid": str(aid or "")},
        ttl_seconds=ATTACHMENT_TTL_SECONDS,
        token_type="attachment",
        issued_at=issued_at,
        token_id="attachment:" + str(bucket),
    )


def verify_attachment(aid: str, ticket: str) -> bool:
    claims = verify_claims(ticket, token_type="attachment")
    return bool(claims and str(claims.get("aid") or "") == str(aid or ""))


def attachment_url(aid: str) -> str:
    clean = str(aid or "")
    return "/api/v1/attachments/" + clean + "?ticket=" + quote(issue_attachment(clean), safe="")


def decorate(value):
    """Replace stable attachment references with fresh browser capability URLs."""
    if isinstance(value, list):
        return [decorate(item) for item in value]
    if not isinstance(value, dict):
        return value
    out = {key: decorate(item) for key, item in value.items()}
    match = _ATTACHMENT_URL.fullmatch(str(out.get("url") or ""))
    if match:
        out["url"] = attachment_url(match.group(1))
    return out


def stabilize(value):
    """Remove expiring capability tickets before facts are persisted."""
    if isinstance(value, list):
        return [stabilize(item) for item in value]
    if not isinstance(value, dict):
        return value
    out = {key: stabilize(item) for key, item in value.items()}
    match = _ATTACHMENT_URL.fullmatch(str(out.get("url") or ""))
    if match:
        aid = match.group(1)
        out["url"] = "/api/v1/attachments/" + aid
    return out
