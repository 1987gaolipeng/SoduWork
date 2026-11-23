"""Check installed DSH threshold compaction within one synthetic ACP prompt.

Reuses the isolated loopback driver, real native tools, process cleanup and
network guard from the lifecycle check. No installed package or user session is
modified. The baseline restores the previous provider-only SoduWork bundle.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from unittest.mock import patch

import e2e_dsh_subagent_settlement as lifecycle
from app.services import dsh_gateway

STEPS = 28
CONTEXT_WINDOW = 64000
OUTPUT_LIMIT = 16384


def content_for(stage):
    return (f"Synthetic completed step {stage:02d}: keep this file unchanged. " * 160) + "\n"


class CompactionFixture(lifecycle.Fixture):
    def response_usage(self, body, message):
        # Synthetic provider accounting follows the actual request size. It is
        # used to verify that native ACP reports lower occupancy after compaction.
        prompt = (len(json.dumps(body.get("messages", []))) + len(json.dumps(body.get("tools", [])))) // 4
        completion = max(1, len(json.dumps(message)) // 4)
        return {"prompt_tokens": prompt, "completion_tokens": completion, "total_tokens": prompt + completion}

    def response(self, body):
        assert body.get("model") == lifecycle.MODEL, "Unexpected model"
        users = [item.get("content") for item in body["messages"] if item.get("role") == "user"]
        if users and isinstance(users[-1], str) and users[-1].startswith(
            "You are now acting as a compaction engine"
        ):
            self.calls["compaction"] += 1
            self.observe("compaction_request", maxTokens=body.get("max_tokens"))
            assert 0 < body.get("max_tokens", 0) <= 8192, "Summary exceeds model output limit"
            completed = self.calls["parent"]
            return {"role": "assistant", "content": (
                "## Primary Request and Intent\n"
                "- FIXTURE:parent: Complete the synthetic file sequence.\n"
                "## Files and Code\n"
                f"- Steps 0 through {completed - 1} were written and must not be repeated.\n"
                "## Pending Jobs\n"
                f"- Continue from step {completed} through step {STEPS - 1}.\n"
                "## Next Step\n- Preserve completed files, finish the sequence, then say PARENT_DONE.\n"
            )}, "stop", None
        if not body.get("tools"):
            self.calls["title"] += 1
            return {"role": "assistant", "content": "Synthetic compaction check"}, "stop", None
        names = {tool["function"]["name"] for tool in body["tools"]}
        assert "write" in names, "Native write tool missing"
        stage = self.calls["parent"]
        self.calls["parent"] += 1
        self.observe("model_request", stage=stage, maxTokens=body.get("max_tokens"),
                     hasSummary="<compacted-summary>" in json.dumps(users), requestChars=len(json.dumps(body)))
        assert stage <= STEPS, "Unexpected extra continuation"
        if stage == STEPS:
            return {"role": "assistant", "content": "PARENT_DONE"}, "stop", None
        return {"role": "assistant", "content": None, "tool_calls": [{
            "id": f"fixture_write_{stage}", "type": "function", "function": {
                "name": "write", "arguments": json.dumps({
                    "file_path": f"step-{stage:02d}.txt", "content": content_for(stage)
                })
            }
        }]}, "tool_calls", None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--adapter-entry", required=True, type=Path)
    parser.add_argument("--runtime-root", required=True, type=Path)
    parser.add_argument("--node", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    for name in ("adapter_entry", "runtime_root", "node"):
        setattr(args, name, getattr(args, name).resolve(strict=True))
    args.expect_bug = False
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    files = [args.adapter_entry, args.adapter_entry.parent.parent / "package.json"]
    files += [args.runtime_root / "node_modules/@deepseek-ai" / module / "lib/index.js"
              for module in ("dsh-compaction-basic", "dsh-compaction", "dsh-agent-loop")]
    before = lifecycle.fingerprint(files)
    original_inject = dsh_gateway.inject_env
    original_bundles = dsh_gateway.bundle_args
    reports = []
    with tempfile.TemporaryDirectory(prefix="soduwork-dsh-compaction-") as temporary:
        root = Path(temporary).resolve()
        installation = root / "installation"
        link = installation / "agent-runtimes/dsh-host"
        link.parent.mkdir(parents=True)
        if os.name == "nt":
            shutil.copytree(args.runtime_root, link)
        else:
            link.symlink_to(args.runtime_root, target_is_directory=True)
        baseline_bundle = root / "baseline-bundle"
        baseline_bundle.mkdir()
        (baseline_bundle / "package.json").write_text(json.dumps({
            "name": "soduwork-old-gateway-fixture", "version": "1.0.0", "private": True,
            "dsh": {"bundle": {"patch": "./cordis.patch.yml"}}
        }), encoding="utf-8")
        (baseline_bundle / "cordis.patch.yml").write_text(
            "- id: llm-pi-ai\n  config:\n    providers: !!js \"JSON.parse(process.env.SODUWORK_DSH_PROVIDERS || '{}')\"\n",
            encoding="utf-8"
        )
        for mode in ("baseline", "managed"):
            def inject(env, llm):
                original_inject(env, {**llm, "contextWindow": CONTEXT_WINDOW, "maxOutputTokens": OUTPUT_LIMIT})
                if mode == "baseline":
                    # Restore only upstream compaction defaults; all other
                    # runtime settings and the actual workload stay identical.
                    env["SODUWORK_DSH_COMPACTION"] = "{}"

            with patch.object(lifecycle, "Fixture", CompactionFixture), patch.object(
                dsh_gateway, "inject_env", inject
            ), patch.object(dsh_gateway, "bundle_args", lambda: (
                ["--bundle", str(baseline_bundle)] if mode == "baseline" else original_bundles()
            )):
                report = lifecycle.run_case(args, "no-child", root / mode, output / mode, installation)
            try:
                if mode == "baseline":
                    assert not report["ok"], "Baseline unexpectedly completed without context recovery"
                    assert "context overflow" in report.get("error", ""), "Wrong baseline failure"
                    assert not report.get("fixtureFailures"), "Baseline model fixture failed"
                    report["expectedBaselineFailure"] = report.pop("error")
                    report["ok"] = True
                else:
                    assert report["ok"], report.get("error", "Native check failed")
                native = lifecycle.native_session_summary(args.node, root / mode)
                assert len(native) == 1, "Compaction replaced the native session"
                session = native[0]
                expected = [f"fixture_write_{stage}" for stage in range(STEPS)]
                assert [call["id"] for call in session["toolCalls"]] == expected, "Tools repeated or omitted"
                assert [result["id"] for result in session["toolResults"]] == expected, "Unsettled tools"
                assert not any(result["isError"] for result in session["toolResults"]), "Tool failed"
                if mode == "managed":
                    assert session["turnEnds"] == ["completed"], "Task needed another user turn"
                else:
                    assert len(session["turnEnds"]) == 1 and session["turnEnds"] != ["completed"], "Baseline hid its failure"
                assert all((root / mode / "work" / f"step-{stage:02d}.txt").read_text() == content_for(stage)
                           for stage in range(STEPS)), "Completed files changed"
                updates = json.loads((output / mode / "acp-updates.json").read_text())
                usage = [event["params"]["update"] for event in updates
                         if event.get("params", {}).get("update", {}).get("sessionUpdate") == "usage_update"]
                assert usage and all(item["size"] == CONTEXT_WINDOW for item in usage), "Missing native window receipts"
                levels = [item["used"] for item in usage]
                drops = [(before, after) for before, after in zip(levels, levels[1:]) if after < before]
                report["contextUsage"] = levels
                report["contextDrops"] = drops
                count = report["calls"].get("compaction", 0)
                if mode == "baseline":
                    model_times = [item["at"] for item in report["observations"] if item["event"] == "model_request"]
                    compaction_times = [item["at"] for item in report["observations"] if item["event"] == "compaction_request"]
                    assert all(at > model_times[-1] for at in compaction_times), "Baseline compacted before the failed turn"
                    assert not any(item.get("hasSummary") for item in report["observations"]), "Baseline used a summary"
                    assert not drops, "Baseline unexpectedly reduced its context"
                else:
                    assert count >= 2, "Long task did not compact repeatedly within its original turn"
                    assert len(drops) >= 2, "Native occupancy did not decrease after repeated compaction"
                    assert len(session["compactions"]) >= 2 and session["summaries"] >= 2, "Missing durable native checkpoints"
                    assert all(item["pendingTools"] == 0 for item in session["compactions"]), "Compaction interrupted an unfinished tool"
                    assert any(item.get("hasSummary") for item in report["observations"]), "Summary was not used"
                report.update(singleNativeSession=True, singleUserPrompt=True,
                              completedToolsExactlyOnce=STEPS, nativeSessions=native)
            except Exception as exc:
                report.update(ok=False, error=str(exc))
            report["mode"] = mode
            (output / mode / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
            reports.append(report)
            print(json.dumps({key: report.get(key) for key in ("mode", "ok", "error", "calls")}), flush=True)
    unchanged = before == lifecycle.fingerprint(files)
    summary = {
        "ok": all(report["ok"] for report in reports) and unchanged,
        "platform": sys.platform,
        "adapter": json.loads(files[1].read_text())["version"],
        "runtime": json.loads((args.runtime_root / "node_modules/@deepseek-ai/dsh/package.json").read_text())["version"],
        "node": subprocess.check_output([str(args.node), "--version"], text=True).strip(),
        "installedInputsUnchanged": unchanged,
        "temporaryStateRemoved": not root.exists(),
        "cases": reports,
        "boundary": "Real installed DSH adapter, native tools and compaction; synthetic loopback model. No production model, desktop UI, user data or credentials."
    }
    (output / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps({"ok": summary["ok"], "summary": str(output / "summary.json")}), flush=True)
    return 0 if summary["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
