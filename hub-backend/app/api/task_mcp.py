"""Expose task creation and dispatch as an HTTP JSON-RPC MCP server. Use purpose-specific
short-lived tickets, with legacy device-secret support only under the migration switch. Reuse
create_task, ai_dispatch_task, and client_start_run so one tool invocation follows the same
complete workflow as desktop confirmation.
"""
from __future__ import annotations

import json
import logging
import time
from datetime import datetime, timezone
from types import SimpleNamespace

from fastapi import APIRouter, Body, Depends, Header, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from ..deps import get_session
from ..models import Client, User
from ..services import (audit, device_auth, model_transport,
                        plugin_mcp_gateway, tasks as svc)
from .ai_proxy import _client_by_bearer

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/mcp", tags=["mcp-server"])

PROTOCOL_VERSION = "2024-11-05"
SERVER_INFO = {"name": "soduwork-task", "version": "1"}


async def _client_by_mcp_bearer(
    authorization: str | None = Header(default=None),
    x_soduwork_device: str | None = Header(default=None, alias="X-Soduwork-Device"),
    x_soduwork_secret: str | None = Header(default=None, alias="X-Soduwork-Secret"),
    session: AsyncSession = Depends(get_session),
) -> SimpleNamespace:
    """Prefer a purpose-bound MCP ticket during the staged client migration."""
    if authorization and authorization.lower().startswith("bearer "):
        raw = authorization[7:].strip()
        try:
            client, claims = await device_auth.principal_from_mcp_ticket(session, raw)
            return SimpleNamespace(client=client, claims=claims)
        except device_auth.DeviceAuthError as exc:
            # Only the explicit ``device:legacy-secret`` shape may enter the
            # rolling-upgrade bridge. A signed ticket of another purpose must
            # never be reinterpreted by a broader authentication dependency.
            if ":" not in raw:
                raise HTTPException(status_code=exc.status, detail=str(exc)) from exc
    client = await _client_by_bearer(
        authorization, x_soduwork_device, x_soduwork_secret, session)
    return SimpleNamespace(client=client, claims={})

_STR = {"type": "string"}
_TOOLS: list[dict] = [
    {
        "name": "task_options",
        "description": "获取优先级及执行候选。创建提议只确认目标、事项类型、材料和负责人；"
                       "插件、Agent 和工程关联由执行者开始执行前选择。不要猜目录中的 id。",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "task_propose",
        "description": "把想好的任务**提议**给人看：不写库、不派活，只是让对方屏幕上长出一张"
                       "可以改的任务卡，等人点头。**在对话里建任务一律先用它**——"
                       "人要能改字段，光用文字来回说「把第三条改成…」太难受。"
                       "识别 kind 事项类型，不能全部默认为需求。"
                       "人在卡上确认之后，由界面保存，不预先选择插件或派活，你不用再调 task_create。",
        "inputSchema": {
            "type": "object",
            "required": ["title"],
            "properties": {
                "title": {"type": "string", "description": "一句话标题，40 字以内"},
                "note": {"type": "string", "description": "要办什么，说清楚背景和边界"},
                "kind": {"type": "string", "enum": ["requirement", "bug", "ticket", "improvement", "other"],
                         "description": "事项类型：新增需求、缺陷修复、支持工单、体验优化或其他"},
                "checklist": {"type": "array", "items": _STR, "description": "验收要点：做到这几条才算完"},
                "priority": {"type": "string", "enum": ["low", "normal", "high", "critical"]},
                "due": {"type": "string", "description": "期望完成日，YYYY-MM-DD"},
                "assigneeKind": {"type": "string", "enum": ["me", "ai"]},
                "repoId": {"type": "string", "description": "仅保留已明确提供的项目背景，创建阶段不替执行者选择工程"},
            },
        },
    },
    {
        "name": "task_create",
        "description": "**真建**一条任务并按需要派给 AI 或起流程。"
                       "★在对话里**不要直接调它**——先用 task_propose 出一张卡让人确认，"
                       "人点头之后界面自己会建。这个工具留给没有界面的场合（脚本、别的 agent）。",
        "inputSchema": {
            "type": "object",
            "required": ["title"],
            "properties": {
                "title": {"type": "string", "description": "一句话标题，40 字以内"},
                "note": {"type": "string", "description": "要办什么，说清楚背景和边界"},
                "checklist": {"type": "array", "items": _STR,
                              "description": "验收要点：做到这几条才算完（会并进说明里）"},
                "priority": {"type": "string", "enum": ["low", "normal", "high", "critical"]},
                "due": {"type": "string", "description": "期望完成日，YYYY-MM-DD"},
                "assigneeKind": {"type": "string", "enum": ["me", "ai"],
                                 "description": "me＝我自己办（只建不派）；ai＝交给 AI"},
                "agentId": {"type": "string", "description": "assigneeKind=ai 时指定哪台执行机，取自 task_options"},
                "flow": {"type": "string", "description": "走哪个流程（插件 bindingId），取自 task_options；空＝不走流程"},
                "repoId": {"type": "string", "description": "在哪个工程上干，取自 task_options"},
            },
        },
    },
    {
        "name": "task_list",
        "description": "列出我名下的任务。可按状态筛、按关键词搜。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "status": {"type": "string", "description": "todo / doing / done，空＝全部"},
                "keyword": {"type": "string", "description": "标题或说明里包含这段字"},
                "limit": {"type": "integer", "description": "最多回几条，默认 20"},
            },
        },
    },
    {
        "name": "task_get",
        "description": "看一条任务的详情：说明、状态、进度、AI 执行情况。",
        "inputSchema": {"type": "object", "required": ["id"], "properties": {"id": _STR}},
    },
    {
        "name": "task_update",
        "description": "改一条任务：标题、说明、状态、优先级、期望完成日。只传要改的字段。",
        "inputSchema": {
            "type": "object",
            "required": ["id"],
            "properties": {
                "id": _STR,
                "title": _STR,
                "note": _STR,
                "status": {"type": "string", "enum": ["todo", "doing", "done"]},
                "priority": {"type": "string", "enum": ["low", "normal", "high", "critical"]},
                "due": {"type": "string", "description": "YYYY-MM-DD，空字符串＝清掉"},
            },
        },
    },
]


