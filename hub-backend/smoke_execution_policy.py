# -*- coding: utf-8 -*-
"""Cross-provider execution policy: schema, real event shapes and live stop path."""
import json
import os
import shutil
import sys
import tempfile
import threading
import uuid

sys.path.insert(0, ".")
data_root = tempfile.mkdtemp(prefix="smoke-policy-")
os.environ["SODUWORK_DATA_ROOT"] = data_root
os.environ["DATABASE_URL"] = (
    "sqlite+aiosqlite:///" + os.path.join(data_root, "policy.db").replace(os.sep, "/"))

from app.services import (ai_local, execution_policy, local_execution_policy,  # noqa: E402
                          local_stream, plugin_packages, workflow_engine)
from app.services.local_base import _RUNS, _STORE  # noqa: E402

passed = failed = 0


def check(name, condition, detail=""):
    global passed, failed
    if condition:
        passed += 1
    else:
        failed += 1
        print("FAIL", name, str(detail)[:500])


POLICY = {
    "containerOrchestration": "forbid", "maxVerificationCommands": 1,
    "adHocProbe": "forbid", "commandTimeoutSeconds": 600,
    "authoritativeQuality": True,
}
normalized = execution_policy.normalize(POLICY)
check("policy normalization is stable", normalized == POLICY, normalized)
check("prompt establishes authoritative quality and precedence",
      "优先级高于" in execution_policy.prompt(normalized)
      and "权威验证" in execution_policy.prompt(normalized))
for bad in (
        {**POLICY, "containerOrchestration": "sometimes"},
        {**POLICY, "maxVerificationCommands": 11},
        {**POLICY, "commandTimeoutSeconds": 5},
        {**POLICY, "surprise": True}):
    try:
        execution_policy.normalize(bad)
        check("invalid policy is rejected", False, bad)
    except ValueError:
        check("invalid policy is rejected", True)

shapes = [
    {"assistantMessageEvent": {"type": "toolcall_end", "toolCall": {
        "id": "pi-1", "name": "bash", "arguments": {"command": "docker exec build mvn test"}}}},
    {"type": "tool_use", "id": "oc-1", "part": {
        "id": "oc-1", "tool": "bash", "state": {"input": {"command": "docker run alpine"}}}},
    {"type": "item.started", "item": {
        "id": "codex-1", "type": "command_execution", "command": "kubectl apply -f app.yml"}},
    {"message": {"content": [{"type": "tool_use", "id": "claude-1", "name": "Bash",
                              "input": {"command": "podman create alpine"}}]}},
]
for idx, message in enumerate(shapes):
    events = execution_policy.command_events(message)
    check("real CLI shape %d exposes command before enforcement" % (idx + 1),
          len(events) == 1 and events[0]["kind"] == "do" and events[0]["text"], events)
check("Codex string process notices are ignored without crashing",
      execution_policy.command_events({"type": "error", "message": "Reconnecting..."}) == [])

state = {}
check("read-only Docker inspection is allowed",
      execution_policy.inspect(
          {"kind": "do", "tool": "bash", "text": "docker --context dev ps", "callId": "r1"},
          normalized, state) is None, state)
check("read-only Kubernetes inspection is allowed",
      execution_policy.inspect(
          {"kind": "do", "tool": "bash", "text": "kubectl -n dev get pods", "callId": "r2"},
          normalized, state) is None, state)
commit_state = {}
commit_message = (
    'cd /runner-work/repo && UUID=$(cat /proc/sys/kernel/random/uuid) && '
    'git commit -m "fix empty report; mvn test and npm run build passed"')
check("build words inside a git commit message are not executable verification commands",
      execution_policy.inspect(
          {"kind": "do", "tool": "bash", "text": commit_message, "callId": "commit-1"},
          normalized, commit_state) is None
      and not commit_state.get("verificationCommands"), commit_state)
