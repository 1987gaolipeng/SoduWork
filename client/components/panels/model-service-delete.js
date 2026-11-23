/* Service deletion has its own confirmation and submits only the stored target
 * domain. Unrelated in-memory edits never become part of a deletion request. */
let _mdDeleteDialog = null;
const _mdDeleteText = (source, params = {}) => globalThis.SoduWorkI18n?.t?.(source, source, params) ||
  source.replace(/\{(\w+)\}/g, (all, key) => params[key] ?? all);
const _mdDeleteCurrent = plan => plan.loadId === _mdLoadId && plan.scope === SoduWorkAPI.taskStorageKey?.('ops');
function _mdDeleteError(message) { return Object.assign(new Error(message), { detail: message }); }
function _mdDeleteCatalogState(providers, models) {
  const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
  return JSON.stringify(stable([
    providers.map(row => [row.id, row.name || '', row.kind || 'openai-compat', row.baseUrl || '',
      row.defaultBaseUrl || '', !!row.personal, row.authMode || 'key', row.note || '']),
    models.map(row => [row.providerId, row.name, row.label || row.name, row.modality || 'chat', row.config || {}, row.ctxWindow || 0]),
  ]));
}

function _mdDeleteManagedCatalog(providers, models, excludedId = '') {
  const own = providers.filter(row => row.personal === true && row.localOnly !== true && row.id !== excludedId);
  const ids = new Set(own.map(row => row.id));
  return { providers: own, models: models.filter(row => row.localOnly !== true && ids.has(row.providerId)) };
}

function _mdGuardServiceDelete(plan) {
  const provider = _mdProvider(plan.pid);
  if (provider && (provider.personal !== true || (provider.localOnly === true) !== plan.local))
    throw _mdDeleteError(_mdDeleteText('此服务无法删除，请刷新后重试。'));
  if (plan.local || !plan.body) return;
  const otherManaged = id => id !== plan.pid && _mdProvider(id)?.personal === true && _mdProvider(id)?.localOnly !== true;
  const { providers, models } = _mdDeleteManagedCatalog(_mdData.providers, _mdMyModels, plan.pid);
  // The Hub does not return the deletion's committed revision. Keep unrelated
  // drafts saveable instead of admitting a deletion that would lock them out.
  if (Object.keys(_mdKeyEdits).some(otherManaged) ||
    [..._mdDrafts].some(([id, draft]) => otherManaged(id) && (draft.original || draft.changed)) ||
    _mdDeleteCatalogState(providers, models) !== _mdDeleteCatalogState(plan.body.providers, plan.body.models))
    throw _mdDeleteError(_mdDeleteText('请先完成或取消其他服务的编辑，再删除此服务。'));
}

async function _mdPrepareServiceDelete(pid) {
  const provider = _mdProvider(pid);
  if (provider?.personal !== true) throw _mdDeleteError(_mdDeleteText('此服务无法删除，请刷新后重试。'));
  const plan = { pid, name: String(provider.name || '').trim() ? provider.name : _mdDeleteText('未命名服务'), local: provider.localOnly === true,
    loadId: _mdLoadId, scope: SoduWorkAPI.taskStorageKey?.('ops'),
    draftOnly: _mdNew?.id === pid && !_mdData.providers.some(row => row.id === pid) };
  if (plan.draftOnly) return { ...plan, count: 0, hasKey: false, body: null };
  const catalog = plan.local ? await SoduWorkAPI.localModels() : await SoduWorkAPI.myModels();
  if (!_mdDeleteCurrent(plan)) throw _mdDeleteError(_mdDeleteText('配置页面已变化，请重新打开删除确认。'));
  if (!catalog || !Array.isArray(catalog.providers) || !Array.isArray(catalog.myModels) || catalog.revision == null)
    throw _mdDeleteError(_mdDeleteText('无法确认服务配置，请检查连接后重试。'));
  if (catalog.revision !== (plan.local ? _mdData.localRevision : _mdData.revision))
    throw _mdDeleteError(_mdDeleteText('服务配置已变化，请重新打开模型页面后重试。'));
  const stored = catalog.providers.find(row => row.id === pid);
  if (stored && (stored.personal !== true || (stored.localOnly === true) !== plan.local))
    throw _mdDeleteError(_mdDeleteText('此服务无法删除，请刷新后重试。'));
  plan.count = catalog.myModels.filter(row => row.providerId === pid).length;
  plan.hasKey = Boolean(stored && ((stored.myKeyLen || 0) > 0 ||
    (stored.authMode !== 'none' && stored.myKeySet)));
  if (!stored) return { ...plan, body: null };
  if (plan.local) {
    plan.body = { localProviders: catalog.providers.filter(row => row.id !== pid),
      localModels: catalog.myModels.filter(row => row.providerId !== pid),
      localKeys: { [pid]: null }, localRevision: catalog.revision };
  } else {
    const own = _mdDeleteManagedCatalog(catalog.providers, catalog.myModels, pid);
    // Removing a personal provider also removes its saved key on the Hub.
    // A redundant raw-ID key patch would be ambiguous when a device service
    // has the same ID, since the deleted managed provider is absent below.
    plan.body = { providers: own.providers, models: own.models,
      keys: {}, expectedRevision: catalog.revision };
  }
  _mdGuardServiceDelete(plan);
  return plan;
}

