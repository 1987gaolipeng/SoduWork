/* Mobile host for the shared PC tool button. Receipts are data, never file access. */
(function (global) {
  'use strict';
  const TEXT_LIMIT = 240000, IMAGE_LIMIT = 16 * 1024 * 1024;
  let current = null;
  const strings = (object, keys) => {
    for (const key of keys) if (typeof object?.[key] === 'string') return object[key];
    return '';
  };
  const pathOf = tool => strings(tool?.args, ['path', 'file_path', 'filePath', 'filename', 'file', 'target']);
  function payload(tool, tools = global.ChatTools) {
    const view = tools?.render(tool);
    if (!view?.side) return null;
    const path = pathOf(tool), args = tool.args || {}, kind = tools.kind(tool);
    const receipt = String((tool.state === 'running' ? tool.partial : tool.result) || '');
    const sections = [], add = (label, value) => sections.push({label, text: value.slice(0, TEXT_LIMIT), truncated: value.length > TEXT_LIMIT});
    if (view.readSnapshot) add('当次读取记录', receipt);
    else if (kind === 'write') {
      const keys = ['content', 'text', 'body', 'data'];
      if (keys.some(key => typeof args[key] === 'string')) add('本次写入内容', strings(args, keys));
    } else if (kind === 'edit') {
      const edits = Array.isArray(args.edits) ? args.edits : [args];
      for (const [index, edit] of edits.slice(0, 100).entries()) {
        const before = strings(edit, ['old_string', 'oldText', 'old_str', 'search', 'from']);
        const after = strings(edit, ['new_string', 'newText', 'new_str', 'replace', 'to']);
        if (!before && !after) continue;
        sections.push({label: edits.length > 1 ? '第 ' + (index + 1) + ' 处修改' : '本次修改片段',
          before: before.slice(0, TEXT_LIMIT), after: after.slice(0, TEXT_LIMIT),
          truncated: before.length > TEXT_LIMIT || after.length > TEXT_LIMIT});
      }
    }
    return {id: String(tool.id || ''), path, name: path.replace(/\\/g, '/').split('/').pop() || '文件记录',
      title: String(view.title || '执行记录'), kind, sections, receipt: receipt.slice(0, TEXT_LIMIT),
      receiptTruncated: receipt.length > TEXT_LIMIT, running: tool.state === 'running', failed: tool.isError === true || /^(error|failed)$/.test(tool.state || ''), stopped: /^(stopped|cancelled|canceled)$/.test(tool.state || '')};
  }
  function normalizePath(value) {
    const path = String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
    if (!path || /[\u0000-\u001f\u007f%?#]/.test(path) || path.startsWith('//') ||
        /^(?![a-z]:\/)[a-z][a-z\d+.-]*:/i.test(path) || path.split('/').some(part => part === '..' || part === '.')) return '';
    return path;
  }
  function matchFile(path, files, taskId) {
    const target = normalizePath(path);
    if (!target || !taskId) return null;
    const matches = (Array.isArray(files) ? files : []).filter(file => file.taskId === taskId && file.artifactId &&
      [file.relative, file.path, file.sourceRef].some(value => normalizePath(value) === target));
    return matches.length === 1 ? matches[0] : null;
  }
  function imageSource(result) {
    const mime = String(result?.mimeType || ''), data = String(result?.data || '');
    if (result?.ok === false || !/^image\/(png|jpeg|gif|webp|bmp|avif|x-icon)$/.test(mime) ||
        !data || data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data) ||
        data.length * 3 / 4 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0) > IMAGE_LIMIT) {
      throw Error('图片内容不可用，请稍后重试。');
    }
    return 'data:' + mime + ';base64,' + data;
  }
  function close() {
    const state = current;
    if (!state) return;
    current = null;
    state.unsubscribe?.();
    state.root.close(); state.root.remove();
    if (state.previous?.isConnected) state.previous.focus({preventScroll: true});
  }
  const live = state => current === state && state.ref === global.NativeChat?.sessionInfo?.()?.ref;
  function node(tag, className, text) {
    const el = global.document.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = text;
    return el;
  }
  function addCode(body, label, value, truncated) {
    const section = node('section', 'mtv-section');
    section.append(node('h3', '', label), node('pre', 'mtv-code', value.slice(0, TEXT_LIMIT) || '（内容为空）'));
    if (truncated) section.append(node('p', 'mtv-note', '内容较长，此处显示前 ' + TEXT_LIMIT + ' 个字符。'));
    body.append(section);
  }
  function renderReceipt(body, data) {
    body.replaceChildren();
    if (data.running) body.append(node('p', 'mtv-note', '操作进行中，内容会随执行更新。'));
    if (!data.sections.length) body.append(node('p', 'mtv-note', '本次回执未附文件正文；下方读取当前已同步版本。'));
    for (const section of data.sections) {
      if (!Object.hasOwn(section, 'before')) addCode(body, section.label, section.text, section.truncated);
      else {
        // Shared diff renderer handles escaping. Sanitize again at the mobile host boundary.
        const diff = global.ChatTools?.diffHtml, purify = global.DOMPurify;
        if (diff && purify && section.before.length + section.after.length <= 60000) {
          const part = node('section', 'mtv-section'); part.append(node('h3', '', section.label));
          const content = node('div', 'mtv-diff');
          content.innerHTML = purify.sanitize(diff(section.before, section.after, data.name));
          part.append(content); body.append(part);
        } else {
          addCode(body, section.label + ' · 修改前', section.before, section.truncated);
          addCode(body, section.label + ' · 修改后', section.after, section.truncated);
        }
      }
    }
    if (data.kind !== 'read' && data.receipt) {
      {
        const more = node('details', 'mtv-receipt'); more.append(node('summary', '', '执行回执'));
        addCode(more, '返回结果', data.receipt, data.receiptTruncated); body.append(more);
      }
    }
  }
  async function loadFile(state) {
    if (!live(state) || state.loading) return;
    state.loading = true; state.fileButton.disabled = true; state.fileButton.setAttribute('aria-busy', 'true');
    state.fileStatus.textContent = '正在读取已同步的任务附件…';
    try {
      const session = global.soduWorkAPI.conversationSession;
      const snapshot = (await session.snapshot(state.ref))?.snapshot;
      if (!live(state)) return;
      const taskId = snapshot?.workflowTaskId || snapshot?.cloudHandoff?.taskId || '';
      if (!taskId) throw Error('会话尚未绑定任务，请稍后重试。');
      const files = await session.processFiles(state.ref);
      if (!live(state)) return;
      const file = matchFile(state.data.path, files, taskId);
      if (!file) throw Error('文件尚未同步，或无法唯一确认所属版本。可在对话底部重新收集交付成果。');
      const image = /\.(png|jpe?g|gif|webp|bmp|avif|ico)$/i.test(state.data.path);
      const result = await session.artifactAction(state.ref, file.artifactId, image ? 'preview' : 'read');
      if (!live(state)) return;
      if (result?.ok === false) throw Error(result.reason || '文件暂时无法读取。');
      state.fileBody.replaceChildren();
      if (image) {
        const picture = node('img', 'mtv-image'); picture.alt = state.data.name; picture.src = imageSource(result);
        picture.addEventListener('error', () => { if (live(state)) state.fileStatus.textContent = '图片无法解码，请稍后重试。'; });
        state.fileBody.append(picture);
      } else if (typeof result?.text === 'string') addCode(state.fileBody, '已同步文件内容', result.text, result.text.length > TEXT_LIMIT);
      else throw Error('服务未返回可查看的文件内容。');
      state.fileStatus.textContent = '当前已同步版本 · 历史操作结果可展开执行回执查看';
      state.fileButton.textContent = '重新读取文件';
    } catch (error) {
      if (live(state)) { state.fileStatus.textContent = error.message || '文件读取失败，请重试。'; state.fileButton.textContent = '重试读取文件'; }
    } finally {
      if (live(state)) { state.loading = false; state.fileButton.disabled = false; state.fileButton.removeAttribute('aria-busy'); }
    }
  }
  function openTool(tool) {
    const data = payload(tool), info = global.NativeChat?.sessionInfo?.();
    if (!data || !info?.ref || !global.document) return false;
    close();
    const previous = global.document.activeElement, root = node('dialog', 'mtv-dialog');
    root.setAttribute('aria-label', data.title + ' ' + data.name);
    const grip = node('div', 'mtv-grip'); grip.setAttribute('aria-hidden', 'true');
    const header = node('header', 'mtv-header'), heading = node('div', 'mtv-heading');
    const stateLabel = value => value.title + ' · ' + (value.running ? '进行中' : value.stopped ? '已停止' : value.failed ? '执行失败' : '执行记录');
    const kicker = node('p', 'mtv-kicker', stateLabel(data));
    heading.append(kicker, node('h2', '', data.name));
    const dismiss = node('button', 'mtv-close', '×'); dismiss.type = 'button'; dismiss.setAttribute('aria-label', '关闭执行记录');
    dismiss.addEventListener('click', close); header.append(heading, dismiss);
    const body = node('div', 'mtv-body');
    const path = node('details', 'mtv-path'); path.append(node('summary', '', '文件路径'), node('p', '', data.path));
    const receipt = node('div'); renderReceipt(receipt, data); body.append(path, receipt);
    const fileBody = node('div', 'mtv-file-body'), fileStatus = node('p', 'mtv-note'); fileStatus.setAttribute('role', 'status');
    const fileButton = node('button', 'mtv-file-button', '查看已同步文件'); fileButton.type = 'button';
    const state = {root, previous, ref: info.ref, data, receipt, fileBody, fileStatus, fileButton};
    current = state;
    if (typeof global.soduWorkAPI?.conversationSession?.processFiles === 'function' && data.path) {
      fileButton.addEventListener('click', () => {void loadFile(state);}); body.append(fileButton, fileStatus, fileBody);
    }
    root.append(grip, header, body); global.document.body.append(root);
    root.addEventListener('cancel', event => {event.preventDefault(); close();});
    root.addEventListener('click', event => {if (event.target === root) {const box = root.getBoundingClientRect(); if (event.clientY < box.top || event.clientX < box.left || event.clientX > box.right) close();}});
    // Drag only the grip, so scrolling code never accidentally dismisses the sheet.
    let drag = null;
    grip.addEventListener('pointerdown', event => {drag = {id: event.pointerId, y: event.clientY}; grip.setPointerCapture(event.pointerId);});
    grip.addEventListener('pointermove', event => {if (drag?.id === event.pointerId) root.style.transform = 'translateY(' + Math.max(0, event.clientY - drag.y) + 'px)';});
    const endDrag = event => {if (drag?.id !== event.pointerId) return; const distance = event.clientY - drag.y; drag = null; root.style.transform = ''; if (distance > 90) close();};
    grip.addEventListener('pointerup', endDrag);
    grip.addEventListener('pointercancel', () => {drag = null; root.style.transform = '';});
    state.unsubscribe = global.soduWorkAPI.conversationSession.onEvent?.(event => {
      if (!live(state)) {close(); return;}
      if (event.ref !== state.ref) return;
      const latest = event.snapshot?.tools?.find(item => String(item.id) === data.id);
      if (!latest) return;
      const update = payload(latest);
      if (!update) return;
      if (JSON.stringify(update) === JSON.stringify(state.data)) return;
      const top = body.scrollTop;
      state.data = update; kicker.textContent = stateLabel(update); renderReceipt(receipt, update); body.scrollTop = top;
    });
    root.showModal(); dismiss.focus({preventScroll: true});
    if (!data.running && !data.sections.length && data.path &&
        typeof global.soduWorkAPI?.conversationSession?.processFiles === 'function') void loadFile(state);
    return true;
  }
  const api = {openTool, close, payload, normalizePath, matchFile, imageSource};
  global.SoduWorkMobileToolViewer = api;
  if (global.ChatTools) global.ChatTools.openSide = openTool;
  global.addEventListener?.('pagehide', close, {once: true});
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
