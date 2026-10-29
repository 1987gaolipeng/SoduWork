import { translateText as tx, localeMap, useLocale } from '../i18n.js'
import React, { useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'
import { Icon, Modal } from '../ui.jsx'
import './plugin-category-manager.css'

const KEY_PATTERN = /^[a-z][a-z0-9_-]{1,31}$/
const TEXT = {
  keepOne: tx("至少保留一个分类。"),
  invalidKey: tx("分类标识 {key} 无效：需使用 2-32 位小写字母、数字、短横线或下划线。"),
  duplicateKey: tx("分类标识 {key} 重复，请修改后再保存。"),
  missingName: tx("分类 {key} 尚未填写名称。"),
}

const LABEL = {
  title: tx("管理插件分类"), close: tx("关闭"), save: tx("保存分类"), saving: tx("正在保存…"),
  heading: tx("统一管理员工目录中的插件分类"),
  intro: tx("分类名称、说明、排序和启用状态会同步到客户端。停用分类不会影响已经配置的插件，但新插件不能再选择它。"),
  retry: tx("重试"), loading: tx("正在读取分类配置…"), add: tx("添加分类"),
  key: tx("标识"), name: tx("名称"), description: tx("说明"), sort: tx("排序"), status: tx("状态"), usage: tx("使用中"),
  nameLabel: tx("分类名称"), descriptionLabel: tx("分类说明"), sortLabel: tx("排序"), placeholder: tx("员工会在这里看到什么？"),
  enabled: tx("启用"), disabled: tx("停用"), remove: tx("删除"), footnote: tx("分类标识用于策略和插件包中的稳定引用，创建后不建议随意修改。删除正在使用的分类时，管理端会提示先迁移插件。")
}

function nextKey(items) {
  const base = 'category'
  let key = base
  let index = 1
  const used = new Set(items.map((item) => item.key))
  while (used.has(key)) key = `${base}_${index++}`
  return key
}

function validate(items) {
  if (!items.length) return TEXT.keepOne
  const seen = new Set()
  for (const item of items) {
    const key = String(item.key || '').trim().toLowerCase()
    const name = String(item.name || '').trim()
    if (!KEY_PATTERN.test(key)) return TEXT.invalidKey.replace('{key}', key || tx("为空"))
    if (seen.has(key)) return TEXT.duplicateKey.replace('{key}', key)
    if (!name) return TEXT.missingName.replace('{key}', key)
    if (!Number.isInteger(item.sort) || Math.abs(item.sort) > 10000) return tx("排序必须是 -10000 到 10000 的整数。")
    seen.add(key)
  }
  return ''
}

export default function PluginCategoryManager({ open, onClose, onSaved }) {
  const uiLocale = useLocale();
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [baseline, setBaseline] = useState('')
  const [removeTarget, setRemoveTarget] = useState(null)

  async function load() {
    setLoading(true)
    setError('')
    setNotice('')
    setLoaded(false)
    try {
      const data = await api.pluginCategories()
      const next = Array.isArray(data?.items) ? data.items : []
      setItems(next)
      setBaseline(JSON.stringify(next))
      setLoaded(true)
    } catch (err) {
      setError(err.message || tx("分类加载失败，请检查管理端连接。"))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open) load()
  }, [open])

  const validation = useMemo(() => validate(items), [items, uiLocale])
  const changed = loaded && JSON.stringify(items) !== baseline

  function update(index, key, value) {
    setItems((old) => old.map((item, at) => at === index ? { ...item, [key]: value } : item))
    setError('')
    setNotice('')
  }

  function add() {
    setItems((old) => [...old, {
      key: nextKey(old), name: "新分类", description: '', sort: (old.length + 1) * 10, enabled: true,
    }])
    setError('')
    setNotice('')
  }

  function remove(index) {
    const item = items[index]
    if (!item || Number(item.usageCount || 0) > 0 || items.length <= 1) return
    setRemoveTarget({ index, label: item.name || item.key })
    setError('')
    setNotice('')
  }

  function confirmRemove() {
    if (!removeTarget) return
    setItems((old) => old.filter((_, at) => at !== removeTarget.index))
    setRemoveTarget(null)
    setError('')
    setNotice('')
  }

  async function save() {
    if (validation || saving || loading || !loaded || !changed) {
      setError(validation)
      return
    }
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const data = await api.updatePluginCategories(items.map((item) => ({
        key: String(item.key || '').trim().toLowerCase(),
        name: String(item.name || '').trim(),
        description: String(item.description || '').trim(),
        sort: Number(item.sort || 0),
        enabled: item.enabled !== false,
      })))
      const next = Array.isArray(data?.items) ? data.items : []
      setItems(next)
      setBaseline(JSON.stringify(next))
      setNotice(tx("分类已保存，客户端目录会自动同步。"))
      if (onSaved) onSaved(next)
    } catch (err) {
      setError(err.message || tx("分类保存失败，请稍后重试。"))
    } finally {
      setSaving(false)
    }
  }

  if (!open) return null
  return <>
    <Modal scope="plugin-page" wide title={LABEL.title} icon="sitemap" onClose={onClose}
    foot={<>
      <button type="button" className="btn btn-ghost" onClick={onClose}>{LABEL.close}</button>
      <button type="button" className="btn btn-primary" disabled={!loaded || loading || saving || !changed || Boolean(validation)} onClick={save}>
        {saving ? LABEL.saving : LABEL.save}
      </button>
    </>}>
    <div className="plugin-category-manager-modal">
      <div className="plugin-category-manager-intro">
        <span className="plugin-category-manager-icon"><Icon name="sitemap" /></span>
        <div><b>{LABEL.heading}</b><p>{LABEL.intro}</p></div>
      </div>
      {loaded && <div className="plugin-category-summary" aria-label={tx("分类概览")}>
        <span><b>{items.length}</b><small>{tx("个分类")}</small></span>
        <span><b>{items.filter((item) => item.enabled !== false).length}</b><small>{tx("个已启用")}</small></span>
        <span><b>{items.reduce((sum, item) => sum + Number(item.usageCount || 0), 0)}</b><small>{tx("个插件正在使用")}</small></span>
        <span className="plugin-category-summary-note"><Icon name="refresh" />{tx("保存后客户端约 15 秒内自动同步")}</span>
      </div>}
      {error && <div className="plugin-category-manager-error" role="alert"><Icon name="alert" /><span>{error}</span>{!loaded && <button type="button" disabled={loading} onClick={load}>{LABEL.retry}</button>}</div>}
      {notice && !error && <div className="plugin-category-manager-notice" role="status"><Icon name="check" /><span>{notice}</span></div>}
      {loading
        ? <div className="plugin-category-manager-loading"><Icon name="refresh" />{LABEL.loading}</div>
        : loaded && <fieldset className="plugin-category-table" disabled={saving} aria-label={LABEL.title}>
          <div className="plugin-category-table-head" role="row"><span>{LABEL.key}</span><span>{LABEL.name}</span><span>{LABEL.description}</span><span>{LABEL.sort}</span><span>{LABEL.usage}</span><span>{LABEL.status}</span><span /></div>
          {items.map((item, index) => <div className="plugin-category-table-row" role="row" key={`${item.key}-${index}`}>
            <code title={item.key}>{item.key}</code>
            <input aria-label={LABEL.nameLabel} value={item.name || ''} maxLength={40} onChange={(event) => update(index, 'name', event.target.value)} />
            <textarea aria-label={LABEL.descriptionLabel} value={item.description || ''} maxLength={160} rows={2} placeholder={LABEL.placeholder} onChange={(event) => update(index, 'description', event.target.value)} />
            <input aria-label={LABEL.sortLabel} className="plugin-category-sort" type="number" min={-10000} max={10000} step={1} value={item.sort ?? 0} onChange={(event) => update(index, 'sort', Number(event.target.value))} />
            <span className="plugin-category-usage" title={Number(item.usageCount || 0) ? tx("正在使用的分类不能删除，请先给插件改分类") : tx("暂无插件使用")}>{Number(item.usageCount || 0)}{tx(" 个插件")}</span>
            <label className="plugin-category-switch"><input type="checkbox" checked={item.enabled !== false} onChange={(event) => update(index, 'enabled', event.target.checked)} /><span>{item.enabled !== false ? LABEL.enabled : LABEL.disabled}</span></label>
            <button type="button" className="plugin-category-delete" aria-label={LABEL.remove + (item.name || item.key)} onClick={() => remove(index)} disabled={items.length <= 1 || Number(item.usageCount || 0) > 0} title={Number(item.usageCount || 0) ? tx("请先迁移正在使用此分类的插件") : LABEL.remove}>{LABEL.remove}</button>
          </div>)}
          <button type="button" className="plugin-category-add" disabled={items.length >= 32} onClick={add}><Icon name="plus" />{LABEL.add}</button>
        </fieldset>}
      <p className="plugin-category-manager-footnote">{LABEL.footnote}</p>
    </div>
  </Modal>
    {removeTarget && <Modal scope="plugin-page" title={tx("删除分类")} icon="trash" onClose={() => setRemoveTarget(null)}
      foot={<>
        <button type="button" className="btn btn-ghost" onClick={() => setRemoveTarget(null)}>{tx("取消")}</button>
        <button type="button" className="btn btn-danger" onClick={confirmRemove}>{tx("确认删除")}</button>
      </>}>
      <div className="plugin-category-remove-confirm">
        <span className="plugin-category-remove-icon"><Icon name="trash" /></span>
        <div><h3>{tx("确定删除“")}{removeTarget.label}{'\u201d\uff1f'}</h3>
          <p>{tx("删除后，客户端目录将不再显示这个分类。已经在使用的分类不能删除，也不会影响已经上架的插件版本。")}</p>
        </div>
      </div>
    </Modal>}
  </>
}
