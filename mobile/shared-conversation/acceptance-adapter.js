(function (global) {
  'use strict';
  let taskId = '', panel = null, busy = false, stopped = false, loading = false, timer = null;
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const call = (action, args = {}) => global.SoduWorkMobileBridge.call('acceptance', {taskId, action, ...args});
  function markup(packet) {
    const readiness = packet.readiness || {};
    const criteria = (packet.criteria || []).map(row => '<li>' + escape(row.label || row.text || '') + '</li>').join('');
    const files = (packet.attachments || []).map(row => '<li>' + escape(row.filename || row.name || '交付文件') + '</li>').join('');
    return '<div class="mobile-review-heading"><strong>交付验收</strong><span>手动验收</span></div>' +
      '<p>' + (packet.canDecide ? '核对本轮固定成果后，在这里确认或退回。' : '等待指定验收人确认。') + '</p>' +
      '<details><summary>完成标准与交付证据</summary><ul>' + criteria + files + '</ul></details>' +
      (readiness.canApprove === false ? '<p role="status">' + escape((readiness.blockers || ['验收证据尚未齐备']).join('；')) + '</p>' : '') +
      (packet.canDecide ? '<label>验收意见<textarea maxlength="2000" rows="2" placeholder="退回时请说明需要修改的地方"></textarea></label>' +
      '<label class="mobile-review-upload">添加返修资料<input type="file" multiple hidden></label><small>仅用于退回修改，不计入交付物</small><ul class="mobile-review-files"></ul>' +
      '<p>自动验收会逐项核验，并按结果确认或退回修改；发送后开始。</p>' +
      '<div class="mobile-review-actions"><button data-action="analyze">在会话中分析</button><button data-action="auto">自动验收</button><button data-action="reject">退回修改</button>' +
      '<button data-action="approve" class="primary"' + (readiness.canApprove === false ? ' disabled' : '') + '>确认验收</button></div>' : '') +
      '<p class="mobile-review-error" role="status"></p>';
  }
  async function refresh() {
    if (stopped || busy || loading || !taskId) return;
    loading = true;
    try {
      const packet = await call('load');
      if (stopped || busy) return;
      if (!packet.available) {panel?.remove(); panel = null; return;}
      const key = JSON.stringify([packet.approvalId, packet.artifactVersionId, packet.requirementVersion, packet.canDecide, packet.readiness]);
      if (panel?.dataset.version === key) return;
      const scroll = document.getElementById('nchatScroll');
      if (!scroll) return;
      const next = document.createElement('section');
      next.className = 'mobile-review-card'; next.dataset.version = key;
      next.setAttribute('aria-label', '交付验收'); next.innerHTML = markup(packet);
      if (panel) panel.replaceWith(next); else scroll.appendChild(next);
      panel = next;
      const uploads = [];
      const error = next.querySelector('.mobile-review-error');
      const lock = value => {
        busy = value;
        next.querySelectorAll('button,input,textarea').forEach(node => {
          node.disabled = value || (node.dataset.action === 'approve' && packet.readiness?.canApprove === false);
        });
      };
      next.querySelector('input')?.addEventListener('change', async event => {
        lock(true); error.textContent = '';
        try {
          const files = Array.from(event.target.files || []);
          if (files.length + uploads.length > 10 || files.some(file => file.size > 10 * 1024 * 1024)) throw Error('最多添加 10 份返修资料，每份不超过 10 MB。');
          for (const file of files) {
            const data = await new Promise((resolve, reject) => {
              const reader = new FileReader(); reader.onerror = () => reject(Error('无法读取返修资料'));
              reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.readAsDataURL(file);
            });
            const result = await call('upload', {version: packet.version, file: {name: file.name, type: file.type, data}});
            uploads.push(result.id);
            const row = document.createElement('li'); row.textContent = file.name;
            next.querySelector('.mobile-review-files').appendChild(row);
          }
        } catch (e) {error.textContent = e.message;}
        finally {event.target.value = ''; lock(false);}
      });
      next.addEventListener('click', async event => {
        const action = event.target.closest('button[data-action]')?.dataset.action;
        if (!action || busy) return;
        const note = next.querySelector('textarea')?.value.trim() || '';
        if (action === 'reject' && !note) {error.textContent = '请写清楚需要修改的地方。'; return;}
        lock(true); error.textContent = '';
        try {
          await call(action, {version: packet.version, note, attachmentIds: uploads});
          if (!['analyze', 'auto'].includes(action)) {panel?.remove(); panel = null; global.petSay?.('验收意见已提交');}
        } catch (e) {error.textContent = e.message;}
        finally {lock(false);}
      });
    } catch (e) {
      if (panel) panel.querySelector('.mobile-review-error').textContent = '验收信息暂未更新：' + e.message;
      else if (![403, 404].includes(e.status)) global.petSay?.('验收信息暂未读取：' + e.message);
    } finally {loading = false;}
  }
  global.SoduWorkMobileAcceptance = {
    start(id) {clearInterval(timer); taskId = id; void refresh(); timer = setInterval(() => {void refresh();}, 15000);},
    markup,
  };
  function resultMarkup(value, error = '') {
    const result = value?.result;
    const title = result?.error ? '自动验收未提交' : result?.verdict === 'rejected' ? '验收未通过'
      : result?.closed ? '验收通过' : result?.verdict === 'approved' ? '验收已通过，需求待收尾'
      : result ? '等待其余验收人确认' : error ? '自动验收暂未完成' : '正在自动验收';
    const note = result?.error || result?.summary || error || '正在逐项核对本轮交付。完成后会自动提交结论，可稍后回来查看。';
    return '<strong>' + title + '</strong><p>' + escape(note) + '</p>' +
      (result?.checks?.length ? '<ul>' + result.checks.map(c => '<li>' + escape(c.label || c.criterion) + '：' +
        (c.result === 'pass' ? '通过' : '未通过') + '；' + escape(c.evidence) + '</li>').join('') + '</ul>' : '') +
      (result?.verdict === 'rejected' ? '<p>' + (result.rework?.started ? '原 AI 已继续修改。' : '已保留返修意见，请回原需求查看处理安排。') + '</p>' : '');
  }
  global.SoduWorkMobileAcceptance.resultMarkup = resultMarkup;
  const unsubscribe = global.soduWorkAPI?.conversationSession?.onEvent?.(event => {
    if (event.ref !== global.NativeChat?.sessionInfo?.()?.ref) return;
    let card = document.getElementById('mobileAutoAcceptance');
    const value = event.snapshot?.mobileAcceptance;
    if (!value) {card?.remove(); return;}
    if (!card) {
      const scroll = document.getElementById('nchatScroll');
      if (!scroll) return;
      card = document.createElement('section'); card.id = 'mobileAutoAcceptance';
      card.className = 'mobile-review-card'; card.setAttribute('role', 'status'); scroll.appendChild(card);
    }
    const html = resultMarkup(value, event.snapshot?.statusText);
    if (card.innerHTML !== html) card.innerHTML = html;
  });
  global.addEventListener('pagehide', () => unsubscribe?.(), {once: true});
  global.addEventListener('pagehide', () => {stopped = true; clearInterval(timer);}, {once: true});
})(window);
