"""Versioned, bounded summaries shared by SoduWork memory surfaces.

``MemoryRecord`` is intentionally separate from the legacy imported
``SessionMemory`` table. The latter stores owner-private Codex evidence;
this table stores the small summaries that may be reused at a defined scope.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Index, JSON, String, Text, UniqueConstraint, func, text
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


def _uuid() -> str:
    return str(uuid.uuid4())


class MemoryRecord(Base):
    __tablename__ = "memory_record"
    __table_args__ = (
        UniqueConstraint(
            "scope", "owner_user_id", "org_id", "memory_key",
            name="uq_memory_record_scope_owner_org_key",
        ),
        Index(
            "uq_memory_record_org_current", "org_id", unique=True,
            sqlite_where=text("scope = 'org' AND owner_user_id = '' AND archived = false"),
            postgresql_where=text("scope = 'org' AND owner_user_id = '' AND archived = false"),
        ),
        Index("ix_memory_record_owner_scope_updated", "owner_user_id", "scope", "updated_at"),
        Index("ix_memory_record_org_scope_updated", "org_id", "scope", "updated_at"),
        Index("ix_memory_record_workspace", "owner_user_id", "workspace_key", "updated_at"),
        Index("ix_memory_record_project", "owner_user_id", "project_key", "updated_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    # session | workspace | project | org. Keys are validated by the service.
    scope: Mapped[str] = mapped_column(String(16), nullable=False, index=True)
    owner_user_id: Mapped[str] = mapped_column(String(36), nullable=False, default="")
    org_id: Mapped[str] = mapped_column(String(36), nullable=False, default="")
    memory_key: Mapped[str] = mapped_column(String(240), nullable=False)
    workspace_key: Mapped[str] = mapped_column(String(240), nullable=False, default="")
    project_key: Mapped[str] = mapped_column(String(240), nullable=False, default="")
    session_key: Mapped[str] = mapped_column(String(240), nullable=False, default="")
    title: Mapped[str] = mapped_column(String(240), nullable=False, default="")
    summary: Mapped[str] = mapped_column(Text, nullable=False, default="")
    fields: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    source_meta: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    archived: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    revision: Mapped[int] = mapped_column(nullable=False, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
