/*
 * Execution dashboard projects actual /ai-desks state for direct and workflow runs. Show
 * running work, blockers, and required intervention; executor is only a filter. Open real
 * terminals on demand rather than fabricating progress or polling for animation.
 */

let _dkPick = '__all__';          /* __all__ selects all executors; other values filter an agent. */
let _dkView = 'board';            /* board shows the overview; task shows one task's full execution narrative. */
let _dkPhase = 'all';             /* all / dispatching / running / waiting / failed / done */

const _DK_PHASE = {
  dispatching: { name: '正在确认', short: '确认中', cls: 'run' },
  running: { name: '正在执行', short: '运行中', cls: 'run' },
  waiting: { name: '待你处理', short: '待处理', cls: 'wait' },
  failed: { name: '异常需处理', short: '异常', cls: 'bad' },
  done: { name: '最近完成', short: '已完成', cls: 'done' },
};

function _dkTasksFor(d) {
  const all = _deskData.tasks || [];
  if (!d) return all;
  /*
   * Identify stations by stable backend keys, not display names, to separate identical
   * runtimes on different hosts. Fall back to names only for legacy data.
   */
  if (d.key) return all.filter(t => (t.deskKey || '') === d.key);
  return all.filter(t => t.agent === d.name);
}

function _dkFindTask(tid) {
  return (_deskData.tasks || []).find(x => x.id === tid) ||
    (_deskData.desks || []).flatMap(d => d.tasks || []).find(x => x.id === tid) || null;
}
