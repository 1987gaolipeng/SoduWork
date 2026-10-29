import { translateText as tx, localeMap, useLocale } from '../i18n.js'
import React, { useState } from 'react'
import { api } from '../api.js'
import { Icon, Modal, toast, SelectMenu } from '../ui.jsx'













export const SHOT = localeMap(() => ([
  ['auto', '界面类改动要截图', '默认。改界面必须留图自证；纯后端贴请求/响应或测试输出。'],
  ['always', '每次都要留证据', '任何改动都要有图或完整输出，验收最严。'],
  ['never', '不许拉浏览器截图', '改用「构建 + 在产物里核对 + curl 探活」自证。★Windows 上"起预览再拉 Chrome"常静默挂死，前端工程建议选它。'],
]))
export const MR = localeMap(() => ([
  ['none', '不建，SoduWork 直接合', 'AI 推完分支就收工，合并由 SoduWork 做。'],
  ['create', '建一个合并请求', 'AI 提 MR/PR 但不自己合，留给评审人。'],
  ['required', '必须建（没 MR 不算交完）', '强制走评审流程的公司选这个。'],
]))
const pick = (arr, k) => (arr.find(([x]) => x === k) || arr[0])

/*
 * Expand variables into readable descriptions in previews while retaining literal variable
 * names in the editor.
 */
const VAR_CN = localeMap(() => ({ '{base}': '基线分支', '{work}': '本条分支', '{task}': "需求编号", '{target}': 'MR 目标分支',
  '{selftest}': '配好的自测说法', '{evidence}': '配好的自证说法', '{commit}': '提交信息规范' }))
const humanize = (s) => Object.keys(VAR_CN).reduce((acc, k) => acc.split(k).join('〈' + VAR_CN[k] + '〉'), String(s || ''))

/** Summarize the effective workflow and distinguish repository overrides from inherited defaults. */
export function DevFlowSummary({ cfg, inherit, steps }) {
  const uiLocale = useLocale();
  const c = cfg || {}
  const eff = (k, d) => c[k] || (inherit || {})[k] || d
  const own = (k) => (inherit ? !!(Array.isArray(c[k]) ? c[k].length : String(c[k] || '').trim()) : false)
  const n = (c.steps && c.steps.length) || ((inherit || {}).steps || {}).length || (steps || []).length
  const items = [
    ['branch', eff('branch', 'fix/{task}')],
    ['selftest', eff('selftest', '') || tx("自测跟工程走")],
    ['screenshot', pick(SHOT, eff('screenshot', 'auto'))[1]],
    ['mr', pick(MR, eff('mr', 'none'))[1]],
    ['steps', n ? n + tx(" 步") : tx("内置步骤")],
  ]
  return (
    <span className="df-sum">
      {items.map(([k, label]) => (
        <span key={k} className={'df-chip' + (own(k) ? ' own' : '')}
          title={own(k) ? tx("这一项是这个工程自己定的") : (inherit ? tx("跟全局默认走") : '')}>{label}</span>
      ))}
    </span>
  )
}