function _mdApplyServiceDeletion(plan, result, latest) {
  const pid = plan.pid;
  const nav = [...(document.getElementById('mdBody')?.querySelectorAll?.('[data-mdselect]') || [])]
    .map(row => row.getAttribute('data-mdselect'));
  const ids = nav.length ? nav : _mdData.providers.map(row => row.id);
  const at = ids.indexOf(pid), neighbour = ids[at + 1] || ids[at - 1] || '';
  _mdData.providers = _mdData.providers.filter(row => row.id !== pid);
  _mdMyModels = _mdMyModels.filter(row => row.providerId !== pid);
  _mdData.myModels = _mdMyModels;
  _mdData.usable = (_mdData.usable || []).filter(row => row.providerId !== pid);
  for (const type of ['image', 'video']) if (_mdData.mediaUsable?.[type])
    _mdData.mediaUsable[type] = _mdData.mediaUsable[type].filter(row => row.providerId !== pid);
  delete _mdKeyEdits[pid]; delete _mdTest[pid]; _mdDrafts.delete(pid); _mdLocalKeyIds.delete(pid);
  _mdClearProviderChecks(pid);
  if (_mdNew?.id === pid) _mdNew = null;
  if (_mdValidation?.providerId === pid) _mdValidation = null;
  if (plan.local) {
    if (result?.revision != null) _mdData.localRevision = result.revision;
    _mdLocalDirty = _mdLocalKeyIds.size > 0;
  } else if (plan.body) {
    // Preserve edits to other providers; clear the flag if only the deleted
    // provider had edits. Compare user-editable fields, not derived probe data.
    const own = _mdDeleteManagedCatalog(_mdData.providers, _mdMyModels);
    const managedId = id => _mdProvider(id)?.personal === true && _mdProvider(id)?.localOnly !== true;
    _mdManagedDirty = Object.keys(_mdKeyEdits).some(managedId) ||
      _mdDeleteCatalogState(own.providers, own.models) !== _mdDeleteCatalogState(plan.body.providers, plan.body.models);
    const hasManagedEditor = [..._mdDrafts].some(([id, draft]) => managedId(id) && (draft.original || draft.changed));
    _mdManagedNeedsReload = latest?.revision == null || _mdManagedDirty || hasManagedEditor;
    if (!_mdManagedNeedsReload) {
      // Public fields cannot reveal a same-length secret change. Accept a read
      // revision only with its entire managed snapshot and no pending managed
      // edits; otherwise retain the old revision so later writes cannot skip a conflict.
      const localIds = new Set(_mdData.providers.filter(row => row.localOnly).map(row => row.id));
      if (_mdNew?.localOnly) localIds.add(_mdNew.id);
      const isLocal = row => row.localOnly || localIds.has(row.providerId);
      _mdData.providers = _mdData.providers.filter(row => row.localOnly).concat(latest.providers.filter(row => !row.localOnly));
      _mdMyModels = _mdMyModels.filter(isLocal).concat(latest.myModels.filter(row => !isLocal(row)));
      _mdData.myModels = _mdMyModels; _mdData.revision = latest.revision;
      _mdData.usable = _mdData.usable.filter(isLocal).concat((latest.usable || []).filter(row => !isLocal(row)));
      _mdData.mediaUsable = Object.fromEntries(['image', 'video'].map(type => [type,
        (_mdData.mediaUsable?.[type] || []).filter(isLocal).concat((latest.mediaUsable?.[type] || []).filter(row => !isLocal(row)))]));
    }
  }
  _mdDirty = _mdLocalDirty || _mdManagedDirty || Object.keys(_mdKeyEdits).some(id => _mdProvider(id)?.personal === true);
  if (_mdOpen === pid) _mdOpen = neighbour;
  if (_mdEditor === pid || _mdEditor === '__new__:' + pid) _mdEditor = '';
}

