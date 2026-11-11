"""Static product contract for the plugin workshop and its safe import path."""
import ast
from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[2]
FRONT = ROOT / "hub-frontend" / "src"
BACK = ROOT / "hub-backend" / "app"
checks = 0


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def ok(condition: bool, message: str) -> None:
    global checks
    if not condition:
        raise AssertionError(message)
    checks += 1


plugin_center = read(FRONT / "screens" / "PluginCenter.jsx")
plugin_catalog = read(FRONT / "screens" / "PluginCatalogIndex.jsx")
plugin_workspace = read(FRONT / "screens" / "PluginDetailWorkspace.jsx")
install_contract = read(FRONT / "screens" / "PluginInstallContract.jsx")
screen = plugin_center + plugin_catalog + plugin_workspace
center_screen = screen
binding_dialog = read(FRONT / "screens" / "PluginBindingDialog.jsx")
run_dialogs = read(FRONT / "screens" / "PluginRunDialogs.jsx")
screen += binding_dialog + run_dialogs
overview = read(FRONT / "screens" / "PluginOverviewParts.jsx")
review = read(FRONT / "screens" / "PluginReviewDecision.jsx")
catalog_policy = read(FRONT / "screens" / "PluginCatalogPolicy.jsx")
category_manager = read(FRONT / "screens" / "PluginCategoryManager.jsx")
catalog_policy_style = read(FRONT / "screens" / "plugin-catalog-policy.css")
publishers = read(FRONT / "screens" / "PluginPublisherKeys.jsx")
publisher_style = read(FRONT / "screens" / "plugin-publishers.css")
activity_style = read(FRONT / "screens" / "plugin-activity.css")
retired_governance = FRONT / "screens" / "PluginGovernanceOverview.jsx"
retired_governance_style = FRONT / "screens" / "plugin-governance.css"
detail_tabs_style = read(FRONT / "screens" / "plugin-detail-tabs.css")
workspace_style = read(FRONT / "screens" / "plugin-admin-workspace.css")
rollout = read(FRONT / "screens" / "PluginRolloutPanel.jsx")
rollout_style = read(FRONT / "screens" / "plugin-rollout.css")
app_shell = read(FRONT / "App.jsx")
retired_automation_hub = FRONT / "screens" / "AutomationHub.jsx"
tool_access = read(FRONT / "screens" / "PluginBindingToolAccess.jsx")
tool_style = read(FRONT / "screens" / "plugin-binding-tools.css")
style = read(FRONT / "screens" / "plugin-workshop.css")
import_contract_style = read(FRONT / "screens" / "plugin-import-contract.css")
dialogs_style = read(FRONT / "screens" / "plugin-workshop-dialogs.css")
foundation_style = read(FRONT / "screens" / "plugin-foundation.css")
lifecycle = read(FRONT / "screens" / "PluginLifecycleRail.jsx")
lifecycle_style = read(FRONT / "screens" / "plugin-lifecycle.css")
author = read(FRONT / "screens" / "PluginAuthoring.jsx")
author_style = read(FRONT / "screens" / "plugin-authoring.css")
evaluation = read(FRONT / "screens" / "PluginEvaluationPanel.jsx")
evaluation_style = read(FRONT / "screens" / "plugin-evaluations.css")
client = read(FRONT / "api.js")
routes = read(BACK / "api" / "plugins.py")
packages = read(BACK / "services" / "plugin_packages.py")
starter = read(BACK / "services" / "plugin_starter.py")
runner = read(BACK / "services" / "runner_skills.py")
plugin_service = read(BACK / "services" / "plugin_service.py")
plugin_bindings = read(BACK / "services" / "plugin_bindings.py")
guide = read(ROOT / "docs" / "plugin-authoring.md")

import_flow = plugin_center.split("async function importFile(file) {", 1)[1].split("function chooseBulkFiles", 1)[0]
install_flow = plugin_service.split("async def install(", 1)[1].split("async def approve_version(", 1)[0]
ok("importPlugin: (file) => upload('/admin/plugins/import', file)" in client
   and import_flow.count("api.importPlugin(file)") == 1 and "preflight" not in import_flow
   and '@router.post("/import")' in routes and "source_channel=\"admin-import\"" in routes
   and install_flow.index("plugin_packages.parse(data)") < install_flow.index("plugin_signatures.inspect(")
       < install_flow.index("plugin_signatures.assert_importable(") < install_flow.index("plugin_packages.store(parsed)")
   and 'trust_state="quarantined", visibility=mode, enabled=False' in install_flow,
   "one-step import must validate package/signature before storing an immutable disabled review version")