# Utility helpers.
def _due_ms(s: str) -> int | None:
    """Convert YYYY-MM-DD to a millisecond timestamp at 18:00 local time."""
    s = (s or "").strip()
    if not s:
        return None
    try:
        d = datetime.strptime(s[:10], "%Y-%m-%d")
    except ValueError:
        return None
    return int(d.replace(hour=18, minute=0).timestamp() * 1000)


def _note_with(note: str, checklist) -> str:
    """Append acceptance criteria using exactly the same format as the desktop confirmation card's
    _noteWith helper.
    """
    items = [str(x).strip() for x in (checklist or []) if str(x).strip()]
    if not items:
        return note or ""
    head = (note.rstrip() + "\n\n") if (note or "").strip() else ""
    return head + "验收要点（做到这些算完）：\n" + "\n".join(
        "%d. %s" % (i + 1, s) for i, s in enumerate(items))


async def _options(session: AsyncSession, client: Client) -> dict:
    from .tasks import list_ai_agents
    agents: list[dict] = []
    try:
        got = await list_ai_agents(client=client, session=session)
        for a in (got or {}).get("agents") or []:
            if a.get("off"):
                continue
            agents.append({"id": a.get("id"), "name": a.get("name"),
                           "type": a.get("type") or "agent", "cli": a.get("cliName") or ""})
    except Exception as e:  # noqa: BLE001  Catalog lookup failure must not fail the entire tool.
        log.warning("MCP task_options 取 AI 清单失败：%s", type(e).__name__)
    return {
        "agents": agents[:20],
        "flows": await svc._flow_choices(session),
        "repos": await svc._repo_choices(session, client),
        "priorities": [{"key": "low", "name": "低"}, {"key": "normal", "name": "普通"},
                       {"key": "high", "name": "高"}, {"key": "critical", "name": "最高"}],
        "today": datetime.now().strftime("%Y-%m-%d"),
    }


