import { translateText as tx, localeMap, useLocale } from '../i18n.js'
import React, { useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import { Icon, Modal, useAsync, Loading, ErrorState, toast } from '../ui.jsx'
import './skill-sharing.css'

const states = localeMap(() => ({ pending: '待审核', approved: '已通过', rejected: '已退回' }))

export default function SkillSharing({ onPublished }) {
  const uiLocale = useLocale();
  const requests = useAsync(() => api.skillSubmissions())
  const [selected, setSelected] = useState(null)
  const pending = requests.data?.items?.filter(item => item.status === 'pending').length
  return <details className="skill-sharing skill-sharing-compact">
    <summary>
      <Icon name="chevron" /><b>{tx("共享审核")}</b>
      <span className="skill-sharing-pending" role="status">{requests.error ? tx("待审数读取失败") :
        requests.loading || pending == null ? tx("读取中…") : tx("{0} 项待审核", [pending])}</span>
      <span className="skill-sharing-expand">{tx("查看申请")}</span>
    </summary>
    <div className="skill-sharing-content">
      <header><p>{tx("员工提交个人 Skill 后，可在此查看完整包，审核指定版本；审核发布后，其他客户端可选择使用。")}</p>
        <button className="admin-text-action" onClick={requests.reload}>{tx("刷新申请")}</button></header>
      {requests.error ? <ErrorState msg={requests.error.message} onRetry={requests.reload} /> :
        requests.loading ? <Loading /> : !requests.data?.items?.length ? <p className="skill-sharing-empty">{tx("暂无共享申请。员工可在 Skill 详情中提交。")}</p> :
        <div className="skill-sharing-list">{requests.data.items.map(item =>
          <div key={item.id} className="skill-sharing-row">
            <span className="skill-sharing-icon"><Icon name="file" /></span>
            <span className="skill-sharing-copy"><b>{item.name}</b><small>{item.description}</small></span>
            <code>{item.checksum.slice(0, 12)}</code>
            <span className={'skill-sharing-state ' + item.status}>{item.published ? tx("已发布") : states[item.status]}</span>
            <div className="admin-row-actions"><button className="admin-text-action"
              data-submission={item.id} aria-label={tx("查看 {0} 的共享申请", [item.name])}
              onClick={() => setSelected(item)}>{tx("查看内容")}</button></div>
          </div>)}</div>}
    </div>
    {selected && <ReviewDialog item={selected} onClose={() => setSelected(null)}
      onReviewed={() => { setSelected(null); requests.reload(); onPublished?.() }} />}
  </details>
}

function ReviewDialog({ item, onClose, onReviewed }) {
  const uiLocale = useLocale();
  const data = useAsync(() => api.skillSubmission(item.id), [item.id])
  const [path, setPath] = useState('SKILL.md')
  const [content, setContent] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [note, setNote] = useState('')
  const revision = useRef(0)
  const current = data.data?.submission || item

  async function read(selected, append = false) {
    const ticket = ++revision.current
    setLoading(true); setError('')
    if (!append) setContent(null)
    try {
      const result = await api.skillSubmissionContent(item.id, item.checksum, selected,
        append ? content.nextOffset : 0)
      if (ticket !== revision.current) return
      setContent(append ? { ...result, text: (content?.text || '') + result.text } : result)
    } catch (err) { if (ticket === revision.current) setError(err.message) }
    finally { if (ticket === revision.current) setLoading(false) }
  }
  useEffect(() => { read(path); return () => { revision.current++ } }, [path, item.id])

  async function download(file = '') {
    setBusy(true)
    try { await api.downloadSkillSubmission(item.id, item.checksum, file, item.name) }
    catch (err) { toast(err.message) }
    finally { setBusy(false) }
  }
  async function review(decision) {
    setBusy(true)
    try {
      const result = await api.reviewSkillSubmission(item.id, { checksum: item.checksum, decision, note })
      toast(decision === 'reject' ? tx("已退回修改") : result.allowed ?
        tx("已审核并发布，其他客户端刷新后可选择使用") : tx("已审核，请在公司能力库中确认开放状态"))
      onReviewed()
    } catch (err) { setError(err.message) }
    finally { setBusy(false) }
  }
  return <div className="skill-review"><Modal scope="skill-review" wide title={tx("审核 Skill · ") + item.name} onClose={onClose}
    foot={<><button className="btn btn-ghost" disabled={busy || !data.data} onClick={() => download()}>{tx("下载完整包")}</button>
      <span className="ml-auto" />
      {current.status === 'pending' ? <>
        <button className="btn btn-ghost" disabled={busy || !note.trim()} onClick={() => review('reject')}>{tx("退回修改")}</button>
        <button className="btn btn-primary" disabled={busy || !confirmed || !data.data}
          onClick={() => review('approve')}>{busy ? tx("正在处理…") : tx("审核并发布")}</button>
      </> : <button className="btn btn-ghost" onClick={onClose}>{tx("完成")}</button>}</>}>
    {data.error ? <ErrorState msg={data.error.message} onRetry={data.reload} /> : !data.data ? <Loading /> : <>
      <div className="skill-review-meta"><span>{data.data.fileCount}{tx(" 个文件")}</span>
        <code title={item.checksum}>{tx("版本 ")}{item.checksum.slice(0, 12)}</code>
        <span>{states[current.status]}</span></div>
      {current.note && <p className="skill-review-note">{tx("提交说明：")}{current.note}</p>}
      <div className="skill-review-package">
        <nav aria-label={tx("Skill 文件目录")}>{data.data.files.map(file =>
          <button key={file.path} data-review-file={file.path} className={file.path === path ? 'on' : ''}
            aria-current={file.path === path ? 'true' : undefined} onClick={() => setPath(file.path)}>
            <Icon name="file" /><span>{file.path}</span></button>)}</nav>
        <section><header><b>{path}</b><button className="btn btn-ghost btn-sm" disabled={busy}
          onClick={() => download(path)}>{tx("下载原文件")}</button></header>
          <div className="skill-review-content">
            {loading && <p>{tx("正在读取…")}</p>}
            {content?.kind === 'text' && <pre className={/\.(md|txt)$/i.test(path) ? 'skill-source-prose' : ''}>{content.text}</pre>}
            {content?.kind === 'image' && <img src={'data:' + content.mediaType + ';base64,' + content.base64} alt={path} />}
            {content?.kind === 'binary' && <p>{content.message}</p>}
          </div>
          {content?.nextOffset != null && <button className="btn btn-ghost btn-sm" disabled={loading}
            onClick={() => read(path, true)}>{tx("继续加载 · ")}{content.nextOffset} / {content.totalCharacters}{tx(" 字符")}</button>}
        </section>
      </div>
      {error && <div role="alert" className="skill-review-error">{error}
        <button className="btn btn-ghost btn-sm" onClick={() => read(path)}>{tx("重读文件")}</button></div>}
      {current.status === 'pending' ? <div className="skill-review-decision">
        <label><span>{tx("审核意见 ")}<small>{tx("退回时必填")}</small></span><textarea value={note} maxLength={2000}
          onChange={e => setNote(e.target.value)} placeholder={tx("使用范围、环境要求或需要修改的问题")} /></label>
        <label className="skill-review-consent"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />
          <span>{tx("已检查全部文件、脚本与模板，确认可以向公司开放此版本。")}</span></label>
      </div> : current.reviewNote && <p className="skill-review-note">{tx("审核意见：")}{current.reviewNote}</p>}
    </>}
  </Modal></div>
}