/** Edit steps within the dialog; empty values inherit the default structure. */
function StepEditor({ steps, fallback, onChange }) {
  const uiLocale = useLocale();
  const list = steps && steps.length ? steps : null
  const shown = list || fallback || []
  const set = (i, k, v) => onChange(shown.map((s, j) => (j === i ? { ...s, [k]: v } : s)))
  const move = (i, d) => { const n = [...shown]; const j = i + d; if (j < 0 || j >= n.length) return; [n[i], n[j]] = [n[j], n[i]]; onChange(n) }
  return (
    <>
      <div className="df-sec">
        <span className="df-sec-t">{tx("流程步骤")}</span>
        <span className="df-sec-d">{list ? tx("这套流程自己定的") : tx("内置骨架（血泪口径都在里面）")}{tx(" · 共 ")}{shown.length}{tx(" 步")}</span>
        <span className="ml-auto" />
        {list
          ? <button className="btn btn-ghost xs" onClick={() => onChange([])}>{tx("恢复内置")}</button>
          : <button className="btn btn-ghost xs" onClick={() => onChange((fallback || []).map((s) => ({ ...s })))}><Icon name="pencil" />{tx("改成自己的")}</button>}
      </div>
      <div className="df-steps-list">
        {shown.map((s, i) => (
          <div className={'df-step' + (list ? '' : ' ro')} key={i}>
            <span className="df-step-idx">{i + 1}</span>
            {list ? (
              <div className="df-step-body">
                <input className="f-in" value={s.title} onChange={(e) => set(i, 'title', e.target.value)} placeholder={tx("这一步叫什么")} />
                <textarea className="f-in" rows={2} value={s.detail} onChange={(e) => set(i, 'detail', e.target.value)}
                  placeholder={tx("要求 AI 做什么、要留下什么证据")} />
              </div>
            ) : (
              <div className="df-step-body"><b className="df-step-ro">{s.title}</b>
                <span className="df-step-ro-d">{humanize((s.detail || '').split('\n')[0])}</span></div>
            )}
            {list && (
              <span className="df-step-ops">
                <button className="rowbtn" title={tx("上移")} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                <button className="rowbtn" title={tx("下移")} disabled={i >= shown.length - 1} onClick={() => move(i, 1)}>↓</button>
                <button className="rowbtn" title={tx("删除这一步")} disabled={shown.length <= 1}
                  onClick={() => onChange(shown.filter((_, j) => j !== i))}><Icon name="trash" /></button>
              </span>
            )}
          </div>
        ))}
      </div>
      {list && (
        <>
          <button className="btn btn-ghost xs" onClick={() => onChange([...shown, { key: 's' + shown.length, title: '新的一步', detail: '' }])}><Icon name="plus" />{tx("加一步")}</button>
          <div className="df-hint">{tx("可用变量：")}<code>{'{base}'}</code>{tx(" 基线分支 · ")}<code>{'{work}'}</code>{tx(" 本条分支 · ")}<code>{'{task}'}</code>{tx(" 需求编号 ·")}<code>{'{target}'}</code>{tx(" MR 目标 · ")}<code>{'{selftest}'}</code> · <code>{'{evidence}'}</code> · <code>{'{commit}'}</code></div>
        </>
      )}
    </>
  )
}

