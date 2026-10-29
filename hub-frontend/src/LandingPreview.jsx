import React, { useState } from 'react'
import { translateText as tx, localeMap, useLocale } from './i18n.js'

const paths = {
  arrow: <><path d="M5 12h14m-5-5 5 5-5 5" /></>,
  download: <><path d="M12 3v12m-5-5 5 5 5-5M5 17v4h14v-4" /></>,
  chat: <><path d="M20 11a8 8 0 0 1-8 8H5l-3 3V11a9 9 0 0 1 18 0Z" /><path d="M7 9h8M7 13h5" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  layers: <><path d="m12 3 10 5-10 5L2 8l10-5ZM2 12l10 5 10-5M2 16l10 5 10-5" /></>,
  file: <><path d="M6 3h8l4 4v14H6V3Zm8 0v5h4M9 12h6M9 16h4" /></>,
  grid: <><rect x="3" y="3" width="7" height="7" rx="2" /><rect x="14" y="3" width="7" height="7" rx="2" /><rect x="3" y="14" width="7" height="7" rx="2" /><rect x="14" y="14" width="7" height="7" rx="2" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" /><path d="m8 12 3 3 5-6" /></>,
  memory: <><path d="M4 5h16v15H4zM8 2v6m8-6v6M8 12h8M8 16h5" /></>,
  sparkle: <><path d="m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4L12 3Z" /></>,
  team: <><circle cx="9" cy="8" r="3" /><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 5v2" /></>,
}

export function PublicIcon({ name = 'arrow', size = 20 }) {
  return <svg className="public-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.arrow}</svg>
}

const examples = localeMap(() => ([
  { id: 'research', label: '调研与文档', title: '把资料，变成有依据的方案',
    prompt: '整理这些调研资料，帮我准备一份产品方案。',
    response: '将资料、分析过程和交付文档放在同一处，后续讨论可以接着做。',
    steps: ['引用资料', '梳理思路', '形成成果'], file: '产品调研与方案', type: 'DOCX',
    note: '在对话中预览成果，也可以保存到资料库。' },
  { id: 'team', label: '需求协作', title: '同一项需求，接住每一次协作',
    prompt: '把这次改版整理成需求，明确目标和验收标准。',
    response: '让负责人、协作者与 AI 围绕同一份需求推进，过程和成果随工作保留。',
    steps: ['明确需求', '协同推进', '人工验收'], file: '改版目标与验收清单', type: 'ISSUE',
    note: '在需求池查看状态，回到原会话继续讨论。' },
  { id: 'routine', label: '例行工作', title: '把重复的事，安排得井井有条',
    prompt: '每周整理项目进展，生成一份可核对的周报。',
    response: '设置执行时间与工作内容，保留每次运行记录，方便查看结果与处理异常。',
    steps: ['安排计划', '执行工作', '查看结果'], file: '项目进展周报', type: 'REPORT',
    note: '自动化与工作会话相连，结果有处可查。' },
]))

export default function LandingPreview() {
  useLocale()
  const [selected, setSelected] = useState(0)
  const example = examples[selected]
  function onKeyDown(event, index) {
    const next = event.key === 'ArrowRight' ? (index + 1) % examples.length
      : event.key === 'ArrowLeft' ? (index + examples.length - 1) % examples.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? examples.length - 1 : null
    if (next === null) return
    event.preventDefault(); setSelected(next)
    event.currentTarget.parentElement.querySelectorAll('[role="tab"]')[next].focus()
  }
  return <div className="product-stage">
    <div className="product-stage-caption"><span><i />{tx('一个空间，衔接整段工作')}</span><span>SoduWork</span></div>
    <div className="product-workspace">
      <div className="product-rail" aria-hidden="true"><img src="/soduwork.png" alt="" className="logo-box" /><PublicIcon name="chat" /><PublicIcon name="grid" /><PublicIcon name="clock" /><PublicIcon name="layers" /><span className="product-rail-tail">S</span></div>
      <div className="product-workspace-main">
        <div className="product-tabs" role="tablist" aria-label={tx('工作场景示意')}>
          {examples.map((item, index) => <button key={item.id} id={'preview-tab-' + item.id} type="button" role="tab" aria-selected={selected === index} aria-controls="product-preview-panel" tabIndex={selected === index ? 0 : -1} onClick={() => setSelected(index)} onKeyDown={event => onKeyDown(event, index)}>{item.label}</button>)}
        </div>
        <div className="product-conversation" id="product-preview-panel" role="tabpanel" tabIndex={0} aria-labelledby={'preview-tab-' + example.id}>
          <span className="product-context"><PublicIcon name="file" size={15} />{tx('工作示例')}</span>
          <h2>{example.title}</h2>
          <div className="product-message">{example.prompt}<span>{tx('你')}</span></div>
          <div className="product-answer"><span className="product-ai"><PublicIcon name="sparkle" size={18} /></span><div><b>SoduWork</b><p>{example.response}</p></div></div>
          <div className="product-steps">{example.steps.map(step => <span key={step}><PublicIcon name="check" size={13} />{step}</span>)}</div>
          <div className="product-document"><span className="product-file-icon"><PublicIcon name="file" size={25} /></span><div><small>{example.type}</small><b>{example.file}</b><p>{tx('成果与过程，一起留在工作里')}</p></div><PublicIcon name="arrow" size={18} /></div>
          <p className="product-note">{example.note}</p>
        </div>
        <div className="product-composer" aria-hidden="true"><span>＋</span><span>{tx('继续聊聊这项工作…')}</span><i><PublicIcon name="arrow" size={16} /></i></div>
      </div>
    </div>
    <div className="product-stage-foot"><span><PublicIcon name="layers" size={15} />{tx('对话 · 需求 · 成果 · 记忆')}</span><small>{tx('功能示意，非实时工作数据')}</small></div>
  </div>
}
