# -*- coding: utf-8 -*-
"""Smoke checks for quality-runner affinity and failure classification.

Prefer the runner used by implementation while it is online, preserving the available
checkout, credentials, and toolchain. Dispatching quality checks to another machine can
otherwise cause an unnecessary clone that lacks repository access.

Classify Git Authentication failed, Unauthorized, and Permission denied errors as
configuration failures. They are terminal and must not rewind implementation or suggest
that rewriting the code will resolve missing credentials.
"""
import os
import sys
import tempfile

DB = os.path.abspath(".smoke-qrunner.db")
for sfx in ("", "-shm", "-wal"):
    try:
        os.remove(DB + sfx)
    except FileNotFoundError:
        pass
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\", "/")
sys.path.insert(0, ".")

import asyncio  # noqa: E402

from app import automation_models as am  # noqa: E402
from app import models  # noqa: E402
from app.db import SessionLocal, init_db  # noqa: E402
from app.services import (code_delivery, runner_hub, runner_quality,  # noqa: E402
                          workflow_contracts, workflow_engine)

ok = fail = 0


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print("  PASS  " + name)
    else:
        fail += 1
        print("  FAIL  " + name + ("  << " + str(extra)[:240] if extra else ""))


class _FakeRunner:
    def __init__(self, rid, host):
        self.id, self.host = rid, host


