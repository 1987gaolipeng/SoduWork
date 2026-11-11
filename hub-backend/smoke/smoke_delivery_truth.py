# -*- coding: utf-8 -*-
"""Repeatable offline tests of unified delivery facts and completion gates using an isolated
database.
"""
import asyncio
import io
import os
import sys
import zipfile
from datetime import datetime, timedelta, timezone

from sqlalchemy import select

DB = os.path.abspath(".smoke-delivery-truth.db")
for suffix in ("", "-shm", "-wal"):
    try:
        os.remove(DB + suffix)
    except FileNotFoundError:
        pass
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\", "/")
sys.path.insert(0, ".")

from app import automation_models as am, models  # noqa: E402
from app.db import SessionLocal, engine, init_db  # noqa: E402
from app.services import (artifact_ingest, delivery_manifest, delivery_truth,
                          task_execution_contract, release_control, storage,
                          task_status, workflow_contracts)  # noqa: E402

ok = fail = 0


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print("  PASS  " + name)
    else:
        fail += 1
        print("  FAIL  " + name + ("  << " + str(extra)[:500] if extra else ""))


def manifest(name="result.md", state="passed", reason=""):
    item = {
        "id": "a-" + name, "name": name, "size": 20, "contentType": "text/markdown",
        "role": "output", "category": "primary", "sourceRef": "ref-ok",
        "url": "/attachments/a", "validation": {"state": state, "reason": reason},
    }
    problems = [] if state == "passed" else [
        {"code": "invalid_output", "name": name, "detail": reason or "文件损坏"}]
    return {
        "schemaVersion": "1.0", "complete": state == "passed", "url": "",
        "files": [item], "primary": [item], "supporting": [], "evidence": [],
        "internal": [], "problems": problems,
        "counts": {"primary": 1, "supporting": 0, "evidence": 0, "internal": 0},
    }


def direct(task_id, ref, state="done"):
    return am.ExecutionSession(
        id="s-" + task_id, task_id=task_id, ref=ref, state=state,
        workflow_run_id="", runner_id="runner-smoke", engine="pi", metadata_={})


def artifact(task_id, seq, ref, data, state="candidate"):
    return am.ArtifactVersion(
        id=f"av-{task_id}-{seq}", task_id=task_id, seq=seq, kind="files",
        source_ref=ref, checksum=f"sum-{task_id}-{seq}", manifest=data, state=state)


