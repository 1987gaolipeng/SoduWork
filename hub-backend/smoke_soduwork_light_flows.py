"""Contract checks for the split SoduWork daytime-change and release-window flows."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

os.environ.setdefault(
    "DATABASE_URL", "sqlite+aiosqlite:///./.smoke-soduwork-light-flows.db")
sys.path.insert(0, ".")

from app.services import plugin_packages  # noqa: E402


ROOT = Path(__file__).resolve().parent.parent
passed = failed = 0


def ok(condition, name, detail=""):
    global passed, failed
    if condition:
        passed += 1
        print("  PASS ", name)
    else:
        failed += 1
        print("  FAIL ", name, " << ", str(detail)[:300])


def load(name):
    raw = json.loads((ROOT / "plugins" / name).read_text(encoding="utf-8"))
    manifest, workflow, report = plugin_packages.normalize(raw)
    return manifest, workflow, report


def by_key(workflow):
    return {node["key"]: node for node in workflow["nodes"]}


def main() -> int:
    fast, fast_flow, fast_report = load("soduwork-fast-change.json")
    release, release_flow, release_report = load(
        "soduwork-batch-release-149.json")
    fast_nodes = by_key(fast_flow)

    ok(fast["key"] == "soduwork-fast-change", "fast key")
    ok(fast["version"] == "1.0.2", "fast version")
    ok(list(fast_nodes) == ["change", "receipt"], "fast has two nodes",
       list(fast_nodes))
    ok([x["type"] for x in fast_flow["nodes"]] == ["ai", "publish"],
       "fast node types", fast_flow["nodes"])
    ok(not ({"quality", "ai_review", "merge", "deploy", "deploy_chain"}
            & {x["type"] for x in fast_flow["nodes"]}),
       "fast omits duplicated heavy gates")
    fast_cfg = fast_nodes["change"]["config"]
    ok(fast_cfg.get("agentKind") == "local:codex", "fast uses local Codex")
    ok(fast_cfg.get("model") == "gpt-5.6-sol", "fast fixed high model")
    ok(fast_cfg.get("reasoningEffort") == "xhigh", "fast fixed xhigh")
    ok(fast_cfg.get("fallbackMode") == "strict", "fast cannot downgrade")
    ok(fast_cfg.get("executionPolicy", {}).get("authoritativeQuality") is False,
       "Codex native loop owns self review")
    ok(fast_cfg.get("executionPolicy", {}).get("maxVerificationCommands") == 8,
       "fast verification budget is bounded")
    fast_outputs = fast_nodes["change"].get("outputs") or []
    ok(len(fast_outputs) == 1, "fast has one declared delivery")
    ok(fast_outputs[0].get("kind") == "git", "fast delivery is git")
    ok(fast_outputs[0].get("required") is True,
       "fast requires immutable git delivery")
    ok(fast_nodes["receipt"].get("dependsOn") == ["change"],
       "receipt follows change")
    ok(len(fast.get("evaluations") or []) == 2, "fast has two evaluations")
    ok(all(x.get("expectedOutputs") == ["change.code"]
           for x in fast.get("evaluations") or []),
       "fast evaluations require fixed commit")
    fast_prompt = fast_cfg.get("prompt") or ""
    ok("reset --hard" in fast_prompt, "fast prompt protects concurrent work")
    ok("GitLab" in fast_prompt and "任务分支" in fast_prompt and "refs/for" not in fast_prompt,
       "fast prompt uses active GitLab and Git task branches")
    ok(fast_report.get("fatal") in (None, [], False), "fast normalization clean",
       fast_report)

    ok(release["key"] == "soduwork-batch-release-149", "release key")
    ok(release["version"] == "1.0.1", "release version")
    ok(list(release_nodes) == [
        "integrate", "merge", "releaseChain", "verifyRelease", "receipt"],
       "release node order", list(release_nodes))
    ok([x["type"] for x in release_flow["nodes"]] == [
        "ai", "merge", "deploy_chain", "validate", "publish"],
       "release node types")
    release_cfg = release_nodes["integrate"]["config"]
    ok(release_cfg.get("agentKind") == "local:codex",
       "release uses local Codex")
    ok(release_cfg.get("model") == "gpt-5.6-sol",
       "release fixed high model")
    ok(release_cfg.get("reasoningEffort") == "xhigh",
       "release fixed xhigh")
    ok(release_cfg.get("fallbackMode") == "strict",
       "release cannot downgrade")
    inputs = {item["key"]: item for item in release.get("inputs") or []}
    ok(inputs.get("candidateChanges", {}).get("required") is True,
       "candidate list is required")
    ok(release_nodes["merge"]["config"].get("autoSubmit") is True,
       "release merge is automation-ready")
    ok(release_nodes["releaseChain"].get("dependsOn") == ["merge"],
       "deploy waits for merge")
    verify = release_nodes["verifyRelease"]
    ok(set(verify.get("dependsOn") or []) == {"merge", "releaseChain"},
       "verification binds merge and deploy")
    ok(verify["config"].get("deployVerify") is True,
       "release checks deployment")
    ok(verify["config"].get("shaCheck") is True,
       "release checks immutable version")
    serialized_flow = json.dumps(release_flow, ensure_ascii=False)
    ok("192.0.2.149" not in serialized_flow,
       "release has no hardcoded host")
    ok("environmentId" not in serialized_flow
       and "environmentKey" not in serialized_flow,
       "release uses project environment binding")
    ok(len(release.get("evaluations") or []) == 2,
       "release has positive and negative evaluations")
    ok((release.get("evaluations") or [None, {}])[1].get(
        "expectedOutputs") == [],
       "unsafe candidate evaluation must block")
    ok(release_report.get("fatal") in (None, [], False),
       "release normalization clean", release_report)

    engine = (ROOT / "app" / "services" / "workflow_engine.py").read_text(
        encoding="utf-8")
    ok("_verified_git_delivery" in engine
       and "code_delivery.check" in engine,
       "git output enters immutable candidate path")
    bootstrap = (ROOT / "app" / "services" / "plugin_bootstrap.py").read_text(
        encoding="utf-8")
    ok('"soduwork-fast-change.json"' in bootstrap,
       "fast flow is bootstrapped")
    ok('"soduwork-batch-release-149.json"' in bootstrap,
       "release flow is bootstrapped")

    print(f"\n{passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