async def main():
    await init_db()

    # Infer verification commands from the fixed repository version rather than hard-coding a build system.
    with tempfile.TemporaryDirectory() as root:
        maven_dir = os.path.join(root, "java")
        node_dir = os.path.join(root, "web")
        static_dir = os.path.join(root, "static")
        unknown_dir = os.path.join(root, "unknown")
        os.makedirs(maven_dir)
        os.makedirs(node_dir)
        os.makedirs(static_dir)
        os.makedirs(unknown_dir)
        open(os.path.join(maven_dir, "pom.xml"), "w", encoding="utf-8").close()
        with open(os.path.join(node_dir, "package.json"), "w", encoding="utf-8") as stream:
            stream.write('{"scripts":{"test":"node test.js"}}')
        with open(os.path.join(static_dir, "index.html"), "w", encoding="utf-8") as stream:
            stream.write('<!doctype html><link href="styles.css"><script src="app.js"></script>')
        with open(os.path.join(static_dir, "styles.css"), "w", encoding="utf-8") as stream:
            stream.write("body{color:#111}")
        with open(os.path.join(static_dir, "app.js"), "w", encoding="utf-8") as stream:
            stream.write("document.body.dataset.ready='1'")
        chk("工程自测能从固定提交识别 Maven / Node，不依赖项目名称",
            runner_quality._detect_project_profile(maven_dir) == "maven"
            and runner_quality._detect_project_profile(node_dir) == "node")
        chk("无构建工具的静态网站也有真实质量档位",
            runner_quality._detect_project_profile(static_dir) == "static-web")
        chk("无法识别的工程不会静默跳过质量门禁",
            runner_quality._detect_project_profile(unknown_dir) == "")

        real_append = runner_quality._append
        runner_quality._append = lambda *_args: None
        try:
            static_ok = runner_quality._project_selftest(
                "static-ok", static_dir, {"CI": "1"}, 60)
            with open(os.path.join(static_dir, "index.html"), "a", encoding="utf-8") as stream:
                stream.write("\n<!-- ======= footer ======= -->")
            with open(os.path.join(static_dir, "styles.css"), "a", encoding="utf-8") as stream:
                stream.write("\n/* ======= footer ======= */")
            static_separator = runner_quality._project_selftest(
                "static-separator", static_dir, {"CI": "1"}, 60)
            with open(os.path.join(static_dir, "app.js"), "a", encoding="utf-8") as stream:
                stream.write("\n<<<<<<< ours\na();\n=======\nb();\n>>>>>>> theirs\n")
            static_conflict = runner_quality._project_selftest(
                "static-conflict", static_dir, {"CI": "1"}, 60)
            with open(os.path.join(static_dir, "app.js"), "w", encoding="utf-8") as stream:
                stream.write("document.body.dataset.ready='1'")
            os.remove(os.path.join(static_dir, "styles.css"))
            static_bad = runner_quality._project_selftest(
                "static-bad", static_dir, {"CI": "1"}, 60)
        finally:
            runner_quality._append = real_append
        chk("HTML/CSS 装饰性等号分隔线不会被误判成 Git 冲突",
            static_separator[0]["ok"], static_separator)
        chk("完整行上的真实 Git 冲突标记仍会阻断发布",
            not static_conflict[0]["ok"]
            and "app.js" in static_conflict[0]["detail"], static_conflict)
        chk("静态站自测验证仓库内资源完整性",
            static_ok[0]["ok"] and not static_bad[0]["ok"]
            and "styles.css" in static_bad[0]["detail"], (static_ok, static_bad))

        real_which = runner_quality.shutil.which
        real_docker_test = runner_quality._docker_maven_test
        real_append = runner_quality._append
        runner_quality.shutil.which = lambda _name: None
        runner_quality._docker_maven_test = lambda *_args: [{
            "name": "Maven 工程测试（Docker）", "ok": True, "exitCode": 0,
            "durationMs": 1, "detail": "probe",
        }]
        runner_quality._append = lambda *_args: None
        try:
            maven_plan = runner_quality._project_selftest(
                "quality-probe", maven_dir, {"CI": "1"}, 60)
        finally:
            runner_quality.shutil.which = real_which
            runner_quality._docker_maven_test = real_docker_test
            runner_quality._append = real_append
        chk("Runner 缺少宿主 Maven 时可按受控 Docker 档位完成同一质量语义",
            len(maven_plan) == 1 and maven_plan[0]["ok"]
            and "Docker" in maven_plan[0]["name"], maven_plan)

        streamed = []
        real_append = runner_quality._append
        runner_quality._append = lambda _rid, text: streamed.append(str(text))
        try:
            stream_result = runner_quality._run_argv(
                "quality-stream", "实时输出",
                [sys.executable, "-c",
                 "import time;print('first',flush=True);time.sleep(.15);print('second',flush=True)"],
                root, dict(os.environ), 10)
        finally:
            runner_quality._append = real_append
        chk("质量命令逐行写入实况而不是结束后一次性回填",
            stream_result["ok"] and any("first" in x for x in streamed)
            and any("second" in x for x in streamed), (stream_result, streamed))

        captured = {}
        real_root = runner_quality._root
        real_which = runner_quality.shutil.which
        real_run_argv = runner_quality._run_argv
        real_subprocess_run = runner_quality.subprocess.run

        def fake_docker_run(_rid, _name, argv, _cwd, env, _timeout):
            captured["argv"] = list(argv)
            captured["env"] = dict(env)
            dockerfile = argv[argv.index("--file") + 1]
            with open(dockerfile, encoding="utf-8") as stream:
                captured["dockerfile"] = stream.read()
            return {"name": _name, "ok": True, "exitCode": 0,
                    "durationMs": 1, "detail": "cached"}

        runner_quality._root = lambda: root
        runner_quality.shutil.which = lambda name: "docker-bin" if name == "docker" else None
        runner_quality._run_argv = fake_docker_run

        def fake_subprocess(buildx_rc):
            # Simulate Docker daemon version output and configurable buildx status.
            def _run(argv, *_args, **_kwargs):
                if "info" in argv:
                    return type("Done", (), {"returncode": 0, "stdout": "27.1.1\n", "stderr": ""})()
                return type("Done", (), {"returncode": buildx_rc, "stdout": "", "stderr": ""})()
            return _run

        runner_quality.subprocess.run = fake_subprocess(0)
        try:
            cached_plan = runner_quality._docker_maven_test(
                "quality-cache", maven_dir, dict(os.environ), 60)
            buildkit_capture = dict(captured)
            captured.clear()
            runner_quality.subprocess.run = fake_subprocess(1)
            fallback_plan = runner_quality._docker_maven_test(
                "quality-fallback", maven_dir, dict(os.environ), 60)
            fallback_capture = dict(captured)
            # A stopped Docker daemon must not be classified as a test failure.
            # Return infrastructure classification with actionable detail.
            runner_quality.subprocess.run = lambda *_a, **_k: type(
                "Done", (), {"returncode": 1, "stdout": "",
                             "stderr": "error during connect: open //./pipe/dockerDesktopLinuxEngine: "
                                       "The system cannot find the file specified."})()
            down_plan = runner_quality._docker_maven_test(
                "quality-daemon-down", maven_dir, dict(os.environ), 60)
        finally:
            runner_quality._root = real_root
            runner_quality.shutil.which = real_which
            runner_quality._run_argv = real_run_argv
            runner_quality.subprocess.run = real_subprocess_run
        chk("Docker Maven 质量门禁启用跨任务依赖缓存且显式打开 BuildKit",
            cached_plan[0]["ok"]
            and buildkit_capture.get("env", {}).get("DOCKER_BUILDKIT") == "1"
            and "--mount=type=cache,id=soduwork-maven-repository-v1,target=/root/.m2"
            in buildkit_capture.get("dockerfile", ""), buildkit_capture)
        chk("★Docker 守护进程没起：判 infrastructure（不回卷 AI）并说人话",
            not down_plan[0]["ok"] and down_plan[0].get("failureKind") == "infrastructure"
            and "Docker Desktop" in down_plan[0]["detail"], down_plan)
        chk("★依赖下载类网络故障（Maven 传输中断）归为 infrastructure，不回卷 AI",
            runner_quality._failure_kind("", [{"detail":
                "[ERROR] Could not transfer artifact org.apache.poi:poi-ooxml-lite:jar:5.2.5 from/to central: "
                "Premature end of Content-Length delimited message body (expected: 5,946,257; received: 2,516,608)"}])
            == "infrastructure"
            and workflow_engine._quality_failure_kind(
                "Premature end of Content-Length delimited message body") == "infrastructure")
        chk("★引擎与执行机共用同一份失败分类清单（单一出处，别再各抄一份）",
            workflow_engine._QUALITY_INFRA_HINTS is runner_quality._INFRASTRUCTURE_HINTS
            and workflow_engine._GIT_AUTH_HINTS is runner_quality._CONFIGURATION_HINTS)
        chk("★Windows 命名管道连不上的报错形状也归为 infrastructure",
            runner_quality._failure_kind("", [{"detail":
                "ERROR: failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine; "
                "check if the path is correct and if the daemon is running"}]) == "infrastructure")
        chk("执行机缺 buildx 时关闭 BuildKit 并改用兼容 Dockerfile",
            fallback_plan[0]["ok"]
            and fallback_capture.get("env", {}).get("DOCKER_BUILDKIT") == "0"
            and "RUN mvn -B -ntp test" in fallback_capture.get("dockerfile", "")
            and "--mount=type=cache" not in fallback_capture.get("dockerfile", ""),
            fallback_capture)

    # Classify credential and permission failures as configuration.
    chk("★clone 报 Authentication failed → 配置问题（不是代码问题）",
        workflow_engine._quality_failure_kind(
            "Cloning into '/runner-data/scm/x'...\nremote: Unauthorized\n"
            "fatal: Authentication failed for 'http://gerrit/...'") == "configuration")
    chk("could not read Username / publickey 被拒 同样算配置问题",
        workflow_engine._quality_failure_kind("could not read Username for 'https://x'")
        == "configuration"
        and workflow_engine._quality_failure_kind("Permission denied (publickey).")
        == "configuration")
    chk("真的测试挂了不要误判成配置问题（该回卷就回卷）",
        workflow_engine._quality_failure_kind(
            "FAIL src/a.test.js  expected 1 got 2\nnpm ERR! Test failed") == "")
    buildx_error = (
        "ERROR: BuildKit is enabled but the buildx component is missing or broken. "
        "Install the buildx component to build images with BuildKit.")
    chk("buildx/daemon 这类宿主故障标成 infrastructure",
        workflow_engine._quality_failure_kind(buildx_error) == "infrastructure"
        and runner_quality._failure_kind("", [{"detail": buildx_error}])
        == "infrastructure")
    chk("基础设施故障禁止回卷代码，但允许质量关自身重试",
        workflow_contracts.rework_forbidden({"failureKind": "infrastructure"})
        and not workflow_contracts.terminal_failure({"failureKind": "infrastructure"}))
    chk("★configuration 属于终态且禁止回卷（这条是回卷闸的判据出处）",
        workflow_contracts.terminal_failure({"failureKind": "configuration"})
        and workflow_contracts.rework_forbidden({"failureKind": "configuration"}))

    # Prefer the implementation node's executor.
    async with SessionLocal() as s:
        s.add(am.WorkflowRun(id="run-q", task_id="t-q", plugin_id="pl", plugin_version_id="pv",
                             binding_id="b", state="running"))
        s.add(am.NodeRun(id="n-ai", run_id="run-q", node_key="implement", node_type="ai",
                         attempt=1, state="succeeded", idempotency_key="k1",
                         executor={"kind": "ai", "provider": "runner",
                                   "runnerId": "dev-machine", "host": "DESKTOP-FIXTURE"}))
        await s.commit()

    real_get = runner_hub.get
    runner_hub.get = lambda rid: _FakeRunner(rid, "DESKTOP-FIXTURE") if rid == "dev-machine" else None
    try:
        async with SessionLocal() as s:
            run = await s.get(am.WorkflowRun, "run-q")
            picked = await workflow_engine._same_runner_as_ai(s, run)
        chk("★质检选机＝开发那一关用过的执行机（代码和凭据都在那台上）",
            picked is not None and picked.id == "dev-machine", picked and picked.id)

        runner_hub.get = lambda rid: None          # Exercise the preferred executor being offline.
        async with SessionLocal() as s:
            run = await s.get(am.WorkflowRun, "run-q")
            picked = await workflow_engine._same_runner_as_ai(s, run)
        chk("那台掉线就回落原来的选机逻辑（不硬等）", picked is None)
    finally:
        runner_hub.get = real_get

    # Preserve executor affinity during redispatch.
    from app.services import ai_exec
    seen = {}

    class _R2:
        def __init__(self, rid, tags=None):
            self.id = rid
            self.client_id = ""
            self.tags = list(tags or [])
            self.capabilities = {}
            self.agents = [{"key": "codex"}]
    real_get2, real_pick = runner_hub.get, runner_hub.pick_for
    real_pick_tags = runner_hub.pick_by_tags
    real_resolve = ai_exec.resolve_assignee_sync
    import app.services.ai_remote as _rem
    real_rem = _rem.resolve_assignee_sync
    runner_hub.get = lambda rid: _R2(rid) if rid in ("dev-machine", "other") else None
    # Keep selection fixtures compatible with real scope parameters such as allowed_org_ids.
    runner_hub.pick_for = lambda cid, cli=None, allowed=None, required_capabilities=None, \
        allowed_org_ids=None: _R2("other")   # The ordinary default would select another machine.
    runner_hub.pick_by_tags = lambda tags, cid="", allowed=None, required_capabilities=None, \
        allowed_org_ids=None: _R2("docker-machine", ["docker"])
    _rem.resolve_assignee_sync = lambda cfg, aid, kind: {"id": aid, "type": kind}
    ai_exec.resolve_assignee_sync = lambda ctx, aid, kind: {"id": "backend-local"}
    try:
        pinned = ai_exec.resolve_kind({}, "local:codex", "c1", "dev-machine")
        loose = ai_exec.resolve_kind({}, "local:codex", "c1", "")
        chk("★返修重跑钉回上一轮那台执行机（不换机器）",
            "dev-machine" in str(pinned.get("id")), pinned)
        chk("没有可钉的就照常挑（老行为不变）", "other" in str(loose.get("id")), loose)
        runner_hub.get = lambda rid: None       # Exercise an offline previous executor.
        off = ai_exec.resolve_kind({}, "local:codex", "c1", "dev-machine")
        chk("上一轮那台掉线 → 回落正常挑机，不硬等", "other" in str(off.get("id")), off)
        tagged = ai_exec.resolve_kind(
            {}, "local:codex", "c1", "dev-machine", None, ["docker"])
        chk("节点声明 Docker 能力时按标签选机且不会错误钉回不匹配的旧机器",
            "docker-machine" in str(tagged.get("id")), tagged)
    finally:
        runner_hub.get, runner_hub.pick_for = real_get2, real_pick
        runner_hub.pick_by_tags = real_pick_tags
        ai_exec.resolve_assignee_sync = real_resolve
        _rem.resolve_assignee_sync = real_rem

    # Do not block script-only workflows without AI nodes.
    async with SessionLocal() as s:
        s.add(am.WorkflowRun(id="run-n", task_id="t-n", plugin_id="pl", plugin_version_id="pv",
                             binding_id="b", state="running"))
        await s.commit()
        run = await s.get(am.WorkflowRun, "run-n")
        picked = await workflow_engine._same_runner_as_ai(s, run)
    chk("没有 AI 节点的流程照旧走原选机", picked is None)

    # Verify rework worktrees inherit fixed commits and pushed task branches establish delivery evidence.
    commit = "a" * 40
    repo = models.Repo(id="repo-cont", project_id="project-cont", name="site",
                       git_url="https://git/site.git", default_branch="main",
                       merge_branch="main")
    task = models.Task(id="task-cont", title="continue", status="doing",
                       owner_client_id="c-rg", repo_id=repo.id)
    artifact = am.ArtifactVersion(
        id="artifact-cont", task_id=task.id, seq=1, kind="code",
        source_ref="runner-ref", commit_sha=commit, branch="fix/task-cont",
        target="main", checksum="b" * 64, state="candidate")
    async with SessionLocal() as s:
        s.add_all([models.Client(id="c-rg", name="runner"), repo, task, artifact])
        await s.commit()
        seen = {}
        real_check = code_delivery.check

        async def fake_check(_session, _task, **kwargs):
            seen.update(kwargs)
            return {"stage": "committed", "branch": kwargs.get("branch_hint"),
                    "target": "main"}

        code_delivery.check = fake_check
        try:
            verified = await workflow_engine._verified_git_delivery(
                s, task, {"provider": "runner", "runnerId": "r1"}, "ref1",
                {"gitBranch": "", "gitRemoteBranch": "fix/task-cont",
                 "gitHead": commit},
                {"declared": [{"kind": "git", "ok": True}]})
        finally:
            code_delivery.check = real_check
    chk("detached 返工接受 Runner 精确核验的远端任务分支，不要求伪造本地分支",
        seen.get("branch_hint") == "fix/task-cont"
        and verified.get("commit") == commit, (seen, verified))
    chk("返工隔离工作树优先从上一版固定提交创建，代码审查锁定版本优先级更高",
        workflow_engine._workspace_base_ref(repo, {}, {"commit": commit}) == commit
        and workflow_engine._workspace_base_ref(
            repo, {"commit": "c" * 40}, {"commit": commit}) == "c" * 40)

    print("\n%d PASS / %d FAIL" % (ok, fail))
    return fail


if __name__ == "__main__":
    sys.exit(1 if asyncio.run(main()) else 0)
