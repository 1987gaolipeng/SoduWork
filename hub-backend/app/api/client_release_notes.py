"""Device-readable release history and version-scoped publisher metadata."""
from datetime import datetime, timezone
import json
import re
from fastapi import APIRouter, Body, Depends, HTTPException, Query, Response
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from ..db import get_session
from ..deps import current_client, require_perm
from ..models import Client, ClientRelease, User
from ..release_note_models import ClientReleaseNote
from ..services.client_updates import parse_version
from ..services import audit

router = APIRouter(prefix="/api/v1/client-release-notes", tags=["client-release-notes"])
admin_router = APIRouter(prefix="/api/v1/admin/client-release-notes", tags=["client-release-notes"])


def validate_locales(locales):
    def text(value, limit):
        return isinstance(value, str) and bool(value.strip()) and len(value) <= limit
    if not isinstance(locales, dict) or set(locales) not in ({"zh-CN", "en-US"}, {"zh-CN", "en-US", "ja-JP", "ko-KR"}):
        raise ValueError("Provide all four languages or a legacy zh-CN/en-US pair")
    if len(json.dumps(locales, ensure_ascii=False)) > 100000:
        raise ValueError("Release notes are too large")
    structures = []
    for content in locales.values():
        if not isinstance(content, dict) or set(content) != {"summary", "sections"} or not text(content.get("summary"), 2000):
            raise ValueError("A non-empty summary is required")
        sections = content.get("sections")
        if not isinstance(sections, list) or not 1 <= len(sections) <= 30:
            raise ValueError("Provide 1–30 sections")
        structure, ids = [], set()
        for section in sections:
            if not isinstance(section, dict) or set(section) != {"id", "title", "items"}:
                raise ValueError("Invalid section")
            sid = section.get("id")
            if not isinstance(sid, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", sid) or sid in ids:
                raise ValueError("Section IDs must be unique")
            ids.add(sid)
            items = section.get("items")
            if not text(section.get("title"), 200) or not isinstance(items, list) or not 1 <= len(items) <= 100:
                raise ValueError("Invalid section title or items")
            item_ids = []
            for item in items:
                if not isinstance(item, dict) or set(item) != {"id", "text"} or not text(item.get("text"), 4000):
                    raise ValueError("Invalid item text")
                iid = item.get("id")
                if not isinstance(iid, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", iid) or iid in item_ids:
                    raise ValueError("Item IDs must be unique within a section")
                item_ids.append(iid)
            structure.append((sid, item_ids))
        structures.append(structure)
    if any(structure != structures[0] for structure in structures[1:]):
        raise ValueError("Translations must have matching section and item IDs/order")
    return locales


def target(version, channel):
    if not parse_version(version) or channel not in {"stable", "beta"}:
        raise HTTPException(422, "Invalid version or channel")


@admin_router.get("")
async def admin_list(_user: User = Depends(require_perm("client.update")), session: AsyncSession = Depends(get_session)):
    rows = (await session.execute(select(ClientReleaseNote))).scalars().all()
    return {"notes": [{"version": r.version, "channel": r.channel, "locales": r.locales,
                       "revision": r.revision, "status": r.status} for r in rows]}


@admin_router.get("/{version}")
async def get_note(version: str, channel: str = "stable",
                   _user: User = Depends(require_perm("client.update")), session: AsyncSession = Depends(get_session)):
    target(version, channel)
    row = await session.get(ClientReleaseNote, (version, channel))
    if not row:
        raise HTTPException(404, "Release notes not found")
    return {"version": version, "channel": channel, "locales": row.locales,
            "revision": row.revision, "status": row.status}


@admin_router.put("/{version}")
async def put_note(version: str, body: dict = Body(...), channel: str = "stable",
                   user: User = Depends(require_perm("client.update")), session: AsyncSession = Depends(get_session)):
    target(version, channel)
    try:
        locales = validate_locales(body.get("locales"))
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    status, expected = body.get("status", "draft"), body.get("expectedRevision")
    if status not in {"draft", "published"} or type(expected) is not int or expected < 0:
        raise HTTPException(422, "Provide status and expectedRevision (0 for creation)")
    if status == "published":
        enabled = await session.scalar(select(ClientRelease.id).where(ClientRelease.version == version,
            ClientRelease.channel == channel, ClientRelease.enabled.is_(True)).limit(1))
        if not enabled:
            raise HTTPException(409, "Enable an installer before publishing its release notes")
    row = await session.get(ClientReleaseNote, (version, channel))
    if row and row.locales == locales and row.status == status:
        return {"ok": True, "revision": row.revision}  # idempotent multi-platform publishing
    values = dict(locales=locales, status=status, revision=expected + 1,
                  published_at=(row.published_at if row and row.published_at else datetime.now(timezone.utc))
                  if status == "published" else None)
    if row:
        result = await session.execute(update(ClientReleaseNote).where(
            ClientReleaseNote.version == version, ClientReleaseNote.channel == channel,
            ClientReleaseNote.revision == expected).values(**values))
        if result.rowcount != 1:
            raise HTTPException(409, "Release notes changed; reload before saving")
    elif expected == 0:
        session.add(ClientReleaseNote(version=version, channel=channel, **values))
    else:
        raise HTTPException(409, "Release notes revision does not exist")
    try:
        await session.flush()
        await session.commit()
        await audit.log(session, user, "client.release_notes", "client_release_note", version,
                        version, {"channel": channel, "revision": expected + 1, "status": status})
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        raise HTTPException(409, "Release notes changed; reload before saving") from exc
    return {"ok": True, "revision": expected + 1}


@router.get("")
async def list_notes(response: Response, current: str, locale: str = "en-US", channel: str = "stable",
                     platform: str = "win32", arch: str = "x64", version: str = "",
                     offset: int = Query(0, ge=0), limit: int = Query(30, ge=1, le=100),
                     _client: Client = Depends(current_client), session: AsyncSession = Depends(get_session)):
    target(current, channel)
    if version:
        target(version, channel)
    if platform not in {"win32", "darwin", "linux"} or arch not in {"x64", "arm64"}:
        raise HTTPException(422, "Invalid platform or architecture")
    response.headers["Cache-Control"] = "no-store"
    # Published history survives disabling an old installer. Draft artifacts stay hidden.
    rows = (await session.execute(select(ClientRelease).where(
        ClientRelease.channel == channel, ClientRelease.platform == platform,
        ClientRelease.arch == arch))).scalars().all()
    by_version = {}
    for row in sorted(rows, key=lambda r: (not r.enabled, not bool(r.notes.strip()), r.id)):
        parsed = parse_version(row.version)
        if parsed and parsed <= parse_version(current) and (not version or row.version == version):
            by_version.setdefault(row.version, row)
    notes = {row.version: row for row in (await session.execute(select(ClientReleaseNote).where(
        ClientReleaseNote.channel == channel, ClientReleaseNote.version.in_(list(by_version))))).scalars()}
    output = []
    for number in sorted(by_version, key=parse_version, reverse=True):
        note = notes.get(number)
        if note and note.status == "published":
            language = locale if locale in note.locales else "en-US"
            output.append({"version": number, "channel": channel, "locale": language,
                "publishedAt": note.published_at.replace(tzinfo=timezone.utc).isoformat() if note.published_at else None,
                "fallback": language != locale, "revision": note.revision, **note.locales[language]})
        elif not note and by_version[number].enabled and by_version[number].notes.strip():
            # Legacy signed prose may mix languages. Never label it as a translation.
            output.append({"version": number, "channel": channel, "locale": "und", "fallback": True,
                "revision": 0, "summary": by_version[number].notes, "sections": []})
    return {"currentVersion": current, "releases": output[offset:offset + limit],
            "nextOffset": offset + limit if offset + limit < len(output) else None}
