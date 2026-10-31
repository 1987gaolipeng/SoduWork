# -*- coding: utf-8 -*-
"""Static main-workspace contracts for window registrations, compact navigation, business routes,
and file size.
"""
import json
from pathlib import Path
import json


ROOT = Path(__file__).resolve().parents[1]
CLIENT = ROOT / "client"
ok = fail = 0


def text(path: str) -> str:
    return (CLIENT / path).read_text(encoding="utf-8")


def chk(name: str, cond: bool, extra="") -> None:
    global ok, fail
    if cond:
        ok += 1
        print("  PASS ", name)
    else:
        fail += 1
        print("  FAIL ", name, "<<", str(extra)[:240])


specs = text("main/window-specs.js")
main = text("main.js")
preload = text("preload.js")
desk = text("desk.html")
boot = text("desk-boot.js")
window_css = text("desk-window.css")
bridge = text("core/win-bridge.js")
drag = text("core/drag.js")
overlay = text("index.html")
pet_ui = text("components/pet/pet-ui.js")
dock = text("components/pet/pet-dock.js")
pet_css = text("components/pet/pet.css")
shell_file = text("components/workspace/workspace-shell.js")
chat_list = text("components/workspace/workspace-chat-list.js")
shell_js = shell_file + chat_list
shell_style = text("components/workspace/workspace-shell.css")
navigation_style = text("components/workspace/workspace-navigation.css")
shell_css = navigation_style + shell_style
theme_css = text("theme/variables.css")
package_json = text("package.json")
distribution_source = text("main/distribution.cjs")
requirement_detail = text("components/requirements/requirements-detail.js")
task_trace = text("components/panels/task-trace-view.js")
approvals = text("components/panels/task-trace-approval.js")
approval_inbox = text("components/panels/task-approval-inbox.js")
config_css = text("components/panels/panels-agents.css")
skin_css = text("components/skin-manager/skin-manager.css")
schedules = text("components/panels/panels-schedules.js")
skills = text("components/panels/panels-skills.js")
capabilities = text("components/panels/panels-capabilities.js")
models = text("components/panels/panels-models.js")
agents = text("components/panels/panels-agents.js")
codeacct = text("components/panels/panels-codeacct.js")
desk_panel = text("components/panels/panels-desk.js")
requirements_board = text("components/requirements/requirements-board.js")
add_panel = text("components/panels/panels-add.js")
compose_panel = text("components/panels/panels-compose.js") + text("components/panels/compose-surface.js")
office_js = text("components/panels/panels-aidesk-office.js")
office_css = text("components/panels/panels-aidesk-office.css")

chk("workspace 在主进程窗口规格登记", "workspace: role('workspace'" in specs)
chk("workspace 在 desk 标题和资源登记",
    "workspace:'工作区'" in desk and "workspace-shell.css" in desk
    and "workspace-shell.js" in desk)
chk("会话历史模块先于侧栏加载",
    desk.index('src="components/workspace/workspace-chat-history.js')
    < desk.index('src="components/workspace/workspace-shell.js'))
chk("workspace 在窗口压平样式登记", 'data-desk-panel="workspace"' in window_css)
chk("workspace 在渲染启动器登记", "OPENERS.workspace" in boot and "WorkspaceHost" in boot)
chk("常规业务统一路由到正式工作区",
    "{ panel: 'workspace', view: panel }" in bridge
    and "panel === 'console' || panel === 'multi'" in bridge)

paint = dock[dock.index("function paintDock()"):dock.index("function placeDock(dock)")]
actions = [x.split('"')[0] for x in paint.split('data-act="')[1:]]
# Current dock routes: conversation, automation, requirements and notifications.
chk("桌面竖条保留对话、自动化、任务和通知，审批回到任务对话",
    actions == ["workspace", "schedules", "requirements", "notices"], actions)
chk("竖条对话与自动化各走既有正式路由",
    'data-act="workspace"' in paint and "openWorkspace()" in dock
    and "openDeskWindow({ panel: 'workspace', view: 'create' })" in dock
    and 'data-act="schedules"' in paint and "openSchedulesEntry()" in dock
    and 'data-act="pichat"' not in paint and 'data-act="newtask"' not in paint)
chk("桌面竖条作为独立组件在覆盖窗中按依赖顺序加载",
    "components/pet/pet-dock.js" in overlay
    and overlay.index("components/pet/pet-ui.js") < overlay.index("components/pet/pet-dock.js"))
