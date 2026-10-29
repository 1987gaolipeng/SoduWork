"""Owner-private imported session evidence and user-confirmed summaries.

Imports never automatically become organization/project knowledge. Stable
source identity + content digest allow idempotent retries without overwriting
a user's previously reviewed summary.
"""
from datetime import datetime
import uuid

from sqlalchemy import Boolean, JSON, DateTime, Index, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column
from .db import Base


class SessionMemory(Base):
    __tablename__ = "session_memory"
    __table_args__ = (
        UniqueConstraint("owner_user_id", "source", "source_hash", name="uq_session_memory_import"),
        Index("ix_session_memory_owner_updated", "owner_user_id", "updated_at"),
        Index("ix_session_memory_owner_scope_archived", "owner_user_id", "scope", "archived"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    owner_user_id: Mapped[str] = mapped_column(String(36))
    org_id: Mapped[str] = mapped_column(String(36), default="")
    project_id: Mapped[str] = mapped_column(String(36), default="")
    repo_id: Mapped[str] = mapped_column(String(36), default="")
    task_id: Mapped[str] = mapped_column(String(36), default="")
    source: Mapped[str] = mapped_column(String(24), default="codex")
    source_session_id: Mapped[str] = mapped_column(String(160), default="")
    source_hash: Mapped[str] = mapped_column(String(64))
    # Phase 2 records the intended reuse boundary while keeping imported
    # evidence private until a future sharing policy explicitly grants access.
    scope: Mapped[str] = mapped_column(String(16), default="private")
    archived: Mapped[bool] = mapped_column(Boolean, default=False)
    source_meta: Mapped[dict] = mapped_column(JSON, default=dict)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    title: Mapped[str] = mapped_column(String(240))
    fields: Mapped[dict] = mapped_column(JSON, default=dict)
    events: Mapped[list] = mapped_column(JSON, default=list)
    warnings: Mapped[list] = mapped_column(JSON, default=list)
    revision: Mapped[int] = mapped_column(default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
