"""Independent data model for the personal material library.

Library records deliberately do not reference tasks, projects, repositories or
attachments.  The only scope boundary is ``owner_key`` which is resolved from
the authenticated client by the library API.
"""
from datetime import datetime
import uuid

from sqlalchemy import BigInteger, Boolean, DateTime, Index, JSON, String, func
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


def _uuid() -> str:
    return str(uuid.uuid4())


class LibraryFolder(Base):
    __tablename__ = "library_folder"
    __table_args__ = (
        Index("ix_library_folder_owner_parent", "owner_key", "parent_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    owner_key: Mapped[str] = mapped_column(String(128), index=True)
    parent_id: Mapped[str | None] = mapped_column(String(36), default=None, index=True)
    name: Mapped[str] = mapped_column(String(160))
    backend: Mapped[str] = mapped_column(String(16), default="local", index=True)
    favorite: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


# NULL parents must also be unique, while separate storage roots may reuse names.
Index("uq_library_folder_scope_name", LibraryFolder.owner_key, LibraryFolder.backend,
      func.coalesce(LibraryFolder.parent_id, ""), LibraryFolder.name, unique=True)


class LibraryItem(Base):
    __tablename__ = "library_item"
    __table_args__ = (
        Index("ix_library_item_owner_updated", "owner_key", "updated_at"),
        Index("ix_library_item_owner_folder", "owner_key", "folder_id"),
        Index("ix_library_item_owner_kind", "owner_key", "kind"),
        Index("ix_library_item_owner_deleted", "owner_key", "deleted_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    owner_key: Mapped[str] = mapped_column(String(128), index=True)
    folder_id: Mapped[str | None] = mapped_column(String(36), default=None, index=True)
    kind: Mapped[str] = mapped_column(String(24), default="document")
    title: Mapped[str] = mapped_column(String(240), default="未命名资料")
    filename: Mapped[str] = mapped_column(String(260), default="")
    content_type: Mapped[str] = mapped_column(String(160), default="application/octet-stream")
    size: Mapped[int] = mapped_column(BigInteger, default=0)
    storage_key: Mapped[str] = mapped_column(String(600), default="")
    backend: Mapped[str] = mapped_column(String(16), default="local")
    favorite: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    extra: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
    last_opened_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    # Recycle-bin state is metadata only.  The MinIO object stays available
    # until the user explicitly purges it, so restore never needs to upload a
    # second copy and delete remains reversible.
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None, index=True)
