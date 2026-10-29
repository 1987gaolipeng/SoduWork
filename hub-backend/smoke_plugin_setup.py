# -*- coding: utf-8 -*-
"""Deterministic contract checks for versioned plugin setup and MCP controls."""
from __future__ import annotations

import asyncio
import os
import shutil
import tempfile


TEMP = tempfile.mkdtemp(prefix="smoke-plugin-setup-")
DB = os.path.join(TEMP, "setup.db").replace("\\", "/")
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB
os.environ["SODUWORK_DATA_ROOT"] = os.path.join(TEMP, "data")


from app.db import SessionLocal, engine, init_db  # noqa: E402
from app.services import (mcp_import, mcp_servers, plugin_installations,  # noqa: E402
                          plugin_setup_contracts as setup)


COUNT = 0


def check(value, message: str) -> None:
    global COUNT
    assert value, message
    COUNT += 1


def expect_error(fn, contains: str) -> None:
    try:
        fn()
    except ValueError as exc:
        check(contains in str(exc), "错误信息应说明：" + contains)
    else:
        raise AssertionError("预期 ValueError：" + contains)


schema = setup.normalize({
    "title": "配置报告偏好",
    "description": "保存后在当前插件版本中复用。",
    "preferences": [
        {"key": "language", "label": "报告语言", "type": "select",
         "required": True, "default": "zh-CN",
         "options": [{"value": "zh-CN", "label": "中文"},
                     {"value": "en-US", "label": "English"}]},
        {"key": "audiences", "label": "阅读对象", "type": "multiselect",
         "options": ["管理层", "项目组"]},
        {"key": "includeEvidence", "label": "附带证据", "type": "boolean",
         "default": True},
        {"key": "detailLevel", "label": "详细程度", "type": "number",
         "minimum": 1, "maximum": 5, "default": 3},
        {"key": "referenceUrl", "label": "参考地址", "type": "url",
         "required": False, "maxLength": 300},
    ],
})
check(len(schema["preferences"]) == 5, "应保留完整的类型化安装设置")
clean = setup.validate(schema, {
    "audiences": ["管理层", "管理层", "项目组"],
    "includeEvidence": False,
    "detailLevel": 4,
    "referenceUrl": "https://example.com/guide",
})
check(clean["language"] == "zh-CN", "缺省值应在服务端应用")
check(clean["audiences"] == ["管理层", "项目组"], "多选值应去重")
check(clean["includeEvidence"] is False, "布尔 false 不能被当成缺失")
check(not setup.missing_required(schema, clean), "完整设置应处于 ready")
check("只作为数据" in setup.context(schema, clean), "运行时必须把偏好标记为数据")

expect_error(lambda: setup.normalize({"preferences": [{
    "key": "apiToken", "label": "API Token", "type": "text"}]}), "不能收集凭据")
expect_error(lambda: setup.normalize({"preferences": [{
    "key": "note", "label": "备注", "type": "text",
    "description": "请在这里填写 API token"}]}), "疑似要求填写凭据")
expect_error(lambda: setup.normalize({"preferences": [{
    "key": "note", "label": "备注" * 60, "type": "text"}]}), "不能超过")
expect_error(lambda: setup.normalize({"preferences": [{
    "key": "region", "label": "区域", "type": "select",
    "options": ["cn", "cn"]}]}), "重复选项")
expect_error(lambda: setup.validate(schema, {"unknown": "x"}), "未声明的字段")
expect_error(lambda: setup.validate(schema, {"language": "fr"}), "不是有效选项")
expect_error(lambda: setup.validate(schema, {"detailLevel": 9}), "不能大于")
expect_error(lambda: setup.validate(schema, {
    "referenceUrl": "https://user:pass@example.com"}), "账号密码")
expect_error(lambda: setup.validate({"preferences": [{
    "key": "note", "label": "备注", "type": "text"}]},
    {"note": "token=abcdefghijklmnop"}), "疑似包含凭据")

