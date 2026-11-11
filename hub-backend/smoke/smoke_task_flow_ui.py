# -*- coding: utf-8 -*-
"""Static UI contracts: task details, the AI workspace, and approvals project the same task facts.

"""
from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[2]
CLIENT = ROOT / "client"
ok = fail = 0


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def chk(name: str, cond: bool, extra="") -> None:
    global ok, fail
    if cond:
        ok += 1
        print("  PASS ", name)
    else:
        fail += 1
        print("  FAIL ", name, "<<", str(extra)[:240])


trace = read(CLIENT / "components/panels/task-trace-view.js")
runtime = read(CLIENT / "components/panels/task-trace-runtime.js")
details = read(CLIENT / "components/panels/task-trace-execution-details.js")
execution_details = read(CLIENT / "components/panels/task-trace-execution-details.js")
trace_css = read(CLIENT / "components/panels/task-trace-view.css")
requirement = read(CLIENT / "components/requirements/requirements-detail.js")
desk = read(CLIENT / "components/panels/panels-desk.js")
detail = read(CLIENT / "components/panels/panels-detail.js")
office = read(CLIENT / "components/panels/panels-aidesk-office.js")
approvals = read(CLIENT / "components/panels/task-trace-approval.js")
approval_inbox = read(CLIENT / "components/panels/task-approval-inbox.js")
chat = read(CLIENT / "components/panels/panels-chat.js") + read(CLIENT / "components/panels/chat-message-renderer.js")
acceptance_results = read(CLIENT / "components/panels/chat-acceptance-results.js")
index = read(CLIENT / "index.html")
desk_html = read(CLIENT / "desk.html")
api = read(CLIENT / "api.js")
bridge = read(CLIENT / "core/win-bridge.js")
main_js = read(CLIENT / "main.js")
approval_api = read(ROOT / "hub-backend/app/api/approvals.py")
task_api = read(ROOT / "hub-backend/app/api/tasks.py")
task_dispatch = read(ROOT / "hub-backend/app/services/task_dispatch.py")
trace_api = read(ROOT / "hub-backend/app/api/trace.py")
rework_service = read(ROOT / "hub-backend/app/services/task_rework.py")
aidesk_service = read(ROOT / "hub-backend/app/services/aidesk_view.py")

chk("统一组件暴露任务执行链路接口，并保留旧名兼容",
    "window.TaskExecutionJourney = api" in trace and "window.TaskFlowDetail = api" in trace
    and "window.TaskTraceView = api" in trace)
chk("需求详情按执行权限展开共享证据，折叠时释放订阅；决策与活动记录不重复展示",
    "task.canViewExecution === false" in requirement
    # Activity records have their own panel; reopening evidence refreshes lifecycle facts without duplicating decisions or history.
    and "TaskExecutionJourney?.mount(journey,{taskId:task.id,compact:true,suppressInlineApproval:true,suppressTimeline:true,force:true})"
    in re.sub(r"\s+", "", requirement)
    and "TaskExecutionJourney?.unmount(journey)" in requirement)
chk("AI 办公区进入统一任务会话，不再另造半屏详情",
    "openTaskConversation(focusTaskId" in desk
    and "openTaskConversation(b.getAttribute('data-office-enter-task')" in office
    and "TaskExecutionJourney.mount" not in desk)
chk("AI 办公区摘要直接消费服务端阶段，完整进度由统一链路呈现",
    "const phase = String((t || {}).phase || 'running')" in office
    and "const phase = _dkOfficePhase(t)" in office
    and "flow.waitingOn" in office and "flow.error || t.lastAction" in office
    and "execution_contract.run_progress(projection)" in aidesk_service
    and "execution_contract.workflow_office_phase(" in aidesk_service
    and "execution_contract.direct_office_phase(" in aidesk_service
    and "def _flow_phase(" not in aidesk_service
    and "def _direct_phase(" not in aidesk_service)
chk("审批在原对话内呈现，复用统一审批和证据组件",
    "ChatAcceptanceResults.create(ctx" in chat
    and "TaskTraceApproval.html(entry.trace.approvals" in acceptance_results
    and "variant: 'task'" in acceptance_results
    and desk_html.index('src="components/panels/chat-acceptance-results.js"')
        < desk_html.index('src="components/panels/chat-message-renderer.js"')
    and "TaskTraceView?.gateHtml?.(gate" in approvals)
chk("人工通用审阅使用成果验收语义，不把日常办公任务误写成代码审查",
    all(text in approvals for text in ("验收交付结果", "确认验收", "交付结果已确认"))
    and "历史交付审阅" not in approvals)