/** Sectioned configuration dialog; inherit indicates repository overrides with blank-value fallback. */
export function DevFlowModal({ value, inherit, defaultSteps, presets, title, repoId, onClose, onSave }) {
  const uiLocale = useLocale();
  const [v, setV] = useState(value || {})
  const [busy, setBusy] = useState(false)
  const set = (k) => (e) => setV({ ...v, [k]: e.target.value })
  const ph = (k, d) => (inherit ? tx("跟默认走：") + (inherit[k] || d) : d)
  const mrNow = v.mr || (inherit || {}).mr || 'none'
  return (
    <Modal wide title={title} icon="tree" onClose={onClose}
      foot={<>
        <DevFlowPreview cfg={v} repoId={repoId} />
        <span className="ml-auto" />
        <button className="btn btn-ghost" onClick={onClose}>{tx("取消")}</button>
        <button className="btn btn-primary" disabled={busy}
          onClick={async () => { setBusy(true); try { await onSave(v) } finally { setBusy(false) } }}>{busy ? tx("保存中…") : tx("保存")}</button>
      </>}>
      {presets && (
        <div className="df-sec">
          <span className="df-sec-t">{tx("套用预设")}</span>
          <span className="df-sec-d">{tx("选一套常见流派打底，再改成贵公司的样子")}</span>
          <span className="ml-auto" />
          <SelectMenu className="f-in df-preset" value="" onChange={(e) => {
            const p = presets.find((x) => x.id === e.target.value)
            if (p) { setV({ ...v, ...p.cfg }); toast(tx("已套用「") + p.name + tx("」，可以接着改")) }
          }}>
            <option value="">{tx("选一套…")}</option>
            {presets.map((p) => <option key={p.id} value={p.id} title={p.desc}>{p.name}</option>)}
          </SelectMenu>
        </div>
      )}

      <div className="df-sec"><span className="df-sec-t">{tx("分支与提交")}</span></div>
      <div className="df-grid">
        <label className="df-field">
          <span className="f-lbl">{tx("工作分支")}</span>
          <input className="f-in" value={v.branch || ''} onChange={set('branch')} placeholder={ph('branch', 'fix/{task}')} />
          <i className="df-hint">{tx("必须含 ")}<code>{'{task}'}</code>{tx("，自动合并靠它认分支")}</i>
        </label>
        <label className="df-field">
          <span className="f-lbl">{tx("提交信息规范")}</span>
          <input className="f-in" value={v.commit || ''} onChange={set('commit')}
            placeholder={ph('commit', tx("留空＝中文写清做了什么+怎么验的"))} />
          <i className="df-hint">{tx("可写贵公司原文，支持 ")}<code>{'{task}'}</code></i>
        </label>
      </div>

      <div className="df-sec"><span className="df-sec-t">{tx("怎么算干完")}</span></div>
      <div className="df-grid">
        <label className="df-field">
          <span className="f-lbl">{tx("自测命令")}</span>
          <input className="f-in" value={v.selftest || ''} onChange={set('selftest')} placeholder={ph('selftest', tx("留空＝跑工程既有的测试/构建"))} />
        </label>
        <label className="df-field">
          <span className="f-lbl">{tx("怎么自证")}</span>
          <SelectMenu className="f-in" value={v.screenshot || (inherit ? '' : 'auto')} onChange={set('screenshot')}>
            {inherit && <option value="">{tx("跟默认走：")}{pick(SHOT, inherit.screenshot)[1]}</option>}
            {SHOT.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </SelectMenu>
          <i className="df-hint">{pick(SHOT, v.screenshot || (inherit || {}).screenshot || 'auto')[2]}</i>
        </label>
        <label className="df-field">
          <span className="f-lbl">{tx("合并请求（MR/PR）")}</span>
          <SelectMenu className="f-in" value={v.mr || (inherit ? '' : 'none')} onChange={set('mr')}>
            {inherit && <option value="">{tx("跟默认走：")}{pick(MR, inherit.mr)[1]}</option>}
            {MR.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </SelectMenu>
        </label>
        {mrNow !== 'none' && (
          <label className="df-field">
            <span className="f-lbl">{tx("MR 提给哪个分支")}</span>
            <input className="f-in" value={v.mrTarget || ''} onChange={set('mrTarget')} placeholder={ph('mrTarget', tx("留空＝工程的合并分支"))} />
          </label>
        )}
      </div>

      <StepEditor steps={v.steps} fallback={(inherit && (inherit.steps || []).length) ? inherit.steps : defaultSteps}
        onChange={(s) => setV({ ...v, steps: s })} />

      <div className="df-sec"><span className="df-sec-t">{tx("另外要求")}</span>
        <span className="df-sec-d">{tx("原样附在流程末尾")}</span></div>
      <textarea className="f-in" rows={2} value={v.extra || ''} onChange={set('extra')}
        placeholder={tx("这个工程特有的规矩，如：改完 proto 要重新生成 client；迁移脚本必须可回滚")} />
    </Modal>
  )
}

/** Preview the backend-rendered execution prompt using the same rendering path as actual dispatch. */
export function DevFlowPreview({ cfg, repoId, label }) {
  const uiLocale = useLocale();
  const [open, setOpen] = useState(false)
  const [txt, setTxt] = useState(null)
  async function show() {
    setOpen(true); setTxt(null)
    try { setTxt(await api.previewDevFlow({ cfg: cfg || null, repoId: repoId || '', local: true })) }
    catch (e) { setTxt({ text: tx("预览失败：") + e.message, branch: '' }) }
  }
  return (
    <>
      <button className="btn btn-ghost btn-sm" onClick={show}><Icon name="external" />{label || tx("预览真正文")}</button>
      {open && (
        <Modal wide title={tx("AI 收到的就是这段（未保存的改动也照这份预览）")} icon="tree" onClose={() => setOpen(false)}
          foot={<button className="btn btn-ghost" onClick={() => setOpen(false)}>{tx("关闭")}</button>}>
          {!txt ? <div className="empty">{tx("渲染中…")}</div> : (
            <>
              {txt.branch && <div className="int-hint" style={{ marginBottom: 8 }}>{tx("这条活会用分支 ")}<code>{txt.branch}</code>{tx("（示例需求编号）。")}</div>}
              <pre className="df-preview">{txt.text}</pre>
            </>
          )}
        </Modal>
      )}
    </>
  )
}
