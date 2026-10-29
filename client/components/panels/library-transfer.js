/* One transfer path for selected attachments, chat deliverables and preview actions. */
(function (global) {
  'use strict';
  let inputs = new WeakMap();
  const outputs = new Map(), indexed = new Map(), queue = [];
  let active = 0, revision = 0;
  const UPLOAD_PATH = '<path d="M7.5 18.25h9a4.25 4.25 0 0 0 .56-8.46A5.75 5.75 0 0 0 6.2 8.5a4.9 4.9 0 0 0 1.3 9.75Z"/><path d="M12 16V9.5m-2.5 2.5L12 9.5l2.5 2.5"/>';
  const CHECK_PATH = '<path d="M7.5 18.25h9a4.25 4.25 0 0 0 .56-8.46A5.75 5.75 0 0 0 6.2 8.5a4.9 4.9 0 0 0 1.3 9.75Z"/><path d="m9 12.5 2 2 4-4"/>';
  const ICON = '<svg viewBox="0 0 24 24" aria-hidden="true">' + UPLOAD_PATH + '</svg>';
  const SAVED_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true">' + CHECK_PATH + '</svg>';
  const OUTPUT_KINDS = new Set(['website', 'document', 'presentation', 'spreadsheet', 'pdf', 'image', 'video', 'archive']);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const scope = () => global.SoduWorkAPI?.taskStorageKey?.('ops') || '';
  const tx = text => global.SoduWorkI18n?.t(text, text) || text;
  const key = file => String(file?.artifactId || file?.path || (file?.taskId && file?.attachmentId ? file.taskId + ':' + file.attachmentId : '') || '');
  const canSave = file => Boolean(file && (file.artifactId || file.path || (file.taskId && file.attachmentId)));
  const say = text => { if (typeof global.petSay === 'function') global.petSay(tx(text)); };
  /*
   * Resolve conversation attribution from the currently displayed host at save time. Return
   * null without a session ID so the backend records a manual upload rather than guessing.
   */
  let sessionProvider = null;
  function bindSession(provider) { sessionProvider = typeof provider === 'function' ? provider : null; }
  function conversationSource() {
    let got = null;
    try { got = sessionProvider ? sessionProvider() : null; } catch (_) { got = null; }
    const sessionId = String(got && got.sessionId || '').trim();
    if (!sessionId) return null;
    return { type: 'conversation', sessionId,
      conversationTitle: String(got && got.conversationTitle || '').trim().slice(0, 240) };
  }
  function signal(job) { revision++; job.listeners.forEach(fn => { try { fn(job); } catch (_) {} }); }
  function start() {
    while (active < 2 && queue.length) {
      const job = queue.shift(); active++;
      Promise.resolve().then(() => {
        if (job.scope !== scope()) throw Error('账号或服务已切换，请重新保存');
        return job.operation();
      }).then(result => {
        if (job.scope !== scope()) throw Error('账号或服务已切换，请重新保存');
        if (!result || result.ok === false) throw Error(result?.reason || '保存到资料库失败');
        job.status = 'saved'; job.result = result;
        global.dispatchEvent?.(new CustomEvent('soduwork-library-changed', { detail: { itemId: result.item?.id || '' } }));
      }).catch(error => {
        job.status = 'error'; job.error = error;
        if (job.automatic && job.scope === scope()) say('文件未能自动保存到资料库，可重新添加后重试');
      })
        .finally(() => { active--; signal(job); job.finish(job); start(); });
    }
  }
  function submit(job) {
    if (job.status === 'saving' || job.status === 'saved') return job;
    job.status = 'saving'; job.error = null;
    job.promise = new Promise(resolve => { job.finish = resolve; });
    signal(job); queue.push(job); start(); return job;
  }
  function trackFile(file, options, listener) {
    const o = options || {};
    if (!file || o.kind === 'dir' || o.source === 'library' || !global.SoduWorkAPI?.uploadLibraryFile) return null;
    let job = inputs.get(file);
    if (!job || job.scope !== scope()) {
      const name = o.name || file.name;
      const upload = name && name !== file.name ? new File([file], name, { type: file.type, lastModified: file.lastModified }) : file;
      const source = Object.prototype.hasOwnProperty.call(o, 'librarySource') ? o.librarySource : conversationSource();
      const capturedSource = source && typeof source === 'object' ? { ...source } : null;
      job = { scope: scope(), status: 'new', automatic: true, listeners: new Set(),
        operation: () => global.SoduWorkAPI.uploadLibraryFile(upload, o.folderId || '', o.storage || '', capturedSource) };
      inputs.set(file, job);
    }
    if (listener) job.listeners.add(listener);
    if (job.status === 'new') submit(job);
    return job;
  }
  function fileStatus(job) {
    return job?.status === 'saved' ? '已自动保存到资料库' : job?.status === 'error' ? '入库失败' : '正在保存到资料库…';
  }
  function retry(job) { if (job && job.scope === scope() && job.status === 'error') submit(job); }
  function outputKey(ref, file) { return JSON.stringify([scope(), global.SoduWorkAPI?.libraryOutputKey?.(ref, file) ||
    JSON.stringify([ref, key(file), file.at || file.updatedAt || 0, file.size || 0])]); }
  function refreshButtons(id, job) {
    if (job.scope !== scope()) return;
    global.document?.querySelectorAll('.library-save-action').forEach(node => {
      if (node.dataset.librarySaveKey === id) buttonState(node, job);
    });
  }
  function lookup(ref, file) {
    const id = outputKey(ref, file);
    let job = outputs.get(id);
    if (!job && global.SoduWorkAPI?.getLibraryOutputStatus && global.SoduWorkAPI?.libraryOutputKey) {
      job = { scope: scope(), status: 'new', listeners: new Set(), ref, file: { ...file } };
      outputs.set(id, job);
      job.lookup = Promise.resolve().then(() => global.SoduWorkAPI.getLibraryOutputStatus(global.SoduWorkAPI.libraryOutputKey(ref, file), file))
        .then(result => {
          if (job.scope !== scope() || outputs.get(id) !== job || job.status !== 'new') return;
          if (result?.item) { job.status = 'saved'; job.result = result; revision++; }
          refreshButtons(id, job);
        }).catch(() => {});
    }
    return job;
  }
  function version(file) { return String(file.at || file.updatedAt || 0) + ':' + String(file.size || 0); }
  function outputError(job) {
    return String(job?.error?.message || '保存到资料库失败，请重试')
      .replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '').slice(0, 240);
  }
  function requirementLabel(job) {
    return job?.status === 'saved' ? '已保存' : job?.status === 'saving' ? '正在保存…' : job?.status === 'error'
      ? (/源文件已丢失/.test(outputError(job)) ? '文件丢失' : '重试') : '';
  }
  function button(file, ref, attr = 'data-library-output') {
    if (!canSave(file)) return '';
    const job = lookup(ref, file);
    const requirement = attr === 'data-rq-library';
    const label = job?.status === 'saved' ? (requirement ? '已保存到本机资料库' : '已保存到资料库') : job?.status === 'saving' ? '正在保存到资料库…' : job?.status === 'error' ? '重试保存' : (requirement ? '保存到本机资料库' : '保存到资料库');
    const title = requirement && job?.status === 'error' ? outputError(job) + '；点击重试' : label;
    const markup = '<button type="button" class="library-save-action' + (job?.status === 'saved' ? ' is-saved' : job?.status === 'error' && requirement ? ' is-error' : '') + '" data-library-save-key="' + esc(outputKey(ref, file)) + '" data-library-version="' + esc(version(file)) + '" ' + attr + '="' + esc(key(file)) + '" data-library-ref="' + esc(ref || '') +
      '"' + (job?.status === 'saving' ? ' disabled aria-busy="true"' : '') + ' title="' + esc(title) + '" aria-label="' + esc(title) + '">' + (job?.status === 'saved' ? SAVED_ICON : ICON) + '<span class="library-save-label">' + (requirement ? requirementLabel(job) : label) + '</span></button>';
    return requirement ? '<span class="rq-library-save">' + markup + '<span class="rq-library-error" role="status"' +
      (job?.status === 'error' ? '' : ' hidden') + '>' + (job?.status === 'error' ? esc(outputError(job)) : '') + '</span></span>' : markup;
  }
  function buttonState(node, job) {
    if (!node) return;
    const label = job.status === 'saved' ? '已保存到资料库' : job.status === 'saving' ? '正在保存到资料库…' : job.status === 'error' ? '重试保存' : '保存到资料库';
    node.disabled = job.status === 'saving'; node.setAttribute('aria-busy', String(job.status === 'saving'));
    node.classList.toggle('is-saved', job.status === 'saved');
    const requirement = node.dataset?.rqLibrary != null;
    node.innerHTML = (job.status === 'saved' ? SAVED_ICON : ICON) + '<span class="library-save-label">' + esc(tx(requirement ? requirementLabel(job) : label)) + '</span>';
    node.classList.toggle('is-error', requirement && job.status === 'error');
    const title = requirement && job.status === 'error' ? outputError(job) + '；点击重试' : requirement && job.status === 'saved' ? '已保存到本机资料库' : label;
    node.title = tx(title); node.setAttribute('aria-label', tx(title));
    const error = requirement && node.parentElement?.querySelector('.rq-library-error');
    if (error) { error.hidden = job.status !== 'error'; error.textContent = job.status === 'error' ? outputError(job) : ''; }
  }
  function selectOutputFiles(files, ids, latest, shown) {
    const linked = ids instanceof Set ? ids : new Set(ids || []);
    const rendered = shown instanceof Set ? shown : new Set();
    const isImageFile = file => {
      const kind = String(file?.kind || '').toLowerCase();
      const type = String(file?.contentType || '').toLowerCase();
      const name = String(file?.name || file?.relative || file?.path || '');
      return kind === 'image' || type.startsWith('image/') || /\.(?:png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i.test(name);
    };
    const isWebsiteFile = file => {
      const kind = String(file?.kind || '').toLowerCase();
      const name = String(file?.name || file?.relative || file?.path || '');
      return kind === 'website' || /\.(?:html?|xhtml)$/i.test(name);
    };
    // A website's images are usually its supporting assets (and validation
    // captures often share the same task). Keep the card focused on the
    // entrypoint; a named/linked image remains available as an explicit
    // deliverable and the files stay in the workspace/package.
    const hasWebsiteOutput = Boolean(latest && (files || []).some(file =>
      file.changedInTurn && isWebsiteFile(file)));
    return (files || []).filter(file => {
      const explicit = linked.has(key(file));
      const currentPrimary = Boolean(latest && file.changedInTurn &&
        // Images without an explicit primary flag are commonly validation
        // screenshots. Keep them out of the deliverable card; manifest-linked
        // images still arrive through `explicit` (and remain eligible).
        (isImageFile(file)
          ? file.primary === true && !hasWebsiteOutput
          : file.primary !== false));
      return file.primary !== false && (explicit || currentPrimary) && canSave(file) &&
        !file.processEvidence && (!currentPrimary || !file.pluginDraft) &&
        !rendered.has(key(file));
    });
  }
  async function saveOutput(ref, file, node) {
    if (!canSave(file) || !global.SoduWorkAPI?.uploadLibraryOutput) return false;
    const id = outputKey(ref, file), capturedRef = String(ref || ''), capturedFile = { ...file }, capturedScope = scope();
    let job = lookup(ref, file);
    if (job?.lookup) await job.lookup;
    if (capturedScope !== scope()) return false;
    job = outputs.get(id);
    if (job?.status === 'saved') { buttonState(node, job); return true; }
    if (!job || job.status === 'error' || job.status === 'new') {
      // Requirement attachments must not inherit an unrelated open chat.
      const capturedSource = capturedFile.taskId && capturedFile.attachmentId ? null : conversationSource();
      job = { scope: scope(), status: 'new', listeners: new Set(), ref: capturedRef, file: capturedFile,
        operation: () => global.SoduWorkAPI.uploadLibraryOutput(capturedRef, capturedFile, '', capturedSource) };
      outputs.set(id, job);
      if (outputs.size > 160) for (const [old, value] of outputs) { if (value.status !== 'saving' && old !== id) { outputs.delete(old); break; } }
    }
    const update = () => {
      if (job.scope !== scope()) return;
      buttonState(node, job);
      global.document?.querySelectorAll('.library-save-action').forEach(button => {
        if (button.dataset.librarySaveKey === id || button.dataset.libraryRef === capturedRef && button.dataset.libraryVersion === version(capturedFile) &&
          (button.dataset.libraryOutput || button.dataset.wbLibraryUpload || button.dataset.rqLibrary) === key(capturedFile)) buttonState(button, job);
      });
    }; job.listeners.add(update);
    submit(job); update(); await job.promise; job.listeners.delete(update);
    if (job.scope !== scope()) return false;
    if (job.status === 'error') say(job.error?.message || '保存到资料库失败');
    else say('已保存到资料库');
    return job.status === 'saved';
  }
  function decorateOutputs(root, files, ref, snapshot = {}) {
    if (!root || !ref) return;
    if (snapshot.delivery?.presentation === 'summary' || snapshot.deliveryPresentation === 'summary' ||
        snapshot.deliveryMode === 'git' || snapshot.cloudHandoff?.deliveryMode === 'git') return;
    const settled = !global.ChatDeliveries || global.ChatDeliveries.isSettled(snapshot);
    // A legacy task stream owns its nested user/assistant rows as one result.
    // Those inner users are not new user instructions in the outer chat.
    const messages = [...root.querySelectorAll('.nmsg,[data-task-stream]')].filter(message => {
      const stream = message.closest('[data-task-stream]');
      return !stream || stream === message;
    });
    const turns = new Map();
    let turn = 0;
    for (const message of messages) {
      if (message.classList.contains('user')) { turn++; continue; }
      if (!message.classList.contains('ai') && !message.dataset.taskStream) continue;
      const task = message.dataset.outputTask || message.dataset.taskStream || '';
      const id = JSON.stringify([turn, task]);
      if (!turns.has(id)) turns.set(id, { turn, task, messages: [] });
      turns.get(id).messages.push(message);
    }
    const latestAnswer = [...messages].reverse().find(message => message.classList.contains('ai') && message.dataset.deliveryFinal !== 'false');
    const shown = new Set();
    const identity = file => JSON.stringify([key(file), version(file)]);
    const remember = card => card.querySelectorAll('[data-library-output]').forEach(node => {
      if (node.dataset.libraryRef === String(ref)) shown.add(JSON.stringify([node.dataset.libraryOutput, node.dataset.libraryVersion]));
    });
    for (const bucket of turns.values()) {
      const current = bucket.turn === turn && bucket.messages.some(message => message.dataset.deliveryCurrent !== 'false');
      const cards = bucket.messages.flatMap(message => [...message.children].filter(node => node.matches('.noutput-library')));
      const message = [...bucket.messages].reverse().find(node => node.dataset.deliveryFinal !== 'false');
      if (!message || (current && !settled)) { cards.forEach(card => card.remove()); continue; }
      if (bucket.messages.some(node => node.querySelector('.ndelivery'))) { cards.forEach(card => card.remove()); continue; }
      // Completed earlier user turns retain their versions and saved state.
      // Repair legacy duplicates in that turn without reinterpreting their rows
      // using the current filesystem index.
      if (!current && cards.length) {
        const group = cards.at(-1), rows = new Map();
        cards.forEach(card => card.querySelectorAll('.noutput-library-row').forEach(row => {
          const id = row.querySelector('[data-library-output]')?.dataset.libraryOutput;
          if (id) rows.set(id, row);
        }));
        if (cards.length > 1) group.replaceChildren(...rows.values());
        cards.filter(card => card !== group).forEach(card => card.remove());
        if (group.parentElement !== message) message.appendChild(group);
        remember(group); continue;
      }
      if (!settled) continue;
      const ids = new Set([...message.querySelectorAll('[data-open-app],[data-output-image],[data-output-video]')]
        .map(node => node.dataset.openApp || node.dataset.outputImage || node.dataset.outputVideo));
      cards.forEach(card => card.querySelectorAll('[data-library-output]').forEach(node => ids.add(node.dataset.libraryOutput)));
      /*
       * A final answer does not have to mention every file it created. The
       * old card only used filenames linkified in the answer, so a run that
       * produced ten documents but linked four showed only those four. Keep
       * explicitly mentioned files, and include current-turn typed outputs
       * from the trusted index even when the model omitted their names. A
       * delivery shortlist can exclude supporting files as primary:false;
       * those remain available in the workspace rather than this card.
       * changedInTurn scopes this fallback to the newest final answer, so
       * reopening an old chat cannot pull unrelated workspace files in.
       */
      const latest = current && (message === latestAnswer || Boolean(message.dataset.taskStream)) && message.dataset.deliveryCurrent !== 'false';
      const candidates = bucket.task ? files.filter(file => (file.taskId || file.cloudTaskId) === bucket.task) : files;
      const available = selectOutputFiles(candidates.filter(file => !shown.has(identity(file))), ids, latest);
      if (!available.length) { cards.forEach(card => card.remove()); continue; }
      const group = cards.at(-1) || root.ownerDocument.createElement('div'); group.className = 'noutput-library';
      cards.filter(card => card !== group).forEach(card => card.remove());
      available.forEach(file => {
        shown.add(identity(file));
        indexed.set(JSON.stringify([ref, key(file), version(file)]), { scope: scope(), file: { ...file } });
      });
      const signature = JSON.stringify([ref, available.map(file => [identity(file), file.name || file.relative || '', file.contentType || ''])]);
      if (group.dataset.libraryFiles !== signature) group.innerHTML = available.map(file => {
        const fileKey = key(file);
        const fileName = file.name || file.relative || '';
        const fileIcon = global.SoduWorkLibraryFileIcons?.markup?.({ filename: fileName, contentType: file.contentType }) || '<span class="noutput-library-extension" aria-hidden="true">' + esc(fileName.split('.').pop().toUpperCase().slice(0, 5)) + '</span>';
        return '<div class="noutput-library-row"><span class="noutput-library-file-icon" aria-hidden="true">' + fileIcon + '</span><button type="button" class="noutput-library-name" data-open-app="' + esc(fileKey) + '" data-user-content title="打开 ' + esc(fileName) + '">' + esc(fileName) + '</button>' + button(file, ref) + '</div>';
      }).join('');
      group.dataset.libraryFiles = signature;
      if (group.parentElement !== message) message.appendChild(group);
    }
    while (indexed.size > 400) indexed.delete(indexed.keys().next().value);
  }
  function saveDecorated(node) {
    const ref = node.dataset.libraryRef || '', item = indexed.get(JSON.stringify([ref, node.dataset.libraryOutput, node.dataset.libraryVersion]));
    if (!item || item.scope !== scope()) { say('当前成果暂时无法上传到资料库'); return Promise.resolve(false); }
    return saveOutput(ref, item.file, node);
  }
  global.addEventListener?.('soduwork-data-scope-changed', () => { revision++; inputs = new WeakMap(); outputs.clear(); indexed.clear(); });
  global.addEventListener?.('soduwork-library-changed', () => {
    for (const [id, job] of [...outputs]) {
      if (job.status === 'saved' && job.file) { outputs.delete(id); lookup(job.ref, job.file); }
    }
  });
  /* Return successfully saved draft attachment IDs for later conversation association. */
  function savedItemIds(files) {
    const ids = new Set();
    for (const file of files || []) {
      const job = file ? inputs.get(file) : null;
      const id = job && job.result && job.result.item && job.result.item.id;
      if (id && job.scope === scope()) ids.add(String(id));
    }
    return [...ids];
  }
  global.LibraryTransfer = { trackFile, fileStatus, retry, canSave, button, saveOutput, decorateOutputs, saveDecorated, bindSession, savedItemIds,
    revision: () => revision, _selectOutputFiles: selectOutputFiles };
})(typeof window !== 'undefined' ? window : globalThis);
