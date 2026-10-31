'use strict';

// Small, account-scoped durable outbox. It stores conversation text only; the
// short-lived Device session is intentionally never written to disk.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function create(file) {
  const target = path.resolve(String(file || ''));
  const root = path.dirname(target);
  let value = { version: 1, jobs: [], sessions: {} };

  function read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
      if (parsed && parsed.version === 1 && Array.isArray(parsed.jobs) &&
          parsed.sessions && typeof parsed.sessions === 'object' && !Array.isArray(parsed.sessions)) {
        value = { version: 1, jobs: parsed.jobs.slice(0, 100), sessions: { ...parsed.sessions } };
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw Error('跨端会话同步队列无法读取，请保留文件后重试');
    }
  }

  function write() {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const temporary = target + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
    fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    try { fs.renameSync(temporary, target); }
    catch (error) { try { fs.rmSync(temporary, { force: true }); } catch (_) {} throw error; }
  }

  read();
  return {
    jobs: () => value.jobs.map(item => ({ ...item, body: { ...(item.body || {}) } })),
    session: key => value.sessions[String(key)] ? { ...value.sessions[String(key)] } : null,
    setSession(key, state) {
      value.sessions[String(key)] = { ...state };
      write();
    },
    enqueue(job) {
      const next = { ...job, id: String(job.id || crypto.randomUUID()), body: { ...job.body },
        createdAt: Number(job.createdAt || Date.now()), attempts: Number(job.attempts || 0) };
      if (value.jobs.some(item => item.id === next.id)) return next;
      value.jobs.push(next);
      if (value.jobs.length > 100) value.jobs.splice(0, value.jobs.length - 100);
      write();
      return next;
    },
    ack(id) {
      const before = value.jobs.length;
      value.jobs = value.jobs.filter(item => item.id !== id);
      if (value.jobs.length !== before) write();
    },
    fail(id) {
      const item = value.jobs.find(row => row.id === id);
      if (!item) return;
      item.attempts = Number(item.attempts || 0) + 1;
      write();
    },
    clear() { value = { version: 1, jobs: [], sessions: {} }; write(); },
  };
}

module.exports = { create };
