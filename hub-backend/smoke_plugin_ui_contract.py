"""Executable contract checks for optional plugin UI contributions."""
import os


# This is a pure contract smoke. Never inherit a developer or production DB.
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"

from app.services import (
    plugin_compat, plugin_drafts, plugin_packages, plugin_ui_contracts,
)


checks = 0


def ok(value, message):
    global checks
    if not value:
        raise AssertionError(message)
    checks += 1


def rejects(value, setup, fragment):
    global checks
    try:
        plugin_ui_contracts.normalize(value, setup)
    except ValueError as exc:
        if fragment not in str(exc):
            raise AssertionError(f"wrong error: {exc}") from exc
        checks += 1
        return
    raise AssertionError("unsafe UI contract was accepted")


def rejects_unattended(value, fragment):
    global checks
    try:
        plugin_ui_contracts.require_unattended(value)
    except ValueError as exc:
        if fragment not in str(exc):
            raise AssertionError(f"wrong unattended error: {exc}") from exc
        checks += 1
        return
    raise AssertionError("interactive UI was accepted for unattended automation")


def rejects_package(value, fragment):
    global checks
    try:
        plugin_packages.normalize(value)
    except ValueError as exc:
        if fragment not in str(exc):
            raise AssertionError(f"wrong package error: {exc}") from exc
        checks += 1
        return
    raise AssertionError("an interactive automation-only package was accepted")


setup = {
    "title": "连接工作台",
    "preferences": [{
        "key": "portalUrl", "label": "系统地址", "type": "url", "required": True,
    }],
}
ui = {
    "contributions": [{
        "id": "project-console",
        "title": "项目控制台",
        "description": "在任务详情查看外部系统的真实页面",
        "slot": "task.detail.tab",
        "icon": "globe",
        "source": {
            "type": "external",
            "url": "{{setup.portalUrl}}/projects/{{task.projectId}}/tasks/{{task.id}}",
            "openMode": "workspace",
        },
    }],
}

normalized = plugin_ui_contracts.normalize(ui, setup)
ok(len(normalized["contributions"]) == 1, "valid external contribution missing")
ok(normalized["contributions"][0]["source"]["openMode"] == "workspace",
   "external page must default to isolated workspace")
bridge_ui = {"contributions": [{
    "id": "ops-app", "title": "Operations", "slot": "workspace.navigation",
    "source": {"type": "external", "url": "https://ops.example.com/",
                "bridge": {"version": 1, "capabilities": [
                    "context.read", "conversation.open", "conversation.send",
                    "requirements.propose", "notifications.send",
                ]}},
}]}
bridge_normalized = plugin_ui_contracts.normalize(bridge_ui)
ok(bridge_normalized["contributions"][0]["source"]["bridge"]["version"] == 1,
   "web-app bridge version must be retained")
ok(len(bridge_normalized["contributions"][0]["source"]["bridge"]["capabilities"]) == 5,
   "web-app bridge capabilities must be bounded")
rejects({"contributions": [{
    "id": "bad-bridge", "title": "Unsafe", "slot": "workspace.navigation",
    "source": {"type": "external", "url": "https://ops.example.com/",
                "bridge": {"version": 1, "capabilities": ["shell.exec"]}},
}]}, {}, "bridge capability")
ok(plugin_ui_contracts.normalize(None) == {"contributions": []},
   "ordinary plugins must default to no UI")
ok(plugin_ui_contracts.has_contributions(normalized),
   "interactive UI marker must be derived from contributions")
effective = plugin_ui_contracts.effective_entrypoints(
    {"conversation": True, "task": True, "automation": True}, normalized,
    has_workflow=True)
ok(effective["conversation"] and effective["task"] and not effective["automation"],
   "interactive UI must remain visible but leave unattended automation")
rejects_unattended(normalized, "不能用于后台自动化")
rejects_package({
    "schemaVersion": 1, "key": "hidden-automation", "name": "隐藏自动化",
    "version": "1.0.0", "description": "错误地只开放后台入口。",
    "instructions": "执行工作并交付。",
    "entrypoints": {"conversation": False, "task": False, "automation": True},
    "setup": setup,
    "ui": ui,
}, "至少要开放会话或任务入口")
ok(plugin_ui_contracts.normalize({"contributions": [{
    "id": "new-task", "title": "创建任务", "slot": "workspace.navigation",
    "source": {"type": "builtin", "actionId": "work.task.create"},
}]})["contributions"][0]["source"] == {
    "type": "builtin", "actionId": "work.requirement.create"},
   "legacy first-party action must resolve to the single Task requirement form")

rejects({"contributions": [{
    "id": "bad", "title": "危险页面", "slot": "task.detail.tab",
    "source": {"type": "external", "url": "javascript:alert(1)"},
}]}, {}, "http")
rejects({"contributions": [{
    "id": "bad", "title": "未知变量", "slot": "task.detail.tab",
    "source": {"type": "external", "url": "https://example.com/{{setup.missing}}"},
}]}, setup, "未声明变量")
rejects({"contributions": [{
    "id": "bad", "title": "凭据地址", "slot": "task.detail.tab",
    "source": {"type": "external", "url": "https://example.com/?token=plain"},
}]}, setup, "不能携带")
rejects({"contributions": [{
    "id": "bad", "title": "伪造动作", "slot": "workspace.navigation",
    "source": {"type": "builtin", "actionId": "admin.delete-all"},
}]}, {}, "未开放")

manifest, _workflow, report = plugin_packages.normalize({
    "schemaVersion": 1,
    "key": "ui-contract",
    "name": "界面合同检查",
    "version": "1.0.0",
    "description": "检查插件 UI 的发布边界",
    "instructions": "读取任务上下文并交付结果。",
    "entrypoints": {"conversation": True, "task": True, "automation": True},
    "setup": setup,
    "ui": ui,
    "capabilities": {},
})
ok(manifest["ui"] == normalized, "normalized manifest lost UI contributions")
ok(any(item.get("kind") == "ui" for item in report.get("components") or []),
   "capability report must disclose employee UI")
ok(report["permissionSummary"]["externalUiCount"] == 1,
   "external UI must be visible in permission summary")
ok(manifest["entrypoints"]["automation"] is False and
   report["entrypoints"]["automation"] is False,
   "published package must normalize interactive automation to false")

package = plugin_drafts.build({
    "template": "method",
    "key": "ui-draft",
    "name": "团队页面插件",
    "version": "1.0.0",
    "description": "把外部系统页面带到任务详情",
    "instructions": "按工作方法完成任务并保留证据。",
    "setup": setup,
    "ui": ui,
})
parsed = plugin_packages.parse(package)
ok(parsed["manifest"]["ui"]["contributions"][0]["slot"] == "task.detail.tab",
   "employee maker package lost UI contribution")

impact = plugin_compat.between(
    {"id": "old", "version": "1.0.0", "manifest": {
        **manifest, "version": "1.0.0", "ui": {"contributions": []}},
     "workflow": _workflow, "capability_report": report},
    {"id": "new", "version": "1.1.0", "manifest": {
        **manifest, "version": "1.1.0"},
     "workflow": _workflow, "capability_report": report},
)
ok(any(item["code"] == "ui.added" for item in impact["changes"]),
   "adding employee UI must require upgrade review")

print(f"plugin UI contract: {checks} checks passed")