# Tool implementations.
async def _call_tool(name: str, args: dict, session: AsyncSession, client: Client) -> dict:
    if name == "task_options":
        return await _options(session, client)

    if name == "task_propose":
        # Prepare confirmation-card fields without persistence or dispatch.
        # Users can edit the structured card before creating the task.
        title = str(args.get("title") or "").strip()
        if not title:
            raise ValueError("title 不能为空")
        return {
            "proposal": {
                "title": title[:80],
                "note": str(args.get("note") or ""),
                "kind": svc._sanitize_parsed(args).get("kind", "requirement"),
                "checklist": [str(x).strip() for x in (args.get("checklist") or []) if str(x).strip()][:8],
                "priority": str(args.get("priority") or "normal"),
                "due": str(args.get("due") or ""),
                "assigneeKind": str(args.get("assigneeKind") or "me"),
                "agentId": str(args.get("agentId") or ""),
                "flow": str(args.get("flow") or ""),
                "repoId": str(args.get("repoId") or ""),
            },
            "hint": "已经把这张卡放到对方屏幕上了。等他确认或修改，别再重复提议，也别自己去 task_create。",
        }

    if name == "task_create":
        title = str(args.get("title") or "").strip()
        if not title:
            raise ValueError("title 不能为空")
        data = {
            "title": title[:80],
            "note": _note_with(str(args.get("note") or ""), args.get("checklist")),
            "source": "对话",
            "status": "todo",
            "priority": str(args.get("priority") or "normal"),
            "due": _due_ms(str(args.get("due") or "")),
        }
        # Set origin to local to preserve device-owned task semantics.
        # Other origins identify backend-owned imported or dispatched tasks and restrict client mutations.
        # Using a different origin can make delete_task reject the task as read-only.
        # Record the creation channel in source, independently of origin.
        made = await svc.create_task(session, client.id, data, origin="local")
        tid = str(made.get("id") or "")
        out = {"id": tid, "title": title, "dispatched": False, "flowStarted": False, "warn": ""}
        if str(args.get("assigneeKind") or "me") != "ai":
            return out

        # Start a workflow when selected; otherwise dispatch directly, matching the confirmation card.
        brief = data["note"] or title
        flow = str(args.get("flow") or "").strip()
        try:
            if flow:
                from .plugins import client_start_run
                body = {"bindingId": flow, "instruction": brief}
                if args.get("repoId"):
                    body["repoId"] = str(args["repoId"])
                if args.get("agentId"):
                    body["execution"] = {"agentId": str(args["agentId"])}
                await client_start_run(task_id=tid, body=body, client=client, session=session)
                out["flowStarted"] = True
            else:
                from .tasks import ai_dispatch_task
                body = {"brief": brief[:2000]}
                if args.get("agentId"):
                    body["assigneeId"] = str(args["agentId"])
                    body["assigneeType"] = "agent"
                await ai_dispatch_task(tid=tid, body=body, client=client, session=session)
                out["dispatched"] = True
        except Exception as e:  # noqa: BLE001
            # Report dispatch failure separately from successful task creation.
            out["warn"] = "需求已创建，但执行未开始：%s。可以到需求详情中重试。" % str(e)[:160]
        return out

    if name == "task_list":
        rows = await svc.list_tasks(session, client.id)
        st = str(args.get("status") or "").strip()
        kw = str(args.get("keyword") or "").strip()
        if st:
            rows = [r for r in rows if str(r.get("status") or "") == st]
        if kw:
            rows = [r for r in rows
                    if kw in str(r.get("title") or "") or kw in str(r.get("note") or "")]
        limit = int(args.get("limit") or 20)
        return {"total": len(rows), "tasks": [
            {"id": r.get("id"), "title": r.get("title"), "status": r.get("status"),
             "priority": r.get("priority"), "due": r.get("due")}
            for r in rows[:max(1, min(100, limit))]]}

    if name == "task_get":
        got = await svc.get_task(session, client.id, str(args.get("id") or ""))
        if not got:
            raise ValueError("没有这条需求（或者它不在你名下）")
        return got

    if name == "task_update":
        tid = str(args.get("id") or "")
        patch: dict = {}
        for k in ("title", "note", "status", "priority"):
            if k in args:
                patch[k] = args[k]
        if "due" in args:
            patch["due"] = _due_ms(str(args.get("due") or ""))
        if not patch:
            raise ValueError("没有要改的字段")
        got = await svc.update_task(session, client.id, tid, patch)
        if not got:
            raise ValueError("没有这条需求（或者它不在你名下）")
        return got

    raise ValueError("没有这个工具：%s" % name)


# ---------------------------------------------------------------- JSON-RPC
def _ok(rid, result) -> dict:
    return {"jsonrpc": "2.0", "id": rid, "result": result}