async def main():
    await init_db()
    async with SessionLocal() as s:
        s.add(models.Client(id="c-truth", name="交付事实测试机"))
        await s.commit()

        # Ordinary manual tasks remain manually completable outside automatic execution.
        manual = models.Task(id="t-manual", title="人工任务", status="todo", owner_client_id="c-truth")
        s.add(manual)
        await s.commit()
        truth = await delivery_truth.evaluate(s, manual)
        chk("人工任务仍可手工办结", truth["authority"] == "manual" and truth["canComplete"], truth)
        chk("人工任务通过统一状态入口办结",
            await task_status.mark(s, manual, "done", why="冒烟") and manual.status == "done")

        # No entry point may complete a task while required AI execution remains active.
        running = models.Task(id="t-running", title="AI 正在干", status="doing", owner_client_id="c-truth")
        s.add_all([running, direct("t-running", "ref-running", "running")])
        await s.commit()
        truth = await delivery_truth.evaluate(s, running)
        chk("AI 运行中不能完成", truth["state"] == "running" and not truth["canComplete"], truth)
        chk("完成门禁拒绝进程未结束的任务",
            not await task_status.mark(s, running, "done", why="冒烟") and running.status == "doing")

        # A watchdog may stop after code was already pushed or merged.
        # Later fixed-version evidence must supersede stale process-failure state.
        code_task = models.Task(id="t-code-after-watchdog", title="代码已合并", status="doing",
                                owner_client_id="c-truth")
        code_session = direct(code_task.id, "ref-code-watchdog", "failed")
        code_session.metadata_ = {"error": "静默 15 分钟后由看门狗收尾"}
        code_version = am.ArtifactVersion(
            id="av-code-watchdog", task_id=code_task.id, seq=1, kind="code",
            source_ref=code_session.ref, commit_sha="abc1234", checksum="sum-code",
            branch="fix/code", target="main", state="merged")
        s.add_all([code_task, code_session, code_version])
        await s.commit()
        truth = await delivery_truth.evaluate(s, code_task)
        chk("已固定并合并的代码成果覆盖过期会话失败",
            truth["canComplete"] and not any(
                x["code"] == "execution_failed" for x in truth["blockers"]), truth)
        projected = task_execution_contract.build_stages(
            {"id": code_task.id, "status": "doing", "createdAt": 1}, [],
            [{"ref": code_session.ref, "status": "failed"}], [], [],
            [{"id": code_version.id, "kind": "code", "state": "merged",
              "sourceRef": code_session.ref}], [])
        execute = next(x for x in projected if x["key"] == "execute")
        chk("全链路展示不再把已有合并成果的执行阶段涂红", execute["state"] == "succeeded", execute)
        same_second = datetime(2026, 8, 8, 8, 0, 0, tzinfo=timezone.utc)
        rerun = models.Task(id="t-rerun-order", title="同秒重派", status="doing",
                            owner_client_id="c-truth")
        older = am.ExecutionSession(
            id="s-order-z", task_id=rerun.id, ref="ref-old", state="done",
            workflow_run_id="", created_at=same_second, started_at=same_second)
        newer = am.ExecutionSession(
            id="s-order-a", task_id=rerun.id, ref="ref-new", state="running",
            workflow_run_id="", created_at=same_second,
            started_at=same_second + timedelta(microseconds=1))
        s.add_all([rerun, older, newer])
        await s.commit()
        truth = await delivery_truth.evaluate(s, rerun)
        chk("同秒重派按微秒级启动时间选择最新执行",
            truth["state"] == "running" and truth["current"].get("ref") == "ref-new", truth)

        # Receiving a file does not establish delivery; runtime libraries are not generic evidence.
        contract = workflow_contracts.evaluate(
            {"outputs": [{"key": "result", "kind": "evidence", "label": "产出物", "required": True}]},
            {}, {"received": ["runtime/libfoo.so"], "valid": ["runtime/libfoo.so"],
                 "deliverables": [], "evidence": [], "ignored": ["runtime/libfoo.so"]})
        chk("运行库不能冒充通用成果", contract["missing"] == ["产出物"], contract)
        explicit = workflow_contracts.evaluate(
            {"outputs": [{"key": "lib", "kind": "file", "path": "runtime/libfoo.so",
                           "label": "动态库", "required": True}]}, {},
            {"received": ["runtime/libfoo.so"], "valid": ["runtime/libfoo.so"],
             "deliverables": [], "evidence": [], "ignored": ["runtime/libfoo.so"]})
        chk("插件显式声明的二进制仍可交付", not explicit["missing"], explicit)

        # Fixed valid outputs must await review of the current version.
        pending = models.Task(id="t-pending", title="待验收成果", status="doing", owner_client_id="c-truth")
        av = artifact("t-pending", 1, "ref-ok", manifest())
        req = am.ApprovalRequest(id="ar-pending", task_id=pending.id,
                                 artifact_version_id=av.id, action="review", status="pending")
        s.add_all([pending, direct(pending.id, "ref-ok", "completed"), av, req])
        await s.commit()
        truth = await delivery_truth.evaluate(s, pending)
        chk("有效成果未验收时明确等待人工",
            truth["state"] == "waiting_human" and not truth["canComplete"], truth)
        req.status = "approved"
        av.state = "reviewed"
        await s.commit()
        chk("当前固定版本通过验收后才可办结",
            await task_status.mark(s, pending, "done", why="验收通过") and pending.status == "done")

        # Old approvals cannot authorize a new version.
        stale = models.Task(id="t-stale", title="版本已变化", status="doing", owner_client_id="c-truth")
        old = artifact("t-stale", 1, "ref-stale", manifest(), "reviewed")
        old_req = am.ApprovalRequest(id="ar-old", task_id=stale.id,
                                     artifact_version_id=old.id, action="review", status="approved")
        new = artifact("t-stale", 2, "ref-stale", manifest("result-v2.md"))
        s.add_all([stale, direct(stale.id, "ref-stale"), old, old_req, new])
        await s.commit()
        truth = await delivery_truth.evaluate(s, stale)
        chk("旧审批章对新成果失效",
            not truth["canComplete"] and any(x["code"] == "review_unassigned" for x in truth["blockers"]), truth)

        # Structurally invalid files cannot complete delivery merely because an approval record exists.
        broken = models.Task(id="t-broken", title="损坏成果", status="doing", owner_client_id="c-truth")
        broken_av = artifact("t-broken", 1, "ref-broken", manifest("report.docx", "failed", "压缩结构损坏"))
        broken_req = am.ApprovalRequest(id="ar-broken", task_id=broken.id,
                                        artifact_version_id=broken_av.id, action="review", status="pending")
        s.add_all([broken, direct(broken.id, "ref-broken"), broken_av, broken_req])
        await s.commit()
        refused = await release_control.decide(
            s, broken, object(), action="review", decision="approve",
            artifact_version_id=broken_av.id)
        chk("损坏成果在审批入口就会被拒绝", refused.get("reason") == "invalid_artifact", refused)
        broken_req.status = "approved"  # Read-time gates must detect invalid historical approval facts.
        await s.commit()
        truth = await delivery_truth.evaluate(s, broken)
        chk("损坏主成果不能被审批票漂白",
            not truth["canComplete"] and any(x["code"] == "output_invalid" for x in truth["blockers"]), truth)

        stale_url = models.Task(id="t-stale-url", title="旧地址不能串轮次", status="doing",
                                owner_client_id="c-truth", artifact_url="https://old.example/result")
        s.add_all([
            stale_url,
            models.TaskEvent(task_id=stale_url.id, kind="ai.artifacts", actor="agent",
                             detail={"ref": "ref-old-url",
                                     "artifactUrl": "https://old.example/result"}),
            models.TaskEvent(task_id=stale_url.id, kind="ai.artifacts", actor="agent",
                             detail={"ref": "ref-new-url", "artifactUrl": ""}),
        ])
        await s.commit()
        scoped = await release_control.output_manifest(s, stale_url, source_ref="ref-new-url")
        chk("旧执行的成果地址不会替新执行冒充主成果",
            scoped["url"] == "" and not scoped["complete"], scoped)

        # Workflow completion requires declared node outcomes, output receipts, and human decisions.
        pv = am.PluginVersion(
            id="pv-truth", plugin_id="p-truth", version="1", checksum="pv-sum",
            trust_state="approved", enabled=True, workflow={"nodes": [
                {"key": "work", "name": "AI 干活", "type": "ai", "outputs": [
                    {"key": "result", "kind": "evidence", "label": "产出物", "required": True}]},
                {"key": "accept", "name": "人工验收", "type": "human_review", "dependsOn": ["work"]},
                {"key": "publish", "name": "办结", "type": "publish", "dependsOn": ["accept"]},
            ]})
        wf_task = models.Task(id="t-workflow", title="工作流任务", status="doing", owner_client_id="c-truth")
        wf_av = artifact("t-workflow", 1, "r-truth", manifest(), "reviewed")
        wf_req = am.ApprovalRequest(id="ar-workflow", task_id=wf_task.id,
                                    artifact_version_id=wf_av.id, action="review", status="approved")
        run = am.WorkflowRun(id="r-truth", task_id=wf_task.id, plugin_id="p-truth",
                             plugin_version_id=pv.id, binding_id="b-truth", state="succeeded")
        work = am.NodeRun(id="nr-work", run_id=run.id, node_key="work", node_type="ai",
                          attempt=1, state="succeeded", output={}, idempotency_key="r-truth:work:1")
        accept = am.NodeRun(id="nr-accept", run_id=run.id, node_key="accept",
                            node_type="human_review", attempt=1, state="succeeded",
                            output={"requestId": wf_req.id, "artifactVersionId": wf_av.id},
                            idempotency_key="r-truth:accept:1")
        publish = am.NodeRun(id="nr-publish", run_id=run.id, node_key="publish",
                             node_type="publish", attempt=1, state="succeeded",
                             output={"message": "完成"}, idempotency_key="r-truth:publish:1")
        s.add_all([pv, wf_task, wf_av, wf_req, run, work, accept, publish])
        await s.commit()
        truth = await delivery_truth.evaluate(s, wf_task)
        chk("工作流成功但缺产出回执仍不能办结",
            not truth["canComplete"] and any(x["code"] == "missing_receipt" for x in truth["blockers"]), truth)
        work.output = {"outputReceipt": {
            "declared": [{"key": "result", "kind": "evidence", "required": True, "ok": True}],
            "missing": [], "received": ["result.md"], "valid": ["result.md"],
            "deliverables": ["result.md"], "evidence": [], "invalid": [], "ignored": []}}
        await s.commit()
        truth = await delivery_truth.evaluate(s, wf_task)
        chk("节点、回执、审批全部一致后工作流可办结", truth["canComplete"], truth)
        chk("引擎也必须经过同一完成门禁",
            await task_status.mark(s, wf_task, "done", engine=True, why="run.succeeded")
            and wf_task.status == "done")

        # A still-approved older request cannot accept a reworked version.
        wf_task.status = "doing"
        wf_new = artifact("t-workflow", 2, "r-truth", manifest("result-v2.md"))
        s.add(wf_new)
        await s.commit()
        truth = await delivery_truth.evaluate(s, wf_task)
        chk("工作流旧审批票不能覆盖返修后的新成果版本",
            not truth["canComplete"]
            and any(x["code"] == "approval_artifact_stale" for x in truth["blockers"]), truth)
        await s.delete(wf_new)
        wf_task.status = "done"
        await s.commit()

        # Expose historical false-completion inconsistencies without silently rewriting the database.
        ahead = models.Task(id="t-ahead", title="状态抢跑", status="done", owner_client_id="c-truth")
        ahead_av = artifact("t-ahead", 1, "ref-ahead", manifest())
        ahead_req = am.ApprovalRequest(id="ar-ahead", task_id=ahead.id,
                                       artifact_version_id=ahead_av.id, action="review", status="pending")
        s.add_all([ahead, direct(ahead.id, "ref-ahead"), ahead_av, ahead_req])
        await s.commit()
        truth = await delivery_truth.evaluate(s, ahead)
        chk("已完成状态若缺交付事实会被识别为不一致",
            not truth["statusConsistent"] and truth["blockers"][0]["code"] == "status_ahead", truth)

        # Retain invalid unreferenced files as evidence outside valid candidates.
        # New executions sharing a URL still receive independent provenance receipts.
        class FakeProvider:
            PREFIX = "fake:"

            @staticmethod
            def fetch_attachment_for_sync(_cfg, _ref, file_id):
                return {
                    "index": b"<!doctype html><html><body>ok</body></html>",
                    "broken": b"not-a-png",
                }.get(file_id)

        async def fake_by_ref(_ref):
            return FakeProvider

        old_by_ref = artifact_ingest._by_ref_async
        old_info = artifact_ingest.runner_info_sync
        old_put = storage.put
        artifact_ingest._by_ref_async = fake_by_ref
        artifact_ingest.runner_info_sync = lambda _ctx, _ref: {}
        storage.put = lambda _key, _data, _ctype: "local"
        try:
            ingest_task = models.Task(
                id="t-ingest", title="回流完整性", status="doing",
                owner_client_id="c-truth", artifact_url="https://same.example/result")
            s.add(ingest_task)
            await s.commit()
            pulled = await artifact_ingest.pull_artifacts(
                s, ingest_task.id, {}, {
                    "attachments": [
                        {"id": "index", "filename": "index.html"},
                        {"id": "broken", "filename": "assets/broken.png"},
                    ]}, ref="ref-ingest", settle=False)
            rows = list((await s.execute(select(models.Attachment).where(
                models.Attachment.task_id == ingest_task.id))).scalars().all())
            broken_row = next(x for x in rows if x.filename == "assets/broken.png")
            built = delivery_manifest.build(rows, source_ref="ref-ingest")
            chk("损坏独立文件保留失败证据且不污染已验证成果候选",
                (broken_row.evidence_meta or {}).get("verification", {}).get("state") == "failed"
                and built["complete"]
                and [item["name"] for item in built["files"]] == ["index.html"], built)
            chk("回流回执明确列出损坏文件", bool(pulled["invalid"]), pulled)
            await artifact_ingest.pull_artifacts(
                s, ingest_task.id, {}, {"attachments": [],
                                        "artifactUrl": "https://same.example/result"},
                ref="ref-same-url", settle=False)
            url_events = list((await s.execute(select(models.TaskEvent).where(
                models.TaskEvent.task_id == ingest_task.id,
                models.TaskEvent.kind == "ai.artifacts"))).scalars().all())
            url_event = next((event for event in url_events
                              if (event.detail or {}).get("ref") == "ref-same-url"), None)
            chk("相同 URL 的新执行也会留下独立来源回执",
                bool(url_event and (url_event.detail or {}).get("ref") == "ref-same-url"),
                getattr(url_event, "detail", None))
        finally:
            artifact_ingest._by_ref_async = old_by_ref
            artifact_ingest.runner_info_sync = old_info
            storage.put = old_put

    # Validate real byte structure rather than extension alone.
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("index.html", "<!doctype html><html><body>ok</body></html>")
    chk("完整网站压缩包通过结构校验",
        delivery_manifest.validate_bytes("完整产出-site.zip", buf.getvalue())["state"] == "passed")
    unsafe = io.BytesIO()
    with zipfile.ZipFile(unsafe, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("C:/outside.txt", "bad")
    chk("完整成果包拒绝 Windows 盘符绝对路径",
        delivery_manifest.validate_bytes("完整产出-unsafe.zip", unsafe.getvalue())["state"] == "failed")
    traversal = io.BytesIO()
    with zipfile.ZipFile(traversal, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("../outside.txt", "bad")
    chk("完整成果包拒绝路径穿越",
        delivery_manifest.validate_bytes("完整产出-traversal.zip", traversal.getvalue())["state"] == "failed")
    chk("伪装成 docx 的文本会失败",
        delivery_manifest.validate_bytes("report.docx", b"not-a-zip")["state"] == "failed")
    stages = task_execution_contract.build_stages(
        {"id": "ui", "status": "doing", "createdAt": 1}, [],
        [{"ref": "ui-ref", "status": "done"}], [], [],
        [{"id": "ui-av", "seq": 1, "kind": "files"}], [])
    verify = next(x for x in stages if x["key"] == "verify")
    chk("详情链路不再把‘有固定版本’画成‘已验收’", verify["state"] == "waiting_human", verify)
    stages = task_execution_contract.build_stages(
        {"id": "ui2", "status": "doing", "createdAt": 1}, [],
        [{"ref": "ui-ref2", "status": "done"}],
        [{"id": "old-review", "action": "review", "status": "approved",
          "artifactVersionId": "old-av"}], [],
        [{"id": "old-av", "seq": 1, "kind": "files"},
         {"id": "new-av", "seq": 2, "kind": "files"}], [])
    verify = next(x for x in stages if x["key"] == "verify")
    chk("详情链路不会把旧版本审批章盖到新版本", verify["state"] == "waiting_human", verify)

    print("\ndelivery truth smoke: %d passed, %d failed" % (ok, fail))
    return 1 if fail else 0


async def guarded():
    try:
        return await main()
    finally:
        await engine.dispose()
        for suffix in ("", "-shm", "-wal"):
            try:
                os.remove(DB + suffix)
            except FileNotFoundError:
                pass


if __name__ == "__main__":
    sys.exit(asyncio.run(guarded()))