heredoc = (
    "git commit -F - <<'EOF'\n"
    "fix: keep the quality gate authoritative\n\n"
    "The independent gate runs docker build and mvn test.\n"
    "EOF\n")
heredoc_state = {}
check("heredoc commit-message prose is data rather than executable commands",
      execution_policy.inspect(
          {"kind": "do", "tool": "bash", "text": heredoc, "callId": "heredoc-1"},
          normalized, heredoc_state) is None
      and not heredoc_state.get("verificationCommands"), heredoc_state)
after_heredoc = heredoc + "docker run --rm alpine true\n"
violation_after = execution_policy.inspect(
    {"kind": "do", "tool": "bash", "text": after_heredoc, "callId": "heredoc-2"},
    normalized, {})
check("a real command after the heredoc terminator remains enforceable",
      violation_after and violation_after.get("code") == "container_orchestration",
      violation_after)
tabbed_heredoc = "git commit -F - <<-EOF\n\tdocker build is prose\n\tEOF\n./mvnw test\n"
tabbed_state = {}
check("tab-stripping heredoc is ignored while the following test is counted",
      execution_policy.inspect(
          {"kind": "do", "tool": "bash", "text": tabbed_heredoc,
           "callId": "heredoc-3"}, normalized, tabbed_state) is None
      and tabbed_state.get("verificationCommands") == 1, tabbed_state)
segmented_state = {}
check("a real verification command after a shell control operator is counted",
      execution_policy.inspect(
          {"kind": "do", "tool": "bash", "text": "cd /runner-work/repo && ./mvnw test",
           "callId": "segment-1"}, normalized, segmented_state) is None
      and segmented_state.get("verificationCommands") == 1, segmented_state)
blocked = execution_policy.inspect(
    {"kind": "do", "tool": "bash", "text": "docker exec pi-build mvn test", "callId": "r3"},
    normalized, state)
check("container orchestration is blocked",
      blocked and blocked["code"] == "container_orchestration", blocked)

verify_state = {}
first = {"kind": "do", "tool": "bash", "text": "mvn clean package", "callId": "v1"}
check("one direct verification command is allowed",
      execution_policy.inspect(first, normalized, verify_state) is None, verify_state)
check("the same tool-call event is de-duplicated",
      execution_policy.inspect(first, normalized, verify_state) is None
      and verify_state.get("verificationCommands") == 1, verify_state)
second = execution_policy.inspect(
    {"kind": "do", "tool": "bash", "text": "./mvnw test", "callId": "v2"},
    normalized, verify_state)
check("a duplicate long verification is blocked",
      second and second["code"] == "verification_limit"
      and verify_state.get("verificationCommands") == 2, (second, verify_state))

probe = execution_policy.inspect(
    {"kind": "do", "tool": "write", "text": "/tmp/RealProbeTest.java", "callId": "p1"},
    normalized, {})
check("temporary ad-hoc test source is blocked",
      probe and probe["code"] == "ad_hoc_probe", probe)
secret = execution_policy.inspect(
    {"kind": "do", "tool": "bash",
     "text": "docker run -e TOKEN=should-not-leak alpine", "callId": "s1"}, normalized, {})
check("policy evidence redacts command secrets",
      secret and "should-not-leak" not in secret["command"]
      and "<redacted>" in secret["command"], secret)

manifest = {
    "schemaVersion": 1, "key": "policy-smoke", "version": "1.0.0", "name": "策略冒烟",
    "workflow": {"nodes": [{"key": "impl", "type": "ai",
                            "config": {"prompt": "do work", "executionPolicy": POLICY}}]},
}
_, workflow, _ = plugin_packages.normalize(manifest)
check("plugin import preserves the canonical policy",
      workflow["nodes"][0]["config"]["executionPolicy"] == normalized, workflow)
manifest["workflow"]["nodes"][0]["config"]["executionPolicy"] = {**POLICY, "extra": 1}
try:
    plugin_packages.normalize(manifest)
    check("plugin import rejects unknown policy fields", False)
