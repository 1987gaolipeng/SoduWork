"""Durable account mail, with recipient and verification payload encrypted at rest."""
from datetime import datetime
from uuid import uuid4

from sqlalchemy import DateTime, Index, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


class MailOutbox(Base):
    __tablename__ = "account_mail_outbox"
    __table_args__ = (Index("ix_account_mail_outbox_due", "state", "next_attempt_at"),
                      Index("ix_account_mail_outbox_created", "created_at"))

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    challenge_id: Mapped[str | None] = mapped_column(String(36), unique=True, nullable=True)
    purpose: Mapped[str] = mapped_column(String(32))
    recipient_mask: Mapped[str] = mapped_column(String(254))
    payload_encrypted: Mapped[str] = mapped_column(Text, default="")
    state: Mapped[str] = mapped_column(String(16), default="queued")
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    next_attempt_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    lease_id: Mapped[str] = mapped_column(String(36), default="")
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    error_code: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
