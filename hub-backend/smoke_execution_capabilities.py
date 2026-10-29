# -*- coding: utf-8 -*-
"""Local execution-capability tests with Runner fixtures, without starting agents or accessing
business data.
"""
from __future__ import annotations

import asyncio
import os
import sys
import tempfile
import time
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, ".")

from app.services import ai_local, ai_remote, execution_capabilities as caps, runner_hub  # noqa: E402
import runner_main  # noqa: E402


ok = fail = 0


def chk(name, condition, extra=""):
    global ok, fail
    if condition:
        ok += 1
        print("  PASS  " + name)
    else:
        fail += 1
        print("  FAIL  " + name + ("  << " + str(extra)[:400] if extra else ""))


def report(*available: str) -> dict:
    return caps.clean_report({"schemaVersion": 2, "reportedAt": int(time.time()),
                              "available": list(available)})


class FakeRunner:
    def __init__(self, rid: str, client: str, available: tuple[str, ...], busy: int = 0):
        self.id, self.client_id = rid, client
        # Independent shared Runners must belong to an authenticated organization.
        # Production dispatch intentionally rejects completely unassigned nodes.
        self.org_id = "" if client else "org-shared"
        self.host, self.os, self.version = rid, "test", "1.5.0"
        self.work_root, self.tags = "C:/work", ["validation"]
        self.agents = [{"key": "pi", "name": "Pi", "version": "test"}]
        self.capabilities = report(*available)
        self.busy, self.connected_at, self.last_beat = busy, 1.0, 1e20
        self.dispatch_mode = "accepting"
        self.ready = True
        self.inventory_ready = True

    def alive(self):
        return True


