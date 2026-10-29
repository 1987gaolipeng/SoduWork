/* Acceptance results and approvals share the original conversation state without duplicating task facts. */
(function (global) {
  'use strict';
  function create(ctx, { rich, render, invalidate }) {
    const acceptanceHandoffs = new Set();
    const acceptanceResultActions = new Set();
    const acceptanceKey = (taskId, approvalId) => String(taskId || '') + ':' + String(approvalId || '');
    function reset() { acceptanceHandoffs.clear(); acceptanceResultActions.clear(); }

    function _acceptanceResultHtml(text, resultKey) {
      const value = String(text || '').trim();
      // Models occasionally add a short preface or Markdown heading before the
      // protocol marker. Keep the whole reply in the result card instead of
      // falling back to plain Markdown with no decision controls.
      const marker = value.match(/(^|\n)[ \t]*(?:#{1,6}[ \t]*)?【(验收分析结果|验收退回卡|验收确认卡)】[ \t]*/);
      if (!marker) return '';
      const kind = marker[2];
      const analysis = kind === '验收分析结果';
      const rejected = kind === '验收退回卡';
      const confirmed = kind === '验收确认卡';
      const body = (value.slice(0, marker.index) + value.slice(marker.index + marker[0].length)).trim();
      const title = analysis ? '验收分析结果' : '自动验收审核结果';
      const state = analysis ? 'is-analysis' : (rejected ? 'is-rejected' : 'is-confirmed');
      const icon = rejected
        ? '<path d="m7 7 10 10M17 7 7 17"/>'
        : '<path d="m5 12.5 4.2 4.2L19 7"/>';
      const subtitle = analysis
        ? '分析已完成，请根据逐项依据在验收卡中确认或退回'
        : '自动验收会话已完成，结果与逐项依据已留在当前会话';
      const status = analysis ? '待人工确认' : (rejected ? '需要修改' : '已确认');
      const taskId = String(ctx._sessionOptions?.taskRef || ctx._sessionOptions?.taskId ||
        ctx._activeCollabTaskId || ctx._collaborationTaskId || ctx._collaborationTask?.id || '').trim();
      const taskEntry = taskId && ctx._collabTasks?.get?.(taskId);
      const approvals = taskEntry?.trace?.approvals || ctx._collaborationTrace?.approvals || [];
      const review = Array.isArray(approvals)
        ? approvals.find(item => item && item.action === 'review' && item.status === 'pending' && !item.myDecision) ||
          approvals.find(item => item && item.action === 'review')
        : null;
      const approvalId = String(ctx._sessionOptions?.approvalId || review?.id || '').trim() || (taskId ? 'direct:' + taskId : '');
      const actionKey = taskId + ':' + approvalId + ':analysis:' + String(resultKey || 'latest');
      const actions = analysis && taskId && !acceptanceResultActions.has(actionKey)
        ? '<div class="nacceptance-result-actions" data-acceptance-result-key="' + ctx.esc(actionKey) + '" data-acceptance-result-task="' + ctx.esc(taskId) + '" data-acceptance-result-approval="' + ctx.esc(approvalId) + '">' +
          '<label class="nacceptance-result-note"><span>验收意见 <small>退回时必填</small></span><textarea rows="2" maxlength="2000" data-acceptance-result-note placeholder="确认结果，或写明需要修改的内容"></textarea></label>' +
          '<label class="nacceptance-result-files"><input type="file" multiple data-acceptance-result-file hidden><span>添加返修资料（可选）</span><small data-acceptance-result-file-list></small></label>' +
          '<label class="nacceptance-result-analysis"><span>补充分析项 <small>可选</small></span><textarea rows="2" maxlength="2000" data-acceptance-result-analysis placeholder="还需要核对什么？填写后可继续分析"></textarea></label>' +
          '<div class="nacceptance-result-buttons"><button type="button" data-acceptance-result-action="analyze">继续分析</button><button type="button" data-acceptance-result-action="reject">退回修改</button><button type="button" class="primary" data-acceptance-result-action="approve">确认验收</button></div></div>'
        : '';
      return '<section class="nacceptance-result ' + state + '" aria-label="' + title + '">' +
        '<header><span class="nacceptance-result-icon" aria-hidden="true"><svg viewBox="0 0 24 24">' + icon + '</svg></span>' +
        '<span><b>' + title + '</b><small>' + subtitle + '</small></span>' +
        '<em>' + status + '</em></header>' +
        '<div class="nacceptance-result-body">' + rich(body) + actions + '</div></section>';
    }

    async function _acceptanceResultAction(button) {
      const card = button?.closest?.('[data-acceptance-result-key]');
      if (!card || button.disabled) return;
      const taskId = String(card.getAttribute('data-acceptance-result-task') || '').trim();
      const approvalId = String(card.getAttribute('data-acceptance-result-approval') || '').trim();
      const key = String(card.getAttribute('data-acceptance-result-key') || '');
      const decision = button.getAttribute('data-acceptance-result-action');
      if (decision === 'analyze') {
        const analysisInput = card.querySelector('[data-acceptance-result-analysis]');
        const prompt = String(analysisInput?.value || '').trim();
        if (!prompt) {
          if (analysisInput) analysisInput.focus();
          let error = card.querySelector('[data-acceptance-result-error]');
          if (!error) { error = document.createElement('p'); error.dataset.acceptanceResultError = ''; card.append(error); }
          error.textContent = '请填写需要补充核对的内容，再继续分析。';
          return;
        }
        const composer = ctx._mount()?.querySelector?.('#nchatInput');
        if (!composer) {
          let error = card.querySelector('[data-acceptance-result-error]');
          if (!error) { error = document.createElement('p'); error.dataset.acceptanceResultError = ''; card.append(error); }
          error.textContent = '当前对话输入框不可用，请刷新后重试。';
          return;
        }
        const followUp = '请补充验收分析：\n' + prompt;
        composer.value = [String(composer.value || '').trim(), followUp].filter(Boolean).join('\n\n');
        composer.dispatchEvent(new Event('input', { bubbles: true }));
        composer.focus();
        acceptanceResultActions.add(key);
        const notice = document.createElement('p');
        notice.className = 'nacceptance-result-followup';
        notice.textContent = '已填入对话框，请按需选择插件后发送。';
        card.replaceChildren(notice);
        return;
      }
      const note = String(card.querySelector('[data-acceptance-result-note]')?.value || '').trim();
      if (decision === 'reject' && !note) {
        const input = card.querySelector('[data-acceptance-result-note]');
        if (input) input.focus();
        let error = card.querySelector('[data-acceptance-result-error]');
        if (!error) { error = document.createElement('p'); error.dataset.acceptanceResultError = ''; card.append(error); }
        error.textContent = '请写明需要修改的内容，再退回。';
        return;
      }
      const files = [...(card.querySelector('[data-acceptance-result-file]')?.files || [])];
      if (files.length > 20) return;
      card.setAttribute('aria-busy', 'true');
      card.querySelectorAll('button,input,textarea').forEach(node => { node.disabled = true; });
      try {
        const api = global.SoduWorkAPI;
        const attachmentIds = [];
        if (decision === 'reject' && files.length) {
          const direct = approvalId.startsWith('direct:');
          const upload = direct ? api?.uploadTaskReworkMaterial : api?.uploadApprovalReworkMaterial;
          if (!upload || (direct ? !taskId : !approvalId)) throw Error('当前客户端暂不支持上传返修资料，请刷新后重试');
          for (const file of files) {
            const result = await upload(direct ? taskId : approvalId, file);
            const row = result?.attachment || result?.item || result;
            const id = String(row?.id || row?.attachmentId || '').trim();
            if (!id) throw Error('返修资料上传后没有返回附件标识');
            attachmentIds.push(id);
          }
        }
        let result;
        if (approvalId.startsWith('direct:')) {
          result = decision === 'approve' ? await api.reviewTask(taskId, note) :
            await api.rejectArtifact(taskId, note, true, attachmentIds);
        } else {
          result = await api.decideApproval(approvalId, decision, note, undefined, attachmentIds);
        }
        if (!result || result.ok === false) throw Error('验收意见没有提交成功，请刷新后重试');
        acceptanceResultActions.add(key);
        card.remove();
        /*
         * Same-person acceptance temporarily reuses the execution session. Clear its acceptance
         * marker after submitting the decision so ordinary follow-up and rework can continue;
         * preserve dedicated acceptance-session metadata.
         */
        if (ctx._sessionOptions?.acceptanceExecutionSession === true) {
          ctx._sessionOptions = { ...ctx._sessionOptions, acceptanceExecutionSession: false,
            acceptanceSession: false, acceptanceMode: 'manual', approvalId: '', acceptanceAttachmentIds: [] };
        }
        await ctx._loadCollabTask?.(taskId);
        render();
      } catch (error) {
        card.removeAttribute('aria-busy');
        card.querySelectorAll('button,input,textarea').forEach(node => { node.disabled = false; });
        let output = card.querySelector('[data-acceptance-result-error]');
        if (!output) { output = document.createElement('p'); output.dataset.acceptanceResultError = ''; card.append(output); }
        output.textContent = String(error?.message || '验收意见没有提交成功，请刷新后重试');
      }
    }

    function pendingApprovals(entry) {
      // A cloud conversation is already executing on the assigned runner.
      // Its task trace may contain workflow approvals used by the generic
      // task surface, but surfacing those as an actionable card here is
      // misleading and blocks the ordinary cloud result presentation.
      // Cloud handles can be represented by the active snapshot, the
      // controller snapshot, or the execution projection while a passive
      // view is being resumed. Treat all of those shapes as the same cloud
      // conversation so a stale task trace cannot reintroduce an approval
      // card during the short reopen window.
      const cloudConversation = ctx._snap?.cloudHandoff?.phase === 'committed' ||
        ctx._snap?.snapshot?.cloudHandoff?.phase === 'committed' ||
        ctx._snap?.execution?.cloud === true || ctx._snap?.execution?.mode === 'cloud';
      const acceptanceConversation = ctx._sessionOptions?.acceptanceSession === true ||
        ctx._sessionOptions?.acceptanceExecutionSession === true;
      /*
       * task.updated may arrive before taskTrace after acceptance elsewhere. reviewedAt is
       * authoritative completion evidence; stale approval snapshots must not restore a
       * pending-review card.
       */
      const taskReviewed = Boolean(entry.task?.reviewedAt || entry.task?.reviewed_at);
      return cloudConversation || acceptanceConversation || taskReviewed ? [] : (entry.trace.approvals || []).filter(a =>
        a.status === 'pending' && !a.myDecision && !acceptanceHandoffs.has(acceptanceKey(entry.taskId, a.id)));
    }

    function bind(list) {
      if (list && list.dataset && !list.dataset.acceptanceResultBound) {
        list.dataset.acceptanceResultBound = '1';
        list.addEventListener('click', event => {
          const button = event.target.closest?.('[data-acceptance-result-action]');
          if (button) { event.preventDefault(); void _acceptanceResultAction(button); }
        });
    }
    }

    function bindApproval(root, id, entry) {
      TaskTraceApproval.bind(root, { trace: entry.trace, opts: {
        taskId: id,
        onAcceptanceOpened: (approvalId) => { acceptanceHandoffs.add(acceptanceKey(id, approvalId)); invalidate(); },
      }, refresh: () => ctx._loadCollabTask(id) });
    }

    return { reset, html: _acceptanceResultHtml, pendingApprovals, bind, bindApproval };
  }
  global.ChatAcceptanceResults = { create };
})(window);
