"""SMTP account mail. No Agent, model call, plaintext secret, or in-memory-only queue."""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import re
import smtplib
import ssl
import time
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from email.utils import formataddr, format_datetime
from uuid import uuid4

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from sqlalchemy import and_, delete, or_, select, update

from ..config import get_settings
from ..mail_models import MailOutbox
from ..models import AppSetting

SETTING_KEY = "account_mail_settings_v1"
DEFAULTS = {"enabled": False, "host": "smtp.126.com", "port": 465, "security": "ssl",
            "username": "", "senderAddress": "", "senderName": "SoduWork"}
PURPOSES = {"register": "注册账号", "login": "登录账号", "reset_password": "重设密码",
            "bind_email": "绑定邮箱", "change_email": "更换邮箱", "delete_account": "注销账号",
            "set_password": "设置密码", "reauthentication": "验证账号身份", "test": "邮件服务测试"}
log = logging.getLogger(__name__)
LEASE_SECONDS = 120
MAX_ATTEMPTS = 3


class MailConfigurationError(ValueError):
    pass


class MailDeliveryError(Exception):
    def __init__(self, code, *, retryable=False, uncertain=False):
        super().__init__(code)
        self.code, self.retryable, self.uncertain = code, retryable, uncertain


def utcnow():
    return datetime.now(timezone.utc)


def aware(value):
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value


def cipher():
    cfg = get_settings()
    # Domain-separated derived key is stable across Hub replicas. An optional
    # MAIL_ENCRYPTION_KEY decouples mail storage from AUTH_SECRET rotation.
    key = str(getattr(cfg, "mail_encryption_key", "") or cfg.auth_secret or "")
    if len(key) < 32:
        raise MailConfigurationError("邮件加密密钥尚未配置")
    derived = HKDF(algorithm=hashes.SHA256(), length=32, salt=b"soduwork-mail-v1",
                   info=b"account-mail-at-rest").derive(key.encode())
    return Fernet(base64.urlsafe_b64encode(derived))


def seal(value):
    return cipher().encrypt(json.dumps(value, ensure_ascii=False).encode()).decode()


def unseal(value):
    try:
        return json.loads(cipher().decrypt(value.encode()))
    except (InvalidToken, ValueError, TypeError, AttributeError):
        raise MailConfigurationError("邮件加密配置已变化，请重新保存发件授权码") from None


def address(value):
    # Same canonical address as the challenge/identity path, including IDNA.
    from .email_auth import normalize_email
    try:
        return normalize_email(value)
    except ValueError:
        raise MailConfigurationError("请填写有效的邮箱地址")


def mask(value):
    local, domain = address(value).split("@", 1)
    return local[:1] + "***@" + domain


async def _stored(session):
    row = await session.get(AppSetting, SETTING_KEY)
    try:
        value = json.loads(row.value) if row else {}
        if not isinstance(value, dict):
            raise ValueError()
    except (ValueError, TypeError):
        raise MailConfigurationError("邮件配置无效，请重新保存") from None
    return {**DEFAULTS, **value}


def _validate(data, *, require_enabled=True):
    if require_enabled and not data.get("enabled"):
        raise MailConfigurationError("邮件服务尚未启用，请联系管理员")
    host = str(data.get("host") or "").strip().lower()
    if not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?", host):
        raise MailConfigurationError("SMTP 服务器地址无效，请填写域名，不含协议或路径")
    if data.get("security") not in {"ssl", "starttls"}:
        raise MailConfigurationError("SMTP 必须使用 SSL/TLS 或 STARTTLS")
    try:
        port = int(data.get("port"))
    except (ValueError, TypeError):
        port = 0
    if not 1 <= port <= 65535:
        raise MailConfigurationError("SMTP 端口无效")
    username = address(data.get("username"))
    sender = address(data.get("senderAddress") or username)
    name = str(data.get("senderName") or "SoduWork").strip()
    if len(name) > 80 or any(ord(c) < 32 for c in name):
        raise MailConfigurationError("发件人名称无效")
    return {**data, "host": host, "port": port, "username": username,
            "senderAddress": sender, "senderName": name}


