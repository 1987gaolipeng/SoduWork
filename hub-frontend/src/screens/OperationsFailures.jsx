import React, { useState } from 'react'
import { api, can } from '../api.js'
import { translateText as tx } from '../i18n.js'
import { ErrorState, Loading, Modal, useAsync } from '../ui.jsx'
import { REQUIREMENT_LABELS, requirementStage } from './requirement-governance.js'
import { RunDrawer } from './PluginRunDialogs.jsx'
import './plugin-foundation.css'
import './plugin-workshop-dialogs.css'
import './plugin-admin-polish.css'

export function OperationsTaskDialog({ taskId, onClose }) {
  const { data: task, error, reload } = useAsync(() => api.taskDetail(taskId))
  return <Modal title={tx('查看需求')} icon="task" onClose={onClose}>
    {error ? <ErrorState msg={error.message} onRetry={reload} /> : !task ? <Loading /> :
      <section className="ops-task-detail"><h3>{task.title}</h3>
        <p>{REQUIREMENT_LABELS[requirementStage(task)]} · <code>{task.id}</code></p>
        {task.note && <p>{task.note}</p>}
        {!!task.acceptanceCriteria?.length && <><b>{tx('验收标准')}</b><ul>
          {task.acceptanceCriteria.map((item, index) => <li key={index}>{item}</li>)}</ul></>}
      </section>}
  </Modal>
}

function FailureRunDialog({ row, onClose, onChanged }) {
  const { data, error, reload } = useAsync(() => api.pluginRun(row.id))
  if (data) return <RunDrawer run={data} onClose={onClose} onChanged={onChanged}
    evidenceOpen />
  return <Modal title={tx('插件运行详情')} icon="activity" onClose={onClose}>
    {error ? <ErrorState msg={error.message} onRetry={reload} /> : <Loading />}
  </Modal>
}

export default function OperationsFailures({ rows, onChanged }) {
  const [selected, setSelected] = useState(null)
  const canInspect = can('plugin.manage') || can('plugin.run')
  const canViewTask = can('task.view')
  return <>
    <div className="ops-failures" tabIndex={0} role="region" aria-label={tx('最近失败')}>
      <div className="ops-section-label">{tx('最近失败')}</div>
      {rows.map(row => <article key={row.id}><span className="ops-fail-dot" />
        <div><b>{row.diagnosis ? tx(row.diagnosis) : tx('流程执行失败')}</b>
          <span>{row.taskAvailable === false ? tx('需求已不存在') : row.taskTitle || row.taskId}</span>
          {row.taskAvailable !== false && <nav className="ops-failure-actions" aria-label={row.taskTitle || tx('最近失败')}>
            {canInspect && <button type="button" className="admin-text-action"
              onClick={() => setSelected({ row, type: 'run' })}>{tx('查看运行日志')}</button>}
            {canViewTask && row.taskId && <button type="button" className="admin-text-action"
              onClick={() => setSelected({ row, type: 'task' })}>{tx('查看需求')}</button>}
            {!canInspect && !canViewTask && <small>{tx('请联系有插件运行权限的管理员处理。')}</small>}
          </nav>}
        </div></article>)}
      {!rows.length && <div className="ops-empty compact">{tx('当前没有失败流程')}</div>}
    </div>
    {selected?.type === 'run' && <FailureRunDialog key={selected.row.id} row={selected.row}
      onChanged={onChanged} onClose={() => setSelected(null)} />}
    {selected?.type === 'task' && <OperationsTaskDialog key={selected.row.taskId} taskId={selected.row.taskId}
      onClose={() => setSelected(null)} />}
  </>
}
