"""Administrator model capacity policy and live admission telemetry."""
import json

from fastapi import APIRouter, Body, Depends, HTTPException

from ..db import SessionLocal
from ..deps import require_perm
from ..services import audit, model_runtime

router = APIRouter(prefix="/api/v1/admin/model-runtime", tags=["models"])


@router.get("", dependencies=[Depends(require_perm("integration.manage"))])
async def get_runtime():
    return await model_runtime.snapshot()


@router.put("")
async def put_runtime(body: dict = Body(...), user=Depends(require_perm("integration.manage"))):
    try:
        config = model_runtime.clean_policy(body.get("policy"))
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    async with SessionLocal() as session:
        async with session.begin():
            row = await model_runtime.lock_setting(session, model_runtime.POLICY_KEY,
                                                   json.dumps(model_runtime.DEFAULTS))
            current = model_runtime.clean_policy(json.loads(row.value))
            if body.get("expectedRevision") != model_runtime.fingerprint(current):
                raise HTTPException(409, "并发策略已更新，请刷新并核对后再保存；当前输入已保留")
            row.value = json.dumps(config)
        await audit.log(session, user, "model.capacity", "setting", model_runtime.POLICY_KEY,
                        "模型并发与等待", {"before": current, "after": config})
    return {"ok": True, "revision": model_runtime.fingerprint(config)}
