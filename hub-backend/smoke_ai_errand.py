# -*- coding: utf-8 -*-
"""Offline temporary-database test of the minimal office workflow: AI execution, human acceptance,
then completion for a task without a repository.
"""
import asyncio
import json
import os
import sys

DB = os.path.abspath(".smoke-errand.db")
for sfx in ("", "-shm", "-wal"):
    try:
        os.remove(DB + sfx)
    except FileNotFoundError:
        pass
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\", "/")
sys.path.insert(0, ".")

from sqlalchemy import select  # noqa: E402

from app import automation_models as am  # noqa: E402
from app import models  # noqa: E402
from app.db import SessionLocal, init_db  # noqa: E402
from app.services import plugin_packages, plugin_service, workflow_contracts  # noqa: E402

ok = fail = 0


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print("  PASS  " + name)
    else:
        fail += 1
        print("  FAIL  " + name + ("  << " + str(extra) if extra else ""))


async def main():
    await init_db()

    raw = json.load(open("plugins/ai-errand.json", encoding="utf-8"))
    manifest, workflow, _rep = plugin_packages.normalize(raw)
    chk("插件包能通过规范化", manifest["key"] == "ai-errand", manifest.get("key"))

    nodes = {n["key"]: n for n in workflow["nodes"]}
    chk("只有三关，别把零活做复杂", len(nodes) == 3, list(nodes))
    chk("第一关是 AI 干活", nodes["work"]["type"] == "ai")
    chk("★第二关是人验收（老路上正缺这一关）", nodes["accept"]["type"] == "human_review")
    chk("验收接在干活后面", nodes["accept"].get("dependsOn") == ["work"])
    chk("末关是办结", nodes["publish"]["type"] == "publish")
    chk("办结接在验收后面（★验收关绝不能放最后，否则一推进就直接完成）",
        nodes["publish"].get("dependsOn") == ["accept"])

    work = nodes["work"]
    chk("★产出不钉死文件名（零活的交付物可能是 docx/pptx/md）",
        [x["kind"] for x in work.get("outputs") or []] == ["evidence"], work.get("outputs"))
    chk("产出是必须的（不交东西不算干完）",
        all(x.get("required") for x in work.get("outputs") or []))
    text_receipt = workflow_contracts.evaluate(
        work, {"finalText": "A complete office answer"}, {})
    chk("plain text is a valid ai-errand deliverable",
        not text_receipt.get("missing") and text_receipt.get("text") == "A complete office answer",
        text_receipt)
    chk("没有工程时按文件交付", workflow_contracts.delivery_mode(work, False) == "files")
    chk("干活关允许重试一次", int((work.get("retry") or {}).get("maxAttempts") or 0) >= 2,
        work.get("retry"))
    prompt = str((work.get("config") or {}).get("prompt") or "")
    chk("★话术里写明了不许反问（派活不许卡在问句上）", "不要反问" in prompt or "别停下来问" in prompt)
    chk("话术要求结尾是可交付结果", "不能是问句" in prompt)

    # Verify bootstrap registers the built-in plugin in quarantine.
    async with SessionLocal() as s:
        await plugin_service.bootstrap_example(s)
        plugin = (await s.execute(select(am.Plugin).where(
            am.Plugin.key == "ai-errand"))).scalar_one_or_none()
        chk("★启动装配真的把它装进来了", plugin is not None)
        ver = (await s.execute(select(am.PluginVersion).where(
            am.PluginVersion.plugin_id == (plugin.id if plugin else "")))).scalars().all()
        chk("有一个不可变版本", len(ver) == 1, len(ver))
        chk("★新版本默认进隔离区（信任模型别被绕过）",
            ver and ver[0].trust_state == "quarantined", ver and ver[0].trust_state)

        # Create an organization-wide binding without a project.
        await plugin_service.approve_version(s, ver[0], True, "验证")
        chk("管理员批准后才离开隔离区", ver[0].trust_state == "approved" and ver[0].enabled)
        binding = await plugin_service.save_binding(
            s, plugin, {"versionId": ver[0].id, "projectId": "", "config": {}})
        chk("★组织级绑定（不挂项目）能建出来", binding is not None and not binding.project_id,
            binding and binding.project_id)

        # A project-free task must resolve that binding.
        s.add(models.Client(id="c-errand", name="测试机"))
        t = models.Task(id="t-errand", title="帮我做个汇报 PPT", status="todo",
                        owner_client_id="c-errand")
        s.add(t)
        await s.commit()
        chk("这条任务确实没有项目", not t.project_id)
        got = await plugin_service.resolve_binding(s, t)
        chk("★★没有项目的任务也能解析到插件绑定（原来 29/38 条任务卡在这儿）",
            got is not None and got.id == binding.id, got and got.id)

    print("\nai errand smoke: %d passed, %d failed" % (ok, fail))
    return 1 if fail else 0


sys.exit(asyncio.run(main()))
