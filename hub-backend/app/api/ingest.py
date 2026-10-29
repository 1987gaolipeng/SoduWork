"""Ingest task envelopes or native integration webhooks. Authenticate with X-Ingest-Token or
X-Gitlab-Token; parse webhooks through the integration connector, falling back to Envelope when
no connector exists.
"""
import json

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..connectors import get_connector
from ..db import get_session
from ..deps import current_integration
from ..models import Integration
from ..services import aggregation as agg

router = APIRouter(prefix="/api/v1", tags=["ingest"])


def _items(body: dict) -> list[dict]:
    if isinstance(body, dict) and isinstance(body.get("items"), list):
        return body["items"]
    if isinstance(body, dict) and body.get("external_id"):
        return [body]
    return []


@router.post("/ingest")
async def ingest(
    body: dict = Body(default_factory=dict),
    integ: Integration = Depends(current_integration),
    session: AsyncSession = Depends(get_session),
):
    return await agg.ingest_many(session, integ, _items(body))


async def _integration_by_token(session: AsyncSession, token: str | None) -> Integration:
    if not token:
        raise HTTPException(status_code=401, detail="缺少 ingest token（X-Ingest-Token / X-Gitlab-Token）")
    res = await session.execute(select(Integration).where(Integration.ingest_token == token))
    integ = res.scalar_one_or_none()
    if integ is None:
        raise HTTPException(status_code=401, detail="无效的 ingest token")
    if not integ.enabled:
        raise HTTPException(status_code=403, detail="该集成已停用")
    return integ


@router.post("/webhooks/{integration_id}")
async def webhook(
    integration_id: str,
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    """Parse native webhook payloads using the integration connector, or fall back to Envelope
    parsing.
    """
    token = request.headers.get("X-Ingest-Token") or request.headers.get("X-Gitlab-Token")
    integ = await _integration_by_token(session, token)
    raw = await request.body()
    conn = get_connector(integ.type)
    if conn is not None and hasattr(conn, "parse_webhook"):
        # Inspect the adapter signature before supplying optional config such as fieldMap.
        # Do not catch TypeError to infer signature support; that would hide parser failures.
        import inspect
        try:
            nargs = len(inspect.signature(conn.parse_webhook).parameters)
        except (TypeError, ValueError):
            nargs = 2
        envelopes = (conn.parse_webhook(dict(request.headers), raw, integ.config or {})
                     if nargs >= 3 else conn.parse_webhook(dict(request.headers), raw))
    else:
        try:
            envelopes = _items(json.loads(raw or b"{}"))
        except Exception:
            envelopes = []
    return await agg.ingest_many(session, integ, envelopes)