skin_dock_css = pet_css[pet_css.index("[data-skin] .edge-dock{"):
                        pet_css.index("[data-skin] .edge-dock::before{")]
chk("换肤后的桌面竖条保持透明混色且不使用高开销背景模糊",
    "color-mix" in skin_dock_css and "transparent" in skin_dock_css
    and "backdrop-filter:" not in pet_css)
chk("主工作区使用换肤令牌而非固定暗色侧栏",
    "var(--ws-side)" in shell_css and "var(--accent)" in shell_css
    and "background:var(--ws-side)" in shell_css[shell_css.index(".ws-side{"):shell_css.index(".ws-side-scroll{")])
chk("工作区导航具备任务和 AI 能力入口，审批不另开旧页面",
    all(key in shell_js for key in (
        "aidesk", "history", "add", "skills", "models", "agents"))
    and not (CLIENT / "components/panels/panels-approvals.js").exists())
nav_css = shell_css[shell_css.index(".ws-nav{"):shell_css.index(".ws-recent{")]
chk("左侧菜单使用高频优先的信息架构与克制字重",
    all(label in shell_js for label in ("新对话", "自动化", "插件", "通知", "需求池", "团队", "AI 团队", "简报", "Agent 管理"))
    and "['', ['schedules', 'skills', 'library', 'notices']]" in shell_js
    and 'wsSideScroll' in shell_js and 'ws-new-chat' in shell_js
    and "['协作', ['history', 'aidesk'], 'collaboration']" in shell_js
    and "['工作内容', ['archive']]" in shell_js
    and "font-weight:700" not in nav_css and ".ws-nav-item.active" in nav_css
    and "font-size:14.5px" in nav_css and "font-weight:420" in nav_css
    and "width:15px;height:15px" in nav_css and "font-size:14.5px" in nav_css)
chk("客户端统一使用 Codex 式可变字体与开源中文字体，且不再回退微软雅黑",
    '"Segoe UI Variable Text"' in theme_css and '"Noto Sans SC"' in theme_css
    and "Microsoft YaHei" not in theme_css
    and '--font-ui:' in theme_css and '--font-display:' in theme_css
    and '--font-mono:' in theme_css and 'font-family:var(--font-ui)' in shell_css)
chk("SoduWork 品牌覆盖窗口、安装包与快捷方式",
    '"productName": "SoduWork"' in package_json
    and '"executableName": "soduwork"' in package_json  # Linux command compatibility.
    and '"artifactName": "SoduWork-${version}-Setup.exe"' in package_json
    and '"shortcutName": "SoduWork"' in package_json
    and '<title>SoduWork · 工作台</title>' in desk
    and "tray.setToolTip(_nativeText('SoduWork · 桌面任务助手'))" in main)
chk("Public identity preserves protocol and user-data compatibility",
    '"appId": "com.soduwork.app"' in package_json
    and "global.SoduWorkAPI = SoduWorkAPI" in text("api.js")
    and "global.SoduWorkAPI = SoduWorkAPI" in text("api.js")
    and "require('./main/userdata-path.cjs').initializeUserData(app)" in main
    and "profile = require('./distribution.cjs').current()" in text("main/userdata-path.cjs")
    and "path.join(app.getPath('appData'), profile.userDataName)" in text("main/userdata-path.cjs")
    and "const PROFILE_ID = 'self-hosted'" in distribution_source
    and "Unknown Client distribution" in distribution_source
    and not (CLIENT / "distributions.json").exists()
    and not (CLIENT / "main/userdata-migrate.js").exists())
# Assert the navigation intent: task creation must not become a left-navigation destination.
# Avoid exact whole-list assertions that fail when unrelated navigation entries are added.
_groups = shell_js[shell_js.index("const HOME_GROUPS = ["):]
_groups = _groups[:_groups.index("];") + 2]
chk("创建任务是任务页操作而非独立导航",
    "'add'" not in _groups and "'history'" in _groups, _groups.replace("\n", " ")[:200])
# Keep notifications prominent; account security joins the existing personal settings group.
chk("通知在主菜单，AI 与账号配置收进我的",
    "'notices'" in _groups and "'agents'" not in _groups
    and "['AI 与账号', ['account', 'usage', 'agents', 'models', 'cloud', 'codeacct']]" in shell_js
    and "['偏好', ['shortcuts', 'skin', 'settings']]" in shell_js)
