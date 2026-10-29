"""Privileged SMTP setup and bounded fixed-template tests."""
from datetime import timedelta

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..deps import require_perm
from ..mail_models import MailOutbox
from ..models import User
from ..services import account_mail as mail, audit

router = APIRouter(prefix="/api/v1/admin", tags=["account-mail"])


def failure(exc):
    return HTTPException(status_code=422, detail={"code": "MAIL_CONFIG_INVALID", "message": str(exc)})


@router.get("/mail-settings")
async def settings(_user: User = Depends(require_perm("identity.manage")),
                   session: AsyncSession = Depends(get_session)):
    try:
        return await mail.public_settings(session)
    except mail.MailConfigurationError as exc:
        raise failure(exc) from None


@router.put("/mail-settings")
async def save(body: dict = Body(default_factory=dict), user: User = Depends(require_perm("identity.manage")),
               session: AsyncSession = Depends(get_session)):
    try:
        result = await mail.save_settings(session, body)
        await session.commit()
    except mail.MailConfigurationError as exc:
        await session.rollback()
        raise failure(exc) from None
    await audit.log(session, user, "mail.settings.update", "setting", mail.SETTING_KEY,
                    "修改账号邮件服务", {"enabled": result["enabled"], "security": result["security"]})
    return result


@router.post("/mail-settings/test")
async def test_delivery(body: dict = Body(default_factory=dict),
                        user: User = Depends(require_perm("identity.manage")),
                        session: AsyncSession = Depends(get_session)):
    if set(body) != {"recipient"}:
        raise HTTPException(status_code=422, detail="只支持指定收件地址发送固定测试邮件")
    # Persist before returning; only the normal SMTP worker sends this mail.
    # A queued acknowledgement is never presented as an inbox delivery receipt.
    recent = await session.scalar(select(MailOutbox.id).where(MailOutbox.purpose == "test",
        MailOutbox.created_at > mail.utcnow() - timedelta(seconds=30)).limit(1))
    if recent:
        raise HTTPException(status_code=429, detail="测试邮件发送较频繁，请 30 秒后重试")
    try:
        row = await mail.enqueue_mail(session, recipient=body["recipient"], purpose="test", code="",
                                      expires_at=mail.utcnow() + timedelta(minutes=5))
        await session.commit()
        await session.refresh(row)
    except mail.MailConfigurationError as exc:
        await session.rollback()
        raise failure(exc) from None
    await audit.log(session, user, "mail.test.enqueue", "mail", row.id,
                    "申请发送固定测试邮件", {"recipient": row.recipient_mask})
    return {"ok": True, "queued": True, "delivery": mail.delivery_api(row)}


@router.get("/mail-deliveries")
async def deliveries(limit: int = Query(default=20, ge=1, le=100),
                     _user: User = Depends(require_perm("identity.manage")),
                     session: AsyncSession = Depends(get_session)):
    rows = (await session.scalars(select(MailOutbox).order_by(MailOutbox.created_at.desc()).limit(limit))).all()
    return {"items": [mail.delivery_api(row) for row in rows]}
