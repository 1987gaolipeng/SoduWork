"""Durable transfer fences. Execution remains owned by Task/ExecutionSession."""
from datetime import datetime

from sqlalchemy import DateTime, Index, Integer, JSON, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


class ConversationHandoff(Base):
    __tablename__ = "conversation_handoff"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    owner_client_id: Mapped[str] = mapped_column(String(64), index=True)
    owner_user_id: Mapped[str] = mapped_column(String(36))
    transfer_id: Mapped[str] = mapped_column(String(80))
    task_id: Mapped[str] = mapped_column(String(36), unique=True)
    phase: Mapped[str] = mapped_column(String(16), default="prepared")
    sha256: Mapped[str] = mapped_column(String(64), default="")
    request_hash: Mapped[str] = mapped_column(String(64), default="")
    storage_key: Mapped[str] = mapped_column(String(400), default="")
    backend: Mapped[str] = mapped_column(String(16), default="")
    options: Mapped[dict] = mapped_column(JSON, default=dict)
    source: Mapped[dict] = mapped_column(JSON, default=dict)
    receipt: Mapped[dict] = mapped_column(JSON, default=dict)
    error: Mapped[str] = mapped_column(Text, default="")
    commit_started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Preparation is not authorization. Legacy drafts deliberately remain NULL.
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    retry_after: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    recovery_attempts: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    __table_args__ = (UniqueConstraint("owner_client_id", "transfer_id"),
                      Index("ix_handoff_owner_id", "owner_user_id", "id"))


class ConversationMessageReceipt(Base):
    """Do not replay an unacknowledged external side effect after Hub restart."""
    __tablename__ = "conversation_message_receipt"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    task_id: Mapped[str] = mapped_column(String(36), index=True)
    owner_client_id: Mapped[str] = mapped_column(String(64))
    message_id: Mapped[str] = mapped_column(String(80))
    content_hash: Mapped[str] = mapped_column(String(64))
    phase: Mapped[str] = mapped_column(String(16), default="sending")
    receipt: Mapped[dict] = mapped_column(JSON, default=dict)
    # Only new authorized durable sends have a payload; legacy uncertain sends
    # remain fenced. Renewable credentials are never stored in this envelope.
    payload: Mapped[dict | None] = mapped_column(JSON, nullable=True, default=None)
    retry_after: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    recovery_attempts: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