chk("工作区不再额外叠一层重复页头",
    "ws-context" not in shell_js and "top:68px!important" not in shell_css
    and "inset:68px 0 0" not in shell_css)
chk("工作区系统标题不随业务页切换",
    "panel === 'workspace' ? 'SoduWork'" in main
    and "page-title-updated" in main
    and "document.title = 'SoduWork · ' + copy[0]" not in shell_js)
chk("首屏装好后才显示工作窗口",
    "deskContentReady" in preload and "desk-content-ready" in main
    and "_deskContentReady" in main and "contentReady();" in boot)
chk("工作区面板首帧即铺满且不挂旧拖动抓手",
    "#aiDeskPanel,#historyBoard,#settingsPanel,#shortcutsPanel,#skinManager" in shell_css
    and "#apPanel" not in shell_css
    and "--window-main:1" in shell_css
    and "global.__deskPanel === 'workspace'" in drag)
chk("usage panel fills workspace on first paint",
    all(token in shell_css for token in ("#caPanel", "#usagePanel", "#sessionMemoryPanel"))
    and "usage: 'usagePanel'" in boot)
chk("新版能力中心在独立窗口与正式工作区共用同一宿主",
    "skills: 'capPanel'" in boot
    and 'data-desk-panel="skills"]    :is(#skPanel,#capPanel)' in window_css
    and "#skPanel,#capPanel" in shell_css
    and "root.id = 'capPanel'" in capabilities
    and "openSkillPanel = openCapabilityPanel" in capabilities)
chk("团队切到定时任务会先收起旧页面",
    "team: 'closeTeamPanel'" in boot and "inbox: 'closeTeamPanel'" in boot)
chk("皮肤页使用紧凑自适应预览且不保留自绘关闭键",
    "minmax(300px,1fr)" in skin_css and "height:96px" in skin_css
    and ".sm-close" in shell_css)
chk("所有一级页面共享 AI 办公区标题栏规范",
    "min-height:68px!important" in shell_css
    and "set-page-head" in desk and "add-page-head" in desk
    and 'class="hb-head ws-page-head"' in requirements_board
    and 'id="hbTitleText">需求池' in requirements_board
    and 'class="np-head ws-page-head"' in desk_panel and 'data-i18n="nav.notices"' in desk_panel
    and 'id="hbApprovalInbox"' in requirements_board
    and all("sch-h-kicker" in src for src in (schedules, skills, models, agents, codeacct)))
# Physical source sizes are reviewed by tools/check-source-size.cjs (advisory).
chk("工作区会话列表先于外壳加载，导航样式由原样式入口导入",
    desk.index('src="components/workspace/workspace-chat-list.js')
    < desk.index('src="components/workspace/workspace-shell.js')
    and shell_style.startswith("@import url('./workspace-navigation.css');"))
chk("宠物交互与桌面竖条职责拆分",
    "function paintDock()" not in pet_ui and "function paintDock()" in dock)
chk("AI 工作台优先展示真实插件节点和失败原因",
    "TaskExecutionJourney?.mount" in requirement_detail
    and not (CLIENT / "components/panels/desk-task-view.js").exists()
    and "stage.error" in task_trace and "node.state" in task_trace
    and "flow.error || t.lastAction" in office_js)
chk("新建页先支持自然对话，不强迫用户创建任务",
    "想让 SoduWork 做什么？" in compose_panel and "直接对话" in compose_panel
    and "if (intent.mode === 'task')" in compose_panel
    and "_enterChat(text" in compose_panel)
chk("task form removes unreliable smart-fill",
    "aiQuick" not in desk and "_wireAiQuick" not in add_panel)
chk("task form keeps description and attachments as one input group",
    'rows="10"' in desk
    and desk.index('id="inNote"') < desk.index('id="addAttField"') < desk.index('id="prioPick"'))
chk("task form defaults both dates to today and loads execution choices together",
    "['inStart', 'inDue'].forEach" in add_panel
    and "SoduWorkAPI.taskExecutionOptions(request)" in add_panel
    and "result.workflows" in add_panel and "result.substrates" in add_panel
    and "result.repos" in add_panel
    and "field.style.display = ''" in add_panel and "is-unavailable" in add_panel)
chk("split task form module is loaded by both renderer entries",
    "components/panels/panels-add.js" in desk
    and "components/panels/panels-add.js" in overlay)
