"""Localized presentation metadata, separate from immutable installer signatures."""
from datetime import datetime
from sqlalchemy import DateTime, Integer, JSON, String, func
from sqlalchemy.orm import Mapped, mapped_column
from .db import Base


class ClientReleaseNote(Base):
    __tablename__ = "client_release_note"
    version: Mapped[str] = mapped_column(String(32), primary_key=True)
    channel: Mapped[str] = mapped_column(String(16), primary_key=True)
    locales: Mapped[dict] = mapped_column(JSON, default=dict)
    revision: Mapped[int] = mapped_column(Integer, default=1)
    status: Mapped[str] = mapped_column(String(16), default="draft")
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