chk("流程阶段可点击，并在公共组件内切换所选阶段详情",
    "data-tfd-stage" in trace and "selectedStageId" in trace and "stageExtrasHtml" in trace)
chk("任务闭环与真实执行关卡合并成一套可点击进程",
    "function phasesHtml" in trace and "ISSUE PROGRESS" in trace and "实际执行关卡" in trace
    and "trace.phases" in trace and ".tfd-loop-strip" in trace_css and ".tfd-route" in trace_css)
chk("人工任务不伪造 AI 执行过程",
    "function isAutomated(trace)" in trace and "automated ? phasesHtml" in trace
    and "automated ? runsHtml" in trace)
chk("任务进程由执行和任务事件主动刷新，界面不再依赖手动刷新按钮",
    "soduwork-work-task-change" in runtime and "soduwork-work-execution" in runtime
    and "['refresh', '刷新'" not in trace)
chk("首屏明确展示下一步，AI 会话进展使用统一语义",
    "summary.nextAction" in trace and "SESSION_EVENT_TEXT" in trace
    and "最近进展" in execution_details and "function sessionDigest" in execution_details
    and "完整对话在" in execution_details
    and "TaskTraceExecutionDetails.sessionHtml" in trace)
chk("阶段异常提示先归一化成可读文本，不把对象直接显示成 [object Object]",
    "function errorText(value)" in trace and "const error = errorText(node.error)" in trace)
chk("证据图片直接预览，执行/确认/发布使用同一阶段详情协议",
    "tfd-evidence-gallery" in trace and "sessionDetailHtml" in trace
    and "decisionDetailHtml" in trace and "deploymentDetailHtml" in trace)
chk("审批详情由审批权限一次性返回全链路，不要求任务归属权限",
    "trace = await task_trace.trace(session, task)" in approval_api
    and '"trace": trace' in approval_api)
chk("旧审批页面已移除，原对话不渲染重复流程卡",
    not (CLIENT / "components/panels/panels-approvals.js").exists()
    and all(call not in approvals + chat for call in (
        "_apPassport(_apDetail)", "_apWorkflowCard(_apDetail)", "_apDeploymentCard(_apDetail)",
        "_apRequirementCard(_apDetail)", "_apArtifactCard(_apDetail)")))
chk("当前固定成果在公共组件里统一下载，不由人审页另造一套",
    'data-tfd-action="download"' in trace and "downloadArtifactsZip(taskId" in trace
    and "state.opts.artifactVersionId" in trace
    and "confirmation.lockedArtifact || item.artifact" in approvals
    and "data-tfd-consent" in approvals
    and "opts.artifact || delivery.artifact" in trace and "?artifactVersionId=" in api
    and "data-ap-zip" not in approvals)
chk("人审退回按任务类型进入工作流回卷或原 AI 会话续跑",
    "task_rework.resume_after_rejection" in approval_api
    and "engine_owns" in rework_service and "ai_exec.say_sync" in rework_service
    and "global.SoduWorkAPI.decideApproval(id, decision, text, undefined, reworkAttachmentIds)" in approvals
    and "data-tfd-rework value=" not in approvals
    and "rework.started" in approvals and "state.refresh(true)" in approvals)
chk("返工轮次与历史流程不会被最新状态覆盖",
    "earlierAttempts" in trace and "返工与重试记录" in trace and "历史执行记录" in trace)
chk("审批预加载事实不会被越权事件刷新",
    "opts.trace && opts.variant === 'approval'" in runtime)
chk("桌宠覆盖页预先加载统一组件，首开不静默失效",
    "task-trace-view.css" in index and "task-trace-view.js" in index)
chk("已淘汰的重复任务卡片不再加载或留在工程中",
    "task-card.js" not in index and "task-card.css" not in index
    and "task-card.js" not in desk_html and "task-card.css" not in desk_html
    and not (CLIENT / "components/panels/task-card.js").exists()
    and not (CLIENT / "components/panels/task-card.css").exists())
chk("全链路详情和旧链接均进入唯一需求抽屉",
    "return openDetailEntry(taskId)" in trace and "window.openDetailEntry?.(detailId)" in detail
    and "global.RequirementsDetail.open(taskId)" in bridge)
chk("切换需求先销毁旧抽屉，异步结果须匹配当前请求",
    "const closed = close();" in requirement and "if (closed === false) return false;" in requirement
    and "if (closed && typeof closed.then === 'function' && !(await closed)) return false;" in requirement
    and "returnFocus = previousFocus;" in requirement
    and "if (request !== seq || !root) return;" in requirement
    and "if (request !== seq || !root || task?.id !== id) return;" in requirement)
