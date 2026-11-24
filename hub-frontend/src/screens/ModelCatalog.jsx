import { translateText as tx, localeMap, useLocale, serverMessage } from '../i18n.js'
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, useId } from 'react'
import { api } from '../api.js'
import { useViewportHeight } from '../viewport-height.js'
import { Loading, ErrorState, Icon, Modal, Confirm, toast, SelectMenu, takeNav, navTo } from '../ui.jsx'
import LlmSettings from './LlmSettings.jsx'
import ModelRuntime from './ModelRuntime.jsx'
import ModelProviderDeletion from './ModelProviderDeletion.jsx'
import './model-catalog-actions.css'
import { CAPABILITY_LABELS, CAPABILITY_STATES, CapabilityBadges, ModelCapabilityStatus } from './ModelCapabilities.jsx'
import './model-capabilities.css'








const MODEL_TYPES = localeMap(() => ([
  ['chat', '对话模型'],
  ['image', '图片生成'],
  ['video', '视频生成'],
]))
const MODEL_TYPE_LABEL = localeMap(() => Object.fromEntries(MODEL_TYPES))
const THINKING_FORMATS = localeMap(() => ([
  ['', '自动识别（按模型名）'],
  ['openai', 'OpenAI reasoning_effort'],
  ['deepseek', 'DeepSeek thinking'],
  ['qwen', 'Qwen enable_thinking'],
  ['qwen-chat-template', 'Qwen chat_template_kwargs'],
  ['chat-template', '自定义 chat_template_kwargs'],
  ['zai', 'Z.ai thinking'],
  ['openrouter', 'OpenRouter reasoning'],
  ['together', 'Together reasoning'],
  ['baseten', 'Baseten reasoning'],
  ['ant-ling', 'Ant Ling thinking'],
  ['string-thinking', '字符串 thinking'],
]))

const KINDS = localeMap(() => ([['openai-compat', 'OpenAI 兼容'], ['anthropic', 'Anthropic']]))

function canProbeProvider(provider) {
  return provider?.enabled && provider.baseUrl && provider.keySet && (provider.kind ?? 'openai-compat') === 'openai-compat'
}

function checkRevision(provider, model) {
  return JSON.stringify([provider.revision, model.revision, model.configRevision])
}