ok("导入并送审" in screen and "已提交企业审核，管理员通过后即可上架" in screen
   and "等待管理员审核" in screen and "审核并上架" in screen
   and "只导入有明确使用权的插件包" in screen and "options.rightsConfirmed" in plugin_center
   and "if not open_source and not rightsConfirmed:" in routes,
   "import UX must explain quarantine, rights and the lightweight internal review path")
ok("codex: 'Codex'" in plugin_workspace and "claude: 'Claude'" in plugin_workspace
   and ".codex-plugin/plugin.json" in packages and ".claude-plugin/plugin.json" in packages,
   "Codex and Claude packages must be direct adapters, not bridge-only copy")
ok("simulatePluginVersion" in client and '@router.post("/versions/{version_id}/simulate")' in routes
   and "不创建需求、不拉代码、也不启动进程" in screen,
   "project simulation must be visibly side-effect free")
ok("runner_skills.build" in read(BACK / "services" / "ai_remote.py")
   and "runner_skills.install" in read(ROOT / "hub-backend" / "runner_main.py")
   and "完整性校验" in runner,
   "bundled skills must cross the Runner boundary with integrity checks")
ok("adapterBlockers" in packages and "unsupportedComponents" in packages,
   "unsupported plugin components must be explicit rather than silently ignored")
ok("CompatibilityNotice" in screen and "confirmBreaking" in binding_dialog,
   "breaking plugin upgrades must be visible and explicitly confirmed")
ok("snapshot.inputKeys" in screen and "snapshot.references" in screen,
   "run evidence must show typed cross-agent handoff references")
ok("plugin-secret-section" in screen and "secretRefs" in screen
   and "api.secretReferences()" in screen and "runtimeSecrets" in read(BACK / "services" / "ai_local.py"),
   "plugin bindings must map logical secrets to runner-only references")
ok("node.diagnosis" in screen
   and "api.retryRunGate(run.id, node.key, { resumeRework })" in run_dialogs
   and "diagnosis.retryable" in run_dialogs
   and "node-failure" in style + dialogs_style,
   "run drawer must explain failures and retry only the selected latest gate")
ok("downloadPluginStarter" in client and '@router.get("/starter")' in routes
   and "plugin_starter.build()" in routes and "enterprise-workflow-starter" in starter,
   "authors must be able to download a starter package produced by the real backend")
ok("PluginAuthorGuide" in screen and "WorkflowContractPanel" in screen
   and "跨 Agent 交接" in author and "节点协议" in author
   and "timeoutSeconds" in author and "timeoutSeconds" in guide,
   "plugin workshop must expose author guidance and per-node contracts")
ok("运行数据暂时没有更新" in screen and "运行状态可能已过期" in screen
   and "loadBindingCatalogs" in screen and "需求列表加载失败" in screen,
   "plugin UX must expose stale data and recover catalog, task and run polling failures")
ok("stopError" in read(BACK / "services" / "workflow_engine.py"),
   "execution policy failures must preserve runner stop errors in immutable evidence")
ok("PluginBinding" in guide and "WorkflowRun" in guide and "outputs" in guide
   and "inputs" in guide and "runner-env" in guide,
   "author guide must explain deployment binding, typed handoff and runner-only secrets")
ok("pluginEvaluations" in client and "startPluginEvaluation" in client
   and '@router.get("/versions/{version_id}/evaluations")' in routes
   and "publication_gate" in routes,
   "immutable versions must expose a real publication-evaluation gate")
ok(("开始验证" in evaluation or "开始安全评测" in evaluation)
   and "api.aiAgents()" in evaluation
   and "api.secretReferences()" in evaluation and "confirmExternalAccess" in evaluation
   and "runnerId" in evaluation and "catalog.agents" in evaluation,
   "evaluation UX must select execution routing, secret references and external-access consent")
ok("Agent 正在执行，页面会自动更新" in evaluation
   and "evaluation-live" in evaluation_style and "evaluation-pulse" in evaluation_style,
   "active evaluations must remain visibly live without manual refresh")
ok("PluginInvocationActivity" in screen and "pluginActivity" in client
   and '@router.get("/{plugin_id}/activity")' in read(BACK / "api" / "plugin_activity.py")
   and "不保存参数、返回内容或凭据" in overview,
   "plugin operators need attributable connector activity without payload leakage")