async def runtime_config(session):
    data = _validate(await _stored(session))
    if not data.get("passwordEncrypted"):
        raise MailConfigurationError("请管理员配置 SMTP 客户端授权码")
    secret = unseal(data["passwordEncrypted"])
    if not isinstance(secret, str) or not secret:
        raise MailConfigurationError("发件授权码无效，请重新保存")
    return {**data, "password": secret}


async def mail_ready(session):
    try:
        await runtime_config(session)
        return True
    except MailConfigurationError:
        return False


async def public_settings(session):
    data = await _stored(session)
    return {key: data.get(key, value) for key, value in DEFAULTS.items()} | {
        "passwordConfigured": bool(data.get("passwordEncrypted")),
        "ready": await mail_ready(session),
        "encryptionKeySource": "dedicated" if getattr(get_settings(), "mail_encryption_key", "") else "derived",
    }


async def save_settings(session, patch):
    data = await _stored(session)
    if not isinstance(patch, dict) or set(patch) - {*DEFAULTS, "password"}:
        raise MailConfigurationError("邮件配置包含不支持的字段")
    data.update({k: v for k, v in patch.items() if k in DEFAULTS})
    data["enabled"] = data.get("enabled") is True
    data = _validate(data, require_enabled=False)
    password = patch.get("password", "")
    if not isinstance(password, str) or len(password) > 1024 or any(c in password for c in "\r\n\0"):
        raise MailConfigurationError("客户端授权码无效")
    if password:
        data["passwordEncrypted"] = seal(password)
    if data["enabled"] and not data.get("passwordEncrypted"):
        raise MailConfigurationError("启用邮件前，请填写客户端授权码")
    if data["enabled"]:
        unseal(data["passwordEncrypted"])
    row = await session.get(AppSetting, SETTING_KEY)
    encoded = json.dumps(data, ensure_ascii=False)
    if row is None:
        session.add(AppSetting(key=SETTING_KEY, value=encoded))
    else:
        row.value = encoded
    await session.flush()
    return await public_settings(session)


async def enqueue_mail(session, *, recipient, purpose, code, expires_at, challenge_id=""):
    await runtime_config(session)
    recipient = address(recipient)
    if purpose not in PURPOSES:
        raise MailConfigurationError("不支持的邮件用途")
    if purpose != "test" and not re.fullmatch(r"[0-9]{6}", str(code)):
        raise MailConfigurationError("验证码格式无效")
    if aware(expires_at) <= utcnow():
        raise MailConfigurationError("验证码已过期，请重新获取")
    row = MailOutbox(challenge_id=challenge_id or None, purpose=purpose, recipient_mask=mask(recipient),
                     payload_encrypted=seal({"recipient": recipient, "code": str(code)}),
                     expires_at=expires_at, next_attempt_at=utcnow())
    session.add(row)
    await session.flush()
    return row


def _message(config, row, payload):
    message = EmailMessage()
    message["From"] = formataddr((config["senderName"], config["senderAddress"]))
    message["To"] = address(payload["recipient"])
    message["Date"] = format_datetime(utcnow())
    message["Message-ID"] = "<" + row.id + "@" + config["senderAddress"].rsplit("@", 1)[1] + ">"
    message["Subject"] = "SoduWork · " + PURPOSES[row.purpose]
    if row.purpose == "test":
        message.set_content("这是一封由管理员主动发送的 SoduWork 邮件服务测试邮件。\n如收到此邮件，说明当前 SMTP 投递已到达你的邮箱。\n本邮件不包含验证码，也不会修改账号。")
    else:
        message.set_content("你正在" + PURPOSES[row.purpose] + "。\n\n验证码：" + payload["code"] +
                            "\n\n验证码在申请后 5 分钟内有效，请勿转发。若非本人操作，请忽略本邮件。")
    return message