def test_contract(tmp: str) -> None:
    old_which = caps.shutil.which
    old_bridges = caps._bridge_facts
    old_declared = os.environ.get("SODUWORK_RUNNER_CAPABILITIES")
    old_soduwork_git = os.environ.get("SODUWORK_GIT")
    fake_git = os.path.join(tmp, "git.exe")
    with open(fake_git, "wb"):
        pass
    os.environ["SODUWORK_GIT"] = fake_git
    caps.shutil.which = lambda _name: None
    # Exercise the Windows fallback on every CI host without changing the
    # process-wide os.name (which would also change pathlib/subprocess).
    with patch.object(caps, "os", SimpleNamespace(name="nt", path=os.path, environ=os.environ)):
        fallback_git = caps._git_path()
    caps.shutil.which = lambda name: "C:/tools/git.exe" if str(name).startswith("git") else None
    caps._bridge_facts = lambda force=False: {
        "browser": (True, "Chrome · Node 24"),
        "office": (False, "尚未安装免费办公文档引擎"),
        "computer": (True, "Windows 桌面控制"),
    }
    os.environ["SODUWORK_RUNNER_CAPABILITIES"] = "browser, company.search, repository, files"
    try:
        got = caps.runtime_report(tmp, grants=["browser"])
        missing_root = caps.runtime_report("Z:/soduwork-capability-smoke/missing")
        computer_granted = caps.runtime_report(tmp, grants=["computer"])
        caps._bridge_facts = lambda force=False: {
            "browser": (True, "Chrome · Node 24"),
            "office": (True, "Python 3.12"),
            "computer": (True, "Windows 桌面控制"),
        }
        caps.invalidate_bridge_cache()
        office_ready = caps.runtime_report(tmp, grants=["browser"])
    finally:
        caps.shutil.which = old_which
        caps._bridge_facts = old_bridges
        caps.invalidate_bridge_cache()
        if old_declared is None:
            os.environ.pop("SODUWORK_RUNNER_CAPABILITIES", None)
        else:
            os.environ["SODUWORK_RUNNER_CAPABILITIES"] = old_declared
        if old_soduwork_git is None:
            os.environ.pop("SODUWORK_GIT", None)
        else:
            os.environ["SODUWORK_GIT"] = old_soduwork_git
    available = set(got["available"])
    chk("探测·工作目录、命令和 Git 形成真实基础能力",
        {"files", "terminal", "repository"} <= available, got)
    chk("探测·Git 不在 PATH 时仍能从明确路径识别",
        os.path.normcase(fallback_git) == os.path.normcase(fake_git), fallback_git)
    common_git = caps._git_candidates({"ProgramFiles": "D:/Programs"})
    chk("探测·覆盖 Windows Git 默认安装目录",
        any(x.replace("\\", "/").endswith("/Git/cmd/git.exe") for x in common_git),
        common_git)
    chk("声明·企业扩展能力保留且别名规范化",
        {"browser", "company.search"} <= available, got)
    malformed = caps.clean_report({"reportedAt": "not-a-time", "available": "terminal"})
    chk("清洗·异常时间戳和标量能力不影响 Runner 握手",
        malformed["reportedAt"] == 0 and malformed["available"] == ["terminal"], malformed)
    chk("契约·单个字符串能力不会被拆成字符",
        caps.normalize("browser-use") == ["browser"] and
        caps.required_for(None, {"requiredAgentCapabilities": "office"}) == ["office"])
    chk("保守·没有桥接就不把 Office/电脑操作伪装成可用",
        "office" not in available and "computer" not in available, got)
    computer = next(x for x in got["items"] if x["key"] == "computer")
    chk("授权·机器已具备但尚未授权时不能接桌面任务",
        computer["installed"] and not computer["authorized"] and not computer["available"], computer)
    chk("授权·本机明确授权后桌面能力才进入调度就绪集合",
        "computer" in computer_granted["available"], computer_granted)
    office = next(x for x in office_ready["items"] if x["key"] == "office")
    chk("授权·Office 安装可用即就绪，不要求与客户端策略冲突的独立授权",
        office["installed"] and office["authorized"] and office["available"] and
        not office["configurable"], office)
    missing_repo = next(x for x in missing_root["items"] if x["key"] == "repository")
    missing_files = next(x for x in missing_root["items"] if x["key"] == "files")
    chk("安全·显式声明不能伪造工作目录和仓库事实",
        not missing_repo["available"] and not missing_files["available"], missing_root)
    chk("提示·Git 已安装但工作目录缺失时给出真正阻塞原因",
        "工作目录" in missing_repo["detail"], missing_repo)

    root_verdict = caps.evaluate(missing_root, ["repository"])
    root_message = caps.error_message(root_verdict, "同事的电脑")
    chk("提示·派活失败时直接说清工作目录而不是笼统报仓库缺失",
        "代码仓库（工作目录未就绪）" in root_message, root_message)

    task = SimpleNamespace(work_routing={
        "requiredAgentCapabilities": ["git", "browser-use", "files"]})
    required = caps.required_for(task, {"deliveryMode": "git"})
    chk("契约·场景和节点要求合并去重",
        required == ["repository", "browser", "files"], required)
    verdict = caps.evaluate(report("files", "terminal", "repository"), required)
    chk("预检·准确给出缺失能力和中文名称",
        verdict["missing"] == ["browser"] and verdict["missingLabels"] == ["浏览与检索"],
        verdict)
    chk("提示·告诉用户到 Runner 补能力或换机器",
        "Agent 管理" in caps.error_message(verdict, "研发机") and "浏览与检索" in caps.error_message(verdict),
        caps.error_message(verdict))
    skill_required = caps.required_for(None, {
        "skills": [{"name": "computer-use"}, {"name": "officecli"}, {"name": "ordinary"}],
    })
    chk("技能·用户允许的可选工具不会把每条任务变成硬要求",
        skill_required == [], skill_required)
    explicit_skill_required = caps.required_for(None, {
        "skills": [{"name": "computer-use"}, {"name": "ordinary"}],
        "requiredSkills": ["computer-use"],
    })
    chk("技能·工作流明确要求的工具仍是 Runner 调度硬要求",
        explicit_skill_required == ["computer"], explicit_skill_required)
    usable, skipped = caps.dispatchable_skills(
        [{"name": "computer-use"}, {"name": "ordinary"}], report("files"))
    chk("授权·未授权可选工具不随派活下发，普通技能照常保留",
        usable == [{"name": "ordinary"}] and skipped == ["computer-use"],
        {"usable": usable, "skipped": skipped})