activity_api = read(BACK / "api" / "plugin_activity.py")
audit_service = read(BACK / "services" / "audit.py")
plugin_service = read(BACK / "services" / "plugin_service.py")
rollout_service = read(BACK / "services" / "plugin_rollout.py")
plugin_catalog_service = read(BACK / "services" / "plugin_catalog.py")
ok(all(name not in plugin_service + plugin_catalog_service for name in (
    "plugin_evaluations", "plugin_governance", "plugin_rollout")),
   "employee catalog and task runtime must not import optional platform governance")
ok("canManage && !internalReview" in plugin_workspace
   and "internalReview ? <details" not in plugin_workspace,
   "internal plugins must use one lightweight admin review without advanced governance")
ok("治理变更" in overview and "运行记录" in screen
   and "list_plugin_governance_activity" in activity_api
   and "targetVersionId" in audit_service and "plugin_binding" in audit_service,
   "plugin administrators need a plugin-scoped lifecycle audit beside connector calls")
binding_save = next(ast.get_source_segment(plugin_bindings, node)
                    for node in ast.parse(plugin_bindings).body
                    if isinstance(node, ast.AsyncFunctionDef) and node.name == "save_binding")
facade_save = next(ast.get_source_segment(plugin_service, node)
                  for node in ast.parse(plugin_service).body
                  if isinstance(node, ast.AsyncFunctionDef) and node.name == "save_binding")
ok("verify_readiness=verify_readiness" in facade_save
   and "readiness_check=binding_readiness" in facade_save
   and "if desired_enabled and verify_readiness:" in binding_save
   and "启用前体检未通过" in binding_save
   and "verify_readiness=False" in rollout_service,
   "every binding enable path must enforce readiness without duplicating atomic rollout probes")
ok("PluginBindingToolAccess" in screen and "pluginMcpTools" in client
   and '@router.get("/versions/{version_id}/mcp-tools")' in routes
   and "未勾选的调用会被 Hub 和 Runner 同时拒绝" in tool_access,
   "plugin bindings must approve concrete MCP tools through a live catalog")
ok("riskLevel" in tool_access and "is-high" in tool_style and "全选这组" in tool_access,
   "tool grants must show risk and keep broad selection explicit")
ok("reject-version" in screen and "PluginRiskConfirm" in screen
   and "修改要求" in review and "重新提交会生成新的不可变版本" in review
   and "note.trim()" in review,
   "plugin review must return actionable feedback before a rejected version can be resubmitted")
ok("org_units" in screen and "个团队" in screen
   and "团队范围随当前不可变版本固化" in overview,
   "team-scoped publication must be presented as teams rather than a member list")
ok("PluginCatalogPolicy" in screen and "updatePluginCatalogPolicy" in client
   and '@router.patch("/{plugin_id}/catalog-policy")' in routes,
   "employee marketplace policy must be managed through a dedicated governed surface")
ok(all(value in catalog_policy for value in (
    "installed_by_default", "not_available", "on_install", "on_use"))
   and "已有需求绑定没有改变" in catalog_policy
   and "已配置的需求绑定、历史运行和版本记录不会被删除。" in catalog_policy
   and "api.updatePluginCategories(items.map" in category_manager
   and "分类已保存，客户端目录会自动同步。" in category_manager
   and "if (onSaved) onSaved(next)" in category_manager,
   "catalog policy must separate shelf state and categories from governed task bindings")

ok("id: 'plugins'" in app_shell and "perm: 'plugin.manage'" in app_shell
   and not retired_automation_hub.exists()
   and not retired_governance.exists() and not retired_governance_style.exists(),
   "plugin governance must be an independent management entry rather than a hidden automation tab")
ok("pluginIssues" in center_screen and "pluginGovernance" in client
   and '@router.get("/governance")' in routes
   and "issues={pluginIssues(governance?.queues)[selected] || []}" in plugin_center
   and "issues.length" in plugin_catalog and "待处理事项" in plugin_workspace,
   "plugin cards and detail actions must retain the real governance read model")
ok(all(label in center_screen for label in (
       "企业插件", "插件说明", "审核与版本", "使用配置", "运行记录"))
   and all(value in plugin_workspace for value in (
       "section === 'overview'", "section === 'versions'", "section === 'settings'", "section === 'runs'"))
   and "data-detail-view" not in center_screen and "data-detail-view" not in detail_tabs_style,
   "plugin detail must mount four stable workspaces instead of hiding one long page with CSS")
