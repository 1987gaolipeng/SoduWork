"""Durable account-owned conversation projections.

The source device remains the only device allowed to append to a conversation.
Other devices receive a read projection through the Hub and can never turn
that read access into execution or write access.
"""
import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


def _uuid() -> str:
    return str(uuid.uuid4())


class AccountConversationCursor(Base):
    """Per-account monotonic directory revision allocator."""

    __tablename__ = "account_conversation_cursor"

    owner_user_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    revision: Mapped[int] = mapped_column(Integer, default=0, server_default="0")


class AccountConversation(Base):
    """The Hub's current metadata projection for one source session."""

    __tablename__ = "account_conversation"
    __table_args__ = (
        UniqueConstraint(
            "owner_user_id", "source_client_id", "source_session_id",
            name="uq_account_conversation_source",
        ),
        Index("ix_account_conversation_owner_revision", "owner_user_id", "revision", "id"),
        Index("ix_account_conversation_owner_updated", "owner_user_id", "updated_at"),
    )

    id: Mapped[str] = mapped_column(String(180), primary_key=True, default=_uuid)
    owner_user_id: Mapped[str] = mapped_column(String(36), index=True)
    source_client_id: Mapped[str] = mapped_column(String(64), index=True)
    source_session_id: Mapped[str] = mapped_column(String(180))
    source_device_name: Mapped[str] = mapped_column(String(120), default="")
    source_epoch: Mapped[str] = mapped_column(String(180), default="")
    source_revision: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    source_digest: Mapped[str] = mapped_column(String(64), default="")
    title: Mapped[str] = mapped_column(String(200), default="")
    state: Mapped[str] = mapped_column(String(24), default="idle")
    archived: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0")
    deleted: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0")
    revision: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc), server_default=func.now(),
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), server_default=func.now(),
    )


class AccountConversationMessage(Base):
    """Append/update projection rows with per-conversation cursors."""

    __tablename__ = "account_conversation_message"
    __table_args__ = (
        Index("ix_account_conversation_message_conversation_revision", "conversation_id", "revision"),
        Index("ix_account_conversation_message_conversation_position", "conversation_id", "position"),
    )

    id: Mapped[str] = mapped_column(String(240), primary_key=True)
    conversation_id: Mapped[str] = mapped_column(
        String(180), ForeignKey("account_conversation.id", ondelete="CASCADE"), index=True,
    )
    position: Mapped[int] = mapped_column(Integer)
    role: Mapped[str] = mapped_column(String(16))
    text: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), server_default=func.now(),
    )
    done: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0")
    deleted: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0")
    revision: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