chk("旧任务详情和重复历史会话入口已移除",
    all(not (CLIENT / ("components/panels/" + name)).exists() for name in
        ("panels-thread.js", "panels-journey.js", "task-detail-support.js"))
    and 'data-rq-chat' in requirement and "source: 'requirement', navigation: true" in requirement)
chk("全链路携带审批定位，AI 办公区进入承载审批的原任务会话",
    "openApprovalsEntry(approvalFocus(trace, taskId))" in trace
    and "openTaskConversation(b.getAttribute('data-office-enter-task'), '', {source:'ai-workbench',navigation:true})" in office
    and "openTaskConversation(focusTaskId, '', {source: 'task-live', navigation: true})" in desk)
chk("待确认入口定位需求验收卡，跨设备无需本机会话存档",
    "const taskId = String(row.dataset.confirmationTask || '')" in approval_inbox
    and "global.RequirementsDetail.open(taskId)" in approval_inbox
    and "view: 'history', requirementId: taskId" in approval_inbox
    and "global.openTaskConversation(" not in approval_inbox)
chk("转人工收尾与转给同事是两个不会互相覆盖的方法和路由",
    "async handoffAutomationTask(" in api and "async handoffTask(" in api
    and "/manual-handoff" in api and '@router.post("/tasks/{tid}/manual-handoff")' in trace_api
    and "SoduWorkAPI.handoffAutomationTask(taskId" in details
    and "SoduWorkAPI.cancelTaskPluginRun" not in trace)
chk("转人工确认条独占完整一行，不会把任务标题挤成竖排",
    ".tfd-hero{position:relative;display:flex;flex-wrap:wrap" in trace_css
    and ".tfd-confirm{position:relative;flex:1 0 100%" in trace_css)
chk("直接派给 AI 后返回服务端最终任务，客户端立即校正进行中状态",
    'return await dispatch(tid, body, client, session)' in task_api
    and 'out["task"] = task_api' in task_dispatch and "return acceptTaskResult(r)" in api)
chk("认领任务同样立即接收最终任务，不出现领完后短暂找不到",
    "async claimInboxTask(tid)" in api and "return acceptTaskResult(data)" in
    api[api.index("async claimInboxTask(tid)"):api.index("async assignInboxTask", api.index("async claimInboxTask(tid)"))])
chk("首次打开新对话和定向人审时，关键参数写入 URL 防止 IPC 竞态丢失",
    "if (p.newSession) q.newSession = '1'" in main_js
    and "if (p.approvalId) q.approvalId" in main_js
    and "newSession:q.get('newSession')==='1'" in desk_html
    and "approvalId:q.get('approvalId')||''" in desk_html)
chk("跨窗人审入口只透传白名单定位字段",
    "global.openApprovalsEntry = function (focus)" in bridge
    and "taskId: String(src.taskId || '')" in bridge
    and "approvalId: String(src.approvalId || '')" in bridge
    and "routeToWorkWindow('history', { requirementId: payload.taskId })" in bridge
    and "routeToWorkWindow('history', {approvalInbox: true})" in bridge
    and "routeToWorkWindow('approvals', payload)" not in bridge)
chk("证据和发布链接交给系统浏览器，不生成失控 Electron 子窗口",
    "bridge.openExternal(href)" in trace and "event.preventDefault(); event.stopPropagation();" in trace)
chk("工作目录复制兼容 file 页面受限剪贴板",
    "TaskTraceExecutionDetails.copyText(value)" in trace
    and "document.execCommand('copy')" in execution_details and "async function copyText(value)" in execution_details)
chk("全链路生命周期运行时在覆盖窗和正式窗口显式加载",
    "task-trace-runtime.js" in index and "task-trace-runtime.js" in desk_html
    and "api.mount = mount" in runtime and "api.unmount = unmount" in runtime)
chk("操作确认组件在全链路视图前加载",
    all(page.index("components/panels/task-trace-execution-details.js") < page.index("components/panels/task-trace-view.js")
        for page in (index, desk_html)))

chk("发布后验收必须显式核对版本、质量门禁与环境范围",
    "['merge', 'deploy', 'uat'].includes" in approvals
    and "我已核对本次版本、证据与环境范围" in approvals
    and "needsVerification(approval) && !(verify && verify.checked)" in approvals
    and "draft.consent === block.getAttribute('data-tfd-consent')" in approvals)
print(f"\ntask flow UI smoke: {ok} passed, {fail} failed")
raise SystemExit(1 if fail else 0)
