import { translateText as tx, localeMap, useLocale } from '../i18n.js'
import React, { useState, useEffect, useRef } from 'react'
import { api } from '../api.js'
import { ErrorState, Loading, Icon, Modal, Confirm, toast } from '../ui.jsx'
import McpSharing from './McpSharing.jsx'
import ConnectorIcon from '../components/ConnectorIcon.jsx'
import { McpForm } from './McpConnectionForm.jsx'
export { McpForm } from './McpConnectionForm.jsx'

/* ===== MCP servers =====
   External tool sources shared by the mcp-tools skill for AI execution and by platform integrations
   for importing work items and writing results back. Two transport types are supported:
   - stdio: start a subprocess with command and args through the mcp-tools/scripts/mcp.mjs bridge.
   - http: call Streamable HTTP integrations with static authentication headers and optional
     dynamic Keycloak bearer tokens.
   Store configuration in the backend, never in the repository. The API masks environment variables,
   authentication headers, and Keycloak passwords as bullets; the UI never receives plaintext.
   Saving an unchanged masked field preserves its stored value. */

const blank = () => ({ id: '', name: '', type: 'stdio', command: 'npx', args: [], env: {},
  url: '', headers: {}, keycloak: {}, description: '', enabled: true,
  startupTimeoutSeconds: 10, toolTimeoutSeconds: 60, enabledTools: [], disabledTools: [] })

