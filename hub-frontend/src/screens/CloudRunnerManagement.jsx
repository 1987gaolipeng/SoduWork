import React, { useEffect, useState } from 'react'
import { api } from '../api.js'
import { Modal, toast } from '../ui.jsx'
import { translateText as tx } from '../i18n.js'
import './cloud-runner-management.css'

export function CloudRunnerActions({ row, busy, onAvailability, onManage }) {
  const pending = row.managementState === 'pending_setup'
  const disabled = row.managementState === 'disabled'
  return <>
    {!pending && <button className="admin-text-action" disabled={busy}
      onClick={() => onAvailability(row, disabled)}>{disabled ? tx('启用') : tx('停用')}</button>}
    {disabled && <button className="admin-text-action" disabled={busy || row.online || row.load > 0}
      onClick={() => onManage(row, 'reassign')}>{tx('重新分配')}</button>}
    {(pending || disabled) && <button className="admin-text-action" disabled={busy || row.online}
      onClick={() => onManage(row, 'provision')}>{tx('安全接入')}</button>}
  </>
}

export default function CloudRunnerManagement({ row, mode, onDone, onClose }) {
  const [query, setQuery] = useState('')
  const [items, setItems] = useState([])
  const [target, setTarget] = useState('')
  const [loading, setLoading] = useState(mode === 'reassign')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [workRoot, setWorkRoot] = useState('')
  const [hub, setHub] = useState('')
  const [setup, setSetup] = useState(null)
  const [platform, setPlatform] = useState(/windows/i.test(row.os || '') ? 'windows' : 'linux')
  const transferring = mode === 'reassign'
  useEffect(() => {
    if (!transferring) return
    let active = true
    setLoading(true); setTarget('')
    const timer = setTimeout(() => {
      api.cloudRunnerAssignees(query).then(result => {
        if (active) { setItems(result.items || []); setError('') }
      }).catch(e => { if (active) { setItems([]); setError(e.message) } })
        .finally(() => { if (active) setLoading(false) })
    }, 200)
    return () => { active = false; clearTimeout(timer) }
  }, [query, transferring])

  async function submit() {
    setBusy(true); setError('')
    try {
      if (transferring) {
        await api.reassignCloudRunner(row, target)
        toast(tx('已分配，完成安全接入后可启用'))
        onDone(); onClose()
      } else {
        setSetup(await api.provisionCloudRunner(row, {
          hostResetConfirmed: confirmed, workRoot: workRoot.trim(), hub: hub.trim(),
        }))
        onDone()
      }
    } catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }

  const command = setup?.commands?.[platform] || ''
  return <Modal title={tx(transferring ? '重新分配云主机' : '安全接入云主机')} icon="monitor"
    onClose={busy ? () => {} : onClose} className="cloud-runner-management"
    footer={<>
      <button className="btn" disabled={busy} onClick={onClose}>{tx(setup ? '关闭' : '取消')}</button>
      {!setup && <button className="btn btn-primary" disabled={busy || (transferring
        ? !target || loading : !confirmed || !workRoot.trim())} onClick={submit}>
        {busy ? tx('处理中…') : tx(transferring ? '确认分配' : '生成接入命令')}</button>}
    </>}>
    <p className="crm-identity"><b>{row.label || row.host}</b><span>{row.owner || row.ownerUserId}</span></p>
    {error && <p className="crm-error" role="alert">{error}</p>}
    {setup ? <>
      <p>{tx('接入命令仅本次显示。请在清理后的主机执行，连接成功后回到列表启用。')}</p>
      <label className="crm-field"><span>{tx('系统')}</span><select className="f-in" value={platform}
        onChange={e => setPlatform(e.target.value)}><option value="linux">Linux</option><option value="windows">Windows</option></select></label>
      <textarea className="f-in crm-command" aria-label={tx('接入命令')} value={command} readOnly spellCheck={false} />
      <button className="btn" onClick={async () => {
        try { await navigator.clipboard.writeText(command); toast(tx('已复制')) }
        catch { setError(tx('无法复制，请手动选择命令')) }
      }}>{tx('复制命令')}</button>
    </> : transferring ? <>
      <p className="crm-note">{tx('请先停止远程执行服务。原用户的云端入口和旧接入凭据将失效。历史会话保留，新用户不会继承旧会话。主机分配后保持停用，需完成安全接入。')}</p>
      <label className="crm-field"><span>{tx('查找用户')}</span><input className="f-in" value={query}
        onChange={e => setQuery(e.target.value)} placeholder={tx('姓名或账号')} /></label>
      <label className="crm-field"><span>{tx('分配给')}</span><select className="f-in" value={target}
        disabled={loading} onChange={e => setTarget(e.target.value)}>
        <option value="">{loading ? tx('加载中…') : tx('请选择用户')}</option>
        {items.map(item => <option key={item.id} value={item.id}>{item.name} · {item.username}</option>)}
      </select></label>
      <p className="muted">{tx('仅显示管理范围内尚未分配云主机的启用账号。每个账号最多一台。')}</p>
    </> : <>
      <p className="crm-note">{tx('请先重装或重建主机，清除旧数据、运行目录及底座凭据，并撤销原用户的 SSH 密码和密钥。仅更换工作目录不能隔离原用户的数据。完成后再执行新接入命令。')}</p>
      <label className="crm-check"><input type="checkbox" checked={confirmed}
        onChange={e => setConfirmed(e.target.checked)} /><span>{tx('已重建主机，并撤销原用户的访问权限及旧凭据')}</span></label>
      <label className="crm-field"><span>{tx('独立工作目录')}</span><input className="f-in" value={workRoot}
        onChange={e => setWorkRoot(e.target.value)} placeholder="/srv/soduwork/workspace" /></label>
      <label className="crm-field"><span>{tx('主机可访问的服务地址')}</span><input className="f-in" value={hub}
        onChange={e => setHub(e.target.value)} placeholder={tx('留空使用当前服务地址')} /></label>
    </>}
  </Modal>
}