def test_scheduler() -> None:
    saved = dict(runner_hub._RUNNERS)
    owner = FakeRunner("owner-pc", "c-owner", ("files", "terminal", "repository"))
    shared = FakeRunner("shared-browser", "", ("files", "terminal", "browser"), busy=2)
    runner_hub._RUNNERS.clear()
    runner_hub._RUNNERS.update({owner.id: owner, shared.id: shared})
    try:
        picked = runner_hub.pick_for("c-owner", "pi", None, ["browser"])
        chk("调度·归属人机器缺能力时自动绕行满足契约的共享节点", picked is shared,
            picked and picked.id)
        chk("调度·没有满足全部能力的节点就拒绝选机",
            runner_hub.pick_for("c-owner", "pi", None, ["browser", "office"]) is None)
        chk("部署调度·标签命中后仍必须满足执行能力",
            runner_hub.pick_by_tags(["validation"], "c-owner", None, ["browser"]) is shared)
        owner.capabilities = report("files", "terminal", "repository", "browser")
        chk("调度·能力都满足时仍遵守客户端归属优先", runner_hub.pick_for(
            "c-owner", "pi", None, ["browser"]) is owner)
        owner.capabilities = caps.clean_report({})
        owner.version = "1.4.0"
        reason = runner_hub.explain_no_tagged_runner(
            ["validation"], None, ["repository", "terminal"])
        chk("调度·旧 Runner 未上报能力时明确提示升级，不伪装成机器离线",
            "升级并重启 Runner" in reason and owner.id in reason, reason)
    finally:
        runner_hub._RUNNERS.clear()
        runner_hub._RUNNERS.update(saved)


def test_remote_gate() -> None:
    saved = dict(runner_hub._RUNNERS)
    machine = FakeRunner("remote-no-office", "c-owner", ("files", "terminal"))
    runner_hub._RUNNERS.clear()
    runner_hub._RUNNERS[machine.id] = machine
    touched = []
    old_upload = ai_remote._upload_inputs
    ai_remote._upload_inputs = lambda *_args: (touched.append(True) or ({}, ""))
    try:
        task = SimpleNamespace(id="t-cap", title="生成汇报", note="", result="", status="todo",
                               priority="normal", source="", created_by_name="",
                               work_routing={"requiredAgentCapabilities": ["office"]})
        out = ai_remote.dispatch_sync({}, task, [], {
            "id": "runner:remote-no-office:pi", "name": "远程 Pi"}, {})
        chk("远程·缺能力在传附件和启动会话之前被硬阻断",
            not out.get("ok") and not touched and out.get("capabilityPreflight", {}).get("missing") == ["office"], out)
    finally:
        ai_remote._upload_inputs = old_upload
        runner_hub._RUNNERS.clear()
        runner_hub._RUNNERS.update(saved)


async def test_runner_second_gate(tmp: str) -> None:
    from app.services import runner_deploy, runner_quality, runner_scm

    machine = runner_main.Runner("http://127.0.0.1:1", "", "", "runner-cap", tmp)
    old_probe = runner_main._capabilities
    old_scm, old_quality, old_deploy, old_preflight = (
        runner_scm.probe_sync, runner_quality.start,
        runner_deploy.start, runner_deploy.preflight)
    touched = []
    runner_main._capabilities = lambda _root, _grants=None: report("files", "terminal")
    runner_scm.probe_sync = lambda *_args, **_kwargs: touched.append("git") or {"ok": True}
    runner_quality.start = lambda *_args, **_kwargs: touched.append("quality") or {"ok": True}
    runner_deploy.start = lambda *_args, **_kwargs: touched.append("deploy") or {"ok": True}
    runner_deploy.preflight = (
        lambda *_args, **_kwargs: touched.append("preflight") or {"ok": True})
    try:
        out = await machine._job({
            "op": "job.dispatch", "cli": "pi", "task": {"id": "t-second"},
            "ctx": {"requiredAgentCapabilities": ["repository"]},
            "requiredCapabilities": ["repository"],
        })
        scm = await machine._job({"op": "git.probe", "payload": {}})
        quality = await machine._quality({"op": "quality.start", "spec": {}})
        deploy = await machine._deploy({"op": "deploy.start", "spec": {}})
        secret_probe = await machine._deploy({
            "op": "deploy.preflight", "spec": {"secrets": []},
            "requiredCapabilities": ["files", "terminal"],
        })
        target_probe = await machine._deploy({
            "op": "deploy.preflight", "spec": {},
            "requiredCapabilities": ["repository", "terminal"],
        })
    finally:
        runner_main._capabilities = old_probe
        runner_scm.probe_sync, runner_quality.start = old_scm, old_quality
        runner_deploy.start, runner_deploy.preflight = old_deploy, old_preflight
    chk("Runner·接活瞬间再次核验，心跳陈旧也不能绕过",
        not out.get("ok") and out.get("capabilityPreflight", {}).get("missing") == ["repository"], out)
    blocked = (scm, quality, deploy, target_probe)
    chk("Runner·Git、质量、部署和目标预检在启动命令前统一二次预检",
        touched == ["preflight"] and
        all(x.get("capabilityPreflight", {}).get("missing") == ["repository"]
            for x in blocked), {"blocked": blocked, "touched": touched})
    chk("Runner·密钥预检只要求文件和命令能力，不被 Git 能力误伤",
        secret_probe.get("ok") and touched == ["preflight"], secret_probe)


