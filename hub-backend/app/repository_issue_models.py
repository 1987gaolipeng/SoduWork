"""Repository-scoped issue imports, member grants and first-start outbox."""
from datetime import datetime
import uuid

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, String, UniqueConstraint, false, func, true
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base
from .automation_models import ScmRepository
from .models import Task


class RepositoryIssueSync(Base):
    __tablename__ = "repository_issue_sync"
    catalog_id: Mapped[str] = mapped_column(String(36), ForeignKey(ScmRepository.id), primary_key=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false())
    enabled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    started_label: Mapped[str] = mapped_column(String(120), default="处理中", server_default="处理中")
    created_by: Mapped[str | None] = mapped_column(String(36), default=None)
    cursor_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    next_poll_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None, index=True)
    last_polled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    last_success_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    last_error: Mapped[str] = mapped_column(String(512), default="", server_default="")
    imported_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    last_created_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    skipped_confidential: Mapped[int] = mapped_column(Integer, default=0, server_default="0")


class RepositoryIssueMember(Base):
    __tablename__ = "repository_issue_member"
    catalog_id: Mapped[str] = mapped_column(String(36), ForeignKey(ScmRepository.id), primary_key=True)
    external_user_id: Mapped[str] = mapped_column(String(80), primary_key=True)
    username: Mapped[str] = mapped_column(String(200), default="", server_default="")
    display_name: Mapped[str] = mapped_column(String(200), default="", server_default="")
    user_id: Mapped[str | None] = mapped_column(String(36), default=None, index=True)
    mapping_source: Mapped[str] = mapped_column(String(24), default="", server_default="")
    active: Mapped[bool] = mapped_column(Boolean, default=True, server_default=true())
    synced_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class RepositoryIssueLink(Base):
    __tablename__ = "repository_issue_link"
    __table_args__ = (
        UniqueConstraint("catalog_id", "issue_iid", name="uq_repository_issue_identity"),
        UniqueConstraint("task_id", name="uq_repository_issue_task"),
        Index("ix_repository_issue_writeback", "writeback_state", "next_retry_at"),
    )
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    catalog_id: Mapped[str] = mapped_column(String(36), ForeignKey(ScmRepository.id), index=True)
    issue_id: Mapped[str] = mapped_column(String(80))
    issue_iid: Mapped[int] = mapped_column(Integer)
    task_id: Mapped[str | None] = mapped_column(String(36), ForeignKey(Task.id, ondelete="SET NULL"), index=True)
    issue_url: Mapped[str] = mapped_column(String(700), default="", server_default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    writeback_state: Mapped[str] = mapped_column(String(16), default="waiting", server_default="waiting")
    writeback_label: Mapped[str] = mapped_column(String(120), default="", server_default="")
    writeback_attempts: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    next_retry_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    last_error: Mapped[str] = mapped_column(String(512), default="", server_default="")
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
