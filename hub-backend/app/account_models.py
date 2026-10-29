"""Email ownership challenges and versioned account consent receipts."""
from datetime import datetime

from sqlalchemy import DateTime, Index, Integer, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base
from .models import _uuid


class EmailChallenge(Base):
    __tablename__ = "account_email_challenge"
    __table_args__ = (Index("ix_account_email_challenge_expiry", "expires_at"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    email_normalized: Mapped[str] = mapped_column(String(254))
    purpose: Mapped[str] = mapped_column(String(32))
    device_id: Mapped[str] = mapped_column(String(64))
    user_id: Mapped[str | None] = mapped_column(String(36), default=None)
    code_hash: Mapped[str] = mapped_column(String(64))
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class EmailRateLimit(Base):
    """Shared atomic counters, keyed by a purpose-bound digest, never raw email/IP."""
    __tablename__ = "account_email_rate_limit"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    count: Mapped[int] = mapped_column(Integer, default=0)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)


class UserConsent(Base):
    __tablename__ = "account_user_consent"
    __table_args__ = (UniqueConstraint("user_id", "document", "version", name="uq_account_consent_version"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(String(36), index=True)
    document: Mapped[str] = mapped_column(String(32))
    version: Mapped[str] = mapped_column(String(64))
    device_id: Mapped[str] = mapped_column(String(64), default="")
    accepted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