def _fail(rid, code: int, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": message}}


@router.post("")
@router.post("/")
async def rpc(
    request: Request,
    body: dict = Body(default_factory=dict),
    principal: SimpleNamespace = Depends(_client_by_mcp_bearer),
    session: AsyncSession = Depends(get_session),
):
    """Handle MCP JSON-RPC requests with HTTP 200 envelopes; protocol errors belong in the JSON-RPC
    error field so clients can read their details.
    """
    rid = body.get("id")
    method = str(body.get("method") or "")
    params = body.get("params") or {}
    client: Client = principal.client
    claims = dict(principal.claims or {})
    plugin_only = claims.get("typ") == "plugin-mcp"

    if method == "initialize":
        return _ok(rid, {"protocolVersion": PROTOCOL_VERSION,
                         "capabilities": {"tools": {}},
                         "serverInfo": SERVER_INFO})
    if method.startswith("notifications/"):
        return {"jsonrpc": "2.0"}            # Return an empty envelope for notifications, which have no JSON-RPC reply.
    if method == "ping":
        return _ok(rid, {})
    if method == "tools/list":
        try:
            plugin_tools = await plugin_mcp_gateway.tool_definitions(
                session, client, claims)
        except ValueError as exc:
            return _fail(rid, -32003, str(exc)[:500])
        # A per-turn @plugin capability must never inherit SoduWork's broader task
        # administration tools. It sees only the two generic plugin gateways.
        return _ok(rid, {"tools": plugin_tools if plugin_only
                         else [*_TOOLS, *plugin_tools]})
    if method == "tools/call":
        actor_user_ref = client.user_ref
        name = str(params.get("name") or "")
        args = params.get("arguments") or {}
        plugin_started = time.perf_counter()
        if plugin_only and name not in {"plugin_mcp_list", "plugin_mcp_call"}:
            return _ok(rid, {"content": [{"type": "text", "text":
                                           "本轮插件授权不能调用 SoduWork 平台需求工具"}],
                             "isError": True})
        try:
            if name == "plugin_mcp_list":
                data = await plugin_mcp_gateway.list_tools(
                    session, client, claims, str(args.get("server") or ""))
            elif name == "plugin_mcp_call":
                data = await model_transport.until_disconnect(
                    request,
                    plugin_mcp_gateway.call_tool(
                        session, client, claims, str(args.get("server") or ""),
                        str(args.get("tool") or ""), args.get("arguments") or {}))
            else:
                data = await _call_tool(name, args, session, client)
        except Exception as e:  # noqa: BLE001
            if isinstance(e, HTTPException) and e.status_code == 499:
                raise
            # Return tool failures with isError so the model can inspect them and retry with corrected arguments.
            log.warning("MCP 工具 %s 失败：%s", name, e)
            if name in {"plugin_mcp_list", "plugin_mcp_call"}:
                actor = await session.get(User, actor_user_ref) if actor_user_ref else None
                await audit.log(
                    session, actor, "plugin.mcp_failed", "mcp",
                    str(args.get("server") or "")[:128], name,
                    {"tool": str(args.get("tool") or "")[:200],
                     "conversationId": str(claims.get("ref") or "")[:120],
                     "bindingIds": list(dict.fromkeys(
                         str(item)[:128] for item in (claims.get("bids") or []) if str(item)))[:3],
                     "versionIds": list(dict.fromkeys(
                         str(item)[:128] for item in (claims.get("pvids") or []) if str(item)))[:3],
                     "durationMs": round((time.perf_counter() - plugin_started) * 1000),
                     "riskLevel": plugin_mcp_gateway.tool_risk(str(args.get("tool") or "")),
                     "errorType": type(e).__name__,
                     "failureKind": str(getattr(e, "kind", "") or "")[:64],
                     "retryAfterSeconds": max(
                         0, int(getattr(e, "retry_after", 0) or 0))})
            return _ok(rid, {"content": [{"type": "text", "text": str(e)[:500]}], "isError": True})
        if name in {"plugin_mcp_list", "plugin_mcp_call"}:
            actor = await session.get(User, actor_user_ref) if actor_user_ref else None
            await audit.log(
                session, actor, "plugin.mcp_call", "mcp",
                str(args.get("server") or "")[:128], name,
                {"tool": str(args.get("tool") or "")[:200],
                 "conversationId": str(claims.get("ref") or "")[:120],
                 "bindingIds": list(dict.fromkeys(
                     str(item)[:128] for item in (claims.get("bids") or []) if str(item)))[:3],
                 "versionIds": list(dict.fromkeys(
                     str(item)[:128] for item in (claims.get("pvids") or []) if str(item)))[:3],
                 "durationMs": round((time.perf_counter() - plugin_started) * 1000),
                 "riskLevel": plugin_mcp_gateway.tool_risk(str(args.get("tool") or "")),
                 "operation": "list" if name == "plugin_mcp_list" else "call"})
        return _ok(rid, {"content": [{"type": "text",
                                      "text": json.dumps(data, ensure_ascii=False, default=str)}],
                         "isError": False})

    return _fail(rid, -32601, "不支持的方法：%s" % method)
