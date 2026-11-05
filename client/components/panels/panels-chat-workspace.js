(function (global) {
  'use strict';
  const controlsContext = {
    get workScope() { return workScope; },
    get artifactKey() { return artifactKey; },
    get WB() { return WB; },
    get sessionApi() { return sessionApi; },
    get links() { return links; },
    get context() { return context; },
    get previewOwner() { return previewOwner; },
    get paint() { return paint; },
    get previewKind() { return previewKind; },
    get info() { return info; },
    get esc() { return esc; },
    get filesHtml() { return filesHtml; },
    get browserHtml() { return browserHtml; },
    get ICONS() { return ICONS; },
    get libraryUploadButton() { return libraryUploadButton; },
    get markdown() { return markdown; },
    get tabById() { return tabById; },
    get nativeApi() { return nativeApi; },
    get ensure() { return ensure; },
    get receiveNativeState() { return receiveNativeState; },
    get split() { return split; },
    get hideNative() { return hideNative; },
    get scheduleNative() { return scheduleNative; },
    get stateFor() { return stateFor; },
    get dispatchElementReference() { return dispatchElementReference; },
    get dispatchAnnotation() { return dispatchAnnotation; },
    get openLink() { return openLink; },
    get maximizeWorkbench() { return maximizeWorkbench; },
    get openOutput() { return openOutput; },
    get activeTab() { return activeTab; },
    get openFiles() { return openFiles; },
    get newBrowser() { return newBrowser; },
    get openFile() { return openFile; },
    get dispatchReference() { return dispatchReference; },
    get locationFor() { return locationFor; },
    get openService() { return openService; },
    get sendAnnotations() { return sendAnnotations; },
    get annotationRows() { return annotationRows; },
    get updateNativeChrome() { return updateNativeChrome; },
    get artifactRequest() { return artifactRequest; },
    get addressFor() { return addressFor; },
    get normalizeAddress() { return normalizeAddress; },
    get restoreReadImageSnapshot() { return restoreReadImageSnapshot; },
  };
  const controls = global.ChatWorkspaceControls || (typeof require === 'function' ? require('./chat-workspace-controls') : null);
  const { loadText, normalizedPath, inputPath, matchesInput, fileChangeFor, fileKey, fileLocation, promoteFileTab, restoreFileView, canEditFile, isCodeFile, isEditorFile, codeMode, destroyEditor, editorSource, mountEditor, diffTexts, mergeFileChanges, codeModeToolbar, codeEditorBody, diffBody, tabBody, copyText, closeTab, cycleTab, focusAddress, bindWorkbench, hydrateRemoteMedia } = controls.create(controlsContext);
  const links = global.ChatOutputLinks || (typeof require === 'function' ? require('./chat-output-links') : null);
  const split = global.ChatWorkspaceSplit || (typeof require === 'function' ? require('./chat-workspace-split') : null);
  const tools = global.ChatTools;
  if (!tools) return;
  const esc = tools.esc;
  const artifactKey = tools.artifactKey;
  const artifactRequest = tools.artifactRequest;
  const previewKind = tools.previewKind;
  const fileUrl = tools.fileUrl;
  const normalizeAddress = tools.normalizeAddress;
  const info = global.ChatWorkspaceInfo || (typeof require === 'function' ? require('./chat-workspace-info') : null);
  if (!info) return;
  const { toolMeta, status, services, changes, currentTurnTools, baseName } = info;
  const ICONS = global.ChatWorkbenchIcons || info.ICONS || {};
  const WB = {
    root: null, context: null, open: false, maximized: false, manualClosed: false, autoOpened: false,
    autoPreviewed: false, autoPreviewKey: '',
    active: '', files: [], summaryFiles: [], changes: [], services: [], tabs: [], states: Object.create(null),
    signature: '', seq: 0, epoch: 0, previewKey: '', previewText: '', previewError: '', previewLoading: false,
    fileChanges: null, editor: null, editorDrafts: Object.create(null), editorDirty: false,
    observer: null, visibilityObserver: null, unlisten: null, unlistenElement: null, nativeShown: '', nativePending: false, frame: 0, nativeRequest: 0,
  };
  const READ_IMAGE_CACHE_BYTES = 64 * 1024 * 1024, READ_IMAGE_CACHE_TABS = 4;
  let readImageRevision = 0, readImageUse = 0;
  function sessionApi() {
    return global.soduWorkAPI && (global.soduWorkAPI.conversationSession || global.soduWorkAPI.piSession);
  }
  function nativeApi() { return global.soduWorkAPI && global.soduWorkAPI.workPreview; }
  function context() { return typeof WB.context === 'function' ? (WB.context() || {}) : {}; }
  function workScope() { return String(context().ref || 'unbound'); }
  function previewOwner() {
    const ref = context().ref, root = WB.root, epoch = WB.epoch;
    const scope = global.SoduWorkAPI?.taskStorageKey?.('ops');
    return () => WB.epoch === epoch && WB.root === root && context().ref === ref &&
      global.SoduWorkAPI?.taskStorageKey?.('ops') === scope;
  }
  function resetSplit(root) { return split.set(root, split.DEFAULT); }
  function ensure(root) {
    if (!root || root.querySelector('.ncw')) return;
    const host = root.querySelector('.nchat-stage') || root;
    host.insertAdjacentHTML('beforeend',
      '<aside class="ncw" aria-label="工作与成果区" aria-hidden="true">' +
        '<div class="ncw-resize" data-wb-resize role="separator" tabindex="0" aria-label="调整对话与成果宽度" ' +
          'aria-orientation="vertical" aria-valuemin="30" aria-valuemax="70" aria-valuenow="50" ' +
          'aria-valuetext="对话 50%，成果 50%" title="拖动调整宽度，向左拖到底全屏查看成果；双击恢复等宽"><span aria-hidden="true"></span></div>' +
        '<header class="ncw-top"><nav class="ncw-tabs" role="tablist"></nav>' +
          '<button type="button" class="ncw-annotation-send" data-wb-send-annotations hidden title="发送全部注释">发送 <i>0</i></button>' +
          '<button type="button" class="ncw-maximize" data-wb-maximize aria-label="最大化成果区">' +
            ICONS.expand + '</button>' +
          '<button type="button" class="ncw-collapse" data-wb-close aria-label="隐藏成果区" title="隐藏成果区">' +
            '<svg viewBox="0 0 24 24"><rect x="3.5" y="4" width="17" height="16" rx="3"/><path d="M13.5 4v16"/></svg>' +
          '</button></header><div class="ncw-body"></div></aside>');
    resetSplit(root);
  }
  function size(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }
  function tabById(id) { return WB.tabs.find((item) => item.id === id) || null; }
  function activeTab() { return tabById(WB.active); }
  function readImagePayload(images) {
    const imageUrls = (Array.isArray(images) ? images : [])
      .map(image => links.imageUrl({ ...image, ok: true })).filter(Boolean);
    // Count UTF-16 string storage conservatively. Only the active tab has
    // image DOM, and off-screen images use browser lazy loading.
    return { imageUrls, imageBytes: imageUrls.reduce((total, url) => total + url.length * 2, 0) };
  }
  function trimReadImageSnapshots() {
    let count = 0, bytes = 0;
    const inactive = WB.tabs.filter(tab => tab.id !== WB.active && tab.file?.readSnapshot?.imageUrls?.length)
      .sort((a, b) => (b.file.readSnapshot.usedAt || 0) - (a.file.readSnapshot.usedAt || 0));
    for (const tab of inactive) {
      const snapshot = tab.file.readSnapshot;
      if (count < READ_IMAGE_CACHE_TABS && bytes + snapshot.imageBytes <= READ_IMAGE_CACHE_BYTES) {
        count++; bytes += snapshot.imageBytes; continue;
      }
      snapshot.imageUrls = []; snapshot.imageBytes = 0; snapshot.evicted = true;
      snapshot.revision = ++readImageRevision;
      delete snapshot.failedImages;
    }
  }
  function restoreReadImageSnapshot(tab, retry = false) {
    const snapshot = tab?.file?.readSnapshot;
    if (tab?.kind !== 'image' || !snapshot?.evicted || snapshot.loading || (snapshot.error && !retry)) return false;
    const owner = previewOwner(), api = sessionApi(), ref = context().ref, request = {};
    const current = () => owner() && WB.tabs.includes(tab) && tab.file?.readSnapshot === snapshot && snapshot.request === request;
    snapshot.request = request; snapshot.loading = true; snapshot.error = '';
    snapshot.revision = ++readImageRevision;
    Promise.resolve().then(() => {
      if (!api?.toolDetail) throw Error('detail unavailable');
      return api.toolDetail(ref, String(snapshot.id));
    }).then(response => {
      if (!current()) return;
      if (!response?.ok || String(response.tool?.id) !== String(snapshot.id)) throw Error('detail unavailable');
      const payload = readImagePayload(response.tool.readImages);
      if (!payload.imageUrls.length) throw Error('image unavailable');
      Object.assign(snapshot, payload, { evicted: false, imagesTruncated: Boolean(response.tool.readImagesTruncated) });
      delete snapshot.failedImages;
    }).catch(() => {
      if (current()) snapshot.error = '图片暂时无法预览';
    }).finally(() => {
      if (!current()) return;
      snapshot.request = null; snapshot.loading = false; snapshot.revision = ++readImageRevision;
      trimReadImageSnapshots();
      if (WB.active === tab.id && WB.open) paint();
    });
    return true;
  }
  function hasVisibleTabs(tabs) { return Boolean(tabs && tabs.length); }
  function stateFor(tab) { return tab ? (WB.states[tab.id] || {}) : {}; }
  // Tab titles and service states are produced as Chinese display strings;
  // route them through the locale catalog so non-Chinese clients read English.
  function tr(value) {
    const text = value === undefined || value === null ? '' : String(value);
    return global.SoduWorkI18n ? global.SoduWorkI18n.translateText(text) : text;
  }
  function addTab(spec, activate) {
    let tab = WB.tabs.find((item) => item.key === spec.key);
    if (!tab) {
      // Keep the produced Chinese label as the translation source: labels are
      // rendered as user content (they may be file names or URLs), so the DOM
      // adapter skips them and only the locale change hook can re-translate.
      tab = { id: 'work-' + (++WB.seq), nativeReady: false, ...spec,
        labelSource: spec.label, label: tr(spec.label) };
      WB.tabs.push(tab);
    } else {
      const sourceChanged = (spec.url && spec.url !== tab.url) ||
        (spec.file && tab.file && (artifactKey(spec.file) !== artifactKey(tab.file) ||
          spec.file.at !== tab.file.at));
      Object.assign(tab, spec);
      tab.labelSource = spec.label;
      tab.label = tr(tab.label);
      if (sourceChanged) tab.nativeReady = false;
    }
    if (activate !== false) { WB.active = tab.id; WB.open = true; }
    return tab;
  }
  function isTaskPreview(file) {
    if (!file || !file.taskId || !file.attachmentId) return false;
    // Prefer local bytes whenever a path exists. Hub attachment URLs are transfer endpoints,
    // not navigable preview URLs; Hub intentionally serves HTML as attachment downloads,
    // so direct navigation would open a save dialog.
    if (file.path) return false;
    const kind = previewKind(file);
    return kind === 'web' || kind === 'pdf';
  }
  function canAutoPreview(file) {
    const kind = previewKind(file);
    // Automatic output handling stays inside the right pane. Other results
    // remain conversation cards until the user chooses an explicit file action.
    return kind !== 'external' && (kind !== 'pdf' || Boolean(file?.path));
  }
  function openPendingCloud(file, activate = true, automatic = false) {
    if (!file?.cloudPending || !links?.materialize) return false;
    const ref = context().ref, current = previewOwner();
    const id = fileKey(file), activeId = WB.active, request = {};
    if (!WB.openingTaskFiles) WB.openingTaskFiles = new Set();
    const opening = WB.openingTaskFiles;
    if (opening.has(id)) return true;
    opening.add(id);
    if (activate) { WB.cloudOpenRequest = request; WB.manualClosed = false; }
    links.materialize(file, sessionApi(), ref, { previewOnly: automatic }).then(local => {
      if (!current()) return;
      WB.files = WB.files.map(item => fileKey(item) === id ? local : item);
      const shouldActivate = activate && WB.cloudOpenRequest === request && WB.active === activeId && !WB.manualClosed;
      const tab = openFile(local, shouldActivate, automatic);
      if (tab) tab.autoPreview = false;
      paint();
    }).catch(error => { if (current()) global.petSay?.(error.message || '云端成果暂时无法打开'); })
      .finally(() => opening.delete(id));
    return true;
  }
  function openTaskPdfPreview(file) {
    // Canvas renderers disable plugins, so PDFs would download instead of displaying.
    // Use the native attachment-preview window, which enables PDF plugin support.
    if (!links?.taskAttachment || typeof global.soduWorkAPI?.previewAttachment !== 'function') return false;
    const current = previewOwner();
    links.taskAttachment(file, global.SoduWorkAPI).then(row => {
      if (!current()) return;
      if (!row || typeof row.url !== 'string') throw Error('成果地址无效');
      return global.soduWorkAPI.previewAttachment({ url: row.url, filename: row.filename || file.name || '成果.pdf' });
    }).then(result => {
      if (result && result.ok === false && !result.canceled) throw Error(result.reason || '无法预览这份成果');
    }).catch(error => { if (current() && typeof global.petSay === 'function') global.petSay(error.message || '无法预览这份成果'); });
    return true;
  }
  function openTaskPreview(file, activate = true, automatic = false) {
    // Materialize web deliverables in the conversation workspace through authorized main-process downloads
    // with SHA-256 verification, then open local files rather than navigating to Hub attachment URLs.
    if (!file || !file.taskId || !file.attachmentId || file.path) return false;
    const kind = previewKind(file);
    if (kind === 'pdf') return openTaskPdfPreview(file);
    if (kind !== 'web' || !links?.materializeTask) return false;
    if (!WB.openingTaskFiles) WB.openingTaskFiles = new Set();
    const id = fileKey(file), opening = WB.openingTaskFiles, activeId = WB.active, request = {};
    if (opening.has(id)) return true;
    opening.add(id);
    if (activate) { WB.cloudOpenRequest = request; WB.manualClosed = false; }
    const ref = context().ref, current = previewOwner();
    links.materializeTask(file, sessionApi(), ref, { previewOnly: automatic }).then(local => {
      if (!current()) return;
      WB.files = WB.files.map(item => fileKey(item) === id ? local : item);
      const shouldActivate = activate && WB.cloudOpenRequest === request && WB.active === activeId && !WB.manualClosed;
      const tab = openFile(local, shouldActivate, automatic);
      if (tab) tab.autoPreview = false;
      paint();
    }).catch(error => { if (current() && typeof global.petSay === 'function') global.petSay(error.message || '成果暂无法保存到本地'); })
      .finally(() => opening.delete(id));
    return true;
  }
  function openFile(file, activate, automatic = false) {
    if (automatic && !canAutoPreview(file)) return null;
    if (openPendingCloud(file, activate, automatic)) return null;
    if (isTaskPreview(file)) { openTaskPreview(file, activate, automatic); return null; }
    if (openTaskOutput(file)) return null;
    const inputTab = WB.tabs.find(tab => tab.inputFile && matchesInput(file, tab.inputFile));
    if (inputTab) {
      if (activate !== false) { WB.active = inputTab.id; WB.open = true; }
      return inputTab;
    }
    const id = fileKey(file);
    if (!id) return null;
    const kind = previewKind(file);
    if (kind === 'external' || (kind === 'pdf' && !file.path)) {
      artifactRequest(sessionApi(), context().ref, file, 'open');
      return null;
    }
    const change = fileChangeFor(file);
    // Declared results open as usable content. Source files and explicit
    // change links still use the editor/diff surface.
    const deliverablePreview = file.primary !== false && ['web', 'markdown', 'image', 'video', 'pdf'].includes(kind);
    const editorFile = !deliverablePreview && (isCodeFile(file) || (kind === 'markdown' && Boolean(change)));
    const tabKind = editorFile && kind === 'markdown' ? 'text' : kind;
    return addTab({ key: 'file:' + workScope() + ':' + id,
      kind: tabKind, label: kind === 'web' ? file.title || file.name : file.name, file,
      // A newly created source file has no meaningful "before" side; open it
      // directly in CodeMirror. Existing edits still open in Diff by default.
      view: editorFile ? (change && change.action !== 'created' ? 'diff' : 'code') : 'preview' }, activate);
  }
  function openOutput(target) {
    const value = String(target || '');
    const file = WB.files.find((item) => fileKey(item) === value || item.path === value);
    if (!file) return false;
    if (openPendingCloud(file, true)) return true;
    if (isTaskPreview(file)) { openTaskPreview(file, true); return true; }
    if (openTaskOutput(file)) return true;
    const kind = previewKind(file);
    if (kind === 'external' || (kind === 'pdf' && !file.path)) {
      artifactRequest(sessionApi(), context().ref, file, 'open');
      return true;
    }
    WB.manualClosed = false;
    if (WB.previewError) WB.previewKey = '';
    const tab = openFile(file, true);
    if (tab) tab.autoPreview = false;
    paint();
    return true;
  }
  function linkTarget(value, files) {
    const file = links && links.fileTarget(value, files);
    if (file) return { kind: 'file', file };
    const raw = String(value || '').trim();
    if (!raw || raw.startsWith('#')) return null;
    const remote = /^(?:https?:\/\/|\/\/)/i.test(raw) ||
      /^(?:localhost|127(?:\.\d{1,3}){3}|[\w.-]+\.[a-z]{2,})(?::\d+)?(?:\/|$)/i.test(raw);
    if (!remote) return null;
    // A bare code/document filename can look like a hostname (for example
    // hello.js). Only explicit URLs should open the browser for these names.
    if (!/^(?:https?:\/\/|\/\/)/i.test(raw) &&
        /\.(?:js|jsx|ts|tsx|mjs|cjs|py|html?|css|scss|ya?ml|json|toml|ini|sh|bash|sql|go|rs|java|kt|swift|rb|php|c|h|cpp|hpp|md|markdown|pdf|docx?|xlsx?|pptx?|png|jpe?g|svg|mp4|m4v|webm|mov|ogv|zip|csv|txt)(?:$|[?#])/i.test(raw)) return null;
    if (!/^(?:https?:\/\/|\/\/|localhost(?::|\/)|127\.\d)/i.test(raw) &&
        /\.(?:html?|md|pdf|docx?|xlsx?|pptx?|png|jpe?g|svg|mp4|m4v|webm|mov|ogv|zip|csv|txt)(?:$|[?#])/i.test(raw)) return null;
    const url = normalizeAddress(raw.startsWith('//') ? 'https:' + raw : raw);
    return url ? { kind: 'url', url } : null;
  }
  function outputMentions(value, files) { return links ? links.mentions(String(value || ''), files) : []; }
  function linkifyOutputs(root, files, filesSig) { return links ? links.linkify(root, files, filesSig) : 0; }
  function openTaskOutput(file) {
    if (!file || !file.taskId || !file.attachmentId) return false;
    if (previewKind(file) !== 'external') return false;
    if (!WB.openingTaskFiles) WB.openingTaskFiles = new Set();
    const id = artifactKey(file), opening = WB.openingTaskFiles, current = previewOwner();
    if (opening.has(id)) return true;
    opening.add(id);
    links.openTaskFile(file, global.SoduWorkAPI, global.soduWorkAPI).catch(error => {
      if (current() && typeof petSay === 'function') petSay(error.message || '无法打开成果');
    }).finally(() => opening.delete(id));
    return true;
  }
  function openLink(value, options = {}) {
    const target = linkTarget(value, WB.files);
    if (!target) return false;
    const mediaType = ['image', 'video'].includes(options.mediaType) ? options.mediaType : '';
    if (mediaType && target.kind === 'url') {
      const parsed = new URL(target.url);
      if (parsed.username || parsed.password) return false;
    }
    if (target.kind === 'file' && openPendingCloud(target.file, true)) return true;
    if (target.kind === 'file' && openTaskOutput(target.file)) return true;
    WB.manualClosed = false;
    if (target.kind === 'file' && !isTaskPreview(target.file) &&
        (previewKind(target.file) === 'external' || (previewKind(target.file) === 'pdf' && !target.file.path))) {
      artifactRequest(sessionApi(), context().ref, target.file, 'open');
      return true;
    }
    if (target.kind === 'file') { const tab = openFile(target.file, true); if (tab) tab.autoPreview = false; }
    else {
      let label = target.url;
      try { label = new URL(target.url).hostname || target.url; } catch (_) { /* keep url */ }
      addTab({ key: 'url:' + workScope() + ':' + target.url,
        kind: 'browser', label, url: target.url, mediaType, autoPreview: false }, true);
    }
    paint();
    return true;
  }
  function openSavedDelivery(id, options = {}) {
    if (!id || !WB.root || !global.LibraryDelivery?.open) return false;
    WB.manualClosed = false;
    const key = 'saved:' + workScope() + ':' + id;
    const existing = WB.tabs.find(tab => tab.key === key);
    const tab = addTab({ key, kind: 'saved-delivery', label: options.title || '已保存版本', autoPreview: false }, true);
    if (!existing) {
      tab.content = global.document.createElement('div');
      tab.content.className = 'ncw-saved-delivery';
      // Reuse the authorized saved-file viewer without opening its modal surface.
      void global.LibraryDelivery.open(id, { ...options, mount: tab.content,
        onMount: dispose => { tab.dispose = dispose; }, onClose: () => closeTab(tab.id) });
    }
    paint();
    return true;
  }
  function openService(item, activate) {
    // item.title is already the translated display string; the label source
    // must stay the original Chinese so a later switch back can re-translate.
    return addTab({ key: 'service:' + workScope() + ':' + item.id,
      kind: 'service', label: item.titleSource ?? item.title, service: item, url: item.url }, activate);
  }
  function newBrowser() {
    const stamp = Date.now() + '-' + (++WB.seq);
    return addTab({ key: 'browser:' + workScope() + ':' + stamp,
      kind: 'browser', label: '新标签页', url: '' }, true);
  }
  function openFiles() {
    if (!WB.files.length) return null;
    return addTab({ key: 'files:' + workScope(), kind: 'files', label: '文件' }, true);
  }
  // A settled delivery can refresh its artifact index more than once (for
  // example when a local copy is reconciled with the delivery receipt), which
  // may change the candidate key while the previous preview is still marked
  // as automatic. Only collapse duplicate previews of the same file; distinct
  // deliverables keep their own tabs, and user-opened tabs remain untouched.
  function samePreviewFile(tab, candidate) {
    if (!tab || !candidate) return false;
    if (candidate.kind === 'service') return tab.key === candidate.key;
    const previous = tab.file, next = candidate.item;
    if (!previous || !next) return false;
    const previousTask = String(previous.taskId || previous.cloudTaskId || '');
    const nextTask = String(next.taskId || next.cloudTaskId || '');
    if (previousTask && nextTask && previousTask !== nextTask) return false;
    if (artifactKey(previous) && artifactKey(previous) === artifactKey(next)) return true;
    const normalize = value => String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
    const previousRelative = normalize(previous.relative), nextRelative = normalize(next.relative);
    if (previousRelative && nextRelative && previousRelative === nextRelative) return true;
    const previousPath = normalize(previous.path), nextPath = normalize(next.path);
    if (previousPath && nextPath && previousPath === nextPath) return true;
    return Boolean(previousRelative && nextPath && (nextPath.endsWith('/' + previousRelative) || nextPath === previousRelative));
  }
  function removeStaleAutoPreviewTabs(candidate) {
    const stale = WB.tabs.filter(tab => tab.autoPreview && samePreviewFile(tab, candidate));
    if (!stale.length) return;
    const staleIds = new Set(stale.map(tab => tab.id));
    stale.forEach(tab => {
      try { tab.dispose?.(); } catch (_) { /* preview already closed */ }
      try { nativeApi()?.destroy?.(tab.id); } catch (_) { /* preview already closed */ }
      delete WB.states[tab.id];
    });
    WB.tabs = WB.tabs.filter(tab => !staleIds.has(tab.id));
    if (staleIds.has(WB.active)) WB.active = WB.tabs[WB.tabs.length - 1]?.id || '';
  }
  /*
   * Resolve tool-card paths through the conversation file index and open code/diff tabs.
   * Return false for missing or native-application files so the caller can handle fallback
   * presentation.
   */
  function openPath(value, hint) {
    const p = normalizedPath(value);
    if (!p) return false;
    if (hint?.readSnapshot) {
      const readSnapshot = { ...hint.readSnapshot };
      const hasImages = Boolean(readSnapshot.imageCount || readSnapshot.images?.length || readSnapshot.imagesTruncated);
      // Validate once when opening, not on every transcript repaint. Only the
      // recorded image bytes are previewed; a tool path never grants file access.
      Object.assign(readSnapshot, readImagePayload(readSnapshot.images), { revision: ++readImageRevision });
      delete readSnapshot.images;
      const file = { name: p.split('/').pop() || p, relative: p, readSnapshot };
      WB.manualClosed = false;
      if (!WB.open) { resetSplit(WB.root); WB.open = true; }
      addTab({ key: 'tool-read:' + workScope() + ':' + fileKey(file), kind: hasImages ? 'image' : 'text',
        label: file.name, file, view: hasImages ? 'preview' : 'code', autoPreview: false }, true);
      paint();
      return true;
    }
    let file = WB.files.find((item) => {
      const names = [item.path, item.relative, item.name].map(normalizedPath).filter(Boolean);
      return names.some((x) => x === p || p.endsWith('/' + x) || x.endsWith('/' + p));
    });
    /* Tool cards can arrive before the output index refreshes. Keep the click
       in the same workbench by promoting the tool's bounded before/after
       payload to a temporary workspace file instead of opening a modal drawer. */
    if (!file && hint && hint.change) {
      const name = p.split('/').pop() || p;
      file = { name, relative: p, path: p, kind: 'file', changedInTurn: true,
        primary: true, size: Number(hint.size) || 0, at: Date.now(), change: hint.change,
        syntheticChange: true };
      WB.files.push(file);
    } else if (file && hint && hint.change && (!file.change || file.syntheticChange)) {
      file.change = hint.change;
      file.syntheticChange = true;
      file.changedInTurn = true;
    }
    if (!file) return false;
    let kind = previewKind(file);
    if (kind === 'external' && hint?.change) kind = 'text';
    if (kind === 'external' || (kind === 'pdf' && !file.path)) return false;
    /* Tool cards open HTML and similar files as source/diff, not web previews. */
    if (kind === 'web') kind = 'text';
    WB.manualClosed = false;
    if (!WB.open) { resetSplit(WB.root); WB.open = true; }
    const change = fileChangeFor(file);
    const editorFile = isCodeFile(file) || Boolean(change) || kind === 'text';
    addTab({ key: 'file:' + workScope() + ':' + fileKey(file),
      kind: editorFile && kind === 'markdown' ? 'text' : kind, label: file.name, file,
      view: change && change.action !== 'created' ? 'diff' : 'code', autoPreview: false }, true);
    paint();
    return true;
  }
  function locationFor(tab) {
    if (!tab) return '';
    if (tab.kind === 'web' || tab.kind === 'pdf') {
      const address = addressFor(tab);
      return /^file:/i.test(address) ? info.displayAddress(address) : address;
    }
    if (tab.kind === 'browser' || tab.kind === 'service') return addressFor(tab);
    const file = tab.file || {};
    return String(fileLocation(tab) || file.relative || file.name || '');
  }
  function referenceFor(tab) {
    if (!tab) return null;
    const location = locationFor(tab);
    if (!location) return null;
    const label = tr(String(tab.label || (tab.file && tab.file.name) || '成果'));
    const kind = tab.kind === 'browser' || tab.kind === 'service' ? 'browser' : 'file';
    return { kind, label, location, text: kind === 'browser'
      ? '请参考网页「' + label + '」：' + location
      : '请查看工作区文件「' + label + '」：' + location };
  }
  function dispatchReference(tab) {
    const reference = referenceFor(tab);
    if (!reference || !WB.root || typeof global.CustomEvent !== 'function') return false;
    WB.root.dispatchEvent(new global.CustomEvent('soduwork-workbench-reference', {
      bubbles: true, detail: reference,
    }));
    return true;
  }
  function dispatchElementReference(tab, payload) {
    if (!tab || !payload || !WB.root || typeof global.CustomEvent !== 'function') return false;
    const label = String(tab.label || '网页').trim() || '网页';
    const selector = String(payload.selector || '').trim();
    const text = String(payload.text || '').trim();
    const html = String(payload.html || '').trim();
    const url = String(payload.url || locationFor(tab) || '').trim();
    const lines = [
      '请修改网页「' + label + '」中的这个元素。',
      url ? '页面：' + url : '',
      selector ? '元素选择器：' + selector : '',
      payload.tag ? '元素类型：' + String(payload.tag) : '',
      text ? '当前内容：' + text : '',
      html ? '元素结构：' + html : '',
      '修改要求：',
    ].filter(Boolean);
    WB.root.dispatchEvent(new global.CustomEvent('soduwork-workbench-reference', {
      bubbles: true,
      detail: { kind: 'browser-element', label, location: url, selector, selectedText: text, html, element: payload, text: lines.join('\n') },
    }));
    return true;
  }
  function annotationRows() { return global.ChatWorkbenchAnnotations ? global.ChatWorkbenchAnnotations.rows() : []; }
  function syncAnnotations() {
    const api = nativeApi(), rows = annotationRows();
    if (api && typeof api.setAnnotations === 'function') WB.tabs.forEach(tab => {
      if (tab.nativeReady) api.setAnnotations(tab.id, rows).catch(() => {});
    });
    updateNativeChrome();
  }
  function dispatchAnnotation(tab, payload) {
    return Boolean(tab && payload && global.ChatWorkbenchAnnotations && global.ChatWorkbenchAnnotations.receive(payload));
  }
  function sendAnnotations() {
    if (!annotationRows().length || !WB.root) return false;
    WB.root.dispatchEvent(new global.CustomEvent('soduwork-workbench-send-annotations', { bubbles: true }));
    return true;
  }
  const latestTurnWebFile = (files, turnChanges) =>
    tools.latestTurnWebFile(files, turnChanges, previewKind);
  function tabIcon(tab) {
    if (tab.kind === 'files') return ICONS.file;
    return tab.kind === 'service' || tab.kind === 'browser' || tab.kind === 'web' ? ICONS.globe : ICONS.file;
  }
  function tabsHtml() {
    let html = '<button type="button" class="ncw-tooltab" data-wb-files' + (WB.active && tabById(WB.active)?.kind === 'files' ? ' aria-pressed="true"' : '') + ' title="打开文件面板（Ctrl+Shift+O）">' + ICONS.file + '<span>文件</span></button>';
    html += WB.tabs.map((tab) => '<span class="ncw-tabwrap"><button type="button" role="tab" data-wb-tab="' +
      esc(tab.id) + '" aria-selected="' + (WB.active === tab.id) + '">' + tabIcon(tab) +
      '<span data-wb-tab-label="' + esc(tab.id) + '"' + (tab.file || tab.kind === 'service' || tab.url ? ' data-user-content' : '') + '>' + esc(tab.label) + '</span></button>' +
      '<button type="button" class="ncw-tabclose" data-wb-tab-close="' + esc(tab.id) +
      '" aria-label="关闭 ' + esc(tab.label) + '">×</button></span>').join('');
    return html + '<button type="button" class="ncw-newtab" data-wb-new aria-label="新建浏览页签">＋</button>';
  }
  function markdown(text) {
    try {
      if (global.marked && global.DOMPurify) {
        return '<div class="ncw-markdown" data-user-content>' +
          links.sanitize(global.marked.parse(String(text || ''), { gfm: true }), global.DOMPurify) + '</div>';
      }
    } catch (_) { /* Fall back to plain text. */ }
    return '<pre class="ncw-code">' + esc(text) + '</pre>';
  }
  function addressFor(tab) {
    if (tab.mediaType) return tab.url;
    const state = stateFor(tab);
    if ((tab.kind === 'web' || tab.kind === 'pdf') && state.displayUrl) return state.displayUrl;
    if ((tab.kind === 'web' || tab.kind === 'pdf') && (!state.url || state.url === 'about:blank')) return tab.file.path || tab.file.relative || tab.file.name;
    return state.url && state.url !== 'about:blank' ? state.url : (tab.url || '');
  }
  function browserHtml(tab) {
    return info.browserToolbar({ tab, state: stateFor(tab), location: locationFor(tab), address: addressFor(tab), libraryButton: libraryUploadButton(tab.file) });
  }
  function filesHtml() {
    const rows = WB.files.slice().sort((left, right) => Number(right.at || 0) - Number(left.at || 0));
    return '<section class="ncw-files" aria-label="会话文件"><header><div><b>工作区文件</b><span>点击打开，或直接引用到对话</span></div><button type="button" data-wb-new title="新建浏览页签">＋ 浏览</button></header>' +
      (rows.length ? '<div class="ncw-file-list">' + rows.map((file) => {
        const id = fileKey(file), name = file.name || baseName(file.path || file.relative) || '文件';
        return '<article class="ncw-file-row"><button type="button" data-wb-file="' + esc(id || file.path) + '" title="打开 ' + esc(name) + '">' + ICONS.file + '<span><b data-user-content>' + esc(name) + '</b><small>' + esc(size(file.size)) + '</small></span></button>' + libraryUploadButton(file) +
          '<button type="button" data-wb-reference-file="' + esc(id || file.path) + '" title="引用到对话">' + ICONS.quote + '</button>' +
          '<button type="button" data-wb-copy-file="' + esc(id || file.path) + '" title="复制文件位置">' + ICONS.copy + '</button></article>';
      }).join('') + '</div>' : '<div class="ncw-files-empty">本次对话还没有可查看的文件。</div>') + '</section>';
  }
  function libraryUploadButton(file) {
    return global.LibraryTransfer?.button(file, context().ref, 'data-wb-library-upload') || '';
  }

  function needsNative(tab) {
    if (!tab) return false;
    if (tab.kind === 'web' || tab.kind === 'pdf' || tab.kind === 'service') return true;
    return tab.kind === 'browser' && !tab.mediaType && Boolean(tab.url);
  }
  function hideNative() {
    if (!WB.nativeShown && !WB.nativePending) return;
    WB.nativeShown = '';
    WB.nativePending = false;
    WB.nativeRequest++;
    requestNativeHide();
  }
  function requestNativeHide(api = nativeApi()) {
    if (!api) return;
    try { const pending = api.hide(); pending?.catch?.(() => {}); } catch (_) { /* preview already closed */ }
  }
  function scheduleNative() {
    if (WB.frame && global.cancelAnimationFrame) global.cancelAnimationFrame(WB.frame);
    const run = async () => {
      WB.frame = 0;
      const tab = activeTab();
      const slot = WB.root && WB.root.querySelector('[data-wb-native]');
      const api = nativeApi();
      if (!api || !WB.open || !needsNative(tab) || !slot || !WB.root.offsetParent) { hideNative(); return; }
      const rect = slot.getBoundingClientRect();
      if (rect.width < 32 || rect.height < 32) { hideNative(); return; }
      const payload = {
        tabId: tab.id, ref: context().ref, label: tab.label,
        bounds: { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) },
      };
      slot.setAttribute('data-native-preview-tab', tab.id);
      if (!tab.nativeReady) {
        if (tab.reloadNative) payload.reload = true;
        if (tab.kind === 'web' && tab.file.artifactId) {
          Object.assign(payload, { kind: 'artifact', artifactId: tab.file.artifactId });
        } else if (tab.kind === 'web' || tab.kind === 'pdf') {
          Object.assign(payload, { kind: 'file', target: tab.file.path });
        }
        else Object.assign(payload, { kind: 'url', url: tab.url });
      }
      WB.nativePending = true;
      const request = ++WB.nativeRequest;
      let result;
      try { result = await api.show(payload); } catch (_) { if (request === WB.nativeRequest) WB.nativePending = false; return; }
      if (request !== WB.nativeRequest) return;
      WB.nativePending = false;
      if (WB.active !== tab.id) return;
      if (result && result.ok) {
        tab.nativeReady = true; tab.reloadNative = false; WB.nativeShown = tab.id;
        if (result.state) receiveNativeState(result.state);
      } else {
        tab.nativeReady = false;
        WB.states[tab.id] = { ...(WB.states[tab.id] || {}), error: result && result.reason || '页面没有打开' };
        updateNativeChrome();
      }
    };
    WB.frame = global.requestAnimationFrame ? global.requestAnimationFrame(run) : setTimeout(run, 0);
  }
  function receiveNativeState(state) {
    // IPC messages already queued before reset may arrive at the new listener.
    // Tab IDs remain unique across resets; never cache an unknown owner's data.
    const tab = state && tabById(state.tabId);
    if (!tab || tab.mediaType) return;
    if (state && state.downloadBlocked) {
      // When the main process blocks direct attachment navigation, direct the user to the delivery card without adding canvas state.
      if (typeof global.petSay === 'function') global.petSay(state.downloadBlocked);
      return;
    }
    if (!state || !state.tabId) return;
    WB.states[state.tabId] = { ...(WB.states[state.tabId] || {}), ...state };
    if (tab && tab.kind === 'browser' && state.title && state.title !== 'about:blank') tab.label = state.title.slice(0, 60);
    updateNativeChrome();
  }
  function updateNativeChrome() {
    const tab = activeTab();
    if (!WB.root || !tab) return;
    const state = stateFor(tab);
    const input = WB.root.querySelector('[data-wb-address]');
    if (input && global.document.activeElement !== input) {
      input.value = info.displayAddress(addressFor(tab)); input.title = input.value;
    }
    const back = WB.root.querySelector('[data-wb-nav="back"]');
    const forward = WB.root.querySelector('[data-wb-nav="forward"]');
    if (back) back.disabled = !state.canBack;
    if (forward) forward.disabled = !state.canForward;
    const reload = WB.root.querySelector('[data-wb-nav="reload"],[data-wb-nav="stop"]');
    if (reload) {
      reload.dataset.wbNav = state.loading ? 'stop' : 'reload';
      reload.title = state.loading ? '停止' : '刷新';
      reload.setAttribute('aria-label', reload.title);
      reload.innerHTML = state.loading ? ICONS.close : ICONS.reload;
    }
    const browser = WB.root.querySelector('.ncw-browser');
    if (browser) browser.classList.toggle('is-loading', Boolean(state.loading));
    const error = WB.root.querySelector('.ncw-browser-error');
    if (error) { error.hidden = !state.error; error.textContent = state.error || ''; }
    const inspect = WB.root.querySelector('[data-wb-inspect]');
    if (inspect) {
      inspect.disabled = !(['browser', 'service', 'web'].includes(tab.kind) && Boolean(state.url || tab.url));
      inspect.setAttribute('aria-pressed', String(Boolean(state.inspectEnabled)));
      inspect.title = state.inspectEnabled ? '正在注释网页元素，点击页面元素添加标注' : '进入注释模式，点击网页元素添加批量修改标注';
    }
    const sendAnnotations = WB.root.querySelector('[data-wb-send-annotations]');
    const annotationCount = annotationRows().length;
    if (sendAnnotations) {
      sendAnnotations.hidden = annotationCount === 0;
      const count = sendAnnotations.querySelector('i');
      if (count) count.textContent = String(annotationCount);
    }
    const label = WB.root.querySelector('[data-wb-tab-label="' + tab.id + '"]');
    if (label) label.textContent = tab.label;
  }
  function paintLayout() {
    const root = WB.root;
    if (!root) return;
    ensure(root);
    const has = hasVisibleTabs(WB.tabs);
    if (!has) { WB.open = false; WB.maximized = false; WB.active = ''; }
    root.classList.remove('ncw-goal');
    root.classList.toggle('ncw-has', Boolean(has));
    root.classList.toggle('ncw-open', Boolean(WB.open));
    root.classList.toggle('ncw-maximized', Boolean(WB.open && WB.maximized));
    root.querySelector('.ncw').setAttribute('aria-hidden', String(!WB.open));
    const count = WB.summaryFiles.length + WB.services.filter((item) => item.url).length;
    const maximize = root.querySelector('[data-wb-maximize]');
    if (maximize) {
      maximize.innerHTML = WB.maximized ? ICONS.restore + '<span>返回对话</span>' : ICONS.expand;
      maximize.title = WB.maximized ? '恢复对话与成果并排（Esc）' : '最大化成果区';
      maximize.setAttribute('aria-pressed', String(WB.maximized));
      maximize.setAttribute('aria-label', WB.maximized ? '恢复对话与成果并排' : '最大化成果区');
    }
    if (global.ChatChrome) ChatChrome.workbenchState({
      open: Boolean(WB.open), maximized: Boolean(WB.open && WB.maximized), count, has: Boolean(has),
      summary: {
        // Pass the full file list; the overlay owns progressive display and its twelve-item initial limit.
        // This keeps list expansion consistent with the total badge.
        files: WB.summaryFiles.map((item) => ({ name: item.name, path: artifactKey(item), size: size(item.size),
          workspace: previewKind(item) !== 'external' })),
        services: WB.services.filter((item) => item.url),
        changes: WB.changes.slice(-8),
      },
    });
    if (WB.open) scheduleNative(); else hideNative();
  }
  function paint() {
    destroyEditor();
    paintLayout();
    if (!WB.root) return;
    WB.root.querySelector('.ncw-tabs').innerHTML = tabsHtml();
    const tab = activeTab();
    if (tab?.kind === 'image' && tab.file?.readSnapshot) {
      tab.file.readSnapshot.usedAt = ++readImageUse;
      if (WB.open) restoreReadImageSnapshot(tab);
    }
    trimReadImageSnapshots();
    const body = WB.root.querySelector('.ncw-body');
    const mediaKey = tab?.kind === 'image' && tab.file?.readSnapshot
      ? JSON.stringify([tab.id, 'read-image', tab.file.readSnapshot.revision])
      : tab?.mediaType ? JSON.stringify([tab.id, tab.mediaType, tab.url]) : '';
    if (tab?.content) { body.replaceChildren(tab.content); body.dataset.wbMediaKey = ""; }
    else if (!mediaKey || body.dataset.wbMediaKey !== mediaKey) {
      body.querySelector?.('video')?.pause();
      body.innerHTML = tabBody(tab);
      body.dataset.wbMediaKey = mediaKey;
      hydrateRemoteMedia(body);
    }
    if (!WB.open) body.querySelector?.('video')?.pause();
    restoreFileView(tab);
    if (tab && tab.view === 'code' && !WB.previewLoading) {
      (global.requestAnimationFrame || ((fn) => setTimeout(fn, 0)))(() => mountEditor(tab));
    }
  }
  function renderWorkbench(root, snapshot, files) {
    WB.root = root; ensure(root);
    const turnTools = currentTurnTools(snapshot || {});
    const nextChanges = changes(turnTools);
    WB.fileChanges = info.currentWorkJournal(snapshot);
    const nextFiles = mergeFileChanges(files, WB.fileChanges);
    const selection = info.currentWorkSelection(snapshot || {}, nextFiles, context().cwd || context().intent?.cwd);
    const nextSummaryFiles = selection.files;
    // A remote Runner prints the same localhost URL as a local dev server, but
    // that loopback belongs to the Runner machine. The committed cloud target
    // carries its reachable host; pass it to the shared service parser so the
    // right-side native browser opens the actual cloud address and port.
    const remote = snapshot?.cloudHandoff?.phase === 'committed' ||
      snapshot?.execution?.cloud === true || snapshot?.executionLocation === 'cloud';
    const target = snapshot?.cloudHandoff?.target || snapshot?.execution?.target || {};
    const cloudHost = String(target.host || target.address || target.runnerHost || '').trim();
    const nextServices = services(turnTools, { cloud: remote, cloudHost })
      .map((item) => ({ ...item, titleSource: item.title, stateSource: item.state,
        title: tr(item.title), state: tr(item.state) }));
    const scope = workScope();
    const signature = scope + '::' + nextFiles.map((item) => artifactKey(item) + ':' + item.at + ':' + item.size + ':' + (item.title || '') + ':' + (item.change?.action || '')).join('|') + '::' +
      nextSummaryFiles.map(artifactKey).join('|') + '::' +
      selection.images.map(item => artifactKey(item) + ':' + Boolean(item.changedInTurn)).join('|') + '::' +
      nextChanges.map((item) => item.id + ':' + item.state).join('|') + '::' +
      (WB.fileChanges?.capturedAt || 0) + '::' +
      nextServices.map((item) => item.id + ':' + item.state + ':' + item.url).join('|');
    if (signature === WB.signature) { scheduleNative(); return; }
    WB.signature = signature;
    WB.files = nextFiles; WB.summaryFiles = nextSummaryFiles; WB.changes = [
      ...nextChanges,
      ...(Array.isArray(WB.fileChanges?.files) ? WB.fileChanges.files.filter(item =>
        links.workspaceFileTarget(item.path, WB.summaryFiles, WB.fileChanges.cwd)).map(item => ({
        id: 'file:' + item.path, action: item.action === 'created' ? '新增' : item.action === 'deleted' ? '删除' : item.action === 'renamed' ? '重命名' : '修改',
        name: baseName(item.path), path: item.path, state: '已完成', fileChange: item,
      })) : []),
    ]; WB.services = nextServices;
    WB.tabs.forEach((tab) => {
      if (tab.file && !tab.file.readSnapshot) {
        const next = WB.files.find((item) => artifactKey(item) === artifactKey(tab.file) ||
          (tab.inputFile && matchesInput(item, tab.inputFile))) || promoteFileTab(tab, WB.files);
        if (next) {
          const changed = next.at !== tab.file.at || next.size !== tab.file.size;
          tab.file = tab.inputFile ? { ...next, ...tab.inputFile, at: next.at, size: next.size } : next;
          if (tab.kind === 'web') {
            tab.labelSource = tab.file.title || tab.file.name;
            tab.label = tr(tab.labelSource);
          }
          if (changed) { tab.nativeReady = false; tab.reloadNative = true; }
        }
      }
      if (tab.service) {
        const next = WB.services.find((item) => item.id === tab.service.id);
        if (next && next.url !== tab.url) { tab.service = next; tab.url = next.url; tab.nativeReady = false; }
      }
    });
    const previewFiles = WB.summaryFiles.filter(canAutoPreview);
    const firstWeb = latestTurnWebFile(previewFiles, WB.changes);
    const firstVideo = previewFiles.filter((item) => previewKind(item) === 'video' && item.changedInTurn && item.primary !== false && !item.processEvidence)
      .sort((left, right) => Number(right.at || 0) - Number(left.at || 0))[0];
    const firstDocument = previewFiles.filter((item) => previewKind(item) === 'markdown' &&
      item.changedInTurn && item.primary !== false && !item.processEvidence)
      .sort((left, right) => Number(right.at || 0) - Number(left.at || 0))[0];
    const firstImage = previewFiles.filter((item) => previewKind(item) === 'image' &&
      item.changedInTurn && item.primary !== false && !item.processEvidence)
      .sort((left, right) => Number(right.at || 0) - Number(left.at || 0))[0];
    const explicitImage = selection.images.filter(item => canAutoPreview(item) && item.changedInTurn)
      .sort((left, right) => Number(right.at || 0) - Number(left.at || 0))[0];
    const firstPreview = firstWeb || firstVideo || firstDocument || firstImage;
    /*
     * The conversation text does not always repeat the generated filename.
     * currentWorkSelection intentionally excludes an unmentioned workspace
     * file, which is correct for the file summary but used to suppress the
     * automatic result preview as well.  Once the turn is settled, use the
     * delivery receipt as a narrowly scoped fallback: only this-turn primary
     * deliverables may become the automatic candidate.  Historical,
     * supporting and process-evidence files remain manual-only.
     */
    const settled = !global.ChatDeliveries || global.ChatDeliveries.isSettled(snapshot || {});
    const deliveryFiles = settled && typeof info.currentDeliveryFiles === 'function'
      ? info.currentDeliveryFiles(snapshot || {}, nextFiles) : [];
    const deliveryRank = file => {
      const kind = previewKind(file);
      if (kind === 'web') return 0;
      if (kind === 'video') return 1;
      if (kind === 'markdown') return 2;
      if (kind === 'image') return 3;
      if (kind === 'pdf') return 4;
      return 99;
    };
    const firstDelivery = deliveryFiles
      .filter(file => canAutoPreview(file) && deliveryRank(file) < 99)
      .sort((left, right) => deliveryRank(left) - deliveryRank(right) ||
        Number(right.at || 0) - Number(left.at || 0))[0];
    const live = WB.services.find((item) => item.url && !/失败|停止|failed|stopped/i.test(item.stateSource || item.state || ''));
    // An explicitly presented new screenshot may replace an automatic page,
    // while the existing manual-focus/close guards below remain authoritative.
    const candidate = explicitImage ? { kind: 'file', item: explicitImage,
      key: scope + ':artifact:' + artifactKey(explicitImage) }
      : live ? { kind: 'service', item: live,
      key: scope + ':service:' + live.id + ':' + live.url }
      : firstPreview ? { kind: 'file', item: firstPreview,
        key: scope + ':artifact:' + artifactKey(firstPreview) }
      : firstDelivery ? { kind: 'file', item: firstDelivery,
        key: scope + ':artifact:' + artifactKey(firstDelivery) } : null;
    if (!WB.autoOpened && !WB.manualClosed && candidate) {
      resetSplit(root);
      WB.open = true; WB.autoOpened = true;
    }
    if (!WB.manualClosed && candidate && candidate.key !== WB.autoPreviewKey) {
      removeStaleAutoPreviewTabs(candidate);
      const active = tabById(WB.active);
      const activate = !active || active.autoPreview === true;
      WB.autoPreviewed = true; WB.autoPreviewKey = candidate.key;
      const tab = candidate.kind === 'service' ? openService(candidate.item, activate) : openFile(candidate.item, activate, true);
      if (tab && activate) tab.autoPreview = true;
    }
    paint();
  }
  function resetWorkbench() {
    const previousRoot = WB.root;
    WB.tabs.forEach(tab => tab.dispose?.());
    if (WB.frame) (global.cancelAnimationFrame || clearTimeout)(WB.frame);
    WB.nativeRequest++;
    WB.epoch++;
    destroyEditor();
    WB.split?.dispose(); WB.split = null;
    const api = nativeApi();
    if (api) {
      if (typeof api.resetEmbedded === 'function') api.resetEmbedded();
      else api.destroy('');
    }
    try { if (WB.unlisten) WB.unlisten(); } catch (_) { /* renderer is already closing */ }
    try { if (WB.unlistenElement) WB.unlistenElement(); } catch (_) { /* renderer is already closing */ }
    try { if (WB.observer) WB.observer.disconnect(); } catch (_) { /* renderer is already closing */ }
    try { if (WB.visibilityObserver) WB.visibilityObserver.disconnect(); } catch (_) { /* renderer is already closing */ }
    const keep = { root: null, context: null, observer: null,
      visibilityObserver: null, unlisten: null, unlistenElement: null };
    Object.assign(WB, {
      open: false, maximized: false, manualClosed: false, autoOpened: false,
      autoPreviewed: false, autoPreviewKey: '',
      active: '', files: [], summaryFiles: [], changes: [], services: [],
      tabs: [], states: Object.create(null), signature: '', previewKey: '', previewText: '', previewError: '',
      previewRequest: null, cloudOpenRequest: null, openingTaskFiles: new Set(),
      previewLoading: false, fileChanges: null, editor: null, editorDrafts: Object.create(null), editorDirty: false,
      nativeShown: '', nativePending: false, frame: 0, ...keep,
    });
    if (previousRoot) {
      resetSplit(previousRoot);
      previousRoot.classList.remove('ncw-has', 'ncw-open', 'ncw-maximized');
      previousRoot.querySelector('.ncw')?.setAttribute('aria-hidden', 'true');
      for (const selector of ['.ncw-tabs', '.ncw-body']) {
        previousRoot.querySelector(selector)?.replaceChildren();
      }
    }
  }
  Object.assign(tools, {
    status, _toolMeta: toolMeta, _services: services, _changes: changes,
    _currentTurnTools: currentTurnTools, _latestTurnWebFile: latestTurnWebFile,
    _previewKind: previewKind, _fileUrl: fileUrl, _normalizeAddress: normalizeAddress, _linkTarget: linkTarget,
    _hasVisibleTabs: hasVisibleTabs, _outputMentions: outputMentions, linkifyOutputs,
  });
  function toggleWorkbench() {
    if (!hasVisibleTabs(WB.tabs)) return;
    WB.open = !WB.open;
    if (!WB.open) WB.maximized = false;
    WB.manualClosed = !WB.open;
    paint();
  }
  function maximizeWorkbench(value) {
    if (!hasVisibleTabs(WB.tabs)) return;
    WB.open = true; WB.manualClosed = false;
    WB.maximized = typeof value === 'boolean' ? value : !WB.maximized;
    paintLayout();
    if (!WB.maximized) WB.root?.querySelector('[data-wb-resize]')?.focus({ preventScroll: true });
  }
  function workbenchState() {
    const count = WB.files.length + WB.services.filter((item) => item.url).length;
    return { open: WB.open, maximized: WB.maximized, count, has: hasVisibleTabs(WB.tabs) };
  }
  function openInput(file) {
    if (!file?.path || !WB.root) return false;
    WB.manualClosed = false;
    const tab = openFile(file, true);
    if (tab) {
      tab.autoPreview = false;
      // Keep the user-opened source preview independent from later output IDs
      // and source/deliverable classification while accepting content versions.
      tab.inputFile = { path: file.path, kind: file.kind, primary: file.primary, artifactId: file.artifactId };
    }
    paint();
    return true;
  }
  global.ChatWorkbench = { bind: bindWorkbench, render: renderWorkbench, reset: resetWorkbench,
                           toggle: toggleWorkbench, maximize: maximizeWorkbench,
                           openOutput, openInput, openLink, openPath, openSavedDelivery, state: workbenchState, syncAnnotations };
  global.addEventListener?.('soduwork-data-scope-changed', resetWorkbench);
  // Re-translate the cached, protected labels when the client language changes
  // mid-session; the DOM adapter never touches them (user content).
  global.addEventListener?.('soduwork-locale-change', () => {
    if (!WB.tabs.length && !WB.services.length) return;
    WB.tabs.forEach((tab) => { tab.label = tr(tab.labelSource ?? tab.label); });
    WB.services.forEach((item) => {
      item.title = tr(item.titleSource ?? item.title);
      item.state = tr(item.stateSource ?? item.state);
    });
    if (WB.root) paint();
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = tools;
})(typeof window !== 'undefined' ? window : globalThis);
