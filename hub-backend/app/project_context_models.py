"""Versioned project context and durable task learning.

These tables deliberately live beside, rather than inside, ``Task`` and ``Repo``:
the project context is an immutable execution input, while a task remains the
business request and a repository remains routing/configuration.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import JSON, DateTime, Index, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


def _uuid() -> str:
    return str(uuid.uuid4())


class ProjectContextSnapshot(Base):
    """Immutable context observed by an Agent at one repository revision."""

    __tablename__ = "project_context_snapshot"
    __table_args__ = (
        UniqueConstraint("fingerprint", name="uq_project_context_fingerprint"),
        Index("ix_project_context_scope", "org_id", "project_id", "repo_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    org_id: Mapped[str] = mapped_column(String(36), default="", index=True)
    project_id: Mapped[str] = mapped_column(String(36), default="", index=True)
    repo_id: Mapped[str] = mapped_column(String(36), default="", index=True)
    branch: Mapped[str] = mapped_column(String(180), default="", index=True)
    baseline_commit: Mapped[str] = mapped_column(String(64), default="", index=True)
    fingerprint: Mapped[str] = mapped_column(String(64), index=True)
    state: Mapped[str] = mapped_column(String(20), default="ready", index=True)
    summary: Mapped[str] = mapped_column(Text, default="")
    sources: Mapped[list] = mapped_column(JSON, default=list)
    conventions: Mapped[list] = mapped_column(JSON, default=list)
    commands: Mapped[list] = mapped_column(JSON, default=list)
    error: Mapped[str] = mapped_column(String(500), default="")
    captured_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class TaskContextEnvelope(Base):
    """The exact context version carried by the latest execution of a task."""

    __tablename__ = "task_context_envelope"

    task_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    snapshot_id: Mapped[str] = mapped_column(String(36), default="", index=True)
    project_id: Mapped[str] = mapped_column(String(36), default="", index=True)
    repo_id: Mapped[str] = mapped_column(String(36), default="", index=True)
    execution_ref: Mapped[str] = mapped_column(String(180), default="", index=True)
    branch: Mapped[str] = mapped_column(String(180), default="")
    baseline_commit: Mapped[str] = mapped_column(String(64), default="")
    fingerprint: Mapped[str] = mapped_column(String(64), default="", index=True)
    state: Mapped[str] = mapped_column(String(20), default="pending", index=True)
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class ProjectMemoryCapsule(Base):
    """A compact, reviewable learning produced by one completed execution."""

    __tablename__ = "project_memory_capsule"
    __table_args__ = (
        UniqueConstraint("task_id", "execution_ref",
                         name="uq_project_memory_task_execution"),
        Index("ix_project_memory_scope_state", "project_id", "repo_id", "state"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    org_id: Mapped[str] = mapped_column(String(36), default="", index=True)
    project_id: Mapped[str] = mapped_column(String(36), default="", index=True)
    repo_id: Mapped[str] = mapped_column(String(36), default="", index=True)
    task_id: Mapped[str] = mapped_column(String(36), index=True)
    execution_ref: Mapped[str] = mapped_column(String(180), default="", index=True)
    branch: Mapped[str] = mapped_column(String(180), default="")
    commit_sha: Mapped[str] = mapped_column(String(64), default="", index=True)
    title: Mapped[str] = mapped_column(String(240), default="")
    summary: Mapped[str] = mapped_column(Text, default="")
    decisions: Mapped[list] = mapped_column(JSON, default=list)
    files: Mapped[list] = mapped_column(JSON, default=list)
    checks: Mapped[list] = mapped_column(JSON, default=list)
    risks: Mapped[list] = mapped_column(JSON, default=list)
    evidence: Mapped[list] = mapped_column(JSON, default=list)
    state: Mapped[str] = mapped_column(String(20), default="candidate", index=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now())
    reviewed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), default=None)
    reviewed_by: Mapped[str] = mapped_column(String(36), default="")
