/* Model rows and capability editing share the provider page's save/revision flow. */
const _mdDrafts = new Map();
const _mdChecks = new Map();
const _mdQueuedChecks = new Map();
let _mdDrainingChecks = false;
function _mdCheckKey(pid, name) { return JSON.stringify([pid, name]); }
function _mdClearCheck(key) {
  _mdQueuedChecks.delete(key);
  // Abort before removing the record: an unsaved edit never reaches the host.
  if (_mdChecks.get(key)?.pending) _mdCancelModelCheck(...JSON.parse(key));
  _mdChecks.delete(key);
}
function _mdClearProviderChecks(pid) {
  for (const key of [..._mdChecks.keys(), ..._mdQueuedChecks.keys()]) {
    if (JSON.parse(key)[0] === pid) _mdClearCheck(key);
  }
}
function _mdStopModelChecks() {
  _mdQueuedChecks.clear();
  for (const [key, check] of _mdChecks) if (check.pending) {
    check.viewClosed = true;
    _mdCancelModelCheck(...JSON.parse(key));
  }
}
function _mdQueueAddedModel(model, provider, scope) {
  if (_mdType(model.modality) !== 'chat' || !provider.baseUrl || model.capabilityCheck ||
      (provider.kind || 'openai-compat') !== 'openai-compat' ||
      !(provider.authMode === 'none' || provider.myKeySet || provider.keySet)) return;
  const pid = provider.id, name = model.name;
  _mdQueuedChecks.set(_mdCheckKey(pid, name), { pid, name, scope, id: model.id, revision: model.configRevision });
  void _mdDrainSavedChecks();
}
async function _mdDrainSavedChecks() {
  if (_mdDrainingChecks) return;
  _mdDrainingChecks = true;
  try {
    while (_mdQueuedChecks.size) {
      // The add operation publishes its row before releasing the catalog write.
      if (_mdSaveFlight) { await _mdSaveFlight.catch(() => {}); continue; }
      const [key, target] = _mdQueuedChecks.entries().next().value;
      _mdQueuedChecks.delete(key);
      const row = _mdMyModels.find(item => item.providerId === target.pid && item.name === target.name);
      if (target.scope !== SoduWorkAPI.taskStorageKey?.('ops') || !row ||
          row.id !== target.id || row.configRevision !== target.revision) continue;
      await _mdCheckModel(target.pid, target.name, true);
    }
  } finally { _mdDrainingChecks = false; }
}
function _mdReconcileChecks(data) {
  const models = new Map((data.myModels || []).map(row => [_mdCheckKey(row.providerId, row.name), row]));
  for (const provider of data.providers || []) for (const row of provider.modelDefs || [])
    models.set(_mdCheckKey(provider.id, row.name), row);
  for (const [key, check] of _mdChecks) {
    if (check.pending) continue;
    const model = models.get(key);
    if (!model || (model.configRevision && check.configRevision !== model.configRevision)) _mdChecks.delete(key);
  }
}
function _mdModelListHtml(p, models, own) {
  const editable = _mdCanEdit(p);
  if (!editable) own = [];
  const rows = models.map(model => ({ model, index: -1 })).concat(own.map((model, index) => ({ model, index })));
  if (!rows.length) return '<p class="md-model-help">' + (editable ? '添加模型后可配置能力并进行检测。' : '服务端尚未配置模型。') + '</p>';
  return '<div class="md-model-list">' + rows.map(({ model, index }) => {
    const id = _mdCheckKey(p.id, model.name), check = _mdChecks.get(id);
    const stale = p._capStale && !check?.usesSavedService;
    const item = stale ? { ...model, capabilityProfile: undefined, capabilityCheck: null } : model;
    const report = stale ? null : check || item.capabilityCheck;
    const inlineStatus = _mdType(model.modality) === 'chat' && !report && !item.capabilityEvidenceError;
    return '<article class="md-model-row md-mtag' + (index >= 0 ? ' is-own' : '') + '" data-md-model="' + esc(id) + '">' +
      '<div><div class="md-model-name"><i class="md-model-type is-' + _mdType(model.modality) + '">' + _MD_TYPES[_mdType(model.modality)] + '</i>' +
      '<span data-user-content>' + esc(model.label || model.name) + '</span></div>' +
      (model.label && model.label !== model.name ? '<span class="md-model-id" data-user-content>' + esc(model.name) + '</span>' : '') +
      ModelCapabilitiesUI.badges(item, report) + '</div><div class="md-model-footer">' +
      (inlineStatus ? '<div class="md-model-status">' + ModelCapabilitiesUI.report(null) + '</div>' : '') +
      '<div class="md-model-actions">' +
      (editable && _mdType(model.modality) === 'chat' ? '<button type="button" data-mdcheck' + (check?.pending ? ' disabled' : '') + '>' + (check?.pending ? '检测中…' : '检测能力') + '</button>' : '') +
      (editable && check?.pending && check.modelRef ? '<button type="button" data-mdcancelcheck>取消检测</button>' : '') +
      (editable && index >= 0 ? '<button type="button" data-mdedit="' + esc(p.id) + '|' + index + '">编辑</button>' +
        '<button type="button" data-mdel="' + esc(p.id) + '|' + index + '" title="移除模型" aria-label="移除模型">移除模型</button>' : '<span class="md-cap-unchecked">组织管理</span>') +
      '</div></div>' + (_mdType(model.modality) === 'chat' && !inlineStatus ? '<div class="md-model-report">' +
        (p._capStale && check?.usesSavedService ? '<small>检测使用已保存的服务配置。</small>' : '') +
        ModelCapabilitiesUI.evidenceWarning(item) + ModelCapabilitiesUI.report(report, item) + '</div>' : '') + '</article>';
  }).join('') + '</div>';
}
function _mdModelEditorHtml(p) {
  if (!_mdCanEdit(p)) return '';
  const draft = _mdDrafts.get(p.id), model = draft?.model || {}, config = model.config || {}, type = _mdType(model.modality);
  return '<details class="md-model-editor" data-mdeditor="' + esc(p.id) + '"' + (draft?.open ? ' open' : '') + '><summary>' +
    (draft?.original ? '编辑模型' : '添加模型') + '</summary><div class="md-addgrid">' +
    '<label class="md-cap-field"><span>模型用途</span><select class="md-addselect" data-paddtype="' + esc(p.id) + '">' + _mdTypeOptions(type) + '</select></label>' +
    '<label class="md-cap-field"><span>模型 ID</span><input class="md-addin" data-padd="' + esc(p.id) + '" aria-label="添加模型 ID" placeholder="输入准确的模型 ID" maxlength="160" value="' + esc(model.name || '') + '"></label>' +
    '<label class="md-addthinking" data-paddthinkingwrap="' + esc(p.id) + '"><span>思考模式</span><select class="md-addselect" data-paddthinking="' + esc(p.id) + '">' + _mdThinkingOptions(config.thinkingMode || (config.thinkingAlwaysOn ? 'always' : 'auto')) + '</select></label>' +
    '<label class="md-cap-field" data-mdchat><span>显示名称</span><input class="md-in" data-mdlabel value="' + esc(model.label || '') + '" placeholder="默认使用模型 ID"></label>' +
    ModelCapabilitiesUI.fields(model) +
    '<input class="md-addin md-addpath" data-paddpath="' + esc(p.id) + '" aria-label="生成接口路径" value="' + esc(config.endpointPath || '') + '" placeholder="生成接口路径">' +
    '<input class="md-addin md-addstatus" data-paddstatus="' + esc(p.id) + '" aria-label="异步任务查询路径" value="' + esc(config.statusPath || '') + '" placeholder="/contents/generations/tasks/{id}">' +
    '<input class="md-addin md-addresult" data-paddresult="' + esc(p.id) + '" aria-label="结果下载路径" value="' + esc(config.resultPath || '') + '" placeholder="状态接口直接返回视频地址时留空">' +
    '<textarea class="md-addin md-adddefaults" data-padddefaults="' + esc(p.id) + '" aria-label="默认生成参数" rows="3">' + esc(JSON.stringify(config.defaults || {}, null, 2)) + '</textarea>' +
    '<div class="md-model-editor-actions"><button type="button" class="md-model-add" data-madd="' + esc(p.id) + '">' + (draft?.original ? '应用修改' : '添加模型') + '</button>' +
    '<button type="button" class="md-model-add-cancel" data-mdcancel="' + esc(p.id) + '">取消</button></div></div></details>';
}
function _mdBindModels(box) {
  box.querySelectorAll('[data-mdedit]').forEach(button => button.addEventListener('click', () => {
    if (button.isConnected === false) return;
    const [pid, index] = button.dataset.mdedit.split('|'), model = _mdMyModels.filter(row => row.providerId === pid)[+index];
    if (!_mdCanEdit(_mdProvider(pid)) || !model) return;
    _mdDrafts.set(pid, { original: model.name, model: structuredClone(model), open: true });
    _mdRender();
    const field = box.querySelector('[data-padd]');
    field?.focus({ preventScroll: true });
    // Reveal the editor only as far as necessary, without jumping to the form top.
    field?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }));
  box.querySelectorAll('[data-mdcancel]').forEach(button => button.addEventListener('click', () => {
    if (button.isConnected === false) return;
    _mdDrafts.delete(button.dataset.mdcancel); _mdRender();
  }));
  box.querySelectorAll('[data-mdeditor]').forEach(editor => {
    const pid = editor.dataset.mdeditor;
    if (!_mdCanEdit(_mdProvider(pid))) return;
    const restored = _mdDrafts.get(pid);
    for (const [selector, value] of Object.entries(restored?.fields || {})) {
      const field = editor.querySelector(selector); if (field) field.value = value;
    }
    if (restored?.advanced) editor.querySelector('.md-cap-advanced')?.setAttribute('open', '');
    ModelCapabilitiesUI.bindThinking(editor, restored?.thinkingCustom);
    function capture(event) {
      if (!editor.isConnected || !_mdCanEdit(_mdProvider(pid))) return;
      const fields = {};
      editor.querySelectorAll('input,select,textarea').forEach(field => {
        const attr = [...field.attributes].find(attribute => attribute.name.startsWith('data-'));
        if (attr) fields['[' + attr.name + '="' + CSS.escape(attr.value) + '"]'] = field.value;
      });
      const previous = _mdDrafts.get(pid) || {};
      _mdDrafts.set(pid, { ...previous, open: editor.open, fields,
        thinkingCustom: ModelCapabilitiesUI.thinkingDraft(editor),
        changed: !!(previous.changed || event?.type === 'input' || event?.type === 'change'),
        advanced: !!editor.querySelector('.md-cap-advanced')?.open });
    }
    editor.addEventListener('input', capture);
    editor.addEventListener('change', capture);
    editor.addEventListener('toggle', event => { if (event.target === editor) capture(); });
    editor.querySelector('.md-cap-advanced')?.addEventListener('toggle', capture);
    const select = editor.querySelector('[data-paddtype]');
    function typeChange() {
      const type = select.value;
      editor.querySelectorAll('[data-mdchat],[data-paddthinkingwrap]').forEach(el => { el.hidden = type !== 'chat'; });
      editor.querySelectorAll('[data-paddpath],[data-padddefaults],[data-paddstatus],[data-paddresult]').forEach(el => {
        const visible = type !== 'chat' && (!el.matches('[data-paddstatus],[data-paddresult]') || type === 'video');
        el.hidden = !visible; el.disabled = !visible;
      });
      const path = editor.querySelector('[data-paddpath]'), status = editor.querySelector('[data-paddstatus]');
      if (!path.value && type !== 'chat') path.value = type === 'image' ? '/images/generations' : pid === 'volcengine' ? '/contents/generations/tasks' : '/videos/generations';
      if (!status.value && type === 'video' && pid === 'volcengine') status.value = '/contents/generations/tasks/{id}';
    }
    select.addEventListener('change', typeChange); typeChange();
    const submitModel = () => _mdApplyModel(editor);
    editor.querySelector('[data-madd]').addEventListener('click', submitModel);
    editor.querySelector('[data-padd]').addEventListener('keydown', event => {
      if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
      event.preventDefault(); submitModel();
    });
  });
  box.querySelectorAll('[data-mdcheck]').forEach(button => button.addEventListener('click', () => {
    if (button.isConnected === false) return;
    const [pid, name] = JSON.parse(button.closest('[data-md-model]').dataset.mdModel);
    _mdCheckModel(pid, name);
  }));
  box.querySelectorAll('[data-mdcancelcheck]').forEach(button => button.addEventListener('click', () => {
    const [pid, name] = JSON.parse(button.closest('[data-md-model]').dataset.mdModel);
    _mdCancelModelCheck(pid, name);
  }));
}
function _mdApplyModel(editor) {
  if (_mdSaveFlight || editor.isConnected === false) return;
  const pid = editor.dataset.mdeditor, draft = _mdDrafts.get(pid), original = draft?.original;
  const old = _mdMyModels.find(row => row.providerId === pid && row.name === original);
  // A removed edit target must not become an implicit new model.
  if (!_mdCanEdit(_mdProvider(pid)) || (original && !old)) return;
  const value = selector => editor.querySelector(selector)?.value.trim() || '';
  const name = value('[data-padd]'), modality = _mdType(value('[data-paddtype]'));
  if (!name) return;
  if (_mdMyModels.some(row => row !== old && row.providerId === pid && row.name === name) || _mdCatalogModels(_mdProvider(pid)).some(row => row.name === name)) {
    petSay('这个模型已经在清单里了'); return;
  }
  try {
    let config, ctxWindow;
    if (modality === 'chat') {
      ({ config, ctxWindow } = ModelCapabilitiesUI.read(editor, old));
    } else {
      const endpointPath = value('[data-paddpath]'), statusPath = value('[data-paddstatus]'), resultPath = value('[data-paddresult]');
      if (!endpointPath.startsWith('/')) throw Error('生成接口路径要以 / 开头');
      if (modality === 'video' && [statusPath,resultPath].some(path => path && (!path.startsWith('/') || !path.includes('{id}')))) throw Error('视频任务路径要以 / 开头，并包含 {id}');
      let defaults;
      try { defaults = JSON.parse(value('[data-padddefaults]') || '{}'); if (!defaults || Array.isArray(defaults) || typeof defaults !== 'object') throw Error(); }
      catch (_) { throw Error('默认参数要填写合法的 JSON 对象'); }
      config = { endpointPath, defaults, ...(modality === 'video' ? { statusPath, resultPath } : {}) };
    }
    const model = { ...(old || {}), providerId: pid, name, label: value('[data-mdlabel]') || name, modality, config, ...(ctxWindow !== undefined ? { ctxWindow } : {}) };
    delete model.capabilityProfile; delete model.capabilityCheck;
    if (!old) {
      if (_mdNew?.id === pid) { petSay('请先保存模型服务，再添加模型。'); return; }
      return _mdAddModel(model);
    }
    _mdMyModels.splice(_mdMyModels.indexOf(old), 1, model);
    _mdClearCheck(_mdCheckKey(pid, name));
    if (original) _mdClearCheck(_mdCheckKey(pid, original));
    _mdDrafts.delete(pid); _mdMarkOwnedDirty(_mdProvider(pid) || pid); _mdRender();
  } catch (error) { petSay(error.message); }
}
function _mdAddModel(model) {
  const pid = model.providerId, local = _mdProvider(pid).localOnly === true;
  const revisionField = local ? 'localRevision' : 'revision';
  const expectedRevision = _mdData[revisionField], loadId = _mdLoadId, scope = SoduWorkAPI.taskStorageKey?.('ops');
  const current = () => loadId === _mdLoadId && scope === SoduWorkAPI.taskStorageKey?.('ops');
  const matches = row => row.providerId === pid && row.name === model.name;
  const flight = Promise.resolve().then(async () => {
    if (!current()) return;
    const catalog = local ? await SoduWorkAPI.localModels() : await SoduWorkAPI.myModels({ localDefaults: false });
    if (!current()) return;
    const provider = catalog.providers.find(row => row.id === pid);
    if (expectedRevision == null || catalog.revision !== expectedRevision || !_mdCanEdit(provider) ||
        (!local && _mdManagedNeedsReload)) throw Error('服务配置已变化，请重新打开模型页面后重试。');
    // Both APIs replace a model list. Base it on persisted rows so no other editor's drafts are submitted.
    const stored = catalog.myModels.filter(row => (row.localOnly === true) === local);
    if (stored.some(matches)) throw Error('这个模型已经在清单里了');
    if (!local && stored.length >= 40) throw Error('个人模型数量已达上限。');
    const models = [...stored, { ...model, localOnly: local }];
    const result = local ? await SoduWorkAPI.saveLocalModels({ models, expectedRevision })
      : await SoduWorkAPI.saveMyModels({ models, expectedRevision, returnRevision: true });
    if (!current()) return;
    if (!result || result.ok === false) throw Error('没存上');
    const choices = model.modality === 'chat' ? result.usable : result.mediaUsable?.[model.modality];
    const choice = choices?.find(row => row.providerId === pid && (local ? row.modelName : row.name) === model.name);
    const saved = local ? result.myModels.find(matches) : { ...choice, ...model, ctxWindow: model.ctxWindow || 0, localOnly: false };
    if (!saved) throw Error('模型配置已保存，但模型清单刷新失败，请重新打开模型页面。');
    _mdData[revisionField] = result.revision;
    if (!local && result.revision == null) _mdManagedNeedsReload = true;
    _mdMyModels = [..._mdMyModels, saved];
    _mdData.myModels = [..._mdData.myModels, saved];
    if (choice) {
      if (model.modality === 'chat') _mdData.usable = [..._mdData.usable, choice];
      else _mdData.mediaUsable[model.modality] = [...(_mdData.mediaUsable[model.modality] || []), choice];
    }
    _mdDrafts.delete(pid);
    _mdClearCheck(_mdCheckKey(pid, model.name));
    if (local || (result.revision && choice?.configRevision)) _mdQueueAddedModel(saved, provider, scope);
    void _mdRefreshSavedModels();
  }).catch(error => {
    if (current()) petSay(_humanErr(error, error.message || '没存上'));
  }).finally(() => {
    _mdSaveFlight = null; _mdAddingModel = '';
    if (current()) _mdRender();
    _mdMark();
  });
  _mdAddingModel = pid;
  _mdSaveFlight = flight;
  _mdMark();
  return flight;
}
async function _mdCheckModel(pid, name, saved = false) {
  if (!_mdCanEdit(_mdProvider(pid))) return;
  const key = _mdCheckKey(pid, name);
  if (_mdChecks.get(key)?.pending) return;
  const local = _mdProvider(pid)?.localOnly === true;
  const queued = _mdQueuedChecks.delete(key);
  const pending = { pending: true, usesSavedService: saved || queued, controller: new AbortController(),
    ...(local ? { requestId: 'cap-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) } : {}) };
  _mdChecks.set(key, pending);
  let unsubscribe;
  try {
    _mdRender();
    if (!saved && !queued && _mdNeedsSave(pid)) {
      if (!await _mdSave(false)) throw Error('请先保存模型配置，再检测能力');
    }
    pending.controller.signal.throwIfAborted();
    const model = _mdMyModels.find(item => item.providerId === pid && item.name === name);
    if (local) {
      pending.modelRef = model?.id;
      unsubscribe = globalThis.soduWorkAPI?.localModels?.onCapabilityProgress?.(value => {
        if (value.requestId !== pending.requestId || _mdChecks.get(key) !== pending) return;
        (pending.checks ||= {})[value.check] = { status: value.status, code: value.code };
        _mdRender();
      });
      _mdRender();
    }
    const report = await SoduWorkAPI.checkMyModelCapabilities({ providerId: pid, model: name,
      ...(pending.usesSavedService && model?.configRevision ? { expectedConfigRevision: model.configRevision } : {}),
      localOnly: local, ...(pending.requestId ? { requestId: pending.requestId } : {}), checks: ['connection', 'imageInput', 'toolCalling', 'streaming'] },
      { signal: pending.controller.signal });
    if (_mdChecks.get(key) !== pending) return;
    if (pending.viewClosed) pending.controller.signal.throwIfAborted();
    _mdChecks.set(key, { ...report, usesSavedService: pending.usesSavedService });
    const row = _mdMyModels.find(item => item.providerId === pid && item.name === name) || _mdProvider(pid)?.modelDefs?.find(item => item.name === name);
    if (row && report.capabilityProfile) { delete row.capabilityEvidenceError; Object.assign(row, { capabilityProfile: report.capabilityProfile,
      capabilityCheck: report, ...(report.configRevision ? { configRevision: report.configRevision } : {}),
      ...(report.runtimeRevision ? { runtimeRevision: report.runtimeRevision } : {}) }); }
    const connection = report.checks?.connection;
    if (!_mdProvider(pid)?._capStale && (connection?.status === 'passed' || connection?.status === 'failed'))
      _mdTest[pid] = { state: connection.status === 'passed' ? 'ok' : 'bad', detail: '' };
    if (globalThis.ComposeModelPicker?.refresh) await ComposeModelPicker.refresh(true);
    if (report.runtimeChanged !== false) globalThis.soduWorkAPI?.broadcast?.('models', { providerId: pid });
  } catch (error) {
    if (_mdChecks.get(key) === pending) {
      const result = pending.controller.signal.aborted ? {
        checkedAt: new Date().toISOString(), checks: Object.fromEntries(['connection', 'imageInput', 'toolCalling', 'streaming']
          .map(check => [check, { status: 'cancelled', code: 'cancelled' }]))
      } : { error: _humanErr(error, '能力检测未完成，请重试') };
      _mdChecks.set(key, { ...result, usesSavedService: pending.usesSavedService });
    }
  }
  finally { unsubscribe?.(); }
  _mdRender();
}
async function _mdCancelModelCheck(pid, name) {
  const pending = _mdChecks.get(_mdCheckKey(pid, name));
  if (!pending?.pending || pending.controller.signal.aborted) return;
  pending.controller.abort();
  if (!pending.modelRef) return;
  try { await globalThis.soduWorkAPI?.localModels?.cancelCapabilities?.({ modelRef: pending.modelRef, requestId: pending.requestId }); }
  catch (_) { petSay('能力检测未能取消，请稍后重试'); }
}