controls = {
    "name": "company", "type": "http", "url": "https://mcp.example.com/mcp",
    "enabled": True, "startupTimeoutSeconds": 12, "toolTimeoutSeconds": 90,
    "enabledTools": ["read", "write"], "disabledTools": ["write"],
}
expect_error(lambda: mcp_servers.validate_controls(controls), "同时启用和禁用")
expect_error(lambda: mcp_servers.validate_controls(
    {"enabledTools": ["read_*"]}), "不能使用通配符")
expect_error(lambda: mcp_servers.validate_controls(
    {"toolTimeoutSeconds": 301}), "3 到 300")
policy = mcp_servers.tool_policy_result(
    ["read", "write", "delete"],
    {"enabledTools": ["read", "write"], "disabledTools": ["write"]})
check(policy["tools"] == ["read"], "连接允许清单与拒绝清单必须同时生效")
check(policy["blockedTools"] == ["write", "delete"], "被阻止工具必须可审计")

parsed = mcp_import.parse(b'''[mcp_servers.company]\nurl = "https://mcp.example.com/mcp"\nstartup_timeout_sec = 18\ntool_timeout_sec = 75\nenabled_tools = ["read", "search"]\ndisabled_tools = ["delete"]\n''', "config.toml")
row = parsed["items"][0]["row"]
check(parsed["source"] == "Codex config.toml", "应识别 Codex 配置来源")
check(row["startupTimeoutSeconds"] == 18 and row["toolTimeoutSeconds"] == 75,
      "应导入 OpenAI/Codex 超时边界")
check(row["enabledTools"] == ["read", "search"] and
      row["disabledTools"] == ["delete"], "应导入 OpenAI/Codex 工具范围")
check(row["enabled"] is False, "导入只能发现连接，不能自动授权")


async def persistence_checks() -> None:
    await init_db()
    async with SessionLocal() as session:
        saved = await plugin_installations.install_current(
            session, "user-1", "plugin-1", "version-1",
            setup=schema, config=clean, verified=True)
        check(saved.config["language"] == "zh-CN", "安装实例应保存规范化偏好")
        check(saved.setup_state == "ready" and saved.verified_at is not None,
              "真实探活后的安装实例应记录 ready 与验证时间")
        states = await plugin_installations.catalog_states(
            session, "user-1", {"plugin-1": ("version-1", "1.0.0")})
        check(states["plugin-1"]["configured"], "目录应返回可直接使用状态")
        check(states["plugin-1"]["setupConfig"]["detailLevel"] == 4,
              "配置只向所属用户回显非敏感偏好")
        stale = await plugin_installations.catalog_states(
            session, "user-1", {"plugin-1": ("version-2", "2.0.0")})
        check(stale["plugin-1"]["setupState"] == "upgrade_required"
              and not stale["plugin-1"]["configured"],
              "旧安装不能冒充当前版本已经配置")
        check(stale["plugin-1"]["verifiedAt"] is None,
              "插件升级后必须使旧版本探活结果失效")
        await plugin_installations.mark_setup_needed(
            session, "user-1", "plugin-1")
        states = await plugin_installations.catalog_states(
            session, "user-1", {"plugin-1": ("version-1", "1.0.0")})
        check(states["plugin-1"]["setupState"] == "needs_setup" and
              states["plugin-1"]["verifiedAt"] is None,
              "连接或协议变化后必须失效旧验证结果")
        await plugin_installations.uninstall(session, "user-1", "plugin-1")
        states = await plugin_installations.catalog_states(
            session, "user-1", {"plugin-1": ("version-1", "1.0.0")})
        check(not states["plugin-1"]["installed"], "停用后不得进入个人工具箱")


try:
    asyncio.run(persistence_checks())
finally:
    asyncio.run(engine.dispose())
    shutil.rmtree(TEMP, ignore_errors=True)

print(f"plugin setup: {COUNT} assertions")
