/*
 * Pure task synchronization shared by browsers and Node tests. Hub is authoritative;
 * retain pending per-task operations without inferring deletion from missing table
 * entries.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TaskSync = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CREATE_FIELDS = [
    'title', 'source', 'note', 'status', 'urgent', 'important', 'handler', 'result',
    'priority', 'start', 'due', 'actualStart', 'actualEnd', 'tags', 'assigneeUserId',
    'recur', 'recurAt', 'remindAt', 'reminded', 'domainId', 'progress', 'projectId', 'repoId',
    'requesterUserId', 'requesterName', 'requesterContact', 'deps',
    'workScenarioKey', 'workScenarioName', 'workRouting',
    'kind', 'acceptanceCriteria', 'triageStage', 'visibility'
  ];
  const UPDATE_FIELDS = CREATE_FIELDS.slice();
  const ARRAY_FIELDS = new Set(['tags', 'progress', 'deps', 'acceptanceCriteria']);
  const TIME_FIELDS = new Set(['start', 'due', 'actualStart', 'actualEnd', 'recurAt', 'remindAt']);
  const NULLABLE_FIELDS = new Set(['assigneeUserId', 'recur', 'projectId', 'requesterUserId']);

  function clone(value) {
    if (value == null || typeof value !== 'object') return value;
    return JSON.parse(JSON.stringify(value));
  }

  function normalise(field, value) {
    if (ARRAY_FIELDS.has(field)) return Array.isArray(value) ? clone(value) : [];
    if (TIME_FIELDS.has(field)) {
      if (value === '' || value == null) return null;
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }
    if (NULLABLE_FIELDS.has(field)) return value === '' || value == null ? null : value;
    return clone(value);
  }

  function same(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  function taskPayload(task) {
    const out = {};
    for (const field of CREATE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(task || {}, field)) {
        out[field] = normalise(field, task[field]);
      }
    }
    out.title = String(out.title || '未命名').slice(0, 200);
    out.source = String(out.source || '');
    out.note = String(out.note || '');
    out.status = out.status || 'todo';
    out.handler = out.handler || 'me';
    out.priority = out.priority || 'normal';
    return out;
  }

  function diffTask(serverTask, localTask) {
    const patch = {};
    for (const field of UPDATE_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(localTask || {}, field)) continue;
      const next = normalise(field, localTask[field]);
      const prev = normalise(field, serverTask && serverTask[field]);
      if (!same(prev, next)) patch[field] = next;
    }
    return patch;
  }

  function mergeOperation(previous, next) {
    if (!previous) return clone(next);
    if (previous.kind === 'put' && next.kind === 'patch') {
      return Object.assign({}, previous, { data: Object.assign({}, previous.data || {}, next.data || {}) });
    }
    if (previous.kind === 'put' && next.kind === 'delete') return null;
    if (previous.kind === 'patch' && next.kind === 'patch') {
      return Object.assign({}, previous, { data: Object.assign({}, previous.data || {}, next.data || {}) });
    }
    if (previous.kind === 'patch' && next.kind === 'delete') return clone(next);
    if (previous.kind === 'delete' && next.kind === 'put') return clone(next);
    return clone(next);
  }

  /* Rebuild the queued command from the user's current intent.  Accumulating
     patches is not enough when a field is changed and then changed back. */
  function reconcileOperation(previous, serverTask, localTask) {
    if (previous && previous.kind === 'delete') return clone(previous);
    const restored = previous?.restore ? { restore: true } : {};
    if (!serverTask) return Object.assign({ kind: 'put', data: taskPayload(localTask) }, restored);
    const data = diffTask(serverTask, localTask);
    if (!Object.keys(data).length && !previous?.restore) return null;
    if (previous && previous.kind === 'put') {
      return Object.assign({ kind: 'put', data: taskPayload(localTask) }, restored);
    }
    return { kind: 'patch', data };
  }

  function sameIntent(a, b) {
    if (!a || !b || a.kind !== b.kind) return false;
    return same(a.data || {}, b.data || {}) &&
      Number(a.notBefore || 0) === Number(b.notBefore || 0);
  }

  function compensatingPatch(inFlight, localTask) {
    if (!inFlight || inFlight.kind !== 'patch') return null;
    const payload = taskPayload(localTask);
    const data = {};
    for (const field of Object.keys(inFlight.data || {})) {
      if (Object.prototype.hasOwnProperty.call(payload, field)) data[field] = payload[field];
    }
    return Object.keys(data).length ? { kind: 'patch', data } : null;
  }

  function applyOperations(serverTasks, operations) {
    const rows = (serverTasks || []).map(clone);
    const byId = new Map(rows.map((task, index) => [task.id, index]));
    for (const op of operations || []) {
      if (!op || !op.id) continue;
      const index = byId.has(op.id) ? byId.get(op.id) : -1;
      if (op.kind === 'delete') {
        if (index >= 0) {
          rows.splice(index, 1);
          byId.clear();
          rows.forEach((task, i) => byId.set(task.id, i));
        }
        continue;
      }
      if (op.kind === 'put') {
        const task = Object.assign({ id: op.id, origin: 'local' }, clone(op.data || {}));
        if (index >= 0) rows[index] = Object.assign({}, rows[index], task);
        else rows.unshift(task);
      } else if (op.kind === 'patch' && index >= 0) {
        rows[index] = Object.assign({}, rows[index], clone(op.data || {}));
      }
      byId.clear();
      rows.forEach((task, i) => byId.set(task.id, i));
    }
    return rows;
  }

  // Saves acknowledge authoritative fields before the Hub builds its complete
  // live projection. Retain only matching display facts, never old permissions
  // or private execution fields from a broader former audience.
  function mergeSaveReceipt(previous, receipt) {
    const next = clone(receipt);
    if (!next?.projectionPending) return next;
    delete next.projectionPending;
    if (!previous || previous.id !== next.id) return next;
    const keep = key => {
      if (Object.prototype.hasOwnProperty.call(previous, key)) next[key] = clone(previous[key]);
    };
    if (previous.assigneeUserId === next.assigneeUserId) keep('assigneeName');
    if (previous.ownerClientId === next.ownerClientId) keep('executionDeviceName');
    if (previous.status === next.status && previous.reviewedAt === next.reviewedAt) {
      if (previous.triageStage === next.triageStage && previous.archivedAt === next.archivedAt) {
        keep('requirementStage');
        keep('reviewRejected');
      }
      if (next.canViewExecution && previous.ownerClientId === next.ownerClientId) keep('ai');
    }
    // An old block stays conservative until the complete event arrives.
    if (previous.maintenanceBlocked) {
      keep('maintenanceBlocked');
      keep('maintenanceBlockReason');
    }
    return next;
  }

  // Missing rows leave this projection only; they never create remote DELETEs.
  function reconcileSnapshot(target, incoming) {
    const byId = new Map(target.map(task => [task.id, task]));
    const next = incoming.map(task => {
      const previous = byId.get(task.id);
      return previous && same(previous, task) ? previous : task;
    });
    let changed = target.length !== next.length;
    for (let i = 0; i < next.length; i++) {
      if (target[i] !== next[i]) { target[i] = next[i]; changed = true; }
    }
    if (target.length > next.length) target.splice(next.length);
    return changed;
  }

  function applySnapshotEvents(snapshot, events) {
    const rows = new Map(snapshot.map(task => [task.id, task]));
    for (const event of events) {
      if (event.type === 'task.deleted') rows.delete(event.id);
      else if (event.task?.id) {
        const task = event.task;
        if (task.origin === 'automation' || task.source === '定时派活') rows.delete(task.id);
        else rows.set(task.id, task);
      }
    }
    return [...rows.values()];
  }

  return {
    CREATE_FIELDS,
    UPDATE_FIELDS,
    taskPayload,
    diffTask,
    mergeOperation,
    reconcileOperation,
    sameIntent,
    compensatingPatch,
    applyOperations,
    mergeSaveReceipt,
    reconcileSnapshot,
    applySnapshotEvents
  };
});
