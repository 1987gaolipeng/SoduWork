'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { replaceFileSync } = require('../verified-file-replace.cjs');
function createBindings(app, sessionId) {
  const root = app && typeof app.getPath === 'function' ? app.getPath('userData') : '';
  const file = root ? path.join(root, 'conversation-tasks', crypto.createHash('sha256').update(sessionId).digest('hex') + '.json') : '';
  let rows = [];
  try { if (file) rows = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
  if (!Array.isArray(rows)) rows = [];
  const view = () => ({ taskBindings: rows.slice(), taskIds: rows.map(x => x.taskId),
    taskId: rows.at(-1)?.taskId || '', activeTaskId: rows.at(-1)?.taskId || '',
    taskTitle: rows.at(-1)?.title || '', collaboration: Boolean(rows.length) });
  function bind(taskId, title) {
    const id = String(taskId || '').trim().slice(0, 120);
    if (!id) return { ok: false, reason: '没有指定任务' };
    const next = rows.filter(x => x.taskId !== id).concat({ taskId: id, title: String(title || '').slice(0, 200) });
    try {
      if (file) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const temporary = file + '.' + crypto.randomUUID() + '.tmp';
        try {
          fs.writeFileSync(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
          replaceFileSync(temporary, file);
        } finally { try { fs.unlinkSync(temporary); } catch (_) {} }
      }
      rows = next;
      return { ok: true, ...view() };
    } catch (_) { return { ok: false, reason: '任务关联无法保存，请检查本机工作目录权限' }; }
  }
  return { view, bind };
}
module.exports = { createBindings };