ok("can('plugin.run') && approved" in center_screen
   and "require_any_perm" in routes,
   "plugin management reads and plugin execution actions must keep separate permissions")
ok("import './plugin-foundation.css'" in center_screen
   and ".plugin-page .plugin-workbench" in foundation_style
   and "display: grid" in foundation_style,
   "plugin catalog must own its layout instead of depending on another lazy screen")
ok("PluginLifecycleRail" in center_screen
   and all(label in lifecycle for label in ("包校验", "自动验证", "发布确认", "开放使用"))
   and "evaluationData.items" in lifecycle,
   "plugin lifecycle must present one clear four-stage release flow backed by live evaluation data")
ok("plugin-catalog-controls" in center_screen and "plugin-commandbar" not in plugin_center
   and "plugin-workshop-head" not in center_screen,
   "plugin management must not repeat the page title with a second oversized header")
ok("PluginCenterGuide" not in plugin_center and "PluginGovernanceOverview" not in plugin_center
   and "plugin-catalog-hero" not in plugin_center,
   "plugin center must open directly on filters and cards without overview pages")
drawer = read(FRONT / "screens" / "PluginDetailDrawer.jsx")
ok('role="dialog"' in drawer and "createPortal" in drawer and "suspended" in drawer
   and "trigger.focus()" in drawer and "event.key !== 'Tab'" in drawer,
   "detail drawer must preserve focus and leave nested dialogs in control")
ok("!plugin.orgId && provenance.signatureState === 'unknown-key'" not in plugin_workspace
   and "核对发布者" in plugin_workspace,
   "internal signed packages must expose the publisher action required by the server")

ok("PluginRolloutPanel" in center_screen and "pluginRollout" in client
   and "applyPluginRollout" in client
   and '@router.get("/{plugin_id}/rollout")' in routes
   and '@router.post("/{plugin_id}/rollout")' in routes,
   "plugin versions need one governed rollout and rollback surface")
ok("任何一项体检失败，全部绑定保持不变" in rollout
   and "expectedVersions" in rollout and "confirmBreaking" in rollout
   and "原子切换" in rollout,
   "rollout UX must explain atomicity, optimistic locking and breaking confirmation")
rollout_service = read(BACK / "services" / "plugin_rollout.py")
ok("with_for_update()" in rollout_service and "commit=False" in rollout_service
   and "await session.rollback()" in rollout_service,
   "batch rollout must lock, defer per-binding commits and roll back as one transaction")
ok("PluginPublisherCandidate" in screen and "trustPluginPublisherCandidate" in client
   and '@router.post("/versions/{version_id}/publisher-candidate/trust")' in routes
   and "登记公钥不等于发布插件" in publishers
   and "私钥始终留在作者设备" in publishers,
   "unknown personal publishers need an explicit fingerprint review and one-click trust flow")

ok("PluginFormDesigner" not in author and "author-boundary" in author
   and "管理员无需在后台编辑插件内容" in author and "不可变版本" in author,
   "admin authoring must govern immutable submissions instead of editing packages")
ok('<PluginInstallContract version={version} />' in plugin_workspace
   and "plugin-preview-setup" in install_contract and "version?.manifest?.setup" in install_contract
   and "以下内容来自所选版本，仅供审核；修改须发布新版本" in install_contract
   and "SETUP_TYPES" in install_contract and "field.sensitive !== true" in install_contract
   and not re.search(r"<(?:input|textarea|select)\b", install_contract),
   "admin import must review a read-only version-bound setup contract")
ok("@media (max-width: 900px)" in author_style
   and "plugin-preview-setup" in import_contract_style
   and "@media (max-width: 480px)" in import_contract_style,
   "plugin governance surfaces must adapt to narrow screens")

sizes = [float(x) for x in re.findall(
    r"font-size:\s*([0-9.]+)px", style + dialogs_style + foundation_style + lifecycle_style
    + author_style + evaluation_style + activity_style + tool_style + catalog_policy_style
    + publisher_style + detail_tabs_style + workspace_style
    + rollout_style + import_contract_style)]
ok(sizes and min(sizes) >= 10, "plugin authoring text must remain commercially readable")
# Physical source sizes are reviewed by tools/check-source-size.cjs (advisory).

print(f"plugin UI: {checks} checks passed")
