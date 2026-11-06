"""Read code-delivery timelines without Git or network access, and explicitly retry approved merges
after conflicts. Conflict retries are never automatic.
"""
from typing import Annotated

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am
from ..db import get_session
from ..deps import current_client
from ..models import Client, Project, Task
from ..schemas import task_to_api
from ..services import code_delivery as cd
from ..services import approval_routing, release_control, task_access

router = APIRouter(prefix="/api/v1", tags=["delivery"])


async def _my_task(session: AsyncSession, client: Client, tid: str) -> Task:
    return await task_access.require_owned_task(session, client, tid)


async def _artifact_download_scope(session: AsyncSession, client: Client, tid: str,
                                   version_id: str = "") -> tuple[Task, am.ArtifactVersion | None]:
    t = await session.get(Task, tid)
    if t is None:
        raise HTTPException(status_code=404, detail="需求不存在")
    artifact = (await session.get(am.ArtifactVersion, version_id) if version_id
                else await release_control.latest_artifact(session, tid, stream="delivery"))
    if version_id and (artifact is None or artifact.task_id != tid
                       or artifact.kind == "requirement"):
        raise HTTPException(status_code=404, detail="需求不存在")
    if not await approval_routing.can_read_task_evidence(
            session, t, client, artifact.id if artifact is not None else ""):
        # Keep existence private from unrelated devices and users.
        raise HTTPException(status_code=404, detail="需求不存在")
    return t, artifact


@router.get("/tasks/{tid}/delivery")
async def get_delivery(
    tid: str,
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Return code-delivery status. applies=False means no repository has the required server_dir
    and merge_branch; use artifact delivery instead.
    """
    t = await _my_task(session, client, tid)
    st = await cd.read_state(session, tid)
    repo = await cd.repo_for(session, t)
    st["applies"] = repo is not None
    st["delivered"] = st["applies"] and await cd.is_delivered(session, t, st)
    if repo is not None:


        proj = await session.get(Project, repo.project_id) if repo.project_id else None
        st["repo"] = {"id": repo.id, "name": repo.name, "target": repo.merge_branch,
                      "gitUrl": repo.git_url or "", "localDir": repo.local_dir or "",
                      "projectId": repo.project_id or "",
                      "projectName": (proj.name if proj else "")}
    st["release"] = await release_control.view(session, tid)
    return st


@router.get("/tasks/{tid}/artifacts.zip")
async def artifacts_zip(
    tid: str,
    artifact_version_id: Annotated[
        str, Query(alias="artifactVersionId", max_length=64)] = "",
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Behavior and constraints for this operation."""
    import io
    import hashlib

    from fastapi.responses import StreamingResponse
    from sqlalchemy import select as _sel

    from ..models import Attachment
    from ..services import delivery_bundle, delivery_manifest, delivery_truth
    t, artifact = await _artifact_download_scope(
        session, client, tid, str(artifact_version_id or ""))
    rows = (await session.execute(
        _sel(Attachment).where(Attachment.task_id == tid)
        .order_by(Attachment.created_at, Attachment.id))).scalars().all()
    if artifact is not None and artifact.kind == "code":
        raise HTTPException(status_code=400, detail="代码成果以仓库提交为准，不提供附件压缩包")
    selected = []
    if artifact is not None:
        selected = delivery_bundle.select_artifact(rows, artifact)
    else:
        # No immutable version yet: keep the newest deliverable for every relative path.
        # This fallback is only for pre-review tasks; it must never put input/history in the zip.
        candidates = [row for row in rows
                      if str(getattr(row, "uploaded_by", "") or "").startswith("agent:")
                      and delivery_manifest.item_from_attachment(row)["category"] in {"primary", "supporting"}]
        latest = {}
        for row in candidates:
            name = delivery_manifest.normalize_name(row.filename)
            if name:
                latest[name] = row
        selected = list(latest.values())
    if not selected:
        detail = ("当前固定版本没有可下载的文件" if artifact is not None
                  else "这条需求还没有产出可打包")
        raise HTTPException(status_code=404, detail=detail)

    # Merge complete archives and all selected independent outputs together.
    try:
        payload = await delivery_bundle.collect(selected, force_bundle=True,
            validate_standalone=True, limits=delivery_bundle.task_download_limits())
    except FileNotFoundError as exc:
        raise HTTPException(status_code=502,
                            detail="当前固定版本的源文件已丢失，拒绝返回不完整压缩包") from exc
    except HTTPException as exc:
        if exc.status_code in (409, 413):
            raise
        raise HTTPException(status_code=502, detail=str(exc.detail)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502,
                            detail="当前固定版本的成果读取失败，拒绝返回不完整压缩包") from exc
    buf = io.BytesIO(payload["bytes"])
    used = {item["path"] for item in payload["files"]}
    from urllib.parse import quote
    return StreamingResponse(
        buf, media_type="application/zip",
        headers={"Content-Disposition":
                 f"attachment; filename*=UTF-8''{quote(delivery_bundle.archive_filename(t.title))}",
                 "X-Artifact-Count": str(len(used)),
                 "X-Artifact-SHA256": hashlib.sha256(payload["bytes"]).hexdigest(),
                 "X-Artifact-Version": str(artifact.id if artifact else "")})


@router.post("/tasks/{tid}/ms-auto")
async def set_ms_auto(
    tid: str,
    body: dict = Body(default_factory=dict),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Toggle per-task automatic milestone progression. Automatic decisions check successful
    execution, not human acceptance criteria, and must be labeled unreviewed. Stop and notify on
    execution failure.
    """
    from ..services import ms_auto
    t = await _my_task(session, client, tid)
    on = bool(body.get("on"))
    t.ms_auto = on
    await session.commit()
    out = {"ok": True, "on": on}
    # Advance immediately when enabled instead of waiting for the next supervisor cycle.
    if on:
        try:
            out["step"] = await ms_auto.step_task(session, t)
        except Exception as e:  # noqa: BLE001
            out["step"] = {"act": "error", "why": f"{type(e).__name__}"}
    return out


@router.post("/tasks/{tid}/retry-merge")
async def retry_merge(
    tid: str,
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Execute an approved merge or retry it after conflict resolution. Missing review or merge
    approval returns HTTP 409.
    """
    t = await _my_task(session, client, tid)
    st = await cd.merge_approved(session, t, who="人工执行")
    if not st.get("ok"):
        raise HTTPException(status_code=409, detail=st.get("error") or "当前版本尚未获准合并")
    await session.refresh(t)
    return {**st, "task": task_to_api(t)}
