/* Pure, bounded projections shared by native and renderer diagnostics. */
(function(root) {
  'use strict';
  function task(value) {
    const t=value || {}, r=t.workRouting || {}, turn=r.conversationTurn || {};
    return {taskId:t.id, status:t.status, requirementStage:t.requirementStage,
      effectiveMode:r.executionSubmissionMode, hasContract:!!r.outputContract,
      conversationId:turn.conversationId, turnId:turn.turnId, turnState:turn.state,
      canSubmitReview:t.canSubmitReview, canReview:t.canReview, reviewed:!!t.reviewedAt,
      rework:!!r.reworkPending, projectionPending:t.projectionPending};
  }
  function http(emit, route, body, reply, status) {
    try {
      const match=String(route || '').split('?')[0].match(/^\/(tasks|approvals)(?:\/([^/]+))?(?:\/([a-z-]+))?$/);
      if(!match)return;
      let b=body || {}; if(typeof b==='string') { try { b=JSON.parse(b); } catch { b={}; } }
      const d=reply || {}, t=d.task || (d.id && d.status ? d : {});
      emit('http.result', {...task(t), taskId:t.id || (match[1]==='tasks' ? match[2] : undefined),
        approvalId:d.request?.id || (match[1]==='approvals' ? match[2] : undefined),
        operation:match[3] || match[1], action:b.action, httpStatus:status, ok:d.ok,
        selectedMode:b.submissionMode || b.executionSubmissionMode,
        effectiveMode:d.submissionMode || t.workRouting?.executionSubmissionMode,
        conversationId:b.conversationId || t.workRouting?.conversationTurn?.conversationId,
        turnId:b.turnId || t.workRouting?.conversationTurn?.turnId,
        turnState:d.turn?.state || t.workRouting?.conversationTurn?.state,
        approvalState:d.request?.status, pendingSubmission:d.pendingSubmission,
        deferred:d.deferred, pendingRework:d.pendingRework, already:d.already,
        fileCount:Array.isArray(d.files)?d.files.length:undefined,
        invalidCount:Array.isArray(d.invalid)?d.invalid.length:undefined});
      const items=Array.isArray(d)?d:(Array.isArray(d.items)?d.items:Array.isArray(d.tasks)?d.tasks:[]);
      for(const item of items.slice(0,500))if(item?.id && item.status)emit('renderer.task',task(item));
      for(const approval of (Array.isArray(d.approvals)?d.approvals:[]).slice(0,50))
        emit('http.result',{taskId:match[2],operation:'trace',approvalId:approval.id,
          approvalState:approval.status,action:approval.action,artifactVersionId:approval.artifactVersionId});
    } catch (_) { /* Diagnostics never affect requests. */ }
  }
  function emit(event,data) { try { root.soduWorkAPI?.recordRequirementDiagnostic?.(event,data); } catch (_) {} }
  const api={task,http,emit};
  if(typeof module==='object' && module.exports)module.exports=api;
  else root.RequirementDiagnostics=api;
})(typeof window==='object'?window:globalThis);
