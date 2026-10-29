import { translateText as tx, localeMap, useLocale, t } from '../i18n.js'
import React, { useMemo, useState } from 'react'
import { Icon } from '../ui.jsx'
import { FilterInput, FilterSelect } from '../FilterControls.jsx'
import { useViewportHeight } from '../viewport-height.js'
import { CATALOG_FILTERS, pluginKind, selectCatalog } from './plugin-catalog-model.js'
import './plugin-catalog-cards.css'

function CatalogIcon({ plugin, version, type }) {
  const [failed, setFailed] = useState('')
  // Published artwork is embedded PNG, as in the desktop plugin catalog.
  const artwork = [version.manifest?.icon, version.icon, plugin.icon].find(value => typeof value === 'string' &&
    value.length <= 131094 && /^data:image\/png;base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
  return <span className={'plugin-card-icon kind-' + type.key} aria-hidden="true">
    {artwork && failed !== artwork ? <img src={artwork} alt="" onError={() => setFailed(artwork)} /> : <Icon name={type.icon} />}
  </span>
}

function RecommendedMark() {
  return <svg className="plugin-card-recommended-mark" viewBox="0 0 48 48" role="img" aria-label={tx('推荐')}>
    <title>{tx('推荐')}</title>
    <path d="m14 25 8-11 2-9c.4-1.7 2.5-2.1 3.9-1 2.4 1.8 2.6 4.6 1.7 7.9L28 19h10a5 5 0 0 1 4.8 6.5l-3.6 11.7a6 6 0 0 1-5.7 4.3H21l-7-3Z" fill="#ffca50" stroke="#e9ac36" strokeWidth="1.2" strokeLinejoin="round" />
    <path d="m17 25 8-11 1.6-7.7c1.3 1.1 1.7 3.3.9 5.9l-2.2 9.4H38c1.2 0 2.1.5 2.5 1.4H27l-3.5 4.8Z" fill="#ffe8a0" />
    <path d="M33 27h7m-8 6h6m-7 6h4" fill="none" stroke="#e5a83b" strokeWidth="1.4" strokeLinecap="round" />
    <rect x="4" y="23" width="11" height="20" rx="3.5" fill="#6978e8" />
    <path d="M7 26v12" stroke="#a8c7ff" strokeWidth="2" strokeLinecap="round" />
    <circle cx="10" cy="39" r="1.3" fill="#fff" />
    <path d="m39 5 1.3 3.7L44 10l-3.7 1.3L39 15l-1.3-3.7L34 10l3.7-1.3Z" fill="#f29b96" />
    <path d="M8 12v6m-3-3h6" fill="none" stroke="#66bfc2" strokeWidth="2" strokeLinecap="round" />
  </svg>
}

export default function PluginCatalogIndex({ items = [], queues, categories = [], selected, onSelect, actions,
  canManage = false, onTogglePublication, onDelete }) {
  const listRef = useViewportHeight()
  const uiLocale = useLocale();
  const [query, setQuery] = useState('')
  const [catalogType, setCatalogType] = useState('plugin')
  const [status, setStatus] = useState('all')
  const [source, setSource] = useState('all')
  const [kind, setKind] = useState('all')
  const [category, setCategory] = useState('all')
  const [sort, setSort] = useState('updated')
  const { shown, counts } = useMemo(() => selectCatalog(items, queues,
    { query, status, source, kind, category, sort, catalogType }), [items, queues, query, status, source, kind, category, sort, catalogType, uiLocale])
  const filtered = Boolean(query || status !== 'all' || source !== 'all' || kind !== 'all' || category !== 'all')
  const typeCount = items.filter(plugin => (pluginKind(plugin).key === 'app') === (catalogType === 'app')).length
  const countLabel = catalogType === 'app' ? tx(' 个应用') : tx(' 个插件')
  function switchType(value) { setCatalogType(value); setKind('all') }
  function onTabKey(event) {
    const tabs = [...event.currentTarget.parentElement.querySelectorAll('[role="tab"]')]
    const index = tabs.indexOf(event.currentTarget)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
      : event.key === 'ArrowRight' ? (index + 1) % tabs.length
      : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : -1
    if (next < 0) return
    event.preventDefault(); tabs[next].click(); tabs[next].focus()
  }

  return <section className="plugin-catalog" aria-label={tx("企业插件目录")}>
    <div className="plugin-catalog-controls">
      <div className="plugin-catalog-action-row"><span>{typeCount}{countLabel}</span><div className="plugin-catalog-actions">{actions}</div></div>
      <div className="plugin-catalog-search-row admin-filterbar">
        <FilterInput className="plugin-catalog-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)}
          placeholder={tx("搜索插件、用途或技能")} aria-label={tx("搜索插件")} />
        <div className="plugin-catalog-type-tabs" role="tablist" aria-label={tx('目录类型')}>
          {[['plugin', tx('插件')], ['app', t('plugin.type.app', '应用')]].map(([key, label]) =>
            <button key={key} type="button" role="tab" id={`plugin-catalog-tab-${key}`}
              aria-selected={catalogType === key} aria-controls={`plugin-catalog-panel-${key}`} tabIndex={catalogType === key ? 0 : -1}
              onKeyDown={onTabKey} onClick={() => switchType(key)}>{label}</button>)}
        </div>
        <div className="plugin-catalog-refine admin-filter-options">
          <FilterSelect aria-label={tx("插件状态")} resetValue="all" value={status} onChange={(e) => setStatus(e.target.value)}>
            {CATALOG_FILTERS.map(([key, label]) => <option key={key} value={key}>{key === 'all' && catalogType === 'app' ? tx('全部应用') : label}（{counts[key]}）</option>)}
          </FilterSelect>
          <label><span className="plugin-sr-only">{tx("插件来源")}</span><FilterSelect aria-label={tx("插件来源")} resetValue="all" value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="all">{tx("全部来源")}</option><option value="enterprise">{tx("企业提交")}</option>
            <option value="builtin">{tx("SoduWork 内置")}</option><option value="external">{tx("外部导入")}</option>
          </FilterSelect></label>
          {catalogType === 'plugin' && <label><span className="plugin-sr-only">{tx("能力类型")}</span><FilterSelect aria-label={tx("能力类型")} resetValue="all" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="all">{tx("全部类型")}</option><option value="skill">{tx("AI 能力")}</option>
            <option value="workflow">{tx("工作流")}</option><option value="connector">{tx("连接工具")}</option>
          </FilterSelect></label>}
          <label><span className="plugin-sr-only">{tx("插件分类")}</span><FilterSelect aria-label={tx("插件分类")} resetValue="all" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="all">{tx("全部分类")}</option>
            {categories.filter((item) => item.enabled !== false || items.some((plugin) => plugin.catalogPolicy?.category === item.key))
              .map((item) => <option key={item.key} value={item.key}>{item.name}{item.enabled === false ? tx(" · 已停用") : ''}</option>)}
          </FilterSelect></label>
          <label><span className="plugin-sr-only">{tx("排序方式")}</span><FilterSelect aria-label={tx("排序方式")} resetValue="updated" value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="updated">{tx("最近更新")}</option><option value="name">{tx("名称排序")}</option>
          </FilterSelect></label>
        </div>
      </div>
    </div>
    {filtered && <div className="plugin-catalog-result" role="status"><span>{tx("找到 ")}{shown.length}{countLabel}</span></div>}
    <div role="tabpanel" id={`plugin-catalog-panel-${catalogType}`} aria-labelledby={`plugin-catalog-tab-${catalogType}`}>
    <div ref={listRef} className="plugin-card-grid" role="list" aria-label={tx("插件列表，可滚动")} tabIndex="0">
      {!shown.length && <div className="plugin-catalog-empty"><Icon name={items.length ? 'search' : 'plug'} />
        <b>{items.length ? tx("没有匹配的插件") : tx("还没有企业插件")}</b>
        <p>{items.length ? tx("换一个关键词，或清除筛选条件。") : tx("在客户端制作并试用插件，再提交到企业审核；也可以导入已有插件包。")}</p>
      </div>}
      {shown.map(({ plugin, publication, source: origin, kind: type, category: categoryKey, issues }) => {
        const version = plugin.latestVersion || {}
        const cap = version.capabilities || {}
        const interactive = (version.manifest?.ui?.contributions || version.ui?.contributions || plugin.ui?.contributions || []).length > 0
        const categoryName = categories.find((item) => item.key === categoryKey)?.name || categoryKey
        const author = version.manifest?.author || version.provenance?.publisherName || plugin.createdBy || tx("未知作者")
        const canToggle = canManage && version.trustState === 'approved' && version.enabled
        const canDelete = canManage && publication.key === 'disabled' && plugin.catalogPolicy?.installation === 'not_available' && onDelete
        const facts = [type.key !== 'app' && type.label,
          (cap.skills || []).length > 0 && `${cap.skills.length}${tx(' 个技能')}`,
          (cap.mcpServers || []).length > 0 && `${cap.mcpServers.length}${tx(' 个连接')}`,
          type.key !== 'app' && interactive && tx('交互式')].filter(Boolean)
        return <article role="listitem" key={plugin.id} data-catalog-kind={type.key} className={'plugin-card-shell' + (plugin.catalogPolicy?.featured ? ' is-featured' : '') + (selected === plugin.id ? ' is-selected' : '')}>
          {plugin.catalogPolicy?.featured && <RecommendedMark />}
          <div className="plugin-card-head">
            <CatalogIcon plugin={plugin} version={version} type={type} />
            <div className="plugin-card-identity">
              <strong className="plugin-card-name" title={plugin.name || tx("未命名插件")}>{plugin.name || tx("未命名插件")}</strong>
              <span className="plugin-card-byline" title={`${categoryName} · ${tx('作者 · ')}${author}`}>{tx('作者 · ')}{author}</span>
            </div>
          </div>
          <button type="button" className={'plugin-card' + (selected === plugin.id ? ' is-selected' : '')}
            aria-label={tx("查看{0}详情", [plugin.name || tx("未命名插件")])} aria-haspopup="dialog" aria-expanded={selected === plugin.id}
            onClick={() => onSelect(plugin.id)}>
            <span className="plugin-card-description">{plugin.description || tx("作者尚未补充用途说明。打开详情查看能力与使用方式。")}</span>
            {facts.length > 0 && <span className="plugin-card-capabilities">{facts.map(fact => <span key={fact}>{fact}</span>)}</span>}
            <span className="plugin-card-footer"><span title={version.provenance?.publisherName || origin.label}>{origin.label}</span>
              <span className="plugin-card-version">{version.version ? `v${version.version}` : tx("暂无版本")}</span>
              {issues.length > 0 && <span className="plugin-card-attention">{issues.length}{tx(" 项待处理")}</span>}
              <Icon name="chevron" />
            </span>
          </button>
          <div className="plugin-card-management">
            <span className={'plugin-card-state state-' + publication.key}><i />{publication.label}</span>
            {(canToggle || canDelete) && <div className="plugin-card-shelf-actions" aria-label={tx('目录操作')}>
              {canToggle && <button type="button" className="plugin-card-quick-action admin-card-action"
                aria-label={`${publication.key === 'published' ? tx('下架') : tx('上架')} ${plugin.name || tx('插件')}`}
                onClick={() => onTogglePublication?.(plugin)}>{publication.key === 'published' ? tx('下架') : tx('上架')}</button>}
              {canDelete && <button type="button" className="plugin-card-quick-action admin-card-action is-danger"
                aria-label={tx('删除已下架插件 ') + (plugin.name || tx('插件'))} onClick={() => onDelete(plugin)}>{tx('删除')}</button>}
            </div>}
          </div>
        </article>
      })}
    </div>
    </div>
  </section>
}