function _mdDeleteService(plan) {
  if (_mdSaveFlight) return Promise.reject(_mdDeleteError(_mdDeleteText('正在保存配置，请稍后重试。')));
  const flight = Promise.resolve().then(async () => {
    if (!_mdDeleteCurrent(plan)) throw _mdDeleteError(_mdDeleteText('配置页面已变化，请重新打开删除确认。'));
    _mdGuardServiceDelete(plan);
    let result, latest;
    plan.refreshWarning = false;
    if (plan.body) {
      result = await SoduWorkAPI.saveMyModels(structuredClone(plan.body));
      if (!result || result.ok === false) throw _mdDeleteError(_mdDeleteText('删除未完成，请重试。'));
      // The write has committed. A read/picker/display failure is a separate warning.
      if (!plan.local && _mdDeleteCurrent(plan)) {
        try {
          const candidate = await SoduWorkAPI.myModels();
          if (candidate?.revision != null && Array.isArray(candidate.providers) && Array.isArray(candidate.myModels)) {
            const own = _mdDeleteManagedCatalog(candidate.providers, candidate.myModels);
            if (_mdDeleteCatalogState(own.providers, own.models) ===
              _mdDeleteCatalogState(plan.body.providers, plan.body.models)) latest = candidate;
          }
        } catch (_) { /* Keep the revision locked until a successful, consistent read. */ }
      }
    }
    if (!_mdDeleteCurrent(plan)) return true;
    try {
      _mdApplyServiceDeletion(plan, result, latest);
      if (!plan.local && plan.body && _mdManagedNeedsReload) plan.refreshWarning = true;
      _mdRender();
    } catch (_) { plan.refreshWarning = true; }
    void _mdRefreshSavedModels();
    return true;
  }).finally(() => {
    if (_mdSaveFlight === flight) _mdSaveFlight = null;
    if (_mdDeleteFlight === flight) _mdDeleteFlight = null;
    _mdMark();
  });
  _mdSaveFlight = flight; _mdDeleteFlight = flight; _mdMark();
  return flight;
}

function _mdCloseDeleteDialog() { _mdDeleteDialog?.finish(false); }