def test_local_gate_uses_runner_grants(tmp: str) -> None:
    old_profile = ai_local._PROFILES.get("pi")
    old_runtime_issue = ai_local._profile_runtime_issue
    old_report = caps.runtime_report
    seen = {}

    def fake_report(_root, *, grants=None):
        seen["grants"] = list(grants or [])
        return report("files", "terminal", "computer")

    ai_local._PROFILES["pi"] = {"name": "Pi", "bin": lambda: sys.executable}
    ai_local._profile_runtime_issue = lambda *_args, **_kwargs: ""
    caps.runtime_report = fake_report
    try:
        out = ai_local.dispatch_sync(
            {}, SimpleNamespace(id="t-local-grants", title="capability smoke"),
            [], {"id": "local:pi"},
            {"workDir": tmp,
             "requiredAgentCapabilities": ["computer", "office"]},
            capability_grants=["computer"])
    finally:
        if old_profile is None:
            ai_local._PROFILES.pop("pi", None)
        else:
            ai_local._PROFILES["pi"] = old_profile
        ai_local._profile_runtime_issue = old_runtime_issue
        caps.runtime_report = old_report
    chk("Local kernel reuses trusted Runner grants at its second gate",
        seen.get("grants") == ["computer"] and
        out.get("capabilityPreflight", {}).get("missing") == ["office"],
        {"seen": seen, "out": out})


async def test_runner_passes_trusted_grants(tmp: str) -> None:
    machine = runner_main.Runner(
        "http://127.0.0.1:1", "", "", "runner-grants", tmp,
        capability_grants=["computer"], max_concurrent=999)
    # This checks capability propagation through real admission, not host pressure.
    # Keep resource policy intact while providing deterministic healthy machine facts.
    machine._resource_budget.sampler = lambda: {
        "cpuCount": 8, "cpuPercent": 20.0,
        "memoryTotalBytes": 16 * 1024**3, "memoryAvailableBytes": 12 * 1024**3,
    }
    old_probe = runner_main._capabilities
    old_dispatch = ai_local.dispatch_sync
    seen = {}
    launched = asyncio.Event()
    loop = asyncio.get_running_loop()
    runner_main._capabilities = (
        lambda _root, _grants=None: report("files", "terminal", "computer"))

    def fake_dispatch(*_args, **kwargs):
        seen["grants"] = list(kwargs.get("capability_grants") or [])
        loop.call_soon_threadsafe(launched.set)
        return {"ok": True, "issueId": "trusted-grants",
                "identifier": "LOCAL-trusted-grants"}

    ai_local.dispatch_sync = fake_dispatch
    try:
        out = await machine._job({
            "op": "job.dispatch", "cli": "pi",
            "task": {"id": "t-runner-grants"},
            "ctx": {"requiredAgentCapabilities": ["computer"]},
            "requiredCapabilities": ["computer"],
        })
        await asyncio.wait_for(launched.wait(), timeout=2)
    finally:
        runner_main._capabilities = old_probe
        ai_local.dispatch_sync = old_dispatch
    chk("Runner passes device grants only through the trusted in-process call",
        out.get("ok") and seen.get("grants") == ["computer"],
        {"seen": seen, "out": out})


async def main() -> int:
    with tempfile.TemporaryDirectory(prefix="soduwork-capability-") as tmp:
        test_contract(tmp)
        test_scheduler()
        test_remote_gate()
        await test_runner_second_gate(tmp)
        test_local_gate_uses_runner_grants(tmp)
        await test_runner_passes_trusted_grants(tmp)
    print("\n%d 通过 / %d 失败" % (ok, fail))
    return 1 if fail else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
