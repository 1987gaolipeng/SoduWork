import { translateText as tx, localeMap, useLocale } from '../i18n.js'
import React, { useEffect, useState } from 'react'
import { api } from '../api.js'
import { Icon, Loading, Modal, toast } from '../ui.jsx'
import './plugin-publishers.css'


const EMPTY = { publisherName: '', keyId: '', publicKey: '', description: '' }
const shortFingerprint = (value = '') =>
  value ? value.slice(0, 12) + '…' + value.slice(-12) : '—'


export function PluginPublisherKeys({ onClose }) {
  const uiLocale = useLocale();
  const [rows, setRows] = useState(null)
  const [error, setError] = useState('')
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState(EMPTY)
  const [busy, setBusy] = useState('')
  const [confirmId, setConfirmId] = useState('')

  async function load() {
    setError('')
    try { setRows((await api.pluginPublishers()).items || []) }
    catch (e) { setRows([]); setError(e.message || tx("可信发布者加载失败")) }
  }
  useEffect(() => { load() }, [])

  async function create() {
    setBusy('create')
    try {
      await api.createPluginPublisher(form)
      setForm(EMPTY); setAdding(false); toast(tx("可信发布者已登记"))
      await load()
    } catch (e) { toast(tx("登记失败：") + e.message) }
    setBusy('')
  }

  async function revoke(row) {
    if (confirmId !== row.id) { setConfirmId(row.id); return }
    setBusy(row.id)
    try {
      await api.revokePluginPublisher(
        row.id, tx("停止信任该密钥签发的新插件包"))
      setConfirmId(''); toast(tx("密钥已撤销，现有已发布版本未被自动停用"))
      await load()
    } catch (e) { toast(tx("撤销失败：") + e.message) }
    setBusy('')
  }

  return <Modal scope="plugin-page" wide title={tx("可信发布者")} icon="shield" onClose={onClose}
    foot={<button className="btn btn-ghost" onClick={onClose}>{tx("关闭")}</button>}>
    <div className="publisher-intro">
      <div><b>{tx("只登记公钥，不上传私钥")}</b><span>{tx("签名有效能证明插件包来自已登记发布者且内容未被改动；最终发布仍需经过预检、评测和管理员审核。")}</span></div>
      <button className="btn btn-primary" onClick={() => setAdding((value) => !value)}>
        {!adding && <Icon name="plus" />}{adding ? tx("收起") : tx("登记发布者")}
      </button>
    </div>

    {adding && <section className="publisher-form">
      <label><span>{tx("发布者名称")}</span><input className="f-in" value={form.publisherName}
        placeholder={tx("例如：研发效能中心")} onChange={(e) => setForm({ ...form, publisherName: e.target.value })} /></label>
      <label><span>Key ID</span><input className="f-in" value={form.keyId}
        placeholder={tx("例如：example.devtools.2026")} onChange={(e) => setForm({ ...form, keyId: e.target.value })} /></label>
      <label className="publisher-key-field"><span>{tx("Ed25519 公钥（Base64）")}</span>
        <textarea className="f-in" rows="2" value={form.publicKey}
          placeholder={tx("只粘贴 32 字节公钥的 Base64；不要填写私钥")}
          onChange={(e) => setForm({ ...form, publicKey: e.target.value })} /></label>
      <label className="publisher-description"><span>{tx("用途说明")}</span>
        <input className="f-in" value={form.description}
          placeholder={tx("由谁维护、用于哪类企业插件")}
          onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
      <div className="publisher-form-actions"><button className="btn btn-ghost"
        onClick={() => { setAdding(false); setForm(EMPTY) }}>{tx("取消")}</button>
        <button className="btn btn-primary" disabled={busy === 'create'}
          onClick={create}>{busy === 'create' ? tx("正在校验…") : tx("校验并登记")}</button></div>
    </section>}

    {error && <div className="publisher-error"><Icon name="alert" /><span>{error}</span><button onClick={load}>{tx("重试")}</button></div>}
    {rows === null && <Loading />}
    {rows && rows.length === 0 && !error && <div className="publisher-empty">
      <Icon name="shield" /><b>{tx("还没有可信发布者")}</b><span>{tx("无签名插件仍可进入隔离区，由管理员人工审核；不会被自动信任。")}</span>
    </div>}
    {rows && rows.length > 0 && <div className="publisher-list">
      <div className="publisher-list-head"><span>{tx("发布者")}</span><span>{tx("密钥与指纹")}</span><span>{tx("状态")}</span><span /></div>
      {rows.map((row) => <div className={'publisher-row ' + row.status} key={row.id}>
        <span className="publisher-identity"><i><Icon name="shield" /></i><span><b>{row.publisherName}</b><small>{row.description || (row.orgId ? tx("组织可信发布者") : tx("平台可信发布者"))}</small></span></span>
        <span className="publisher-proof"><b>{row.keyId}</b><code title={row.fingerprint}>{shortFingerprint(row.fingerprint)}</code></span>
        <span className={'publisher-status ' + row.status}>{row.status === 'active' ? tx("有效") : tx("已撤销")}</span>
        <span className="publisher-actions">{row.status === 'active' && <button
          className={confirmId === row.id ? 'confirm' : ''}
          disabled={busy === row.id} onClick={() => revoke(row)}>
          {busy === row.id ? tx("处理中…") : confirmId === row.id ? tx("确认撤销") : tx("撤销")}
        </button>}</span>
      </div>)}
    </div>}
    <p className="publisher-footnote">{tx("撤销密钥只阻止它签发的新包和再次发布，不会静默中断已经上线的业务；已发布版本请在版本记录中单独撤销。")}</p>
  </Modal>
}