export default function ModelCatalog({ me }) {
  const viewportRef = useViewportHeight()
  const listRef = useRef(null)
  const bindList = useCallback(element => {
    listRef.current = element
    viewportRef(element)
  }, [viewportRef])
  const uiLocale = useLocale();
  const [d, setD] = useState(null)
  const [guide] = useState(() => {
    const nav = takeNav('models')
    return me?.id && nav?.accountId === me.id ? nav : null
  })
  const openedGuide = useRef(false)
  const [editP, setEditP] = useState(null)     // provider | 'new'
  const [addM, setAddM] = useState(null)       // {providerId, model?}
  const [del, setDel] = useState(null)         // {kind:'p'|'m', id, name}
  const [discover, setDiscover] = useState(null)  // provider whose upstream list to import
  const [defaultOpen, setDefaultOpen] = useState(false)
  const [defaultDirty, setDefaultDirty] = useState(false)
  // Details do not resize or reorder the service grid.
  const [viewProviderId, setViewProviderId] = useState(null)
  const [capabilityTargets, setCapabilityTargets] = useState({})
  const registerCapabilityTarget = useCallback((id, element) => {
    setCapabilityTargets(current => {
      if (current[id] === element) return current
      const next = { ...current }
      if (element) next[id] = element; else delete next[id]
      return next
    })
  }, [])
  const [error, setError] = useState(null)
  const [newProviderId, setNewProviderId] = useState('')
  const pendingProviderFocus = useRef('')

  const activeLoad = useRef(null)
  const firstChecks = useRef(new Map())
  const checkQueue = useRef(Promise.resolve())
  useEffect(() => {
    if (!guide || openedGuide.current || me?.id !== guide.accountId) return
    if (guide.firstChat === 'provider') {
      openedGuide.current = true
      setEditP('new')
    } else if (d && ['model', 'discover'].includes(guide.firstChat)) {
      openedGuide.current = true
      const p = d.providers.find(p => p.id === guide.providerId && p.enabled && p.baseUrl && p.keySet)
      if (!p) toast(tx('所选服务已停用或配置不完整，请重新选择。'))
      else if (guide.firstChat === 'model') setAddM({ providerId: p.id, provider: p })
      else setDiscover(p)
    }
  }, [d, guide, me?.id])
  const load = () => {
    setError(null)
    const request = api.modelCatalog()
    activeLoad.current = request
    request.then(catalog => {
      if (activeLoad.current !== request) return
      for (const [id, target] of firstChecks.current) {
        const model = catalog.models.find(row => row.id === id)
        const provider = catalog.providers.find(row => row.id === target.providerId)
        if (!model?.enabled || (model.modality || 'chat') !== 'chat' || model.capabilityCheck ||
            model.providerId !== target.providerId || !canProbeProvider(provider) ||
            target.key !== checkRevision(provider, model)) {
          firstChecks.current.delete(id)
        }
      }
      setD(catalog)
      activeLoad.current = null
    }).catch(e => {
      if (activeLoad.current !== request) return
      setError(e); activeLoad.current = null
    })
  }
  useEffect(() => {
    load()
    return () => { activeLoad.current = null; firstChecks.current.clear() }
  }, [])

  const closeAddModel = () => setAddM(current => current === addM ? null : current)
  const closeDiscovery = () => setDiscover(current => current === discover ? null : current)
  function modelsSaved(provider, receipts) {
    if (canProbeProvider(provider)) {
      for (const saved of receipts) {
        if (saved?.id && saved.revision && saved.configRevision && saved.providerRevision &&
            saved.providerRevision === provider.revision) {
          firstChecks.current.set(saved.id, { providerId: provider.id, key: checkRevision(provider, saved) })
        }
      }
    }
    load()
  }
  function scheduleFor(provider, model) {
    const target = firstChecks.current.get(model.id)
    if (!target || target.key !== checkRevision(provider, model)) return
    return run => {
      if (firstChecks.current.get(model.id) !== target) return
      firstChecks.current.delete(model.id)
      checkQueue.current = checkQueue.current.then(run)
      return checkQueue.current
    }
  }
  function applyCheck(provider, model, result) {
    setD(current => {
      const currentProvider = current.providers.find(row => row.id === provider.id)
      if (currentProvider?.revision !== provider.revision) return current
      return { ...current, models: current.models.map(row => row.id === model.id && checkRevision(currentProvider, row) === checkRevision(provider, model)
        ? { ...row, capabilityProfile: result.capabilityProfile, capabilityCheck: result } : row) }
    })
    // A catalog read already in flight may predate this persisted report.
    if (activeLoad.current) load()
  }
  const models = d?.models || []
  const byP = (pid) => models.filter((m) => m.providerId === pid)
  // Keep custom services ahead of built-ins within each enabled/disabled group
  // after reload too. A just-created service still receives temporary focus.
  const providers = (d?.providers || []).slice().sort((a, b) =>
    Number(b.id === newProviderId) - Number(a.id === newProviderId) ||
    (b.enabled - a.enabled) || (a.builtin - b.builtin) || a.name.localeCompare(b.name))
  useEffect(() => {
    if (!pendingProviderFocus.current || !d?.providers?.some(p => p.id === pendingProviderFocus.current)) return
    const card = listRef.current?.querySelector('.model-provider.is-new-provider')
    if (!card) return
    pendingProviderFocus.current = ''
    // A card can be taller than the list viewport; reveal its identifying header.
    const heading = card.querySelector('.model-provider-head') || card
    heading.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    card.focus({ preventScroll: true })
  }, [d, newProviderId, listRef])
  const viewProvider = providers.find(p => p.id === viewProviderId)
  const enabledProviders = providers.filter((p) => p.enabled).length
  const enabledModels = models.filter((m) => m.enabled).length
  const readyProviders = providers.filter((p) => p.enabled && p.baseUrl && p.keySet).length

  async function toggleP(p) {
    try { await api.saveModelProvider(p.id, { enabled: !p.enabled, expectedRevision: p.revision }); load() }
    catch (e) { toast(e.message || tx("保存失败")); load() }
  }
  async function toggleM(m) {
    try { await api.saveModelDef({ providerId: m.providerId, name: m.name, enabled: !m.enabled, expectedRevision: m.revision }); load() }
    catch (e) { toast(e.message || tx("保存失败")); load() }
  }

  const dialogs = <>
      {defaultOpen && <Modal title={tx("组织默认调用（旧版兼容）")} icon="key" wide dirty={defaultDirty}
        onClose={() => { setDefaultOpen(false); setDefaultDirty(false) }}><LlmSettings embedded onDirtyChange={setDefaultDirty} /></Modal>}
      {editP && <ProviderForm initial={editP === 'new' ? null : editP}
        onClose={() => setEditP(null)} onSaved={(providerId) => {
          if (editP === 'new') { setNewProviderId(providerId); pendingProviderFocus.current = providerId }
          setEditP(null); load()
        }} />}
      {addM && <ModelForm providerId={addM.providerId} initial={addM.model || null}
        onClose={closeAddModel} onSaved={receipts => { closeAddModel(); modelsSaved(addM.provider, receipts) }} />}
      {discover && <DiscoverForm key={discover.id} provider={discover}
        onClose={closeDiscovery} onSaved={receipts => { closeDiscovery(); modelsSaved(discover, receipts) }} />}
      {del?.kind === 'p' && <ModelProviderDeletion key={del.id} providerId={del.id}
        onClose={() => setDel(null)} onDeleted={() => { setDel(null); toast(tx("已删除")); load() }} />}
      {del?.kind === 'm' && <Confirm title={tx("删除模型")} danger confirmText={tx("删除")}
        text={tx("确定删除「{0}」？正在用它的人会挑不到。", [del.name])}
        onClose={() => setDel(null)}
        onConfirm={async () => {
          try {
            await api.deleteModelDef(del.id, del.revision)
            toast(tx("已删除"))
          } catch (e) { toast(tx("删不掉：") + (e.message || e)) }
          setDel(null); load()
        }} />}
  </>

  return (
    <div className="model-catalog">
      {guide && <button type="button" className="btn first-chat-reopen" onClick={() => navTo('overview')}>{tx('返回首次对话清单')}</button>}
      <ModelRuntime providers={providers} models={models}
        catalogCounts={d ? { providers: providers.length, models: models.length } : null} catalogSummary={
        <section className="model-catalog-summary model-runtime-dimension" aria-label={tx("目录配置")} aria-busy={!d && !error}>
          <header className="model-dimension-head"><Icon name="box" /><h4>{tx("目录配置")}</h4></header>
          <div className="model-catalog-summary-card"><span>{tx("服务总数")}</span><strong>{d ? providers.length : '—'}</strong><small>{d ? tx("已启用 {0} · 已停用 {1}", [enabledProviders, providers.length - enabledProviders]) : error ? tx("目录读取失败") : tx("正在读取目录")}</small></div>
          <div className="model-catalog-summary-card"><span>{tx("模型总数")}</span><strong>{d ? models.length : '—'}</strong><small>{d ? tx("已启用 {0} · 已停用 {1}", [enabledModels, models.length - enabledModels]) : error ? tx("目录读取失败") : tx("正在读取目录")}</small></div>
          <div className="model-catalog-summary-card"><span>{tx("配置完整服务")}</span><strong>{d ? readyProviders : '—'}</strong><small>{tx("服务已启用，且地址与密钥均已填写。")}</small></div>
          <p className="model-dimension-note">{error ? tx("目录读取失败") : tx("配置完整仅表示设置已齐全。")}</p>
          <button type="button" className="btn btn-ghost xs" aria-haspopup="dialog" onClick={() => setDefaultOpen(true)}
            title={tx("此设置用于日报总结和旧版执行。新需求和 Runner 使用的模型请在模型目录中添加。")}>
            <Icon name="key" />{tx("组织默认调用（旧版兼容）")}</button>
        </section>
      } catalogActions={
        <button className="btn btn-primary" disabled={!d} onClick={() => setEditP('new')}><Icon name="plus" />{tx("接一个服务")}</button>
      } />
      {error && <ErrorState msg={error.message} onRetry={load} />}
      {!d && !error && <Loading />}
      <div ref={bindList} className="model-provider-grid" tabIndex={0} role="region" aria-label={tx("服务与模型列表，可滚动")}>
        {providers.map((p) => {
          const ms = byP(p.id)
          const configured = p.enabled && p.baseUrl && p.keySet
          const enabled = ms.filter(m => m.enabled)
          const chatCount = configured ? enabled.filter(m => (m.modality || 'chat') === 'chat').length : 0
          const chatReady = chatCount > 0 && (p.kind || 'openai-compat') === 'openai-compat'
          let state
          let stateHint
          if (!p.enabled) state = tx("已停用")
          else if (!p.baseUrl) state = tx("缺地址")
          else if (!p.keySet) state = tx("缺密钥")
          else if (!ms.length) state = tx("已配置但无模型")
          else if (!chatCount) state = tx("无已启用的对话模型")
          else if (chatReady) state = tx("可对话（{0}）", [chatCount])
          else {
            state = tx("需兼容 Agent（{0}）", [chatCount])
            stateHint = tx("{0} 个已启用的对话模型需要使用支持此协议的 Agent。", [chatCount])
          }
          return (
            <article key={p.id} tabIndex={p.id === newProviderId ? -1 : undefined}
              className={'model-provider' + (p.enabled ? '' : ' disabled') + (p.id === newProviderId ? ' is-new-provider' : '')}>
              <header className="model-provider-head">
                <span className={'model-provider-glyph' + (chatReady ? ' ready' : '')}>{(p.name || p.id || '?').slice(0, 1)}</span>
                <div className="model-provider-title">
                  <div><h3 title={p.name || p.id}>{p.name || p.id}</h3>{p.builtin && <span className="sysbadge">{tx("内置")}</span>}</div>
                  <code title={p.id}>{p.id}</code>
                </div>
                <span className={'model-state ' + (chatReady ? 'ready' : (!p.enabled ? 'off' : 'warn'))} title={stateHint}><i />{state}</span>
              </header>

              <div className="model-provider-facts">
                <div><span>{tx("服务地址")}</span><code title={p.baseUrl || ''}>{p.baseUrl || tx("还没填写接口地址")}</code></div>
                <div><span>{tx("组织密钥")}</span><b>{p.keySet ? tx("已配置 · {0} 位", [p.keyLen]) : tx("尚未配置")}</b></div>
              </div>
              {p.note && <p className="model-provider-note" title={p.note}>{p.note}</p>}

              <div className="model-cloud">
                <div className="model-cloud-label">
                  <span>{tx("已启用模型")}</span><b>{enabled.length}/{ms.length}</b>
                  {ms.length > 0 && <button type="button" className="model-cloud-toggle" aria-haspopup="dialog"
                    onClick={event => { event.currentTarget.focus(); setViewProviderId(p.id) }}>
                    {tx("查看")}<Icon name="chevron" aria-hidden="true" />
                  </button>}
                </div>

              </div>

              <footer className="model-provider-actions admin-card-actions">
                <div className="model-card-action-group">
                  <button type="button" className="admin-card-action is-primary" onClick={() => setAddM({ providerId: p.id, provider: p })}><Icon name="plus" />{configured && !ms.length ? tx("加第一个模型") : tx("加模型")}</button>
                  <button type="button" className="admin-card-action" onClick={() => setDiscover({ ...p })}><Icon name="search" />{tx("发现模型")}</button>
                  <button type="button" className="admin-card-action" onClick={() => setEditP(p)}><Icon name="settings" />{tx("配置服务")}</button>
                </div>
                <ProviderMoreActions provider={p} onToggle={() => toggleP(p)}
                  onDelete={() => setDel({ kind: 'p', id: p.id, name: p.name, revision: p.revision })} />
              </footer>
            </article>
          )
        })}
      </div>

      {/* Keep checks mounted independently of the detail dialog. Closing it must
          not discard a queued first check or an in-flight result. */}
      {providers.flatMap(p => byP(p.id).filter(m => (m.modality || 'chat') === 'chat').map(m =>
        <ModelCapabilityStatus key={m.id + ':' + checkRevision(p, m)} model={m}
          portalTarget={capabilityTargets[m.id] || null} scheduleFirstCheck={scheduleFor(p, m)}
          disabled={!p.enabled || !m.enabled || !p.baseUrl || !p.keySet}
          onChecked={result => applyCheck(p, m, result)} />))}
      {viewProvider ? <Modal title={tx("{0}的模型列表", [viewProvider.name || viewProvider.id])}
        icon="box" wide scope="model-provider-dialog" onClose={() => setViewProviderId(null)}
        foot={<>
          <button type="button" className="btn btn-primary" onClick={() => setAddM({ providerId: viewProvider.id, provider: viewProvider })}><Icon name="plus" />{tx("加模型")}</button>
          <button type="button" className="btn btn-ghost" onClick={() => setDiscover({ ...viewProvider })}><Icon name="search" />{tx("发现模型")}</button>
          <button type="button" className="btn btn-ghost" onClick={() => setEditP(viewProvider)}><Icon name="settings" />{tx("配置服务")}</button>
        </>}>
        <div className="model-provider">
          <div className="model-chips" tabIndex={0} role="region"
            aria-label={tx("{0}的模型列表", [viewProvider.name || viewProvider.id])}>
            {byP(viewProvider.id).map((m) => (
              <div key={m.id} className={'model-chip' + (m.enabled ? '' : ' off')}>
                <div className="model-chip-identity">
                  <div className="model-chip-heading"><i className={'model-kind kind-' + (m.modality || 'chat')}>
                    {MODEL_TYPE_LABEL[m.modality || 'chat']}
                  </i>
                  <code title={m.name}>{m.label || m.name}</code></div>
                  {m.label && m.label !== m.name && <span className="model-chip-id">{m.name}</span>}
                  {(m.modality || 'chat') === 'chat' && <CapabilityBadges model={m} />}
                </div>
                <div className="model-chip-actions" role="group" aria-label={tx("{0} 操作", [m.label || m.name])}>
                  <button type="button" className="admin-card-action" aria-label={tx("配置模型 {0}", [m.label || m.name])} onClick={() => setAddM({ providerId: viewProvider.id, model: m })}>{tx("配置")}</button>
                  <button type="button" className="admin-card-action" aria-label={tx("{0}模型 {1}", [m.enabled ? tx("停用") : tx("启用"), m.label || m.name])} title={m.enabled ? tx("停用后将不再供成员选择") : tx("启用模型")} onClick={() => toggleM(m)}>{m.enabled ? tx("停用") : tx("启用")}</button>
                  {!m.builtin && <span className="model-chip-danger"><button type="button" className="admin-card-action is-danger" aria-label={tx("删除模型 {0}", [m.label || m.name])} onClick={() => setDel({ kind: 'm', id: m.id, name: m.label || m.name, revision: m.revision })}>{tx("删除")}</button></span>}
                </div>
                {(m.modality || 'chat') === 'chat' && <CapabilityStatusSlot modelId={m.id} register={registerCapabilityTarget} />}
              </div>
              ))}
          </div>
          {byP(viewProvider.id).length === 0 && <p className="muted">{tx("这个服务还没有模型")}</p>}
        </div>
        {dialogs}
      </Modal> : dialogs}
    </div>
  )
}

