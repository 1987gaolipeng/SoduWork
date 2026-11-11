# -*- coding: utf-8 -*-
"""Conversation @plugin HTTP smoke; isolated database and full cleanup."""
import asyncio
import os
import shutil
import sys
from datetime import datetime, timedelta, timezone

import httpx
from sqlalchemy import delete, select

sys.path.insert(0, ".")

DB = os.path.abspath(".smoke-plugin-conversation.db")
DATA = os.path.abspath(".smoke-plugin-conversation-data")
for suffix in ("", "-shm", "-wal"):
    try:
        os.remove(DB + suffix)
    except FileNotFoundError:
        pass
shutil.rmtree(DATA, ignore_errors=True)
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\", "/")
os.environ["SODUWORK_DATA_ROOT"] = DATA

from app import automation_models as am, models  # noqa: E402
from app.db import SessionLocal, engine, init_db  # noqa: E402
from app.main import app  # noqa: E402
from app.services import device_auth  # noqa: E402

USER = "u-smoke-at-plugin"
CLIENT = "c-smoke-at-plugin"
ORG = "o-smoke-at-plugin"
PROJECT = "p-smoke-at-plugin"
PLUGIN = "plg-smoke-at-plugin"
VERSION = "plv-smoke-at-plugin"
BINDING = "plb-smoke-at-plugin"
BAD_VERSION = "plv-smoke-at-plugin-unapproved"
BAD_BINDING = "plb-smoke-at-plugin-unapproved"
SECRET = "at-plugin-" + ("s" * 40)
TOKEN = ""
passed = failed = 0


def check(name, condition, extra=""):
    global passed, failed
    if condition:
        passed += 1
    else:
        failed += 1
        print("FAIL", name, str(extra)[:500])


def headers():
    return {"Authorization": "Device " + TOKEN}


async def purge():
    async with SessionLocal() as session:
        await session.execute(delete(models.AuditLog).where(
            models.AuditLog.action == "plugin.conversation_use"))
        await session.execute(delete(am.PluginInstallation).where(
            am.PluginInstallation.user_id == USER))
        await session.execute(delete(am.PluginBinding).where(
            am.PluginBinding.id.in_([BINDING, BAD_BINDING])))
        await session.execute(delete(am.PluginVersion).where(
            am.PluginVersion.id.in_([VERSION, BAD_VERSION])))
        await session.execute(delete(am.Plugin).where(am.Plugin.id == PLUGIN))
        await session.execute(delete(models.Project).where(models.Project.id == PROJECT))
        await session.execute(delete(models.Client).where(models.Client.id == CLIENT))
        await session.execute(delete(models.User).where(models.User.id == USER))
        await session.execute(delete(models.OrgUnit).where(models.OrgUnit.id == ORG))
        await session.commit()


async def seed():
    global TOKEN
    await purge()
    async with SessionLocal() as session:
        session.add(models.OrgUnit(id=ORG, name="At plugin organization"))
        session.add(models.User(id=USER, username="smoke-at-plugin", org_id=ORG,
                                display_name="At plugin smoke", is_active=True))
        session.add(models.Client(id=CLIENT, name="At plugin client",
                                  secret_hash=device_auth.hash_secret(SECRET),
                                  auth_state="active", user_ref=USER))
        session.add(models.Project(id=PROJECT, name="Conversation project", org_id=ORG))
        session.add(am.Plugin(id=PLUGIN, key="weekly-method", name="Weekly method",
                              description="Create an evidence-based weekly report",
                              enabled=True, source_kind="soduwork", org_id=ORG))
        session.add(am.PluginVersion(
            id=VERSION, plugin_id=PLUGIN, version="2.1.0", checksum="at-plugin-smoke",
            manifest={"name": "Weekly method", "description": "Use verified evidence"},
            workflow={"nodes": [{"key": "draft", "type": "ai", "name": "Draft report",
                                  "config": {"prompt": "INTERNAL METHOD: cite verified facts"},
                                  "outputs": [{"key": "report", "kind": "file",
                                               "label": "Weekly report", "path": "weekly.md",
                                               "required": True}]},
                                 {"key": "approve", "type": "human_review", "name": "Manager gate",
                                  "config": {"summary": "Confirm report accuracy"}}]},
            capability_report={
                "skills": [], "mcpServers": ["worklog"],
                "evaluationCases": [{
                    "key": "weekly-quality", "name": "Weekly quality",
                    "instruction": "Create a weekly report", "inputs": {},
                    "criteria": ["Every claim has evidence", "Risks are explicit"],
                    "expectedOutputs": ["report"],
                }],
            },
            trust_state="approved", enabled=True))
        session.add(am.PluginBinding(id=BINDING, plugin_id=PLUGIN, version_id=VERSION,
                                     org_id=ORG, project_id=PROJECT,
                                     config={"agentKind": "local:pi",
                                             "mcpTools": {"worklog": ["records_search"]}},
                                     secret_refs={"worklog": "secret-hidden"}, enabled=True))
        session.add(am.PluginInstallation(
            plugin_id=PLUGIN, version_id=VERSION, user_id=USER,
            enabled=True))
        session.add(am.PluginVersion(
            id=BAD_VERSION, plugin_id=PLUGIN, version="9.9.9", checksum="unapproved-newer",
            manifest={"name": "Unapproved replacement"}, workflow={"nodes": []},
            capability_report={}, trust_state="quarantined", enabled=False))
        session.add(am.PluginBinding(
            id=BAD_BINDING, plugin_id=PLUGIN, version_id=BAD_VERSION, org_id=ORG,
            project_id=PROJECT, config={}, enabled=True,
            updated_at=datetime.now(timezone.utc) + timedelta(days=1)))
        await session.commit()
        TOKEN = device_auth.issue_session(await session.get(models.Client, CLIENT))[0]


