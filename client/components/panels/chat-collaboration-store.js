/* Durable, non-sensitive index for tasks attached to one conversation. */
(function (global) {
  'use strict';

  const KEY = 'soduwork_work_collaboration_sessions_v1';
  const LIMIT = 32;
  const clean = (value, max) => String(value == null ? '' : value).trim().slice(0, max || 240);

  function taskFrom(value) {
    const source = value && typeof value === 'object' ? value : {};
    const taskId = clean(source.taskId || source.id, 120);
    if (!taskId) return null;
    return {
      taskId,
      title: clean(source.title || source.taskTitle, 200),
      status: clean(source.status, 40),
      adapterId: clean(source.adapterId, 40),
      model: clean(source.model, 120),
      locationMode: clean(source.locationMode, 20),
      agentName: clean(source.agentName, 120),
      runnerName: clean(source.runnerName, 120),
      projectName: clean(source.projectName, 160),
      branch: clean(source.branch, 160),
      projectId: clean(source.projectId || (source.project && source.project.id), 120),
      repoId: clean(source.repoId || (source.repo && source.repo.id), 120),
      strategy: clean(source.strategy || source.selectedStrategy, 24),
      workflowBindingId: clean(source.workflowBindingId || source.bindingId, 120),
      agentKind: clean(source.agentKind || source.selectedAgentKind, 40),
      queueMode: clean(source.queueMode, 20),
      updatedAt: Number(source.updatedAt || Date.now()) || Date.now(),
    };
  }

  function normalizeRecord(value) {
    const source = value && typeof value === 'object' ? value : {};
    const rows = [];
    const byId = new Map();
    const input = Array.isArray(source.tasks) ? source.tasks.slice() : [];
    if (!Array.isArray(source.tasks) && (source.taskId || source.id)) input.push(source);
    input.forEach((item) => {
      const row = taskFrom(item);
      if (!row) return;
      const old = byId.get(row.taskId);
      const merged = Object.assign({}, old || {}, row);
      if (old && !row.title) merged.title = old.title;
      byId.set(row.taskId, merged);
    });
    byId.forEach((row) => rows.push(row));
    rows.splice(LIMIT);
    let activeTaskId = clean(source.activeTaskId || source.taskId, 120);
    if (!activeTaskId || !rows.some((row) => row.taskId === activeTaskId)) {
      activeTaskId = rows.length ? rows[rows.length - 1].taskId : '';
    }
    const active = rows.find((row) => row.taskId === activeTaskId) || {};
    return {
      version: 2,
      tasks: rows,
      // Queue dismissal is separate from the task/history association. Keep it
      // outside the bounded metadata list so an old binding cannot resurrect it.
      removedQueueTaskIds: Array.from(new Set(
        (Array.isArray(source.removedQueueTaskIds) ? source.removedQueueTaskIds : [])
          .map(id => clean(id, 120)).filter(Boolean))),
      activeTaskId,
      taskId: activeTaskId,
      taskTitle: clean(active.title || source.taskTitle, 200),
      updatedAt: Number(source.updatedAt || Date.now()) || Date.now(),
    };
  }

  function read() {
    try {
      const raw = JSON.parse(global.localStorage.getItem(KEY) || '{}');
      if (!raw || typeof raw !== 'object') return {};
      const result = {};
      Object.keys(raw).forEach((conversationId) => {
        const record = normalizeRecord(raw[conversationId]);
        if (record.tasks.length || record.removedQueueTaskIds.length) result[conversationId] = record;
      });
      return result;
    } catch (_) {
      return {};
    }
  }

  function write(value) {
    try { global.localStorage.setItem(KEY, JSON.stringify(value || {})); return true; } catch (_) { return false; }
  }

  function publicRecord(conversationId, value) {
    const record = normalizeRecord(value);
    const active = record.tasks.find((row) => row.taskId === record.activeTaskId) || {};
    return Object.assign({ conversationId: clean(conversationId, 160) }, record, {
      taskId: record.activeTaskId,
      taskTitle: clean(active.title, 200),
      title: clean(active.title, 200),
      projectId: clean(active.projectId, 120),
      repoId: clean(active.repoId, 120),
    });
  }

  function get(conversationId) {
    const id = clean(conversationId, 160);
    if (!id) return null;
    const record = read()[id];
    return record && record.tasks.length ? publicRecord(id, record) : null;
  }

  function list(conversationId) {
    const record = get(conversationId);
    return record ? record.tasks.slice() : [];
  }

  function isQueueRemoved(conversationId, taskId) {
    const record = read()[clean(conversationId, 160)];
    return Boolean(record && record.removedQueueTaskIds.includes(clean(taskId, 120)));
  }

  function setQueueRemoved(conversationId, taskId, removed) {
    const id = clean(conversationId, 160), wanted = clean(taskId, 120);
    if (!id || !wanted) return false;
    const all = read(), record = normalizeRecord(all[id]);
    const ids = new Set(record.removedQueueTaskIds);
    if (removed) ids.add(wanted);
    else ids.delete(wanted); // Only an explicit send/re-add clears a dismissal.
    record.removedQueueTaskIds = Array.from(ids);
    record.updatedAt = Date.now();
    if (record.tasks.length || ids.size) all[id] = record;
    else delete all[id];
    return write(all);
  }

  function upsertTask(conversationId, value, options) {
    const id = clean(conversationId, 160);
    const row = taskFrom(value);
    if (!id || !row) return null;
    const all = read();
    const current = normalizeRecord(all[id]);
    const tasks = current.tasks.filter((item) => item.taskId !== row.taskId);
    const previous = current.tasks.find((item) => item.taskId === row.taskId);
    tasks.push(Object.assign({}, previous || {}, row));
    const next = normalizeRecord(Object.assign({}, current, {
      tasks: tasks.slice(-LIMIT),
      activeTaskId: options && options.active === false ? current.activeTaskId : row.taskId,
      updatedAt: Date.now(),
    }));
    all[id] = next;
    write(all);
    return publicRecord(id, next);
  }

  function bind(conversationId, value) {
    return upsertTask(conversationId, value, { active: !(value && value.active === false) });
  }

  function setActive(conversationId, taskId) {
    const id = clean(conversationId, 160);
    const wanted = clean(taskId, 120);
    if (!id || !wanted) return null;
    const all = read();
    const current = normalizeRecord(all[id]);
    if (!current.tasks.some((item) => item.taskId === wanted)) return publicRecord(id, current);
    current.activeTaskId = wanted;
    current.updatedAt = Date.now();
    all[id] = normalizeRecord(current);
    write(all);
    return publicRecord(id, all[id]);
  }

  function removeTask(conversationId, taskId) {
    const id = clean(conversationId, 160);
    const wanted = clean(taskId, 120);
    if (!id || !wanted) return null;
    const all = read();
    const current = normalizeRecord(all[id]);
    current.tasks = current.tasks.filter((item) => item.taskId !== wanted);
    current.activeTaskId = current.activeTaskId === wanted
      ? (current.tasks.length ? current.tasks[current.tasks.length - 1].taskId : '') : current.activeTaskId;
    if (current.tasks.length || current.removedQueueTaskIds.length) all[id] = normalizeRecord(current);
    else delete all[id];
    write(all);
    return current.tasks.length ? publicRecord(id, current) : null;
  }

  function findByTask(taskId) {
    const wanted = clean(taskId, 120);
    if (!wanted) return null;
    const all = read();
    for (const conversationId of Object.keys(all)) {
      const record = normalizeRecord(all[conversationId]);
      if (record.removedQueueTaskIds.includes(wanted)) continue;
      const row = record.tasks.find((item) => item.taskId === wanted);
      if (row) return Object.assign({ conversationId }, record, row, {
        taskId: row.taskId, taskTitle: row.title, title: row.title,
      });
    }
    return null;
  }

  function findByProject(projectId, options) {
    const wanted = clean(projectId, 120);
    if (!wanted) return null;
    const includeTerminal = Boolean(options && options.includeTerminal);
    const terminal = new Set(['completed', 'complete', 'done', 'delivered', 'failed',
      'blocked', 'stopped', 'cancelled', 'canceled', 'aborted']);
    const all = read();
    let best = null;
    Object.keys(all).forEach((conversationId) => {
      const record = normalizeRecord(all[conversationId]);
      record.tasks.forEach((row) => {
        if (record.removedQueueTaskIds.includes(row.taskId)) return;
        if (clean(row.projectId, 120) !== wanted) return;
        if (!includeTerminal && terminal.has(String(row.status || '').toLowerCase())) return;
        const candidate = Object.assign({ conversationId }, record, row, {
          taskId: row.taskId, taskTitle: row.title, title: row.title,
        });
        if (!best || Number(candidate.updatedAt || 0) >= Number(best.updatedAt || 0)) {
          best = candidate;
        }
      });
    });
    return best;
  }
  function remove(conversationId) {
    const id = clean(conversationId, 160);
    if (!id) return;
    const all = read();
    if (!Object.prototype.hasOwnProperty.call(all, id)) return;
    delete all[id];
    write(all);
  }

  global.ChatCollaborationStore = {
    get, list, bind, upsertTask, setActive, removeTask, findByTask, findByProject, remove,
    isQueueRemoved, setQueueRemoved,
  };
})(window);
