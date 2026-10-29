"""Durable IM transport state; Task and ExecutionSession remain execution authorities."""
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Index, Integer, JSON, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


class IMConnection(Base):
    __tablename__ = "im_connection"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    owner_user_id: Mapped[str] = mapped_column(String(36), index=True)
    owner_client_id: Mapped[str] = mapped_column(String(64))
    user_version: Mapped[int] = mapped_column(Integer)
    client_version: Mapped[int] = mapped_column(Integer)
    provider: Mapped[str] = mapped_column(String(24))
    name: Mapped[str] = mapped_column(String(100))
    enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    credentials: Mapped[str] = mapped_column(Text)
    config: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class IMPairing(Base):
    __tablename__ = "im_pairing"
    code_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    connection_id: Mapped[str] = mapped_column(String(36), index=True)
    task_id: Mapped[str] = mapped_column(String(36))
    runner_id: Mapped[str] = mapped_column(String(80))
    options: Mapped[dict] = mapped_column(JSON, default=dict)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class IMWebhookReceipt(Base):
    """Bind timestamp-only platform signatures to their first verified request body."""
    __tablename__ = "im_webhook_receipt"
    __table_args__ = (Index("ix_im_webhook_receipt_expiry", "connection_id", "created_at"),)
    connection_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    verification_key: Mapped[str] = mapped_column(String(64), primary_key=True)
    content_hash: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class IMBinding(Base):
    __tablename__ = "im_binding"
    __table_args__ = (UniqueConstraint("connection_id", "identity_key", name="uq_im_binding_identity"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    connection_id: Mapped[str] = mapped_column(String(36), index=True)
    identity_key: Mapped[str] = mapped_column(String(64))
    external_identity: Mapped[dict] = mapped_column(JSON)
    task_id: Mapped[str] = mapped_column(String(36), index=True)
    runner_id: Mapped[str] = mapped_column(String(80))
    options: Mapped[dict] = mapped_column(JSON, default=dict)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class IMRoute(Base):
    """A task-wide transport gate serializes messages even across different IM bindings."""
    __tablename__ = "im_route"
    task_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    active_inbox_id: Mapped[str] = mapped_column(String(36), default="")
    lease_token: Mapped[str] = mapped_column(String(36), default="")
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class IMInbox(Base):
    __tablename__ = "im_inbox"
    __table_args__ = (UniqueConstraint("connection_id", "event_id", name="uq_im_inbox_event"),
                     Index("ix_im_inbox_due", "status", "available_at"),
                     Index("ix_im_inbox_task_order", "task_id", "created_at", "id"))
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    connection_id: Mapped[str] = mapped_column(String(36))
    event_id: Mapped[str] = mapped_column(String(180))
    content_hash: Mapped[str] = mapped_column(String(64))
    binding_id: Mapped[str] = mapped_column(String(36), default="")
    task_id: Mapped[str] = mapped_column(String(36), default="")
    text: Mapped[str] = mapped_column(Text, default="")
    reply_context: Mapped[dict] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String(24), default="queued")
    ref: Mapped[str] = mapped_column(String(180), default="")
    admission_key: Mapped[str] = mapped_column(String(160), default="")
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    diagnosed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    base_seq: Mapped[int] = mapped_column(Integer, default=0)
    base_round: Mapped[int] = mapped_column(Integer, default=0)
    detail: Mapped[str] = mapped_column(String(160), default="")
    available_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class IMOutbox(Base):
    __tablename__ = "im_outbox"
    __table_args__ = (UniqueConstraint("inbox_id", "kind", "part", name="uq_im_outbox_part"),
                     Index("ix_im_outbox_due", "status", "available_at"),
                     Index("ix_im_outbox_binding_order", "binding_id", "status", "created_at", "part", "id"))
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    inbox_id: Mapped[str] = mapped_column(String(36))
    connection_id: Mapped[str] = mapped_column(String(36))
    binding_id: Mapped[str] = mapped_column(String(36))
    kind: Mapped[str] = mapped_column(String(24))
    part: Mapped[int] = mapped_column(Integer, default=0)
    text: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(24), default="queued")
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    external_message_id: Mapped[str] = mapped_column(String(180), default="")
    detail: Mapped[str] = mapped_column(String(160), default="")
    available_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    lease_token: Mapped[str] = mapped_column(String(36), default="")
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
