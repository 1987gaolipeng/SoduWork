"""Read-only catalogs and selected-model transport used by task parsing."""
import logging
from types import SimpleNamespace
from sqlalchemy.ext.asyncio import AsyncSession

log = logging.getLogger("uvicorn.error")

async def _flow_choices(session: AsyncSession, client=None, *, limit=20) -> list[dict]:
    """List workflows available to the employee's organization without exposing other
    organizations' plugins to forms or model context.
    """
    try:
        from . import plugin_service
        if client is None or not getattr(client, "id", None):
            return []
        task = SimpleNamespace(
            id="", project_id=None, repo_id="",
            owner_client_id=str(client.id), work_routing={})
        rows = await plugin_service.available_bindings(session, task)
        out = []
        for workflow in rows or []:
            key = str(workflow.get("key") or "").strip()
            if not key or workflow.get("runnable") is False:
                continue
            name = str(workflow.get("name") or key)
            process = dict(workflow.get("process") or {})
            tag = "【" + str(process.get("label") or "企业流程") + "】" if process.get("enterprise") else ""
            out.append({
                "key": key,
                "name": name,
                "displayName": tag + name,
                "desc": str(workflow.get("description") or "")[:70],
            })
        return out if limit is None else out[:limit]
    except Exception as error:  # noqa: BLE001
        log.warning("取流程清单失败：%s", type(error).__name__)
        return []


async def _parse_with_my_model(session: AsyncSession, client, model: str,
                               system: str, user: str) -> str:
    """Call the user's configured model once, returning empty on failure so the caller can fall
    back without exposing an exception.
    """
    import json as _json

    from . import model_catalog, model_transport, task_parse_response
    strict = task_parse_response.REQUIREMENT_REQUEST.get()
    try:
        conf = await model_catalog.resolve(session, client, (model or "").strip())
        if not conf or conf.get("kind") != "openai-compat":
            return ""
        # Task parsing has only read context at this point; release its checkout
        # before capacity admission and model waiting.
        if session is not None:
            await session.close()
        body = _json.dumps({
            "model": conf["model"], "temperature": 0.2,
            "messages": [{"role": "system", "content": system},
                         {"role": "user", "content": user}],
        }, ensure_ascii=False).encode("utf-8")
        resp = await model_transport.open_response(conf, "/chat/completions", body,
                                                   timeout=120 if strict else 90)
        raw = await resp.read()
        data = _json.loads(raw.decode("utf-8", "replace"))
        content = (data.get("choices") or [{}])[0].get("message", {}).get("content") or ""
        if strict and not content.strip():
            from fastapi import HTTPException
            raise HTTPException(502, "模型未返回需求内容")
        return content
    except Exception as e:  # noqa: BLE001 - Suggestion parsing failure must not block task creation.
        log.warning("用个人模型解析任务失败：%s", type(e).__name__)
        if strict:
            from fastapi import HTTPException
            status = getattr(e, "status", getattr(e, "status_code", 503))
            raise HTTPException(status if isinstance(status, int) else 503,
                                "模型暂时无法完成需求解析，请重试") from e
        return ""
