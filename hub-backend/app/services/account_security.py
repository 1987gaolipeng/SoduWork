"""Recent, single-use identity proofs for sensitive account operations."""
import asyncio
import base64
import hashlib
import io
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException
from PIL import Image, ImageOps, UnidentifiedImageError
from sqlalchemy import case, exists, select, update

from ..account_privacy_models import AccountActionGrant
from ..auth import verify_password
from ..models import Client, User
from . import email_auth

PURPOSES = {"change_email", "change_password", "export", "delete_account", "devices"}


def error(status, code, message):
    return HTTPException(status, detail={"code": code, "message": message})


async def owner(session, client):
    user = await session.get(User, str(client.user_ref or ""))
    if user is None or not user.is_active or user.account_deleted_at:
        raise error(401, "ACCOUNT_UNAVAILABLE", "当前账号不可用")
    return user


async def grant(session, user, client, body):
    purpose = str(body.get("purpose") or "")
    if purpose not in PURPOSES:
        raise error(422, "VERIFICATION_PURPOSE_INVALID", "验证用途无效")
    password = body.get("password")
    if password:
        if len(password) > 128:
            raise error(422, "PASSWORD_INVALID", "密码长度无效")
        await email_auth.password_budget(session, user.id, client.id)
        if not await asyncio.to_thread(verify_password, password, user.password_hash):
            raise error(403, "VERIFICATION_FAILED", "身份验证失败，请检查后重试")
    else:
        if not user.email_verified_at or not user.email_normalized:
            raise error(422, "EMAIL_NOT_VERIFIED", "请使用当前密码验证身份，或先绑定邮箱")
        await email_auth.consume_challenge(session, challenge_id=body.get("challengeId", ""),
            email=user.email_normalized, purpose="reauthentication", device_id=client.id,
            code=body.get("code", ""), user_id=user.id)
    token = secrets.token_urlsafe(32)
    session.add(AccountActionGrant(user_id=user.id, client_id=client.id, purpose=purpose,
        token_hash=hashlib.sha256(token.encode()).hexdigest(), user_auth_version=user.auth_version or 1,
        client_auth_version=client.auth_version or 1,
        expires_at=datetime.now(timezone.utc) + timedelta(minutes=5)))
    await session.commit()
    return {"verificationToken": token, "expiresIn": 300}


async def consume_grant(session, user, client, token, purpose):
    if not isinstance(token, str) or not 32 <= len(token) <= 128:
        raise error(403, "VERIFICATION_REQUIRED", "请先验证身份")
    now = datetime.now(timezone.utc)
    result = await session.execute(update(AccountActionGrant).where(
        AccountActionGrant.token_hash == hashlib.sha256(token.encode()).hexdigest(),
        AccountActionGrant.user_id == user.id, AccountActionGrant.client_id == client.id,
        AccountActionGrant.purpose == purpose, AccountActionGrant.consumed_at.is_(None),
        AccountActionGrant.expires_at > now,
        exists(select(User.id).where(User.id == user.id, User.is_active.is_(True),
            User.account_deleted_at.is_(None), User.auth_version == (user.auth_version or 1))),
        exists(select(Client.id).where(Client.id == client.id, Client.user_ref == user.id,
            Client.auth_state == "active", Client.auth_version == (client.auth_version or 1))),
        AccountActionGrant.user_auth_version == (user.auth_version or 1),
        AccountActionGrant.client_auth_version == (client.auth_version or 1),
    ).values(consumed_at=now))
    if result.rowcount != 1:
        raise error(403, "VERIFICATION_EXPIRED", "身份验证已过期或已使用，请重新验证")


async def revoke_devices(session, user, *, device_id=None, erase_private=False):
    query = select(Client).where(Client.user_ref == user.id)
    if device_id:
        query = query.where(Client.id == device_id)
    rows = list((await session.scalars(query)).all())
    revoked = []
    for device in rows:
        values = dict(user_ref=None,
            auth_state=case((Client.auth_state == "revoked", "revoked"), else_="pending"),
            auth_version=Client.auth_version+1, activated_at=None,
            revoked_at=case((Client.auth_state == "revoked", Client.revoked_at), else_=None))
        if erase_private:
            values.update(config={}, model_keys={}, models=[], agent_models={}, git_creds={},
                          mcp_servers=[], mcp_enabled=[], skills=[], work_root="")
        changed = await session.execute(update(Client).where(
            Client.id == device.id, Client.user_ref == user.id
        ).values(**values).execution_options(synchronize_session=False))
        if changed.rowcount == 1:
            revoked.append(device.id)
    return revoked


def sanitize_avatar(value):
    if value == "":
        return ""
    if not isinstance(value, str) or len(value) > 750_000:
        raise error(422, "AVATAR_INVALID", "请选择小于 500KB 的 PNG、JPEG 或 WebP 头像")
    header, sep, payload = value.partition(",")
    if not sep or header not in {"data:image/png;base64", "data:image/jpeg;base64", "data:image/webp;base64"}:
        raise error(422, "AVATAR_INVALID", "头像仅支持 PNG、JPEG 或 WebP 图片")
    try:
        raw = base64.b64decode(payload, validate=True)
        if len(raw) > 500_000:
            raise ValueError("size")
        with Image.open(io.BytesIO(raw)) as source:
            if source.width * source.height > 4_000_000 or source.width < 1 or source.height < 1:
                raise ValueError("dimensions")
            if source.format not in {"PNG", "JPEG", "WEBP"} or getattr(source, "n_frames", 1) != 1:
                raise ValueError("format")
            clean = ImageOps.fit(ImageOps.exif_transpose(source).convert("RGBA"), (256, 256))
            clean.info.clear()
            target = io.BytesIO()
            clean.save(target, format="PNG", optimize=True)
            return "data:image/png;base64," + base64.b64encode(target.getvalue()).decode("ascii")
    except (ValueError, OSError, UnidentifiedImageError, Image.DecompressionBombError) as exc:
        raise error(422, "AVATAR_INVALID", "图片无法读取，请选择有效的静态图片") from exc