async def main():
    await init_db()
    await seed()
    from route_test_support import api_routes
    paths = {route.path for route in api_routes(app)}
    check("conversation plugin endpoint registered",
          "/api/v1/plugins/conversation-context" in paths, sorted(paths))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        catalog = await client.get("/api/v1/plugins/catalog", headers=headers())
        items = catalog.json().get("items", []) if catalog.status_code == 200 else []
        catalog_plugin = next(
            (row for row in items if row.get("pluginId") == PLUGIN), {})
        check("catalog blocks plugin chat until its MCP connection is ready",
              catalog.status_code == 200
              and catalog_plugin.get("conversationUse", {}).get("available") is False
              and catalog_plugin.get("conversationUse", {}).get("code")
                  == "connection_required"
              and catalog_plugin.get("conversationUse", {}).get("missingMcp")
                  == ["worklog"],
              catalog.text)

        resolved = await client.post("/api/v1/plugins/conversation-context", headers=headers(),
                                     json={"pluginIds": [PLUGIN, PLUGIN],
                                           "conversationId": "chat-smoke"})
        body = resolved.json() if resolved.status_code == 200 else {}
        result = (body.get("items") or [{}])[0]
        check("newer unapproved binding falls back to the approved catalog version",
              result.get("version") == "2.1.0" and result.get("name") == "Weekly method", result)
        check("installed version resolves independently of project workflow bindings without exposing secrets",
              resolved.status_code == 200 and len(body.get("items") or []) == 1
              and result.get("scope") == "organization"
              and result.get("scopeLabel") == "全公司"
              and "INTERNAL METHOD" in result.get("context", "")
              and "secret-hidden" not in resolved.text
              and "agentKind" not in resolved.text
              and "secretRefs" not in resolved.text,
              resolved.text)
        check("chat use exposes workflow names but does not claim workflow execution",
              result.get("workflow") == [
                  {"key": "draft", "type": "ai", "name": "Draft report"},
                  {"key": "approve", "type": "human_review", "name": "Manager gate"},
              ] and "不要声称已经启动" in result.get("context", "")
              and "期望交付" in result.get("context", "")
              and "weekly.md" in result.get("context", "")
              and "本轮依赖的企业 MCP：worklog" in result.get("context", "")
              and "Every claim has evidence" in result.get("context", "")
              and "交付质量标准" in result.get("context", "")
              and "Confirm report accuracy" in result.get("context", ""), result)

        wrong_scope = await client.post("/api/v1/plugins/conversation-context", headers=headers(),
                                        json={"pluginIds": [PLUGIN], "projectId": "other"})
        check("project selection cannot inject workflow bindings into an installed conversation plugin",
              wrong_scope.status_code == 200
              and wrong_scope.json()["items"][0]["versionId"] == VERSION
              and wrong_scope.json()["items"][0]["scope"] == "organization"
              and "secret-hidden" not in wrong_scope.text, wrong_scope.text)
        empty = await client.post("/api/v1/plugins/conversation-context", headers=headers(),
                                  json={"pluginIds": []})
        check("empty plugin selection is rejected", empty.status_code == 409, empty.text)

        async with SessionLocal() as session:
            version = await session.get(am.PluginVersion, VERSION)
            version.trust_state = "quarantined"
            await session.commit()
        unapproved = await client.post("/api/v1/plugins/conversation-context", headers=headers(),
                                       json={"pluginIds": [PLUGIN]})
        check("unapproved version cannot enter a conversation", unapproved.status_code == 409,
              unapproved.text)
        async with SessionLocal() as session:
            version = await session.get(am.PluginVersion, VERSION)
            version.trust_state = "approved"
            await session.commit()
            audits = list((await session.execute(select(models.AuditLog).where(
                models.AuditLog.action == "plugin.conversation_use"))).scalars())
            check("conversation plugin use is audited with version and conversation id",
                  len(audits) == 2
                  and all(a.target_id == PLUGIN and a.detail.get("versions") == ["2.1.0"] for a in audits)
                  and audits[0].target_id == PLUGIN
                  and audits[0].detail.get("pluginIds") == [PLUGIN]
                  and audits[0].detail.get("versions") == ["2.1.0"]
                  and audits[0].detail.get("conversationId") == "chat-smoke", audits)


async def guarded():
    try:
        await main()
    finally:
        await purge()
        async with SessionLocal() as session:
            check("smoke data cleaned", await session.get(models.Client, CLIENT) is None
                  and await session.get(am.Plugin, PLUGIN) is None)
        await engine.dispose()


asyncio.run(guarded())
print("PASS=%d FAIL=%d" % (passed, failed))
for suffix in ("", "-shm", "-wal"):
    try:
        os.remove(DB + suffix)
    except FileNotFoundError:
        pass
shutil.rmtree(DATA, ignore_errors=True)
sys.exit(1 if failed else 0)
