"""Read-only stable installer feed for external version catalogs."""
from __future__ import annotations

import hashlib
import hmac
import json
from datetime import datetime, timezone
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, Header, HTTPException
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import get_settings
from ..db import get_session
from ..models import ClientRelease
from ..services import client_updates as contract
from .client_updates import _release_api
from .download import _verified_row_async

router = APIRouter(prefix="/api/v1/client-releases", tags=["client-release-feed"])


def require_read_token(authorization: str | None = Header(default=None)) -> None:
    expected = get_settings().client_release_read_token.strip()
    if not expected:
        raise HTTPException(status_code=503, detail="版本列表接口尚未配置")
    scheme, _, token = (authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not hmac.compare_digest(
        token.strip().encode("utf-8"), expected.encode("utf-8")
    ):
        raise HTTPException(status_code=401, detail="版本列表令牌无效",
                            headers={"WWW-Authenticate": "Bearer"})


def _format(row: ClientRelease) -> str:
    name = row.artifact_name.lower()
    suffixes = contract.RELEASE_PLATFORM_SUFFIXES.get(row.platform, ())
    return next((suffix.lstrip(".") for suffix in sorted(suffixes, key=len, reverse=True)
                 if name.endswith(suffix)), "")


@router.get("", dependencies=[Depends(require_read_token)])
async def list_stable_releases(session: AsyncSession = Depends(get_session)):
    base_url = get_settings().hub_public_url.strip().rstrip("/")
    try:
        origin = urlsplit(base_url)
        valid_origin = (origin.scheme in {"http", "https"} and origin.hostname and
                        not origin.username and not origin.password and
                        not origin.query and not origin.fragment)
        origin.port  # Reject malformed ports as configuration errors too.
    except ValueError:
        valid_origin = False
    if not valid_origin:
        raise HTTPException(status_code=503, detail="版本列表接口未配置有效的公开服务地址")
    # One SELECT captures metadata together; this endpoint deliberately has no pagination.
    rows = list((await session.execute(select(ClientRelease).where(
        ClientRelease.channel == "stable"
    ))).scalars().all())
    rows.sort(key=lambda row: (
        contract.parse_version(row.version) or (0, 0, 0, 0, 0),
        -contract.installer_brand_rank(row.artifact_name), row.id,
    ), reverse=True)
    current_targets = set()
    releases = []
    for row in rows:
        item = _release_api(row)
        created = row.created_at
        if created and created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)
        item["createdAt"] = (created.astimezone(timezone.utc).isoformat()
                             .replace("+00:00", "Z") if created else "")
        fmt = _format(row)
        target = (row.platform, row.arch, fmt)
        is_current = False
        if row.enabled and fmt and target not in current_targets:
            try:
                contract.assert_trusted_release(row)
                is_current = await _verified_row_async(row) is not None
            except contract.UpdateContractError:
                pass
            if is_current:
                current_targets.add(target)
        item.update({
            "format": fmt,
            "downloadUrl": f"{base_url}/api/v1/download/client/releases/{row.id}",
            "isCurrent": is_current,
        })
        releases.append(item)
    snapshot = hashlib.sha256(json.dumps(
        releases, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")).hexdigest()
    return JSONResponse({
        "schemaVersion": 1, "product": "SoduWork", "snapshotId": snapshot,
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "nextCursor": None, "releases": releases,
    }, media_type="application/json; charset=utf-8", headers={"Cache-Control": "no-store"})
