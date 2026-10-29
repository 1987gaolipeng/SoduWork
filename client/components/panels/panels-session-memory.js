/* Imported session evidence stays private. Only an explicitly selected summary
   is carried into a new conversation; source instructions are displayed as text. */
(function (global) {
  'use strict';
  const FIELDS = { summary: '会话摘要', goal: '目标与最新要求', decisions: '已确认的决定',
    constraints: '约束', pending: '未完成与待确认', outcomes: '交付结果' };
  const LIMITS = { summary: 6000, goal: 3000, decisions: 3000, constraints: 3000, pending: 3000, outcomes: 3000 };
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const api = () => (global.soduWorkAPI?.conversationSession || global.soduWorkAPI?.piSession)?.memory;
  let panel, sequence = 0, listSequence = 0, optionsSequence = 0, current = null, previewId = '', choices = null;
  let wizardStep = 'idle';
  let busy = false, personalDraft = null, importMode = false, loadingPersonal = false, accountKey = '';
  const UI = { archived: '\u663e\u793a\u5df2\u5f52\u6863', restore: '\u6062\u590d', archive: '\u5f52\u6863', source: '\u6765\u6e90\u4fe1\u606f', attachments: '\u9644\u4ef6\u5f15\u7528\uff1a\u672a\u5bfc\u5165\u539f\u4ef6' };
  // The library is the editable personal-memory surface. Session summaries,
  // engineering context, and project context stay local and are consumed by
  // conversations; they are not exposed as editable rows in My Memory.
  let entry = null;

  function wizardMarkup(step) {
    const active = step === 'confirm' ? 2 : 1;
    const labels = ['选择文件', '检查与整理', '确认保存'];
    return '<div class="cmem-wizard" data-wizard data-wizard-step="' + esc(step) + '">' +
      '<ol aria-label="Codex 会话导入步骤">' + labels.map((label, index) =>
        '<li class="' + (index < active ? 'is-done ' : '') + (index === active ? 'is-active' : '') + '">' +
        '<span>' + (index + 1) + '</span><b>' + label + '</b></li>').join('') + '</ol>' +
      '<p data-wizard-hint>' + (step === 'confirm' ? '最后确认后才会保存到 SoduWork；来源记录仍保持私有。'
        : '文件只在本机解析，先检查来源、摘要和安全边界，再决定是否保存。') + '</p></div>';
  }

  function memoryContext() {
    const context = global.WorkspaceShell && typeof global.WorkspaceShell.newSessionContext === 'function'
      ? (global.WorkspaceShell.newSessionContext() || {}) : {};
    const chrome = global.ChatChrome && global.ChatChrome.workspace || {};
    return { cwd: String(context.cwd || chrome.dir || '').trim(), sidebarProjectId: String(context.sidebarProjectId || '').trim() };
  }
  function message(text, error = false) {
    const area = panel.querySelector('[data-message]');
    area.textContent = text;
    area.classList.toggle('is-error', error);
  }
  function requireOk(result) {
    if (!result || result.ok === false) throw Error(result?.reason || '操作没有完成，请重试');
    return result;
  }
  function mount() {
    if (panel) return panel;
    panel = document.createElement('section');
    panel.id = 'sessionMemoryPanel';
    panel.className = 'sch-panel cmem-panel';
    panel.innerHTML = '<header class="sch-head cmem-head ws-page-head"><div class="sch-h-txt">' +
      '<span class="cmem-kicker" data-i18n="eyebrow.personal_memory">PERSONAL MEMORY</span><b class="sch-h-title">我的记忆</b>' +
      '<span class="cmem-muted">从已完成的日常对话自动积累，后续工作会自动参考；仅保存在当前账号的本机</span></div>' +
      '<div class="cmem-head-actions"><span class="cmem-singleton">\u4e00\u4e2a\u8d26\u53f7\u4ec5\u4fdd\u7559\u4e00\u4efd</span>' +
      '<button type="button" data-import class="cmem-secondary">\u5bfc\u5165 Codex \u4f1a\u8bdd</button></div></header>' +
      '<div data-message class="cmem-message" role="status" aria-live="polite"></div>' +
      '<div class="cmem-document-layout"><section data-detail class="cmem-detail" aria-label="\u4e2a\u4eba\u8bb0\u5fc6\u6587\u6863"></section></div>';
    document.body.appendChild(panel);
    panel.querySelector('[data-import]').addEventListener('click', importFile);
    return panel;
  }

  function memoryKey() {
    const context = memoryContext();
    return accountKey + '|' + context.cwd + '|' + context.sidebarProjectId;
  }
  function rememberPersonalDraft(form) {
    const content = form.elements.content?.value || '';
    personalDraft = { key: memoryKey(), accountKey, content, dirty: true, base: current?.__dimension ? current : null };
    form.dataset.dirty = '1';
    const count = form.querySelector('[data-content-count]');
    if (count) count.textContent = content.length.toLocaleString() + ' / 16 MiB';
  }
  async function loadList() {
    const turn = ++listSequence, epoch = sequence;
    if (importMode) return;
    try {
      const modernApi = api()?.dimensions;
      const modern = requireOk(await (modernApi?.list ? modernApi.list({ ...memoryContext(), scope: 'personal' }) : { items: [] }));
      if (turn !== listSequence || epoch !== sequence || !panel.classList.contains('show') || importMode) return;
      const nextAccount = String(modern.accountKey || '');
      if (accountKey && nextAccount !== accountKey) { personalDraft = null; current = null; }
      const previousKey = memoryKey();
      accountKey = nextAccount;
      if (personalDraft?.key === previousKey && !personalDraft.accountKey) { personalDraft.key = memoryKey(); personalDraft.accountKey = accountKey; }
      const items = Array.isArray(modern.items) ? modern.items : [];
      const detail = items[0] ? requireOk(await modernApi.get({ id: items[0].id, ...memoryContext() })) : null;
      if (turn !== listSequence || epoch !== sequence || !panel.classList.contains('show') || importMode) return;
      loadingPersonal = false;
      const item = detail?.item ? { ...detail.item, __dimension: true } : null;
      if (items.length > 1) message('检测到旧版多条个人记忆，已按一份 personal.md 处理。', false);
      const form = panel.querySelector('[data-personal-form]');
      const dirty = form?.dataset.dirty === '1' && personalDraft?.key === memoryKey();
      if (item) {
        current = dirty && personalDraft?.base ? personalDraft.base : item;
        if (!dirty) renderDimensionDetail();
      } else {
        current = dirty && personalDraft?.base ? personalDraft.base : null;
        if (!dirty) renderDimensionDetail();
      }
    } catch (error) { if (epoch === sequence) message(error.message, true); }
  }

  function empty() {
    if (!panel) return;
    importMode = false;
    current = null;
    renderDimensionDetail();
  }

  function clearPreview() {
    if (previewId) api()?.cancel(previewId).catch(() => {});
    previewId = '';
  }
  async function importFile() {
    if (busy || !api()) return;
    const epoch = ++sequence;
    busy = true; panel.querySelector('[data-import]').disabled = true;
    clearPreview();
    try {
      const result = await api().preview();
      if (epoch !== sequence) { if (result?.previewId) api().cancel(result.previewId); return; }
      if (result?.canceled) return;
      requireOk(result);
      previewId = result.previewId; current = result; importMode = true; wizardStep = 'review';
      choices = await api().options();
      if (epoch !== sequence) { api().cancel(previewId).catch(() => {}); return; }
      requireOk(choices);
      message('摘要由消息摘录生成，请核对后修改。未明确记载的决定和待办会留空。');
      renderDetail();
    } catch (error) {
      if (epoch === sequence) {
        clearPreview(); current = null; importMode = false; wizardStep = 'idle'; renderDimensionDetail(); message(error.message, true);
      }
    }
    finally {
      busy = false; panel.querySelector('[data-import]').disabled = false;
    }
  }
  async function select(id, modern = false) {
    const epoch = ++sequence;
    clearPreview(); wizardStep = 'idle';
    message('');
    try {
      const detail = await (modern ? api().dimensions.get({ id, ...memoryContext() }) : api().get(id));
      const options = modern ? { projects: [], repos: [], tasks: [] } : await api().options();
      if (epoch !== sequence) return;
      current = requireOk(detail).item; current.__dimension = modern; choices = requireOk(options);
      renderDetail();
      loadList(false);
    } catch (error) { if (epoch === sequence) message(error.message, true); }
  }
  function optionRows(rows, value, label, emptyLabel) {
    const missing = value && !rows.some(row => row.id === value);
    return '<option value="">' + esc(emptyLabel) + '</option>' +
      (missing ? '<option selected value="' + esc(value) + '">已关联，当前列表未显示</option>' : '') +
      rows.map(row => '<option value="' + esc(row.id) + '"' + (row.id === value ? ' selected' : '') +
      '>' + esc(row[label]) + '</option>').join('');
  }
  function associations() {
    const p = panel.querySelector('[data-project]'), r = panel.querySelector('[data-repo]');
    const pid = p?.value ?? current.projectId ?? '';
    const rid = r?.value ?? current.repoId ?? '';
    if (p) p.innerHTML = optionRows(choices.projects || [], pid, 'name', '不关联项目');
    if (r) r.innerHTML = optionRows((choices.repos || []).filter(row => !pid || row.projectId === pid),
      rid, 'name', '不关联工程');
  }
  function renderDimensionDetail() {
    const root = panel.querySelector('[data-detail]');
    const item = current?.__dimension ? current : null;
    const draft = !loadingPersonal && personalDraft?.key === memoryKey() && personalDraft.dirty ? personalDraft.content : null;
    const content = draft != null ? draft : (item?.editableContent ?? item?.content ?? '');
    const pathLabel = item?.relativePath || item?.fileName || 'personal.md';
    const bytes = Number(item?.bytes || 0);
    const sizeLabel = bytes > 0 ? (bytes < 1024 ? bytes + ' B' : bytes < 1048576 ? (bytes / 1024).toFixed(1) + ' KB' : (bytes / 1048576).toFixed(1) + ' MB') : '';
    const emptyHero = item || draft != null || loadingPersonal ? '' :
      '<div class="cmem-empty-hero"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l2.3 5.1 5.2 2.4-5.2 2.4-2.3 5.1-2.3-5.1-5.2-2.4 5.2-2.4z"/></svg>' +
      '<b>还没有个人记忆</b><span>完成对话后，工作摘要会自动写进这份文档；现在也可以直接记下希望 SoduWork 记住的事。</span></div>';
    root.innerHTML = '<form class="cmem-form cmem-personal-form" data-personal-form>' + emptyHero +
      '<div class="cmem-document-heading"><div><span class="cmem-kicker" data-i18n="eyebrow.local_document">LOCAL DOCUMENT</span><h2>个人记忆</h2></div><span class="cmem-private">仅自己可见</span></div>' +
      '<div class="cmem-file-bar"><span class="cmem-file-icon">MD</span><div><b>personal.md</b><small>\u672c\u5730\u6587\u4ef6 \u00b7 \u6bcf\u4e2a\u8d26\u53f7\u4e00\u4efd</small></div>' +
      (sizeLabel ? '<span class="cmem-file-size">' + esc(sizeLabel) + '</span>' : '') +
      '<span class="cmem-file-path">' + esc(pathLabel) + '</span></div>' +
      '<label class="cmem-content-label"><span>\u8bb0\u5fc6\u5185\u5bb9</span><textarea name="content" data-personal-content maxlength="16777216" rows="18" placeholder="完成对话后，工作摘要会自动出现在这里。也可以补充希望 SoduWork 记住的事情…">' + esc(content) + '</textarea></label>' +
      '<div class="cmem-editor-footer"><span class="cmem-count" data-content-count>' + content.length.toLocaleString() + ' / 16 MiB</span><span class="cmem-muted">自动保留近期工作摘要，也可以补充或修正内容</span></div>' +
      '<footer class="cmem-actions"><button type="submit" class="cmem-primary">\u4fdd\u5b58 personal.md</button>' + (item ? '<button type="button" data-dim-delete>\u5220\u9664\u6587\u4ef6</button>' : '') + '</footer></form>';
    const form = root.querySelector('form');
    form.elements.content.disabled = loadingPersonal;
    form.querySelector('[type=submit]').disabled = loadingPersonal;
    form.dataset.dirty = draft != null ? '1' : '0';
    form.addEventListener('input', () => rememberPersonalDraft(form));
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (busy || !form.reportValidity()) return;
      busy = true;
      try {
        const body = { content: form.elements.content.value, revision: current?.revision || '' };
        const result = current?.__dimension
          ? requireOk(await api().dimensions.update({ id: current.id, ...memoryContext() }, body))
          : requireOk(await api().dimensions.create({ ...memoryContext(), scope: 'personal', title: '\u4e2a\u4eba\u8bb0\u5fc6', content: body.content }));
        if (!current?.__dimension && result.created === false && result.item?.content !== body.content) {
          current = { ...result.item, __dimension: true };
          throw Error('个人记忆已自动更新，草稿已保留，请核对现有内容后再保存。');
        }
        current = { ...result.item, __dimension: true };
        personalDraft = null;
        renderDimensionDetail();
        await loadList();
        message('\u4e2a\u4eba\u8bb0\u5fc6\u5df2\u4fdd\u5b58\uff0c\u59cb\u7ec8\u4fdd\u6301\u4e00\u4efd personal.md');
      } catch (error) { message(error.message, true); } finally { busy = false; }
    });
    form.querySelector('[data-dim-delete]')?.addEventListener('click', async () => {
      if (busy || !global.confirm((global.SoduWorkI18n?.translateText || String)('\u5220\u9664 personal.md \u5417\uff1f\u5220\u9664\u540e\u4e0d\u4f1a\u4ece\u65e7\u6587\u4ef6\u590d\u6d3b'))) return;
      busy = true;
      try { requireOk(await api().dimensions.delete({ id: current.id, ...memoryContext() })); current = null; personalDraft = null; renderDimensionDetail(); await loadList(); message('\u4e2a\u4eba\u8bb0\u5fc6\u5df2\u5220\u9664'); }
      catch (error) { message(error.message, true); } finally { busy = false; }
    });
  }

  function renderDetail() {
    if (current?.__dimension) return renderDimensionDetail();
    const draft = Boolean(previewId), fields = current.fields || {};
    if (draft && !['review', 'confirm'].includes(wizardStep)) wizardStep = 'review';
    const step = draft ? wizardStep : 'library';
    const root = panel.querySelector('[data-detail]');
    root.innerHTML = '<form class="cmem-form"><div class="cmem-detail-title"><h2>' +
      (draft ? '预览与确认' : '会话记忆') + '</h2><span class="cmem-private">仅自己可见</span></div>' +
      (draft ? wizardMarkup(step) : '') +
      '<div class="cmem-source-card"><b>' + UI.source + '</b><span>' + esc(current.sourceMeta?.fileName || current.source || 'Codex') + '</span>' +
      (current.sourceMeta?.retained ? '<small>' + esc(String(current.sourceMeta.retained)) + ' events' +
        (current.sourceMeta.scanned ? ' / ' + esc(String(current.sourceMeta.scanned)) + ' scanned' : '') +
        (current.sourceMeta.attachmentCount ? ' \u00b7 ' + UI.attachments : '') + '</small>' : '') + '</div>' +
      (draft ? '<div class="cmem-safety-card"><b>\u5b89\u5168\u8fb9\u754c</b><span>\u53ea\u4fdd\u5b58\u8131\u654f\u540e\u7684\u6587\u672c\u6458\u8981\uff1b\u4e0d\u4f1a\u6267\u884c\u5386\u53f2\u547d\u4ee4\u3001\u4e0a\u4f20\u9644\u4ef6\u6216\u628a\u6765\u6e90\u6307\u4ee4\u5f53\u4f5c\u672c\u6b21\u6307\u4ee4\u3002</span></div>' : '') +
      '<label>标题<input name="title" maxlength="240" required value="' + esc(current.title) + '"></label>' +
      '<div class="cmem-association"><label>项目<select data-project>' +
      optionRows(choices.projects || [], current.projectId, 'name', '不关联项目') + '</select></label>' +
      '<label>Git 工程<select data-repo></select></label></div>' +
      '<details class="cmem-task-link"><summary>关联任务（可选）</summary><div class="cmem-association">' +
      '<label>查找任务<input data-task-search type="search" maxlength="120" placeholder="按任务标题搜索"></label>' +
      '<label>任务<select data-task>' + optionRows(choices.tasks || [], current.taskId, 'title', '不关联任务') +
      '</select></label></div></details>' +
      Object.entries(FIELDS).map(([key, label]) => '<label>' + label + '<textarea name="' + key +
        '" maxlength="' + LIMITS[key] + '" rows="' + (key === 'summary' ? 5 : 2) + '"' +
        (key === 'summary' ? ' required' : '') + '>' + esc(fields[key]) + '</textarea></label>').join('') +
      '<details class="cmem-evidence"><summary>查看来源摘录（' + (current.events || []).length + ' 条）</summary>' +
      '<div data-events></div><button type="button" data-events-more>继续查看来源</button></details>' +
      ((current.warnings || []).length ? '<ul class="cmem-warnings">' + current.warnings.map(w => '<li>' + esc(w) + '</li>').join('') + '</ul>' : '') +
      (draft ? '<label class="cmem-confirm"><input data-confirm type="checkbox" required><span>\u6211\u5df2\u6838\u5bf9\u6458\u8981\uff0c\u540c\u610f\u5c06\u6458\u8981\u548c\u4e0a\u8ff0\u8131\u654f\u8bc1\u636e\u4fdd\u5b58\u5230\u5f53\u524d\u8d26\u53f7\u7684\u672c\u673a\uff0c\u4ec5\u81ea\u5df1\u53ef\u89c1\u3002</span></label>' :
        '<p class="cmem-muted">\u8fd9\u6761\u8bb0\u5fc6\u5df2\u7ecf\u4fdd\u5b58\u3002\u4fee\u6539\u53ea\u4f1a\u66f4\u65b0\u6458\u8981\u548c\u5173\u8054\u8303\u56f4\uff0c\u4e0d\u4f1a\u91cd\u65b0\u4e0a\u4f20\u539f\u59cb\u4f1a\u8bdd\u3002</p>') +
      '<footer class="cmem-actions"><button type="submit" data-wizard-submit class="cmem-primary"' +
      (draft && step !== 'confirm' ? ' disabled' : '') + '>' +
      (draft ? '确认导入' : '保存修改') + '</button>' +
      (draft ? '<button type="button" data-wizard-next>\u4e0b\u4e00\u6b65\uff1a\u786e\u8ba4\u5bfc\u5165</button><button type="button" data-wizard-back hidden>\u8fd4\u56de\u68c0\u67e5</button><button type="button" data-cancel>取消预览</button>' :
        '<button type="button" data-use>用于新对话</button><button type="button" data-archive>' + (current.archived ? UI.restore : UI.archive) + '</button><button type="button" data-delete>删除记忆</button>') +
      '</footer></form>';
    const form = root.querySelector('form');
    const use = form.querySelector('[data-use]');
    const wizard = root.querySelector('[data-wizard]');
    const next = form.querySelector('[data-wizard-next]');
    const back = form.querySelector('[data-wizard-back]');
    const submit = form.querySelector('[data-wizard-submit]');
    function setWizard(nextStep) {
      wizardStep = nextStep;
      if (!wizard) return;
      wizard.dataset.wizardStep = nextStep;
      const items = [...wizard.querySelectorAll('li')];
      items.forEach((item, index) => {
        item.classList.toggle('is-done', index < (nextStep === 'confirm' ? 2 : 1));
        item.classList.toggle('is-active', index === (nextStep === 'confirm' ? 2 : 1));
      });
      const hint = wizard.querySelector('[data-wizard-hint]');
      if (hint) hint.textContent = nextStep === 'confirm' ? '最后确认后才会保存到 SoduWork；来源记录仍保持私有。'
        : '文件只在本机解析，先检查来源、摘要和安全边界，再决定是否保存。';
      if (next) next.hidden = nextStep === 'confirm';
      if (back) back.hidden = nextStep !== 'confirm';
      if (submit) submit.disabled = draft && nextStep !== 'confirm';
      if (nextStep === 'confirm') form.querySelector('[data-confirm]')?.focus();
    }
    next?.addEventListener('click', () => setWizard('confirm'));
    back?.addEventListener('click', () => setWizard('review'));
    if (draft && wizardStep === 'confirm') setWizard('confirm');
    if (use && current.archived) {
      use.disabled = true;
      use.title = '归档记忆需要先恢复，才能用于新对话';
    }
    form.addEventListener('input', event => {
      if (use && !event.target.matches('[data-task-search], [data-confirm]')) {
        use.disabled = true; use.title = '保存修改后再用于新对话';
      }
    });
    const repoSelect = form.querySelector('[data-repo]');
    repoSelect.innerHTML = optionRows((choices.repos || []).filter(r => !current.projectId || r.projectId === current.projectId),
      current.repoId, 'name', '不关联工程');
    form.querySelector('[data-project]').addEventListener('change', () => {
      repoSelect.value = ''; form.querySelector('[data-task]').value = ''; associations();
    });
    repoSelect.addEventListener('change', () => {
      const repo = choices.repos.find(r => r.id === repoSelect.value);
      if (repo) form.querySelector('[data-project]').value = repo.projectId;
      form.querySelector('[data-task]').value = '';
    });
    form.querySelector('[data-task]').addEventListener('change', event => {
      const task = choices.tasks.find(t => t.id === event.target.value);
      if (!task) return;
      form.querySelector('[data-project]').value = task.projectId;
      repoSelect.innerHTML = optionRows(choices.repos.filter(r => r.projectId === task.projectId),
        task.repoId, 'name', '不关联工程');
    });
    form.querySelector('[data-task-search]').addEventListener('input', async event => {
      const epoch = sequence, request = ++optionsSequence;
      try {
        const next = requireOk(await api().options({ search: event.target.value }));
        if (epoch !== sequence || request !== optionsSequence) return;
        choices.tasks = next.tasks;
        const select = form.querySelector('[data-task]');
        select.innerHTML = optionRows(next.tasks, select.value, 'title', '不关联任务');
      } catch (error) { if (epoch === sequence) message(error.message, true); }
    });
    let count = 0;
    function moreEvents() {
      const events = current.events || [];
      const target = form.querySelector('[data-events]');
      for (const e of events.slice(count, count + 50)) {
        const article = document.createElement('article');
        const label = document.createElement('b'), body = document.createElement('pre');
        label.textContent = (e.role === 'user' ? '用户' : e.role === 'assistant' ? 'Codex' : '工具记录') + ' · ' + e.id;
        body.textContent = e.text; article.append(label, body); target.appendChild(article);
      }
      count += 50; form.querySelector('[data-events-more]').hidden = count >= events.length;
    }
    moreEvents(); form.querySelector('[data-events-more]').addEventListener('click', moreEvents);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (draft && wizardStep !== 'confirm') { setWizard('confirm'); return; }
      if (busy || !form.reportValidity()) return;
      const epoch = sequence, body = { title: form.elements.title.value.trim(), fields: {},
        projectId: form.querySelector('[data-project]').value, repoId: repoSelect.value,
        taskId: form.querySelector('[data-task]').value, confirmed: draft ? Boolean(form.querySelector('[data-confirm]')?.checked) : true,
        revision: current.revision || 1, scope: current.scope || 'private' };
      for (const key of Object.keys(FIELDS)) body.fields[key] = form.elements[key].value.trim();
      busy = true;
      const buttonStates = [...form.querySelectorAll('button')].map(button => [button, button.disabled]);
      buttonStates.forEach(([button]) => { button.disabled = true; });
      try {
        const result = requireOk(draft ? await api().confirm(previewId, body) : await api().update(current.id, body));
        if (epoch !== sequence) return;
        previewId = ''; wizardStep = 'idle'; importMode = true; current = result.item; renderDetail();
        message(result.duplicate ? '这份会话已导入，已打开原记忆，保留之前确认的摘要。' : '已保存。点击“用于新对话”可选择 Agent 继续工作。');
      } catch (error) { if (epoch === sequence) message(error.message, true); }
      finally { busy = false; buttonStates.forEach(([button, disabled]) => { button.disabled = disabled; }); }
    });
    form.querySelector('[data-cancel]')?.addEventListener('click', () => {
      sequence++; clearPreview(); wizardStep = 'idle'; current = null; importMode = false; renderDimensionDetail(); loadList(); message('');
    });
    form.querySelector('[data-use]')?.addEventListener('click', () => {
      const payload = { newSession: true, memoryIds: [current.id], memoryTitle: current.title,
        memoryProjectId: current.projectId || '', memoryRepoId: current.repoId || '' };
      if (global.WorkspaceHost) WorkspaceHost.open('create', payload);
      else if (global.openComposePanel) { close(); openComposePanel(payload); }
    });
    form.querySelector('[data-archive]')?.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      try {
        const result = requireOk(await api()[current.archived ? 'restore' : 'archive'](current.id));
        current = result.item; renderDetail(); await loadList(false);
        message(current.archived ? UI.archive : UI.restore);
      } catch (error) { message(error.message, true); }
      finally { busy = false; }
    });
    form.querySelector('[data-delete]')?.addEventListener('click', async () => {
      if (busy || !global.confirm((global.SoduWorkI18n?.translateText || String)('删除这条记忆及保存的来源摘录？已发送给 Agent 的历史上下文不会被撤回，Codex 原文件不受影响。'))) return;
      const epoch = sequence;
      busy = true;
      try {
        requireOk(await api().delete(current.id));
        if (epoch !== sequence) return;
        current = null; empty(); await loadList(false); message('记忆已删除');
      } catch (error) { if (epoch === sequence) message(error.message, true); }
      finally { busy = false; }
    });
  }
  function open() {
    mount().classList.add('show');
    sequence++; listSequence++; current = null; importMode = false; wizardStep = 'idle'; clearPreview();
    if (typeof global.expandForOverlay === 'function') global.expandForOverlay();
    if (!api()) { message('\u8bf7\u66f4\u65b0\u5ba2\u6237\u7aef\u540e\u4f7f\u7528\u8bb0\u5fc6', true); return; }
    loadingPersonal = true; renderDimensionDetail(); loadList();
  }
  function close() {
    sequence++; listSequence++; clearPreview(); importMode = false; current = null; choices = null; wizardStep = 'idle';
    if (panel) panel.classList.remove('show');
  }

  function renderEntry() {
    document.getElementById('sessionMemoryEntry')?.remove();
    if (!entry?.memoryIds?.length) return;
    const host = document.querySelector('#composePanel .cp-box');
    if (!host) return;
    const chip = document.createElement('div');
    chip.id = 'sessionMemoryEntry'; chip.className = 'cmem-context-chip';
    const label = document.createElement('span');
    label.textContent = '会话记忆 · ' + entry.memoryTitle;
    const remove = document.createElement('button'); remove.type = 'button';
    remove.textContent = '移除'; remove.addEventListener('click', () => global.SessionMemoryEntry.clear());
    chip.append(label, remove); host.prepend(chip);
  }
  global.SessionMemoryEntry = {
    set(payload) {
      entry = Array.isArray(payload?.memoryIds) && payload.memoryIds.length ? { ...payload } : null;
      renderEntry();
    },
    clear() { entry = null; renderEntry(); },
    options() { return entry ? { memoryIds: entry.memoryIds.slice(0, 3),
      projectId: entry.memoryProjectId || '', repoId: entry.memoryRepoId || '' } : {}; },
  };
  global.openSessionMemoryPanel = open;
  global.closeSessionMemoryPanel = close;
})(window);
