"""Canonical plugin identity and race-safe immutable-version inserts."""
from __future__ import annotations

from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am


class PluginVersionConflict(ValueError):
    """The same semantic version was reused for different package content."""


def scope(org_id: str | None) -> str:
    return "organization" if org_id else "platform"


def qualified_key(org_id: str | None, key: str) -> str:
    """Stable public identity; display names remain editable metadata."""
    clean = str(key or "").strip()
    return f"org:{org_id}/{clean}" if org_id else f"soduwork/{clean}"


def public(plugin: am.Plugin) -> dict:
    return {
        "scope": scope(plugin.org_id),
        "qualifiedKey": qualified_key(plugin.org_id, plugin.key),
    }


async def find_plugin(session: AsyncSession, org_id: str | None,
                      key: str) -> am.Plugin | None:
    statement = select(am.Plugin).where(am.Plugin.key == key)
    statement = statement.where(
        am.Plugin.org_id == org_id if org_id else am.Plugin.org_id.is_(None))
    return (await session.execute(statement.limit(1))).scalar_one_or_none()


async def get_or_create_plugin(
    session: AsyncSession, *, org_id: str | None, key: str, name: str,
    description: str, source_kind: str, created_by: str,
) -> tuple[am.Plugin, bool]:
    """Create one stable identity even when two Hub workers import together."""
    existing = await find_plugin(session, org_id, key)
    if existing is not None:
        return existing, False
    candidate = am.Plugin(
        org_id=org_id, key=key, name=name, description=description,
        source_kind=source_kind, enabled=False, created_by=created_by)
    try:
        async with session.begin_nested():
            session.add(candidate)
            await session.flush()
        return candidate, True
    except IntegrityError:
        # The savepoint keeps the outer request transaction usable. The winner
        # owns the identity and this request continues against that exact row.
        existing = await find_plugin(session, org_id, key)
        if existing is None:
            raise
        return existing, False


async def version_state(
    session: AsyncSession, plugin_id: str, version: str, checksum: str,
) -> tuple[str, am.PluginVersion | None]:
    rows = list((await session.execute(select(am.PluginVersion).where(
        am.PluginVersion.plugin_id == plugin_id,
        or_(am.PluginVersion.version == version,
            am.PluginVersion.checksum == checksum),
    ))).scalars().all())
    same = next((row for row in rows if row.checksum == checksum), None)
    if same is not None:
        return "same", same
    conflict = next((row for row in rows if row.version == version), None)
    if conflict is not None:
        return "conflict", conflict
    return "new", None


async def insert_version_once(
    session: AsyncSession, candidate: am.PluginVersion,
) -> tuple[am.PluginVersion, bool]:
    """Insert an immutable version, or return the concurrent winner."""
    state, existing = await version_state(
        session, candidate.plugin_id, candidate.version, candidate.checksum)
    if state == "same" and existing is not None:
        return existing, False
    if state == "conflict":
        raise PluginVersionConflict(
            "\u540c\u4e00\u7248\u672c\u53f7\u7684\u63d2\u4ef6\u5185\u5bb9\u5df2\u7ecf\u53d8\u5316\uff0c\u8bf7\u63d0\u5347\u7248\u672c\u53f7\u540e\u518d\u5bfc\u5165")
    try:
        async with session.begin_nested():
            session.add(candidate)
            await session.flush()
        return candidate, True
    except IntegrityError:
        state, existing = await version_state(
            session, candidate.plugin_id, candidate.version, candidate.checksum)
        if state == "same" and existing is not None:
            return existing, False
        if state == "conflict":
            raise PluginVersionConflict(
                "\u540c\u4e00\u7248\u672c\u53f7\u7684\u63d2\u4ef6\u5185\u5bb9\u5df2\u7ecf\u53d8\u5316\uff0c\u8bf7\u63d0\u5347\u7248\u672c\u53f7\u540e\u518d\u5bfc\u5165")
        raise
