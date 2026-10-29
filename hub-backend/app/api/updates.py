"""Renderer OTA version checks, manifests, and downloads; publish files under releases/<version>/
using publish_release.py.
"""
import os

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..models import Release

router = APIRouter(prefix="/api/v1/updates", tags=["updates"])

# hub-backend/releases
RELEASES_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "releases")


@router.get("/check")
async def check(current: str = "", channel: str = "stable", session: AsyncSession = Depends(get_session)):
    # The renderer-only updater could create a mixed-version Electron process and
    # is permanently retired. Old clients receive a safe no-op until they are
    # manually installed once with the full-package updater.
    return {"hasUpdate": False, "retired": True,
            "message": "请安装新版 SoduWork 以启用完整客户端在线升级"}

    res = await session.execute(
        select(Release).where(Release.channel == channel).order_by(Release.created_at.desc())
    )
    latest = res.scalars().first()
    if latest is None:
        return {"hasUpdate": False}
    return {
        # Offer updates only when the candidate version is newer, not merely different.
        # A server with older assets must not downgrade a newer installed client.
        # Compare numeric versions rather than assuming the server's latest is newer.
        # Preserve installed functionality when release storage lags the client version.
        "hasUpdate": _newer(latest.version, current),
        "version": latest.version,
        "notes": latest.notes,
        "current": current,
    }


def _newer(latest: str, current: str) -> bool:
    """Return whether latest is numerically newer than current; invalid versions conservatively
    disable updates.
    """
    def parts(v: str):
        out = []
        for chunk in str(v or "").strip().split("."):
            digits = "".join(ch for ch in chunk if ch.isdigit())
            if digits == "":
                return None
            out.append(int(digits))
        return out or None

    a, b = parts(latest), parts(current)
    if a is None:
        return False
    if b is None:
        return True                      # Offer the latest version when the client reports no current version.
    size = max(len(a), len(b))
    a += [0] * (size - len(a))
    b += [0] * (size - len(b))
    return a > b


@router.get("/manifest/{version}")
async def manifest(version: str, session: AsyncSession = Depends(get_session)):
    raise HTTPException(status_code=410, detail="渲染层热更新已停用，请安装新版 SoduWork")

    r = await session.get(Release, version)
    if r is None:
        raise HTTPException(status_code=404, detail="版本不存在")
    return {"version": r.version, "notes": r.notes, "files": r.files}


@router.get("/files/{version}/{filepath:path}")
async def get_file(version: str, filepath: str, session: AsyncSession = Depends(get_session)):
    raise HTTPException(status_code=410, detail="渲染层热更新已停用，请安装新版 SoduWork")

    r = await session.get(Release, version)
    if r is None:
        raise HTTPException(status_code=404, detail="版本不存在")
    base = os.path.normpath(os.path.join(RELEASES_DIR, version))
    fp = os.path.normpath(os.path.join(base, filepath))
    if not (fp == base or fp.startswith(base + os.sep)):
        raise HTTPException(status_code=403, detail="非法路径")
    if not os.path.isfile(fp):
        raise HTTPException(status_code=404, detail="文件不存在")
    return FileResponse(fp)