function CapabilityStatusSlot({ modelId, register }) {
  const bind = useCallback(element => register(modelId, element), [modelId, register])
  return <div className="model-cap-status-slot" ref={bind} />
}

function ProviderMoreActions({ provider, onToggle, onDelete }) {
  const id = useId()
  const trigger = useRef(null), popup = useRef(null)
  const [open, setOpen] = useState(false)
  useLayoutEffect(() => {
    const element = popup.current
    const sync = event => setOpen(event.newState === 'open')
    const place = () => {
      if (!element.matches(':popover-open')) return
      const rect = trigger.current.getBoundingClientRect()
      const width = element.offsetWidth, height = element.offsetHeight
      const viewport = window.visualViewport
      const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0
      const vw = viewport?.width || innerWidth, vh = viewport?.height || innerHeight
      Object.assign(element.style, {
        left: Math.max(left + 12, Math.min(rect.right - width, left + vw - width - 12)) + 'px',
        top: Math.max(top + 12, Math.min(rect.bottom + 6 + height > top + vh - 12 ? rect.top - height - 6 : rect.bottom + 6, top + vh - height - 12)) + 'px',
      })
    }
    const afterToggle = event => { sync(event); place() }
    element.addEventListener('toggle', afterToggle)
    const observer = new ResizeObserver(place)
    observer.observe(element)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    viewportEvents(true)
    function viewportEvents(add) {
      const method = add ? 'addEventListener' : 'removeEventListener'
      window.visualViewport?.[method]('resize', place)
      window.visualViewport?.[method]('scroll', place)
    }
    return () => {
      observer.disconnect(); element.removeEventListener('toggle', afterToggle)
      window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true)
      viewportEvents(false)
    }
  }, [])
  const choose = action => { popup.current.hidePopover(); trigger.current.focus(); action() }
  return <div className="model-card-more">
    <button ref={trigger} type="button" className="admin-card-action" popoverTarget={id}
      aria-expanded={open} aria-controls={id}>{tx("更多")}<Icon name="chevron" aria-hidden="true" /></button>
    <div ref={popup} id={id} popover="auto" className="model-card-more-popup" onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); popup.current.hidePopover(); trigger.current.focus() }
    }}>
      <button type="button" className="admin-card-action" onClick={() => choose(onToggle)}>{provider.enabled ? tx("停用服务") : tx("启用服务")}</button>
      {!provider.builtin && <button type="button" className="admin-card-action is-danger" onClick={() => choose(onDelete)}><Icon name="trash" />{tx("删除服务")}</button>}
    </div>
  </div>
}


