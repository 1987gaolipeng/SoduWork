"""Expose enterprise workflow identity and delivery environments in every plugin picker.

Enterprise development workflows must identify their origin and target environment during
selection and task creation. The manifest may declare process label, route, and environments
with restricted scope. Legacy versions infer enterprise identity from merge, deploy, or
deploy_chain nodes, so existing installations do not require reimporting.
"""
from __future__ import annotations

import json
import os
import sys

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///.smoke-plugin-process.db"
sys.path.insert(0, ".")

from app.services import plugin_packages  # noqa: E402

passed = failed = 0


def ok(cond, name, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print("  PASS ", name)
    else:
        failed += 1
        print("  FAIL ", name, " << ", str(detail)[:300])


def _base(**extra):
    manifest = {
        "schemaVersion": 1, "key": "proc-demo", "name": "流程演示", "version": "1.0.0",
        "workflow": {"nodes": [
            {"key": "work", "type": "ai", "config": {"prompt": "干活"},
             "outputs": [{"key": "r", "kind": "evidence", "label": "结果"}]},
        ]},
    }
    manifest.update(extra)
    return manifest


def main() -> int:
    # Preserve valid declared process metadata.
    manifest, _, report = plugin_packages.normalize(_base(process={
        "enterprise": True, "label": "企业研发流程",
        "route": "评审 → 合并 → CICD 发布",
        "environments": [{"label": "QA 测试环境", "scope": "company"}],
    }))
    row = manifest.get("process") or {}
    ok(row.get("enterprise") is True, "声明 enterprise 保留")
    ok(row.get("label") == "企业研发流程", "声明 label 保留")
    ok("QA" in (row.get("environments") or [{}])[0].get("label", ""),
       "环境标签保留", row)
    profile = plugin_packages.process_profile(manifest, report)
    ok(profile.get("enterprise") and profile.get("environments"),
       "声明优先于推断", profile)

    # Reject invalid process scope.
    try:
        plugin_packages.normalize(_base(process={
            "enterprise": True,
            "environments": [{"label": "某环境", "scope": "galaxy"}]}))
        ok(False, "非法 scope 被拒绝")
    except ValueError as e:
        ok("scope" in str(e), "非法 scope 被拒绝", e)

    # Reject environments without display labels.
    try:
        plugin_packages.normalize(_base(process={
            "enterprise": True, "environments": [{"scope": "company"}]}))
        ok(False, "环境缺 label 被拒绝")
    except ValueError as e:
        ok("label" in str(e), "环境缺 label 被拒绝", e)

    # Infer enterprise identity for legacy workflows lacking process metadata.
    old = _base()
    old["workflow"]["nodes"].append(
        {"key": "merge", "type": "merge", "dependsOn": ["work"], "config": {}})
    manifest_old, _, report_old = plugin_packages.normalize(old)
    manifest_old.pop("process", None)  # Simulate an older stored version without the field.
    inferred = plugin_packages.process_profile(manifest_old, report_old)
    ok(inferred.get("enterprise") is True, "merge 节点推断为企业流程", inferred)
    ok(inferred.get("label") == "企业流程", "推断给默认 label", inferred)

    # Do not classify pure office workflows as enterprise delivery flows.
    manifest_office, _, report_office = plugin_packages.normalize(_base())
    manifest_office.pop("process", None)
    ok(plugin_packages.process_profile(manifest_office, report_office)
       .get("enterprise") is False, "办公形状不推断为企业流程")

    # Active built-in development plugins declare process and deployment environments.
    root = os.path.join(os.path.dirname(os.path.dirname(__file__)), "plugins")
    declared = {}
    for name in ("software-delivery",
                 "project-validation-release", "engineering-delivery"):
        with open(os.path.join(root, name + ".json"), encoding="utf-8") as f:
            m, _, r = plugin_packages.normalize(json.load(f))
        declared[name] = plugin_packages.process_profile(m, r)
    ok(all(p.get("enterprise") for p in declared.values()),
       "当前内置研发插件都是企业流程", declared)
    sd_envs = " ".join(e["label"] for e in
                       declared["software-delivery"].get("environments") or [])
    ok("项目配置" in sd_envs,
       "software-delivery 使用项目配置的交付环境", sd_envs)

    print(f"\n{passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