export default function McpServers({ templates = [] }) {
  const uiLocale = useLocale();
  const [rows, setRows] = useState(null)
  const [edit, setEdit] = useState(null)      // Selected row, new-entry marker, or null.
  const [del, setDel] = useState(null)
  const [importPreview, setImportPreview] = useState(null)
  const [importBusy, setImportBusy] = useState(false)
  const importPicker = useRef(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const load = () => {
    setError(null)
    api.mcpServers().then((r) => setRows(r.servers || [])).catch(setError)
  }
  useEffect(() => { load() }, [])
  if (!rows && error) return <ErrorState msg={error.message} onRetry={load} />
  if (!rows) return <Loading />

  async function persist(server, original, remove = false) {
    setBusy(true)
    try { const r = await (remove ? api.deleteMcpServer(original.id, original) : api.upsertMcpServer(server, original)); setRows(r.servers || []); toast(tx("已保存 · 下一次安排执行即生效")); return true }
    catch (e) {
      if (e.status === 409) {
        try { const latest = await api.mcpServers(); setRows(latest.servers || []); } catch (_) {}
        toast(tx('此连接已被更新，当前填写内容已保留。关闭后重新打开可查看最新配置。'))
      } else toast(tx("保存失败：") + e.message)
      return false
    }
    finally { setBusy(false) }
  }

  function openTemplate(item) {
    const preset = item?.template || {}
    const existing = rows.find((row) => row.templateKey === item.key || row.name === preset.name)
    if (existing) { setEdit(existing); return }
    setEdit({
      ...blank(), ...preset, id: '', templateKey: item.key || '',
      name: preset.name || item.name || '',
      description: preset.description || item.description || '',
      enabled: false,
    })
  }

  async function pickImport(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setImportBusy(true)
    try {
      const result = await api.preflightCapabilityMcp(file)
      setImportPreview({ file, ...result })
    } catch (error) {
      toast(tx("配置预检没有通过：") + error.message)
    }
    setImportBusy(false)
  }

  async function importConfig() {
    if (!importPreview?.file) return
    setImportBusy(true)
    try {
      const result = await api.importCapabilityMcp(importPreview.file)
      setRows(result.servers || rows)
      setImportPreview(null)
      toast(result.message || tx("连接器配置已导入"))
    } catch (error) {
      toast(tx("导入失败：") + error.message)
    }
    setImportBusy(false)
  }

  return (
    <div className="card mcp-card">
      <McpSharing onPublished={load} />
      <div className="mcp-toolbar">
        <span className="mcp-toolbar-copy">
          <b>{tx("连接器")}</b>
          <small>{tx("统一接入知识库、业务系统和本地工具；探测通过后才启用")}</small>
        </span>
        <span className="mcp-run-legend" aria-label={tx("连接器执行位置")}>
          <i><Icon name="grid" />{tx("HTTP 由 Hub 调用")}</i>
          <i><Icon name="desktop" />{tx("stdio 由在线 Runner 执行")}</i>
        </span>
        <span className="mcp-toolbar-actions">
          <input ref={importPicker} type="file" accept=".json,.toml,application/json"
            hidden onChange={pickImport} />
          <button className="btn btn-ghost btn-sm" disabled={importBusy}
            onClick={() => importPicker.current?.click()}>
            <Icon name="plug" />{importBusy ? tx("预检中…") : tx("导入")}
          </button>
          <button className="btn btn-primary btn-sm" onClick={() => setEdit('new')}><Icon name="plus" />{tx("新建连接")}</button>
        </span>
      </div>

      {templates.length > 0 && (
        <section className="cap-admin-templates">
          <div className="cap-admin-section-title">
            <div><b>{tx("从可信模板接入")}</b><span>{tx("模板自动进入目录，但必须由管理员确认配置后才会启用")}</span></div>
            <em>{templates.length}{tx(" 项推荐")}</em>
          </div>
          <div className="cap-admin-template-grid">
            {templates.map((item) => {
              const connected = rows.some((row) => row.templateKey === item.key || row.name === item.template?.name)
              const risk = item.risk === 'read' ? tx("只读") : item.risk === 'network' ? tx("需联网") : tx("可写入")
              return (
                <button key={item.key} className="cap-admin-template" onClick={() => openTemplate(item)}
                  title={[...(item.permissions || []), ...(item.requires || [])].join(' · ')}>
                  <b><ConnectorIcon value={item} />{item.name}</b>
                  <span>{item.description}</span>
                  <em>{connected ? tx("已接入 · 查看配置") : tx("{0} · 配置接入", [risk])}</em>
                </button>
              )
            })}
          </div>
        </section>
      )}

      {rows.length === 0 ? (
        <div className="mcp-empty">
          <span className="mcp-empty-ico"><Icon name="plug" /></span>
          <b>{tx("还没有可用连接")}</b>
          <span>{tx("从可信模板开始，或新建 HTTP / stdio 连接。保存前可以就地探测工具清单。")}</span>
          <button className="btn btn-primary btn-sm" onClick={() => setEdit('new')}><Icon name="plus" />{tx("新建第一个连接")}</button>
        </div>
      ) : (
        <div className="mcp-list">
          {rows.map((s) => (
            <div key={s.id} className={'mcp-item' + (s.enabled ? '' : ' off')}>
              <span className="mcp-i-main">
                <span className="mcp-i-top"><ConnectorIcon value={s} /><b>{s.name}</b>
                  {s.type === 'http' && <em className="mcp-i-env">HTTP</em>}
                  {s.type !== 'http' && <em className="mcp-i-env">stdio</em>}
                  <em className={'mcp-i-place ' + (s.type === 'http' ? 'hub' : 'runner')}>{s.type === 'http' ? tx("Hub 调用") : tx("Runner 执行")}</em>
                  {!s.enabled && <em className="mcp-i-off">{tx("已停用")}</em>}
                  {Object.keys(s.env || {}).length > 0 &&
                    <em className="mcp-i-env" title={tx("环境变量：") + Object.keys(s.env).join('、')}>
                      {Object.keys(s.env).length}{tx(" 个环境变量")}</em>}
                  {Object.keys(s.headers || {}).length > 0 &&
                    <em className="mcp-i-env" title={tx("鉴权头：") + Object.keys(s.headers).join('、')}>
                      {Object.keys(s.headers).length}{tx(" 个鉴权头")}</em>}
                  {(s.keycloak || {}).tokenUrl &&
                    <em className="mcp-i-env" title={tx("配了 Keycloak 动态令牌")}>Keycloak</em>}
                  <em className="mcp-i-env" title={tx("启动 / 单次工具调用超时")}>
                    {s.startupTimeoutSeconds || 10}s / {s.toolTimeoutSeconds || 60}s</em>
                  {(s.enabledTools || []).length > 0 &&
                    <em className="mcp-i-env" title={tx("仅开放：") + s.enabledTools.join('、')}>{tx("限 ")}{s.enabledTools.length}{tx(" 个工具")}</em>}
                  {(s.disabledTools || []).length > 0 &&
                    <em className="mcp-i-env" title={tx("明确禁用：") + s.disabledTools.join('、')}>{tx("禁 ")}{s.disabledTools.length}{tx(" 个工具")}</em>}
                </span>
                {s.description && <span className="mcp-i-desc">{s.description}</span>}
                <code className="mcp-i-cmd">{s.type === 'http'
                  ? 'HTTP · ' + (s.url || '') : [s.command, ...(s.args || [])].join(' ')}</code>
              </span>
              <span className="mcp-i-ops admin-row-actions">
                <button className="admin-text-action" onClick={() => setEdit(s)}>{tx("编辑")}</button>
                <button className="admin-text-action danger" onClick={() => setDel(s)}>{tx("移除")}</button>
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="mcp-foot">
        <Icon name="shield" />
        <span><b>{tx("凭据不会回显。")}</b>{tx("环境变量、鉴权头和客户端密钥由服务端保存，界面仅显示为 ••••，运行时按连接注入。")}</span>
      </div>

      {edit && <McpForm initial={edit === 'new' ? null : edit} busy={busy}
        template={templates.find(t => t.key === edit.templateKey)}
        onClose={() => setEdit(null)}
        onSave={async (v) => {
          if (await persist(v, edit === 'new' || !edit.id ? null : edit)) setEdit(null)
        }} />}
      {del && <Confirm title={tx("移除连接器")} danger confirmText={tx("移除")}
        text={tx("确定移除「{0}」？AI 以后就调不到它的工具了；服务器本身不受影响。", [del.name])}
        onClose={() => setDel(null)}
        onConfirm={async () => { if (await persist(null, del, true)) setDel(null) }} />}
      {importPreview && <McpImportPreview value={importPreview} busy={importBusy}
        onClose={() => setImportPreview(null)} onImport={importConfig} />}
    </div>
  )
}

function McpImportPreview({ value, busy, onClose, onImport }) {
  const uiLocale = useLocale();
  const summary = value.summary || {}
  const servers = value.servers || []
  return (
    <Modal wide title={tx("导入连接器配置")} icon="plug" onClose={onClose}
      foot={<>
        <button className="btn btn-ghost" onClick={onClose}>{tx("取消")}</button>
        <span className="ml-auto" />
        <button className="btn btn-primary" disabled={busy || !summary.importable} onClick={onImport}>
          {busy ? tx("正在导入…") : tx("导入 ") + (summary.importable || 0) + tx(" 个连接")}
        </button>
      </>}>
      <div className="cap-mcp-import-head">
        <span><small>{tx("来源")}</small><b>{value.source || tx("连接器配置")}</b></span>
        <span><small>{tx("识别")}</small><b>{summary.total || 0}{tx(" 个")}</b></span>
        <span><small>{tx("可导入")}</small><b>{summary.importable || 0}{tx(" 个")}</b></span>
        <span><small>{tx("同名跳过")}</small><b>{summary.duplicates || 0}{tx(" 个")}</b></span>
      </div>
      <div className="int-hint cap-mcp-import-hint">{tx("导入只完成登记，")}<b>{tx("所有新连接默认停用")}</b>{tx("。密钥值不会出现在预览里；导入后请逐项检查、测一下，再决定是否启用。")}</div>
      <div className="cap-mcp-import-list">
        {servers.map((item, index) => (
          <div key={item.name + index} className={'cap-mcp-import-row' +
            (!item.valid ? ' bad' : item.duplicate ? ' duplicate' : '')}>
            <span className="cap-mcp-import-main">
              <span><b>{item.name}</b><em>{item.type === 'http' ? 'HTTP' : 'STDIO'}</em>
                {item.duplicate && <i>{tx("同名，跳过")}</i>}
                {!item.valid && <i>{tx("不可导入")}</i>}
              </span>
              <code>{item.target || tx("未填写连接目标")}</code>
              {(item.credentialKeys || []).length > 0 &&
                <small>{tx("含凭据字段：")}{item.credentialKeys.join('、')}{tx("（值不回显）")}</small>}
              {[...(item.errors || []), ...(item.warnings || [])].map((message, i) =>
                <small key={i} className={i < (item.errors || []).length ? 'error' : ''}>{message}</small>)}
            </span>
          </div>
        ))}
      </div>
    </Modal>
  )
}
