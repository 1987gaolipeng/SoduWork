"""Durable delivery work, committed atomically with the authoritative task."""
from datetime import datetime, timezone
import uuid

from sqlalchemy import DateTime, Index, Integer, JSON, String
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


class TaskNotificationOutbox(Base):
    __tablename__ = "task_notification_outbox"
    __table_args__ = (
        Index("ix_task_notification_due", "available_at", "lease_until"),
        Index("ix_task_notification_order", "task_id", "created_at", "id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    # No FK: a deletion notification must survive the deleted aggregate.
    task_id: Mapped[str] = mapped_column(String(36))
    event_type: Mapped[str] = mapped_column(String(32))
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    available_at: Mapped[datetime] = mapped_column(DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc))
    lease_token: Mapped[str | None] = mapped_column(String(36), nullable=True)
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc))