function ProviderForm({ initial, onClose, onSaved }) {
  const uiLocale = useLocale();
  const editing = !!initial
  const [id, setId] = useState(initial ? initial.id : '')
  const [name, setName] = useState(initial ? initial.name : '')
  const [kind, setKind] = useState(initial ? initial.kind : 'openai-compat')
  const [baseUrl, setBaseUrl] = useState(initial ? initial.baseUrl : '')
  const [note, setNote] = useState(initial ? initial.note : '')
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [connection, setConnection] = useState(null)
  const activeTest = useRef(null)
  useEffect(() => () => { activeTest.current = null }, [])

  function changeConnection(setValue, value) {
    activeTest.current = null
    setConnection(null)
    setValue(value)
  }

  async function testConnection() {
    const request = api.testModelProviderConnection({
      baseUrl: baseUrl.trim(), kind, apiKey: apiKey.trim(),
      ...(editing ? { providerId: initial.id } : {}),
    })
    activeTest.current = request
    setConnection({ pending: true })
    try {
      const result = await request
      if (activeTest.current === request) setConnection(result)
    } catch (error) {
      if (activeTest.current === request) setConnection({ ok: false, detail: error.message })
    }
  }

  async function save() {
    const pid = (editing ? initial.id : id).trim()
    if (!pid) { toast(tx("给这个服务起一个英文标识（如 my-gateway）")); return }
    if (!name.trim()) { toast(tx("填一个给人看的名字")); return }
    if (baseUrl && !/^https?:\/\//.test(baseUrl.trim())) { toast(tx("接口地址要以 http(s):// 开头")); return }
    setBusy(true)
    try {
      await api.saveModelProvider(pid, {
        expectedRevision: initial?.revision || 'new',
        name: name.trim(), kind, baseUrl: baseUrl.trim(), note: note.trim(),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      })
      toast(apiKey.trim() ? tx("已保存，密钥已更新") : tx("已保存（密钥未改动）"))
      onSaved(pid)
    } catch (e) { toast(tx("保存失败：") + (e.message || e)) }
    setBusy(false)
  }

  return (
    <Modal draft={{ id, name, kind, baseUrl, note, apiKey }} title={editing ? tx("配置「{0}」", [initial.name]) : tx("接一个模型服务")} icon="plug" onClose={onClose}
      foot={dismiss => <><button className="btn btn-ghost" onClick={dismiss}>{tx("取消")}</button>
        <button className="btn" disabled={busy || connection?.pending} onClick={testConnection}>
          {connection?.pending ? tx("测试中…") : tx("测试连接")}</button>
        <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? tx("保存中…") : tx("保存")}</button></>}>
      {!editing && (
        <div><label className="f-lbl">{tx("标识（英文，建好不改）")}</label>
          <input className="f-in" value={id} onChange={(e) => setId(e.target.value)}
            placeholder={tx("如 my-gateway")} autoFocus /></div>
      )}
      <div style={{ marginTop: editing ? 0 : 12 }}><label className="f-lbl">{tx("名字")}</label>
        <input className="f-in" value={name} onChange={(e) => setName(e.target.value)}
          placeholder={tx("给人看的名字，如「研发网关」")} autoFocus={editing} /></div>
      <div style={{ marginTop: 12 }}><label className="f-lbl">{tx("接口协议")}</label>
        <SelectMenu className="f-in" value={kind} disabled={editing && initial.builtin}
          onChange={(e) => changeConnection(setKind, e.target.value)}>
          {KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </SelectMenu>
        <div className="muted" style={{ fontSize: 14.5, marginTop: 6, lineHeight: 1.7 }}>{tx("绝大多数都选「OpenAI 兼容」：自建网关、vLLM、Ollama、各家中转、以及国内几家的兼容端点都走这一档。")}</div></div>
      <div style={{ marginTop: 12 }}><label className="f-lbl">
        {kind === 'anthropic' ? tx("Anthropic 服务根地址") : tx("接口地址（含 /v1）")}</label>
        <input className="f-in" value={baseUrl} onChange={(e) => changeConnection(setBaseUrl, e.target.value)}
          placeholder={kind === 'anthropic' ? 'https://api.anthropic.com' : 'https://gateway.example.com/v1'} /></div>
      <div style={{ marginTop: 12 }}>
        <label className="f-lbl">API Key（{initial && initial.keySet ? tx("已配置 · {0} 位，留空则不改", [initial.keyLen]) : tx("未配置")}）</label>
        <input className="f-in" type="password" value={apiKey} onChange={(e) => changeConnection(setApiKey, e.target.value)}
          placeholder={initial && initial.keySet ? tx("输入新密钥以轮换，留空保持现有") : tx("粘贴 API Key")}
          autoComplete="new-password" />
        <div className="muted" style={{ fontSize: 14.5, marginTop: 6, lineHeight: 1.7 }}>
          {/* Use JSX elements for emphasis; Markdown markers would render literally. */}{tx("此密钥由组织共用。员工可在自己的客户端配置个人密钥；已配置时使用个人额度，否则使用组织额度。密钥只保存在后台数据库，任何接口都不会返回明文。")}</div></div>
      <div style={{ marginTop: 12 }}><label className="f-lbl">{tx("说明（可选）")}</label>
        <input className="f-in" value={note} onChange={(e) => setNote(e.target.value)} placeholder={tx("一句话")} /></div>
      {connection && !connection.pending && <div role="status" className="hintline" style={{ marginTop: 12, overflowWrap: 'anywhere' }}>
        {connection.ok ? <>
          {tx("连接成功，本次读取到 {0} 个模型。", [connection.counts?.total ?? connection.models.length])}
          {tx("其中 {0} 个声明支持对话，{1} 个用途未确认。", [connection.counts?.chat ?? 0, connection.counts?.unknown ?? connection.models.length])}
          {connection.models.length > 0 && tx("示例：{0}。", [connection.models.slice(0, 3).join(', ')])}
          {tx("发消息前还需添加模型并确认额度。")}
        </> : serverMessage({ key: connection.code, params: connection.params, fallback: connection.detail })}
      </div>}
    </Modal>
  )
}

function ModelForm({ providerId, initial, onClose, onSaved }) {
  const uiLocale = useLocale();
  const editing = !!initial
  const [name, setName] = useState(initial ? initial.name : '')
  const [label, setLabel] = useState(initial?.label || '')
  const [modality, setModality] = useState(initial ? (initial.modality || 'chat') : 'chat')
  const [endpointPath, setEndpointPath] = useState(
    initial?.config?.endpointPath || ''
  )
  const [statusPath, setStatusPath] = useState(
    initial?.config?.statusPath || ''
  )
  const [resultPath, setResultPath] = useState(
    initial?.config?.resultPath || ''
  )
  const [defaultsText, setDefaultsText] = useState(
    JSON.stringify(initial?.config?.defaults || {}, null, 2)
  )
  const [thinkingMode, setThinkingMode] = useState(initial?.config?.thinkingMode || (
    initial?.config?.thinkingAlwaysOn ? 'always' : 'auto'
  ))
  const [thinkingFormat, setThinkingFormat] = useState(initial?.config?.thinkingFormat || '')
  const [imageRouting, setImageRouting] = useState(initial?.config?.imageRouting || 'auto')
  const [capabilities, setCapabilities] = useState(initial?.config?.capabilities || {})
  const [ctxWindow, setCtxWindow] = useState(initial?.contextWindowKnown === false ? '' : initial?.ctxWindow || '')
  const [maxOutputTokens, setMaxOutputTokens] = useState(initial?.config?.maxOutputTokens || '')
  const [supportsReasoningEffort, setSupportsReasoningEffort] = useState(
    initial?.config?.supportsReasoningEffort !== false
  )
  const [busy, setBusy] = useState(false)

  function changeModality(next) {
    setModality(next)
    if (!endpointPath && next === 'image') setEndpointPath('/images/generations')
    if (!endpointPath && next === 'video') {
      setEndpointPath(providerId === 'volcengine'
        ? '/contents/generations/tasks' : '/videos/generations')
    }
    if (next === 'video' && providerId === 'volcengine' && !statusPath) {
      setStatusPath('/contents/generations/tasks/{id}')
    }
    if (next === 'chat') {
      setEndpointPath('')
      setStatusPath('')
      setResultPath('')
    }
  }

  async function save() {
    if (!name.trim()) { toast(tx("填模型标识（发给网关的那个名字）")); return }
    const retainedConfig = { ...initial?.config }
    const originalThinking = initial?.config?.thinkingMode || (initial?.config?.thinkingAlwaysOn ? 'always' : 'auto')
    if (thinkingMode !== originalThinking) for (const key of ['reasoning', 'thinkingAlwaysOn', 'thinkingLevelMap']) delete retainedConfig[key]
    for (const key of ['thinkingMode', 'thinkingFormat', 'supportsReasoningEffort', 'thinkingAlwaysOn']) delete retainedConfig[key]
    if (modality === 'chat') {
      if (imageRouting === 'native' && capabilities.imageInput === 'unsupported') {
        toast(tx('原生识图与不支持图片输入的配置冲突')); return
      }
      for (const [value, max] of [[ctxWindow, 10000000], [maxOutputTokens, 262144]]) {
        if (value !== '' && (!Number.isInteger(Number(value)) || Number(value) < 1024 || Number(value) > max)) {
          toast(tx('Token 上限必须填写允许范围内的整数')); return
        }
      }
      if (ctxWindow && Number(maxOutputTokens) > Number(ctxWindow)) { toast(tx('最大输出不能超过上下文窗口')); return }
    }
    delete retainedConfig.maxOutputTokens
    let defaults = {}
    if (modality !== 'chat') {
      try {
        defaults = JSON.parse(defaultsText || '{}')
        if (!defaults || Array.isArray(defaults) || typeof defaults !== 'object') throw new Error()
      } catch {
        toast(tx("默认参数要填写合法的 JSON 对象"))
        return
      }
      if (!endpointPath.trim().startsWith('/')) {
        toast(tx("生成接口路径要以 / 开头"))
        return
      }
      if (modality === 'video' && statusPath.trim() &&
          (!statusPath.trim().startsWith('/') || !statusPath.includes('{id}'))) {
        toast(tx("任务查询路径要以 / 开头，并包含 {id}"))
        return
      }
      if (modality === 'video' && resultPath.trim() &&
          (!resultPath.trim().startsWith('/') || !resultPath.includes('{id}'))) {
        toast(tx("结果下载路径要以 / 开头，并包含 {id}"))
        return
      }
    }
    setBusy(true)
    try {
      const saved = await api.saveModelDef({
        expectedRevision: initial?.revision || 'new',
        providerId,
        name: name.trim(),
        label: label.trim() || name.trim(),
        modality,
        ...(modality === 'chat' ? { ctxWindow: Number(ctxWindow) || 0 } : {}),
        config: modality === 'chat' ? {
          ...retainedConfig, imageRouting,
          capabilities: Object.fromEntries(Object.keys(CAPABILITY_LABELS).map(key => [key, capabilities[key] || 'unknown'])),
          ...(maxOutputTokens ? { maxOutputTokens: Number(maxOutputTokens) } : {}),
          ...(thinkingMode !== 'auto' ? { thinkingMode } : {}),
          ...(thinkingFormat ? { thinkingFormat } : {}),
          ...(thinkingMode === 'controllable' ? { supportsReasoningEffort } : {}),
        } : {
          endpointPath: endpointPath.trim(),
          ...(modality === 'video' && statusPath.trim()
            ? { statusPath: statusPath.trim() } : {}),
          ...(modality === 'video' && resultPath.trim()
            ? { resultPath: resultPath.trim() } : {}),
          defaults,
        },
        enabled: initial ? initial.enabled : true,
      })
      toast(editing ? tx("模型配置已更新") : tx("已加上"))
      onSaved(!editing && modality === 'chat' ? [saved] : [])
    } catch (e) { toast(tx("保存失败：") + (e.message || e)) }
    setBusy(false)
  }

  return (
    <Modal draft={{ name, label, modality, endpointPath, statusPath, resultPath, defaultsText, thinkingMode,
        thinkingFormat, imageRouting, capabilities, ctxWindow, maxOutputTokens, supportsReasoningEffort }} title={editing ? tx("配置模型") : tx("加一个模型")} icon={editing ? 'pencil' : 'plus'}
      wide onClose={onClose}
      foot={dismiss => <><button className="btn btn-ghost" onClick={dismiss}>{tx("取消")}</button>
        <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? tx("保存中…") : tx("保存")}</button></>}>
      <div className="model-config-form"><div><label className="f-lbl">{tx("模型标识（发给网关的那个名字）")}</label>
        <input className="f-in" value={name} disabled={editing}
          onChange={(e) => setName(e.target.value)}
          placeholder={tx("如 deepseek-chat / gpt-image-1")} autoFocus={!editing} /></div>
      <div style={{ marginTop: 12 }}><label className="f-lbl">{tx("显示名（可选）")}</label>
        <input className="f-in" value={label} onChange={(e) => setLabel(e.target.value)}
          placeholder={tx("给人看的名字，留空就用模型标识")} autoFocus={editing} /></div>
      <div style={{ marginTop: 12 }}><label className="f-lbl">{tx("模型用途")}</label>
        <SelectMenu className="f-in" value={modality} onChange={(e) => changeModality(e.target.value)}>
          {MODEL_TYPES.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
        </SelectMenu>
        <div className="muted" style={{ fontSize: 14.5, marginTop: 6, lineHeight: 1.7 }}>{tx("对话模型可单独支持图片输入；图片生成和视频生成用于创作成果。")}</div></div>
      {modality === 'chat' && <>
        <section className="model-config-section"><h3>{tx('模型能力')}</h3>
          <p className="model-config-hint">{tx('按服务实际支持的能力设置，未知项可检测确认。')}</p>
          <div className="model-cap-grid">{Object.entries(CAPABILITY_LABELS).map(([key, title]) => <div key={key}>
            <label className="f-lbl" htmlFor={'model-cap-' + key}>{tx(title)}</label>
            <SelectMenu id={'model-cap-' + key} className="f-in" value={capabilities[key] || 'unknown'}
              onChange={event => setCapabilities(current => ({ ...current, [key]: event.target.value }))}>
              {Object.entries(CAPABILITY_STATES).map(([value, title]) => <option key={value} value={value}>{tx(title)}</option>)}
            </SelectMenu></div>)}</div>
        </section>
        <details className="model-config-advanced"><summary>{tx('高级设置')}</summary>
          <div className="model-cap-grid">
            <div><label className="f-lbl" htmlFor="model-image-routing">{tx('图片处理方式')}</label>
              <SelectMenu id="model-image-routing" className="f-in" value={imageRouting} onChange={event => setImageRouting(event.target.value)}>
                <option value="auto">{tx('自动选择')}</option><option value="native">{tx('模型原生识图')}</option>
                <option value="vision-fallback">{tx('独立视觉服务')}</option>
              </SelectMenu></div>
            <div><label className="f-lbl" htmlFor="model-context-window">{tx('上下文窗口')}</label>
              <input id="model-context-window" className="f-in" type="number" min="1024" max="10000000" step="1"
                placeholder={tx('自动')} value={ctxWindow} onChange={event => setCtxWindow(event.target.value)} /></div>
            <div><label className="f-lbl" htmlFor="model-max-output">{tx('最大输出 Token')}</label>
              <input id="model-max-output" className="f-in" type="number" min="1024" max="262144" step="1"
                aria-describedby="model-max-output-hint" placeholder="16384" value={maxOutputTokens} onChange={event => setMaxOutputTokens(event.target.value)} />
              <p id="model-max-output-hint" className="model-config-hint">{tx('留空时使用 16384 Token。请按服务实际限制填写；能力检测不验证最大输出上限。')}</p></div>
          </div><p className="model-config-hint">{tx('自动选择优先使用已确认的原生视觉能力；兼容识图需要配置独立视觉服务。')}</p>
      {modality === 'chat' && <div className="model-thinking-config" style={{ marginTop: 14 }}>
        <div className="f-lbl">{tx("思考能力")}</div>
        <div className="muted" style={{ fontSize: 14.5, lineHeight: 1.7 }}>{tx("对于不支持关闭思考的模型请选择“始终开启”。客户端会显示固定思考状态，不再提供无效的关闭开关。")}</div>
        <div className="model-thinking-grid" style={{ marginTop: 8 }}>
          {[['auto', tx("自动识别")], ['always', tx("始终开启")], ['controllable', tx("可控制")], ['none', tx("不使用思考")]].map(([value, text]) =>
            <label className="f-check" key={value}><input type="radio" name="thinking-mode" value={value}
              checked={thinkingMode === value} onChange={() => setThinkingMode(value)} />{text}</label>)}
        </div>
        {thinkingMode === 'controllable' && <label className="f-check" style={{ marginTop: 8 }}><input type="checkbox"
          checked={supportsReasoningEffort} onChange={(e) => setSupportsReasoningEffort(e.target.checked)} />{tx("支持 reasoning_effort / 思考强度参数")}</label>}
        <label className="f-lbl" style={{ marginTop: 10 }}>{tx("思考协议格式")}</label>
        <SelectMenu className="f-in" value={thinkingFormat} onChange={(e) => setThinkingFormat(e.target.value)}>
          {THINKING_FORMATS.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
        </SelectMenu>
      </div>}
        </details></>}
      {modality !== 'chat' && <>
        <div style={{ marginTop: 12 }}><label className="f-lbl">{tx("生成接口路径")}</label>
          <input className="f-in" value={endpointPath}
            onChange={(e) => setEndpointPath(e.target.value)}
            placeholder={modality === 'image' ? '/images/generations' : '/videos/generations'} />
          <div className="muted" style={{ fontSize: 14.5, marginTop: 6, lineHeight: 1.7 }}>{tx("填服务地址下的相对路径，平台会沿用该服务的地址和密钥。")}</div></div>
        {modality === 'video' && <>
          <div style={{ marginTop: 12 }}><label className="f-lbl">{tx("异步任务查询路径（可选）")}</label>
            <input className="f-in" value={statusPath}
              onChange={(e) => setStatusPath(e.target.value)}
              placeholder="/contents/generations/tasks/{id}" />
            <div className="muted" style={{ fontSize: 14.5, marginTop: 6, lineHeight: 1.7 }}>{tx("Seedance 使用此路径查询生成进度；")}{'{id}'}{tx(" 会替换为创建接口返回的任务 ID。")}</div></div>
          <div style={{ marginTop: 12 }}><label className="f-lbl">{tx("结果下载路径（可选）")}</label>
            <input className="f-in" value={resultPath}
              onChange={(e) => setResultPath(e.target.value)}
              placeholder="/videos/{id}/content" />
            <div className="muted" style={{ fontSize: 14.5, marginTop: 6, lineHeight: 1.7 }}>{tx("状态接口直接返回视频地址时留空；需要单独下载内容的服务再填写。")}</div></div>
        </>}        <div style={{ marginTop: 12 }}><label className="f-lbl">{tx("默认生成参数（JSON）")}</label>
          <textarea className="f-in model-json-config" rows={7} value={defaultsText}
            onChange={(e) => setDefaultsText(e.target.value)}
            placeholder={'{\n  "size": "1024x1024"\n}'} />
          <div className="muted" style={{ fontSize: 14.5, marginTop: 6, lineHeight: 1.7 }}>{tx("可配置尺寸、时长、清晰度、比例等服务参数；每次调用仍可覆盖这些默认值。")}</div></div>
      </>}
      <div className="muted" style={{ fontSize: 14.5, marginTop: 10, lineHeight: 1.7 }}>{tx("密钥配置在模型服务上，这个服务底下的所有模型共用。")}</div></div>
    </Modal>
  )
}

function DiscoverForm({ provider, onClose, onSaved }) {
  const uiLocale = useLocale();
  const [phase, setPhase] = useState('loading')   // loading | ready | empty | error
  const [rows, setRows] = useState([])
  const [purpose, setPurpose] = useState('chat')
  const [detail, setDetail] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    api.discoverModels(provider.id)
      .then((r) => {
        if (!alive) return
        if (!r.ok) { setDetail(r.code ? serverMessage({ key: r.code, params: r.params, fallback: r.detail }) : (r.detail || tx("读取失败"))); setPhase('error'); return }
        const metadata = new Map((r.candidates || []).map(item => [item.id, item]))
        const list = (r.models || []).map(name => {
          const candidate = metadata.get(name)
          return { name, status: candidate?.status || 'unknown', purposes: candidate?.purposes || [], checked: false }
        })
        if (list.length === 0) { setPhase('empty'); return }
        setRows(list); setPhase('ready')
      })
      .catch((e) => { if (alive) { setDetail(String(e && e.message || e)); setPhase('error') } })
    return () => { alive = false }
  }, [provider.id])

  const [query, setQuery] = useState('')
  const supportsPurpose = row => row.status === 'declared' && row.purposes.includes(purpose)
  const matches = row => (supportsPurpose(row) || row.status === 'unknown') && row.name.toLowerCase().includes(query.trim().toLowerCase())
  const filtered = rows.filter(matches)
  const checkedCount = rows.filter((r) => r.checked).length
  function changePurpose(next) {
    setPurpose(next)
    setRows(current => current.map(row => row.checked ? { ...row, checked: false } : row))
  }
  function toggleAll(next) {
    setRows(current => current.map(row => matches(row) && (!next || supportsPurpose(row)) ? { ...row, checked: next } : row))
  }
  function checkRow(name, checked) {
    setRows(current => current.map(row => row.name === name ? { ...row, checked } : row))
  }

  async function importSelected() {
    const picked = rows.filter((r) => r.checked)
    if (picked.length === 0) { toast(tx("先勾选要添加的模型")); return }
    setBusy(true)
    const added = []
    let failed = 0
    for (const row of picked) {
      try {
        const saved = await api.saveModelDef({ providerId: provider.id, name: row.name,
          label: row.name, modality: purpose, expectedRevision: 'new', enabled: true })
        added.push(saved)
      } catch (e) { failed += 1 }
    }
    setBusy(false)
    toast(failed === 0
      ? tx("已添加 {0} 个模型", [added.length])
      : tx("添加了 {0} 个，{1} 个失败", [added.length, failed]))
    if (added.length) onSaved(added); else onClose()
  }

  return (
    <Modal dirty={rows.some(row => row.checked)} title={tx("从服务发现模型")} icon="search" onClose={onClose}
      foot={dismiss => <><button className="btn btn-ghost" onClick={dismiss}>{tx("关闭")}</button>
        {phase === 'ready' && <button className="btn btn-primary" disabled={busy || checkedCount === 0}
          onClick={importSelected}>{busy ? tx("添加中…") : tx("添加选中的 {0} 个", [checkedCount])}</button>}</>}>
      <div className="model-config-form">
        <div className="muted" style={{ fontSize: 14.5, lineHeight: 1.7, marginBottom: 10 }}>
          {tx("列出「{0}」上游提供的模型标识，勾选后加入目录；已存在的不会重复出现。", [provider.name || provider.id])}
        </div>
        {phase === 'loading' && <Loading />}
        {phase === 'error' && <div className="model-discover-note">{detail}</div>}
        {phase === 'empty' && <div className="model-discover-note">{tx("这个服务的模型都已经在目录里了。")}</div>}
        {phase === 'ready' && <>
          <label className="f-lbl" htmlFor="discovery-purpose">{tx("模型用途")}</label>
          <SelectMenu id="discovery-purpose" className="f-in" aria-label={tx("模型用途")} disabled={busy}
            value={purpose} onChange={event => changePurpose(event.target.value)}>
            {MODEL_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </SelectMenu>
          <input type="search" className="f-in" aria-label={tx("按模型名称筛选")} placeholder={tx("按模型名称筛选")}
            value={query} onChange={event => setQuery(event.target.value)} />
          <div className="model-discover-toolbar">
            <button type="button" className="admin-card-action" disabled={busy || !filtered.some(supportsPurpose)} onClick={() => toggleAll(true)}>{tx("选择筛选结果")}</button>
            <button type="button" className="admin-card-action" disabled={busy || !filtered.some(row => row.checked)} onClick={() => toggleAll(false)}>{tx("取消选择筛选结果")}</button>
            <span className="muted">{tx("共 {0} 个", [filtered.length])}</span>
          </div>
          <p aria-live="polite">{tx("将在此服务下添加并启用 {0} 个模型。", [checkedCount])}</p>
          <div className="model-discover-list" role="region" tabIndex={0} aria-label={tx("发现的模型列表")}>
            {!filtered.length && <p className="muted">{tx("没有符合当前用途和名称的模型。")}</p>}
            {filtered.map((row) => (
              <div className="model-discover-row" key={row.name}>
                <label>
                  <input type="checkbox" checked={row.checked} disabled={busy || (row.status === 'unknown' && !row.checked)}
                    onChange={event => checkRow(row.name, event.target.checked)} />
                  <code title={row.name}>{row.name}</code>
                  {row.status === 'unknown' && <span className="muted">{tx("用途未确认")}</span>}
                </label>
                {row.status === 'unknown' && !row.checked && <button type="button" className="admin-card-action" disabled={busy}
                  aria-label={tx("确认 {0} 可用于{1}", [row.name, MODEL_TYPE_LABEL[purpose]])}
                  onClick={() => checkRow(row.name, true)}>{tx("确认为{0}", [MODEL_TYPE_LABEL[purpose]])}</button>}
              </div>
            ))}
          </div>
        </>}
      </div>
    </Modal>
  )
}
