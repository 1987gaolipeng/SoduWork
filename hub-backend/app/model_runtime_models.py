"""Relational state for the Hub model admission runtime.

The policy remains an AppSetting because it is administrator configuration. Live
leases and rolling metrics are high-churn operational state and must not share
that JSON row: a lease update should touch one indexed row, not rewrite every
request currently in flight.
"""
from __future__ import annotations

from sqlalchemy import BigInteger, Float, Index, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


class ModelRuntimeLease(Base):
    __tablename__ = "model_runtime_lease"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    state: Mapped[str] = mapped_column(String(16), nullable=False, default="queued")
    created_at: Mapped[float] = mapped_column(Float, nullable=False)
    expires_at: Mapped[float] = mapped_column(Float, nullable=False)
    provider: Mapped[str] = mapped_column(String(80), nullable=False, default="")
    model: Mapped[str] = mapped_column(String(160), nullable=False, default="")
    global_scope: Mapped[str] = mapped_column(String(96), nullable=False, default="all")
    provider_scope: Mapped[str] = mapped_column(String(96), nullable=False, default="")
    key_scope: Mapped[str] = mapped_column(String(96), nullable=False, default="")
    model_scope: Mapped[str] = mapped_column(String(96), nullable=False, default="")
    user_scope: Mapped[str] = mapped_column(String(96), nullable=False, default="")
    global_limit: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    provider_limit: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    key_limit: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    model_limit: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    user_limit: Mapped[int] = mapped_column(Integer, nullable=False, default=1)

    __table_args__ = (
        Index("ix_model_runtime_lease_state_created", "state", "created_at", "id"),
        Index("ix_model_runtime_lease_state_expires", "state", "expires_at"),
        Index("ix_model_runtime_lease_state_provider", "state", "provider_scope"),
        Index("ix_model_runtime_lease_state_key", "state", "key_scope"),
        Index("ix_model_runtime_lease_state_model", "state", "model_scope"),
        Index("ix_model_runtime_lease_state_user", "state", "user_scope"),
    )


class ModelRuntimeMetric(Base):
    __tablename__ = "model_runtime_metric"

    bucket: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    name: Mapped[str] = mapped_column(String(32), primary_key=True)
    value: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    __table_args__ = (
        Index("ix_model_runtime_metric_name_bucket", "name", "bucket"),
    )