function _mdConfirmServiceDelete(pid) {
  if (_mdSaveFlight || _mdDeleteDialog || _mdProvider(pid)?.personal !== true) return;
  const dialog = document.createElement('dialog');
  dialog.id = 'mdDeleteDialog'; dialog.className = 'md-delete-dialog';
  dialog.setAttribute('aria-labelledby', 'mdDeleteTitle'); dialog.setAttribute('aria-describedby', 'mdDeleteDescription');
  dialog.innerHTML = '<div class="md-delete-card"><header class="md-delete-heading">' +
    '<span class="md-delete-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5"/></svg></span>' +
    '<h2 id="mdDeleteTitle">' + _mdMessage('删除模型服务', '删除模型服务') + '</h2></header>' +
    '<div id="mdDeleteDescription"><p id="mdDeleteSummary"></p><p id="mdDeleteDraft" hidden></p></div>' +
    '<p id="mdDeleteError" role="alert" hidden></p><footer>' +
    '<button type="button" data-md-delete-cancel autofocus>' + _mdMessage('取消', '取消') + '</button>' +
    '<button type="button" class="md-delete-confirm" data-md-delete-confirm disabled>' +
    _mdMessage('正在读取…', '正在读取…') + '</button></footer></div>';
  const cancel = dialog.querySelector('[data-md-delete-cancel]'), confirm = dialog.querySelector('[data-md-delete-confirm]');
  const errorBox = dialog.querySelector('#mdDeleteError');
  const loadId = _mdLoadId, scope = SoduWorkAPI.taskStorageKey?.('ops');
  let closed = false, busy = false, plan = null, failed = false;
  const current = () => !closed && loadId === _mdLoadId && scope === SoduWorkAPI.taskStorageKey?.('ops');
  const finish = success => {
    if (closed) return;
    closed = true;
    if (dialog.open) dialog.close(); dialog.remove();
    if (_mdDeleteDialog?.dialog === dialog) { _mdDeleteDialog = null; _mdDeletePending = ''; }
    if (loadId !== _mdLoadId || scope !== SoduWorkAPI.taskStorageKey?.('ops')) return;
    const box = document.getElementById('mdBody');
    const target = success ? box?.querySelector('[data-mdselect][aria-pressed="true"],#mdEmptyAdd') :
      [...(box?.querySelectorAll('[data-pdelete]') || [])].find(row => row.getAttribute('data-pdelete') === pid);
    target?.focus({ preventScroll: true });
  };
  const errorText = error => error?.detail ||
    (/本地模型配置|系统安全存储/.test(error?.message || '') ? error.message :
      (typeof _humanErr === 'function' ? _humanErr(error, _mdDeleteText('请检查连接后重试。')) : _mdDeleteText('请检查连接后重试。')));
  function paint() {
    const params = { name: plan.name, count: plan.count };
    dialog.querySelector('#mdDeleteTitle').innerHTML = _mdMessage(plan.draftOnly ? '丢弃“{name}”？' : '删除“{name}”？',
      plan.draftOnly ? '丢弃“{name}”？' : '删除“{name}”？', params);
    const summary = plan.draftOnly ? '将丢弃此服务尚未保存的配置。' : plan.local
      ? (plan.count ? (plan.hasKey ? '将从本机移除连接配置、{count} 个模型及已保存的 API Key。' : '将从本机移除连接配置及 {count} 个模型。')
        : (plan.hasKey ? '将从本机移除连接配置及已保存的 API Key。' : '将从本机移除连接配置。'))
      : (plan.count ? (plan.hasKey ? '将从账号移除连接配置、{count} 个模型及已保存的 API Key。' : '将从账号移除连接配置及 {count} 个模型。')
        : (plan.hasKey ? '将从账号移除连接配置及已保存的 API Key。' : '将从账号移除连接配置。'));
    dialog.querySelector('#mdDeleteSummary').innerHTML = _mdMessage(summary, summary, params);
    const draft = dialog.querySelector('#mdDeleteDraft');
    draft.hidden = plan.draftOnly || !(_mdProvider(pid)?._capStale || _mdLocalKeyIds.has(pid) ||
      Object.hasOwn(_mdKeyEdits, pid) || _mdDrafts.has(pid));
    draft.innerHTML = _mdMessage('未保存的修改将一并丢弃。', '未保存的修改将一并丢弃。');
    confirm.innerHTML = _mdMessage(plan.draftOnly ? '丢弃服务' : '删除服务', plan.draftOnly ? '丢弃服务' : '删除服务');
  }
  async function prepare() {
    busy = true; confirm.disabled = true; dialog.setAttribute('aria-busy', 'true');
    try {
      const next = await _mdPrepareServiceDelete(pid);
      if (!current()) { finish(false); return; }
      plan = next; failed = false; errorBox.hidden = true; paint();
    } catch (error) {
      if (!current()) { finish(false); return; }
      failed = true; errorBox.hidden = false; errorBox.textContent = errorText(error);
      confirm.innerHTML = _mdMessage('重试', '重试');
    } finally {
      busy = false; if (current()) { confirm.disabled = false; dialog.removeAttribute('aria-busy'); }
    }
  }
  cancel.addEventListener('click', () => { if (!cancel.disabled) finish(false); });
  dialog.addEventListener('cancel', event => { event.preventDefault(); if (!cancel.disabled) finish(false); });
  dialog.addEventListener('click', event => { if (event.target === dialog && !cancel.disabled) finish(false); });
  dialog.addEventListener('close', () => finish(false));
  confirm.addEventListener('click', async () => {
    if (busy || !current()) return;
    if (!plan) { await prepare(); return; }
    busy = true; confirm.disabled = true; cancel.disabled = true; errorBox.hidden = true;
    dialog.setAttribute('aria-busy', 'true'); confirm.innerHTML = _mdMessage('正在删除…', '正在删除…');
    try {
      if (failed) {
        const next = await _mdPrepareServiceDelete(pid);
        if (!current()) { finish(false); return; }
        // Another writer may have changed the deletion scope. Show it before resubmitting.
        if (JSON.stringify(next.body) !== JSON.stringify(plan.body)) {
          plan = next; failed = false; paint(); errorBox.hidden = false;
          errorBox.innerHTML = _mdMessage('服务配置已更新，请核对后再次确认。', '服务配置已更新，请核对后再次确认。'); return;
        }
      }
      await _mdDeleteService(plan);
      if (!current()) { finish(false); return; }
      finish(true);
      globalThis.petSay?.(_mdDeleteText(plan.refreshWarning ? '服务已删除，但配置清单需要刷新，请重新打开模型页面。' :
        plan.draftOnly ? '已丢弃未保存的服务“{name}”' : '已删除模型服务“{name}”', { name: plan.name }));
    } catch (error) {
      if (!current()) { finish(false); return; }
      failed = true; errorBox.hidden = false;
      errorBox.innerHTML = _mdMessage('删除失败，请重试。', '删除失败，请重试。');
      const reason = document.createElement('span'); reason.textContent = errorText(error); errorBox.appendChild(reason);
      confirm.innerHTML = _mdMessage('重试删除', '重试删除');
    } finally {
      busy = false; if (current()) { confirm.disabled = false; cancel.disabled = false; dialog.removeAttribute('aria-busy'); }
    }
  });
  _mdDeletePending = pid; _mdDeleteDialog = { dialog, finish, current };
  document.body.appendChild(dialog); dialog.showModal(); cancel.focus({ preventScroll: true });
  void prepare();
}
for (const name of ['soduwork-data-scope-changed', 'soduwork-device-auth'])
  globalThis.addEventListener?.(name, () => { if (_mdDeleteDialog && !_mdDeleteDialog.current()) _mdCloseDeleteDialog(); });