except ValueError as exc:
    check("plugin import rejects unknown policy fields with node context",
          "impl" in str(exc) and "executionPolicy" in str(exc), exc)

with open("plugins/engineering-delivery.json", encoding="utf-8") as stream:
    delivery = json.load(stream)
_, delivery_flow, _ = plugin_packages.normalize(delivery)
limits = {node["key"]: (node.get("config") or {}).get("executionPolicy", {}).get(
    "maxVerificationCommands") for node in delivery_flow["nodes"]}
check("the built-in delivery workflow separates scope, implementation and review duties",
      delivery["version"] == "1.5.4"
      and limits.get("scope") == 0 and limits.get("implement") == 1
      and limits.get("review") == 0, limits)
repo_flow = workflow_engine._repo_flow_context("git", {"selftest": "mvn test"})
check("Git workflow nodes inherit the project delivery protocol",
      repo_flow.get("flow") and repo_flow.get("unattended")
      and repo_flow.get("devFlow", {}).get("selftest") == "mvn test"
      and workflow_engine._repo_flow_context("files", {}) == {}, repo_flow)
task = type("Task", (), {"id": "task-123", "title": "fix", "note": ""})()
composed = ai_local._compose(task, {
    "brief": execution_policy.prompt(normalized), "deliveryMode": "git",
    "repo": {"path": "/runner-work/repo", "gitUrl": "https://gitlab.example.test/repo.git",
             "branch": "develop", "flow": True, "devFlow": {}, "unattended": True,
             "scm": "git"},
    "expectedOutputs": [{"key": "code", "kind": "git", "label": "commit"}],
    "pluginNodeName": "implement",
})
check("a GitLab plugin node retains branch delivery and global policy precedence",
      "refs/for/" not in composed and "task-123" in composed
      and "whether that instruction appears before or after" in composed, composed[-2000:])

ref = str(uuid.uuid4())
os.makedirs(os.path.join(_STORE, ref), exist_ok=True)
work = tempfile.mkdtemp(prefix="soduwork-policy-work-")
_RUNS[ref] = {
    "ref": ref, "state": "running", "cli": "pi", "seq": 0, "segment": 1,
    "ws": work, "taskId": "task-policy", "title": "policy smoke", "cfg": {},
    "lines": [], "queue": ["must be cleared"], "artifactMode": "git",
    "executionPolicy": normalized, "executionPolicyState": {},
}
killed = threading.Event()
notes = local_execution_policy.enforce(ref, shapes[0], [], lambda _ref: killed.set() or True)
check("live guard asks the process tree to stop", killed.wait(2), dict(_RUNS[ref]))
check("live guard records a visible structured violation",
      _RUNS[ref].get("stopping") and _RUNS[ref].get("failureKind") == "execution_policy"
      and not _RUNS[ref].get("queue") and notes and "已阻止" in notes[0]["text"], _RUNS[ref])
local_stream._finish(ref, -9, {}, "")
check("policy stop settles as failed rather than user-stopped",
      _RUNS[ref].get("state") == "failed"
      and _RUNS[ref].get("failureKind") == "execution_policy", _RUNS[ref])
status = ai_local.status_sync({}, ref)
guard = status.get("executionPolicyGuard") or {}
check("provider status returns an auditable policy guard",
      guard.get("enabled") and not guard.get("ok")
      and guard.get("code") == "container_orchestration", guard)
check("workflow engine treats the policy guard as an authoritative failure",
      "禁止自行编排容器" in workflow_engine._execution_policy_error(status), status)

_RUNS.pop(ref, None)
shutil.rmtree(work, ignore_errors=True)
shutil.rmtree(data_root, ignore_errors=True)
print("PASS=%d FAIL=%d" % (passed, failed))
sys.exit(1 if failed else 0)