def send_smtp(config, row, payload):
    """Only accepted SMTP DATA means sent; never include provider replies in logs."""
    connection, data_started = None, False
    try:
        context = ssl.create_default_context()
        if config["security"] == "ssl":
            connection = smtplib.SMTP_SSL(config["host"], config["port"], timeout=10, context=context)
        else:
            connection = smtplib.SMTP(config["host"], config["port"], timeout=10)
            connection.ehlo()
            connection.starttls(context=context)
        connection.ehlo()
        connection.login(config["username"], config["password"])
        # Recheck expiry after slow DNS/TLS/auth, before sending any mail body.
        if aware(row.expires_at) <= utcnow():
            raise MailDeliveryError("MAIL_EXPIRED")
        message = _message(config, row, payload)
        data_started = True
        refused = connection.send_message(message)
        if refused:
            raise MailDeliveryError("SMTP_RECIPIENT_REJECTED")
    except MailDeliveryError:
        raise
    except smtplib.SMTPAuthenticationError:
        raise MailDeliveryError("SMTP_AUTH_FAILED") from None
    except smtplib.SMTPRecipientsRefused as exc:
        # All recipients were rejected at RCPT, before any DATA was accepted.
        # Keep provider replies (which can contain addresses) out of diagnostics.
        temporary = bool(exc.recipients) and all(
            400 <= reply[0] < 500 for reply in exc.recipients.values())
        raise MailDeliveryError("SMTP_RECIPIENT_REJECTED", retryable=temporary) from None
    except ssl.SSLError:
        raise MailDeliveryError("SMTP_TLS_FAILED") from None
    except smtplib.SMTPResponseException as exc:
        raise MailDeliveryError("SMTP_REJECTED", retryable=400 <= exc.smtp_code < 500) from None
    except (smtplib.SMTPException, OSError):
        raise MailDeliveryError("SMTP_RESULT_UNKNOWN" if data_started else "SMTP_CONNECTION_FAILED",
                                retryable=not data_started, uncertain=data_started) from None
    finally:
        if connection is not None:
            # QUIT failure after successful DATA must not turn a sent email into retry.
            try:
                connection.close()
            except OSError:
                pass


def delivery_api(row):
    return {"id": row.id, "purpose": row.purpose, "recipient": row.recipient_mask,
            "state": row.state, "attempts": row.attempts, "errorCode": row.error_code,
            "createdAt": aware(row.created_at).isoformat() if row.created_at else None,
            "sentAt": aware(row.sent_at).isoformat() if row.sent_at else None}