export function PluginPublisherCandidate({ version, pluginName, onClose, onRegistered }) {
  const uiLocale = useLocale();
  const [candidate, setCandidate] = useState(null)
  const [form, setForm] = useState({ publisherName: '', description: '' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function load() {
    setError('')
    try {
      const row = await api.pluginPublisherCandidate(version.id)
      setCandidate(row)
      setForm({
        publisherName: row.publisherName || '',
        description: tx("由个人插件提交申请，经管理员核对登记"),
      })
    } catch (e) {
      setCandidate(null)
      setError(e.message || tx("发布身份加载失败"))
    }
  }
  useEffect(() => { load() }, [version.id])

  async function trust() {
    setBusy(true)
    try {
      const result = await api.trustPluginPublisherCandidate(version.id, form)
      toast(tx("发布身份已登记，当前不可变版本的签名验证通过"))
      if (onRegistered) await onRegistered(result)
      onClose()
    } catch (e) {
      toast(tx("登记失败：") + e.message)
    }
    setBusy(false)
  }

  return <Modal scope="plugin-page" title={tx("核对发布身份")} icon="shield" onClose={onClose}
    foot={<><button className="btn btn-ghost" disabled={busy} onClick={onClose}>{tx("取消")}</button>
      <button className="btn btn-primary" disabled={busy || !candidate || !form.publisherName.trim()}
        onClick={trust}>{busy ? tx("正在重新验签…") : tx("登记公钥并继续审核")}</button></>}>
    {error && <div className="publisher-error"><Icon name="alert" /><span>{error}</span><button onClick={load}>{tx("重试")}</button></div>}
    {!candidate && !error && <Loading />}
    {candidate && <div className="publisher-candidate">
      <div className="publisher-candidate-intro"><i><Icon name="shield" /></i><span>
        <b>{pluginName} · v{version.version}</b>
        <small>{tx("这把公钥已经证明能验证当前不可变插件包，但尚未获得企业信任。")}</small>
      </span></div>
      <dl>
        <div><dt>Key ID</dt><dd>{candidate.keyId}</dd></div>
        <div><dt>{tx("SHA-256 指纹")}</dt><dd title={candidate.fingerprint}>{candidate.fingerprint}</dd></div>
        <div><dt>{tx("Ed25519 公钥")}</dt><dd title={candidate.publicKey}>{candidate.publicKey}</dd></div>
      </dl>
      <section className="publisher-form publisher-candidate-form">
        <label><span>{tx("发布者名称")}</span><input className="f-in" value={form.publisherName}
          onChange={(e) => setForm({ ...form, publisherName: e.target.value })} /></label>
        <label><span>{tx("用途说明")}</span><input className="f-in" value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
      </section>
      <p className="publisher-footnote"><b>{tx("登记公钥不等于发布插件。")}</b>{tx("登记后仍须完成能力审查、发布评测和明确启用；私钥始终留在作者设备的系统安全存储中。")}</p>
    </div>}
  </Modal>
}
