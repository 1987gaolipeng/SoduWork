import { translateText as tx, localeMap, useLocale } from '../i18n.js'
import React, { useEffect, useState } from 'react'
import { api } from '../api.js'
import { Icon, toast, SelectMenu } from '../ui.jsx'
import './plugin-catalog-policy.css'
import PluginCoverPreview from './PluginCoverPreview.jsx'

const DEFAULT = {
  category: 'general',
  installation: 'available',
  authentication: 'on_use',
  featured: false,
  coverUrl: '',
  sort: 0,
}

const INSTALLATION_COPY = localeMap(() => ({
  available: '已上架 · 员工按需启用',
  installed_by_default: '已上架 · 企业默认启用',
  not_available: '已下架',
}))
function normalized(value) {
  return { ...DEFAULT, ...(value || {}) }
}

export function PluginCatalogPolicy({
  pluginId, value, capabilities = {}, canManage = false, disabled = false, categoryRevision = 0, onChanged,
}) {
  const uiLocale = useLocale();
  const [draft, setDraft] = useState(normalized(value))
  const [saving, setSaving] = useState(false)
  const [categories, setCategories] = useState([])
  const [categoryError, setCategoryError] = useState('')
  useEffect(() => setDraft(normalized(value)), [value])
  useEffect(() => {
    if (!canManage) return undefined
    let live = true
    setCategoryError('')
    api.pluginCategories().then((data) => {
      if (!live) return
      const items = Array.isArray(data && data.items) ? data.items : []
      setCategories(items)
      // The API returns a synthetic "general" value for imported plugins
      // without a catalog policy. If administrators replaced that category,
      // select the first enabled category so the policy can be saved normally.
      const currentValue = normalized(value)
      const hasCurrentCategory = items.some((item) => item.key === currentValue.category)
      const fallback = items.find((item) => item.enabled !== false)
      if (currentValue.configured !== true && !hasCurrentCategory && fallback) {
        setDraft((old) => old.category === DEFAULT.category
          ? { ...old, category: fallback.key } : old)
      }
      if (!items.length) setCategoryError(tx("管理端尚未返回可用分类"))
    }).catch((error) => {
      if (live) setCategoryError(error.message || tx("分类加载失败"))
    })
    return () => { live = false }
  }, [canManage, categoryRevision])
  const current = normalized(value)
  const dirty = JSON.stringify(draft) !== JSON.stringify(current)
  const hasConnector = Boolean((capabilities.mcpServers || []).length)
  const set = (key, next) => setDraft((old) => ({ ...old, [key]: next }))
  const locked = disabled || saving
  // A disabled category remains selectable only when this plugin already has
  // an explicit policy for it.  New policies must choose an enabled category;
  // otherwise the form offers a value that the backend correctly rejects.
  const preserveDisabledCategory = current.configured === true
  const visibleCategories = categories.filter((item) =>
    item.enabled !== false || (preserveDisabledCategory && item.key === current.category))
  const categoryOptions = !preserveDisabledCategory || visibleCategories.some((item) => item.key === current.category)
    ? visibleCategories
    : [{ key: current.category, name: tx("{0}（历史分类）", [current.category]), enabled: false }, ...visibleCategories]
  const categoryValid = !categoryError && categoryOptions.some((item) => item.key === draft.category)
  const selectedCategory = categoryOptions.find((item) => item.key === draft.category)

  async function save() {
    if (!categoryValid || locked || !dirty) return
    setSaving(true)
    try {
      const policy = await api.updatePluginCatalogPolicy(pluginId, draft)
      setDraft(normalized(policy))
      if (onChanged) onChanged(policy)
      toast(policy.installation === 'not_available'
        ? tx("插件已从员工目录下架；已有需求绑定没有改变")
        : tx("插件已上架，员工目录会立即更新"))
    } catch (error) {
      toast(tx("上架策略保存失败：") + error.message)
    }
    setSaving(false)
  }


  return <section className="plugin-catalog-policy">
    <div className="plugin-catalog-intro">
      <span className="eyebrow">{tx("员工目录")}</span>
      <div><h3>{tx("上架与分类")}</h3><p>{tx("审核通过即可让员工发现；需求执行范围仍由项目绑定独立控制。")}</p></div>
      <span className={'plugin-catalog-state state-' + draft.installation}>
        {INSTALLATION_COPY[draft.installation]}
      </span>
    </div>
    <div className={'plugin-catalog-choice-note mode-' + draft.installation}>
      <Icon name={draft.installation === 'not_available' ? 'alert' : 'sparkle'} />
      <span><b>{draft.installation === 'not_available' ? tx("下架只影响员工目录") : draft.installation === 'installed_by_default' ? tx("上架后新员工会默认获得") : tx("上架后员工可按需安装")}</b>
        <small>{draft.installation === 'not_available' ? tx("已配置的需求绑定、历史运行和版本记录不会被删除。") : tx("审核状态决定能否执行，目录策略只决定员工是否看得到。")}</small></span>
    </div>
    <div className="plugin-catalog-fields">
      <label>
        <span>{tx("员工分类")}</span>
        <SelectMenu disabled={!canManage || locked || !categoryOptions.length} value={categoryValid ? draft.category : ''}
          onChange={(event) => set('category', event.target.value)}>
          {!categoryValid && <option value="" disabled>{categoryError || (!canManage ? draft.category :
            categoryOptions.length ? tx("请选择已启用分类") : tx("暂无可用分类"))}</option>}
          {categoryOptions.map((item) =>
            <option key={item.key} value={item.key}>{item.name}{item.enabled ? '' : tx("（已停用）")}</option>)}
        </SelectMenu>
        {selectedCategory?.description && <small className="plugin-catalog-category-help">{selectedCategory.description}</small>}
      </label>
      <label>
        <span>{tx("上架状态")}</span>
        <SelectMenu disabled={!canManage || locked} value={draft.installation}
          onChange={(event) => set('installation', event.target.value)}>
          <option value="available">{tx("已上架 · 员工按需启用")}</option>
          <option value="installed_by_default">{tx("已上架 · 企业默认启用")}</option>
          <option value="not_available">{tx("已下架")}</option>
        </SelectMenu>
      </label>
      <label>
        <span>{tx("连接检查")}</span>
        {hasConnector
          ? <SelectMenu disabled={!canManage || locked || draft.installation === 'not_available'}
              value={draft.authentication}
              onChange={(event) => set('authentication', event.target.value)}>
              <option value="on_use">{tx("使用时检查")}</option>
              <option value="on_install">{tx("安装时检查")}</option>
            </SelectMenu>
          : <span className="plugin-catalog-na">{tx("无需外部连接")}</span>}
      </label>
      <label className="plugin-catalog-featured">
        <span>{tx("目录推荐")}</span>
        <button type="button" role="switch" aria-checked={draft.featured}
          disabled={!canManage || locked}
          className={draft.featured ? 'on' : ''}
          onClick={() => set('featured', !draft.featured)}>
          <i /><b>{draft.featured ? tx("优先展示") : tx("普通排序")}</b>
        </button>
      </label>
      <label><span>{tx('推荐封面地址')}</span><input type="url" value={draft.coverUrl || ''}
        placeholder="https://example.com/cover.jpg" disabled={!canManage || locked}
        onChange={event => set('coverUrl', event.target.value)} /></label>
      {canManage && <button className="plugin-catalog-save" type="button"
        disabled={!dirty || locked || !categoryValid} onClick={save}>
        {saving ? tx("正在保存…") : dirty ? tx("保存策略") : tx("已保存")}
      </button>}
    </div>
    {(draft.featured || draft.coverUrl) && <div className="plugin-catalog-cover-preview"><PluginCoverPreview url={draft.coverUrl || ''} debounceMs={300} /></div>}
    {canManage && categoryError && <p className="plugin-category-admin-note plugin-category-admin-note-error">{categoryError}{tx("，请在插件与应用重试分类管理。")}</p>}
    {canManage && <p className="plugin-category-admin-note">{tx("分类由插件与应用的“更多 → 管理分类”统一维护。")}</p>}
    {canManage && <p className="plugin-catalog-sync-note">{tx("保存后约 15 秒内同步到客户端；上架、下架和分类会同时更新。")}</p>}

  </section>
}