chk("AI 办公区只投影真实任务、执行者、进度与关口",
    "_dkOfficeTaskHtml(t)" in office_js and "data-office-enter-task" in office_js
    and "flow.waitingOn" in office_js and "AgentBrand.html" in office_js
    and "t.lastAction" in office_js and "aio-deliveries" in office_js
    and "animation:aioPulse" in office_css
    and ".aio-agent.is-live .aio-agent-state" in office_css)
chk("AI 办公区空闲 Agent 不伪造忙碌动画且不回归桌椅场景",
    ".aio-agent-state" in office_css
    and ".aio-agent.is-live .aio-agent-state" in office_css
    and ".aio-agent .aio-agent-state" not in office_css
    and all(name not in office_js + office_css for name in (
        "aio-seat", "aio-meeting-table", "aio-room-zone", "aio-collab-room")))
chk("待确认列表清除加载态、展示空态且丢弃过期响应",
    "listApprovals('pending')" in approval_inbox and "if (seq !== revision) return" in approval_inbox
    and "body.innerHTML = items.length" in approval_inbox
    and "暂无需要你确认的需求" in approval_inbox)
chk("对话刷新保留审批草稿与证据展开态，并合并重复请求",
    "block.dataset.approvalAccess === 'loading'" in approvals
    and "renderedCards.get(currentRoot) === markup" in approvals
    and "note.value = draft.note" in approvals and "proof.open = draft.proofOpen" in approvals)
chk("待确认列表每次刷新同步需求池与导航计数",
    "WorkspaceShell?.setApprovalCount?.(count)" in approval_inbox
    and "badge.textContent = String(count)" in approval_inbox
    and "data-task-approval-count" in approval_inbox
    and "update(result);" in approval_inbox)
chk("待确认入口只负责发现，决策进入跨设备需求详情并防重复提交",
    "global.RequirementsDetail.open(taskId)" in approval_inbox
    and "requirementId: taskId" in approval_inbox
    and "decideApproval" not in approval_inbox and "submitting.has(id)" in approvals
    and "block.dataset.approvalSubmitted === 'true'" in approvals)
summary_start = config_css.index(".cfg-panel .cfg-summary{")
summary_css = config_css[summary_start:config_css.index(".cfg-panel .cfg-notice", summary_start)]
chk("配置页顶部使用皮肤令牌的浅色状态台",
    "var(--bg-0)" in summary_css and "var(--accent)" in summary_css
    and "var(--cfg-night)" not in summary_css and "color:#fff" not in summary_css)
chk("模型与代码账号使用左侧目录、右侧详情的统一连接中心布局",
    "cfg-master-detail md-master-detail" in models
    and 'class="cfg-master md-master"' in models
    and 'class="cfg-detail md-detail"' in models
    and "data-mdselect=" in models and "_mdDetailHtml(target)" in models
    and "cfg-master-detail ca-master-detail" in codeacct
    and 'class="cfg-master ca-master"' in codeacct
    and 'class="cfg-detail ca-detail"' in codeacct
    and "_caDetailHtml(selected," in codeacct,
    ("model-master-detail", "code-account-master-detail"))
chk("配置详情只呈现一个聚焦表单并支持安全的就地验证",
    "md-editor-form st-" in models
    and "_mdBodyHtml(p, state, models, own, test)" in models
    and "md-editor-focus" not in models and "_mdKeyEdits" in models
    and all("_caNavItem('" + key + "'" in codeacct
            for key in ("identity", "token", "ssh", "test"))
    and "凭据只写不读" in codeacct and "不会修改远端内容" in codeacct
    and "url = _caUrl, revision = _caEditRevision" in codeacct
    and "SoduWorkAPI.testMyGit(url)" in codeacct
    and "url === _caUrl && revision === _caEditRevision" in codeacct)
chk("模型多窗口同步不会覆盖尚未保存的输入",
    "typeof _mdDirty !== 'undefined'" in bridge
    and "typeof _mdKeyEdits !== 'undefined'" in bridge
    and "if (dirty) return" in bridge)
chk("宽屏页面按任务类型使用有上限的内容宽度",
    "max-width:1760px" in shell_css and "max-width:1840px" in shell_css
    and "max-width:1680px" in shell_css and "max-width:1480px" in shell_css
    and "--ws-page-gutter" in shell_css)

print(f"\nworkspace smoke: {ok} passed, {fail} failed")
raise SystemExit(1 if fail else 0)