async def process_one(session_factory, *, target_id=None, sender=None):
    """Atomic compare-and-set claims work with SQLite tests and multi-Hub PostgreSQL.

    SMTP has no exactly-once API. A lost post-DATA receipt or expired sending
    lease is terminal unknown, never blindly retried and sent twice.
    """
    now, lease = utcnow(), str(uuid4())
    async with session_factory() as session:
        await session.execute(update(MailOutbox).where(MailOutbox.state == "sending",
            MailOutbox.lease_until < now).values(state="unknown", error_code="SMTP_RESULT_UNKNOWN",
                payload_encrypted="", lease_id="", lease_until=None))
        await session.execute(update(MailOutbox).where(MailOutbox.state.in_(["queued", "retry"]),
            MailOutbox.expires_at <= now).values(state="expired", error_code="MAIL_EXPIRED", payload_encrypted=""))
        query = select(MailOutbox.id).where(MailOutbox.state.in_(["queued", "retry"]),
            MailOutbox.next_attempt_at <= now, MailOutbox.expires_at > now)
        if target_id:
            query = query.where(MailOutbox.id == target_id)
        candidate = await session.scalar(query.order_by(MailOutbox.created_at).limit(1))
        if not candidate:
            await session.commit()
            return False
        claim = await session.execute(update(MailOutbox).where(MailOutbox.id == candidate,
            MailOutbox.state.in_(["queued", "retry"])).values(state="sending", lease_id=lease,
                lease_until=now + timedelta(seconds=LEASE_SECONDS), attempts=MailOutbox.attempts + 1))
        await session.commit()
        if claim.rowcount != 1:
            return False
        row = await session.get(MailOutbox, candidate)
        if row.challenge_id:
            from ..account_models import EmailChallenge
            challenge = await session.get(EmailChallenge, row.challenge_id)
            if challenge is None or challenge.consumed_at is not None or aware(challenge.expires_at) <= utcnow():
                row.state, row.error_code, row.payload_encrypted = "expired", "MAIL_EXPIRED", ""
                row.lease_id, row.lease_until = "", None
                await session.commit()
                return True
        try:
            config = await runtime_config(session)
            payload = unseal(row.payload_encrypted)
        except MailConfigurationError:
            config, payload = None, None
        await session.rollback()  # Do not hold DB transaction while calling SMTP.
        # rollback expires mapped attributes; retain only required immutable fields.
        row = await session.get(MailOutbox, candidate)
        from types import SimpleNamespace
        envelope = SimpleNamespace(id=row.id, purpose=row.purpose, expires_at=row.expires_at)
        attempts = row.attempts
        await session.rollback()
    state, code, delay = "sent", "", 0
    try:
        if config is None:
            raise MailDeliveryError("MAIL_NOT_READY")
        await asyncio.to_thread(sender or send_smtp, config, envelope, payload)
    except MailDeliveryError as exc:
        code = exc.code
        state = "unknown" if exc.uncertain else "expired" if code == "MAIL_EXPIRED" else "failed"
        delay = 15 * attempts
        if exc.retryable and attempts < MAX_ATTEMPTS and utcnow() + timedelta(seconds=delay) < aware(envelope.expires_at):
            state = "retry"
    except Exception:
        # No raw exception/body logging: transport libraries may echo the code or password.
        state, code = "unknown", "MAIL_INTERNAL_ERROR"
    async with session_factory() as session:
        values = dict(state=state, error_code=code, lease_id="", lease_until=None,
                      next_attempt_at=utcnow() + timedelta(seconds=delay))
        if state != "retry":
            values["payload_encrypted"] = ""
        if state == "sent":
            values["sent_at"] = utcnow()
        await session.execute(update(MailOutbox).where(MailOutbox.id == candidate,
            MailOutbox.lease_id == lease, MailOutbox.state == "sending").values(**values))
        await session.commit()
    log.info("account_mail id=%s state=%s code=%s", candidate, state, code or "OK")
    return True


async def cleanup(session_factory):
    """Bounded expiry maintenance; terminal delivery diagnostics last 30 days."""
    from ..account_models import EmailChallenge, EmailRateLimit
    now = utcnow()
    async with session_factory() as session:
        for model, column, before in ((EmailChallenge, EmailChallenge.expires_at, now - timedelta(days=1)),
                                     (EmailRateLimit, EmailRateLimit.expires_at, now - timedelta(days=1)),
                                     (MailOutbox, MailOutbox.created_at, now - timedelta(days=30))):
            key = model.key if model is EmailRateLimit else model.id
            query = select(key).where(column < before).limit(500)
            if model is MailOutbox:
                query = query.where(MailOutbox.state.in_(["sent", "failed", "expired", "unknown"]))
            ids = list((await session.scalars(query)).all())
            if ids:
                await session.execute(delete(model).where(key.in_(ids)))
        await session.commit()


async def _delivery_pending(session_factory) -> bool:
    """Keep an idle queue read-only while preserving expiry and lease recovery."""
    now = utcnow()
    actionable = or_(
        and_(MailOutbox.state.in_(["queued", "retry"]),
             or_(MailOutbox.next_attempt_at <= now, MailOutbox.expires_at <= now)),
        and_(MailOutbox.state == "sending", MailOutbox.lease_until < now),
    )
    async with session_factory() as session:
        return await session.scalar(select(MailOutbox.id).where(actionable).limit(1)) is not None


async def worker_loop():
    from ..db import SessionLocal
    next_cleanup = 0
    while True:
        try:
            if time.monotonic() >= next_cleanup:
                await cleanup(SessionLocal)
                next_cleanup = time.monotonic() + 3600
            worked = await process_one(SessionLocal) if await _delivery_pending(SessionLocal) else False
            if not worked:
                await asyncio.sleep(2)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.warning("account_mail worker code=MAIL_QUEUE_UNAVAILABLE")
            await asyncio.sleep(5)
