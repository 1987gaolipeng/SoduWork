# -*- coding: utf-8 -*-
"""Smoke checks for the PPM Beta connector.

The opt-in live batch (SMOKE_ALLOW_LIVE_DB=1) reads integration configuration and exchanges
Keycloak tokens against the configured environment. Missing X-MCP-Key must produce an
actionable error without sending an MCP request. Offline checks cover envelope, registry,
and poller contracts.
"""
import asyncio
import os
import sys
import time

sys.path.insert(0, ".")

from app.connectors import REGISTRY  # noqa: E402
from app.connectors import ppm  # noqa: E402

ok = fail = 0


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print("  PASS  " + name)
    else:
        fail += 1
        print("  FAIL  " + name + ("  << " + str(extra)[:220] if extra else ""))


def _rejects(tool: str) -> bool:
    """Check whether the read-only MCP allowlist rejects a tool without making a request."""
    try:
        ppm.mcp_call({"mcp": {"url": "http://127.0.0.1:1/x"}}, tool, {})
        return False
    except ValueError as e:
        return "只读" in str(e)


conn = REGISTRY.get("ppm")
chk("注册表里有 ppm 且参与定时轮询(scheduled)", conn is not None and conn.scheduled)
chk("poller 契约:有 pull(config, cursor)", hasattr(conn, "pull"))

env = conn.to_envelope({"bugCode": "BUG-000123", "title": "首页白屏",
                        "fixUser": {"account": "dev1"}, "systemName": "示例应用",
                        "bugStatus": "新建", "bugLevel": "严重"})
chk("Envelope 复用 testplat 别名(bugCode/fixUser.account/systemName 全认出)",
    env and env["external_id"] == "BUG-000123" and env["assignee"] == "dev1"
    and env["ext_repo"] == "示例应用" and env["status"] == "todo", env)
chk("来源标签是 PPM Beta(列表里一眼认出)", "PPM Beta" in env["source_label"], env)

try:
    ppm.mcp_call({"mcpUrl": "https://matrix.invalid/api/mcp", "mcpKey": "",
                  "keycloak": {}}, "bug_list", {})
    chk("没配 mcpKey 给人话且不发请求", False)
except ValueError as e:
    chk("没配 mcpKey 给人话且不发请求(缺 key 先短路,凭据不足不上网)",
        "X-MCP-Key" in str(e), str(e))

try:
    ppm.mcp_call({"mcpKey": "fixture-only-key"}, "bug_list", {})
    chk("缺少服务地址时拒绝请求", False)
except ValueError as e:
    chk("缺少服务地址时拒绝请求", "mcpUrl" in str(e))

# Writeback tools must be blocked by the connector's read-only contract.
chk("bug_list/bug_detail 在只读白名单里", "bug_list" in ppm.READ_ALLOWED
    and "bug_detail" in ppm.READ_ALLOWED)
for w in ("bug_claim", "bug_transition", "bug_comment", "monthly_goal_task_start",
          "worklog_approval_decide"):
    chk("★回写工具「%s」被代码拒(只读硬约束,不发请求)" % w,
        w not in ppm.READ_ALLOWED and _rejects(w))


async def live():
    from sqlalchemy import select

    from app import models
    from app.db import SessionLocal
    async with SessionLocal() as s:
        row = (await s.execute(select(models.Integration).where(
            models.Integration.type == "ppm"))).scalars().first()
        if row is None:
            print("  SKIP  当前环境未配置 PPM；不把可选集成缺席判成平台故障")
            return
        chk("环境中已配置 PPM 集成", True)
        kc = dict((row.config or {}).get("keycloak") or {})
    t0 = time.time()
    token = ppm.keycloak_token(kc)
    first = time.time() - t0
    chk("★Keycloak 真换到令牌(打真实 Keycloak 环境,ROPC)",
        isinstance(token, str) and token.count(".") == 2 and len(token) > 100,
        f"len={len(token)}")
    t1 = time.time()
    again = ppm.keycloak_token(kc)
    chk("令牌缓存生效(第二次不再打网,毫秒级)",
        again == token and (time.time() - t1) < 0.05,
        f"first={first:.2f}s second={time.time() - t1:.4f}s")
    # Missing MCP credentials produce an actionable failure for integration health reporting.
    async with SessionLocal() as s:
        row = (await s.execute(select(models.Integration).where(
            models.Integration.type == "ppm"))).scalars().first()
        try:
            ppm.PpmConnector().pull(row.config or {}, {})
            chk("pull 在缺 mcpKey 时人话失败", False)
        except ValueError as e:
            chk("pull 在缺 mcpKey 时人话失败(管理端健康度可见)",
                "X-MCP-Key" in str(e), str(e))

if os.environ.get("SMOKE_ALLOW_LIVE_DB") == "1":
    asyncio.run(live())
else:
    print("  SKIP  真PPM凭据与 Keycloak 探针（显式设置 SMOKE_ALLOW_LIVE_DB=1 才运行）")

print(f"\n{ok} PASS / {fail} FAIL")
sys.exit(1 if fail else 0)
