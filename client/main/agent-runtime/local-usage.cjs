'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const values = require('./usage-values');
const { epoch } = require('../conversation/message-time');
const { OPAQUE_REFERENCE } = require('../pi-session/local-model-runtime-privacy.cjs');
const catalog = require('./runtime-catalog');
const labels = Object.freeze({
  chat: '对话', app: '应用', conversation_title: '生成对话标题', requirement: '需求', task: '需求执行', automation: '定时自动化', model_check: '模型检测',
});
const metrics = ['tokens', 'input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'requests', 'durationMs', 'costMicrousd'];
const dayMs = 86400000;
const dayOf = time => new Date(time + 8 * 3600000).toISOString().slice(0, 10);
const digest = parts => crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
function usageModelKey(ref) {
  if (OPAQUE_REFERENCE.test(ref)) return 'usage-' + digest(['model', ref]);
  return /^usage-[a-f0-9]{64}$/.test(ref) ? ref : '';
}

function scopeKey(identity) {
  if (!identity?.hub || !identity.clientId || !identity.accountScope) throw Error('Local usage identity unavailable');
  return digest([String(identity.hub).replace(/\/+$/, ''), identity.clientId, identity.accountScope]);
}

function fact(receipt) {
  if (receipt?.localOnly !== true || receipt.cumulative || receipt.quotaUsageToken ||
      !receipt.usage || typeof receipt.usage !== 'object') return null;
  const at = epoch(receipt.at);
  if (!at || at > Date.now() + dayMs) return null;
  // Unlabelled explicit Pi receipts predate sourceAgent. Runner per-call
  // receipts carry a frozen provider field. Older synthetic session totals
  // omitted it even when the entire session was stamped local after a switch.
  const agent = receipt.agent || 'pi';
  if (agent !== 'app-ai') {
    const runtime = catalog.runtime(agent);
    if (runtime?.modelMode !== 'managed' || runtime.transport === 'runner' &&
        (receipt.reportable !== false || !Object.hasOwn(receipt, 'provider'))) return null;
  }
  const raw = receipt.usage;
  const usage = values.empty();
  const openai = 'prompt_tokens' in raw || 'completion_tokens' in raw;
  values.add(usage, openai ? { ...raw, inputIncludesCache: true,
    cacheRead: raw.prompt_tokens_details?.cached_tokens ?? raw.cacheRead,
    reasoning: raw.completion_tokens_details?.reasoning_tokens ?? raw.reasoning } : raw);
  // Pi attaches zero-filled SDK counters even when a proven local call
  // failed before the provider returned its usage.
  const missingPiUsage = agent === 'pi' && !usage.total && !usage.requests && !usage.costKnown;
  if (missingPiUsage) usage.requests = 1;
  if (!(usage.total || usage.requests || usage.durationMs || usage.costMicrousd)) return null;
  const currency = /^[A-Z]{3}$/.test(raw.currency) ? raw.currency : 'USD';
  const modelRef = usageModelKey(receipt.model);
  const quality = missingPiUsage ? 'unknown'
    : ['reported', 'reconciled', 'estimated', 'unknown'].includes(raw.quality) ? raw.quality : 'reported';
  const counts = { ...usage, tokens: usage.total, costMicrousd: currency === 'USD' ? usage.costMicrousd : 0 };
  if (!metrics.every(key => Number.isSafeInteger(counts[key]) && counts[key] >= 0)) return null;
  return { at, agent, modelRef, currency, quality, known: usage.costKnown ? 1 : 0, counts: metrics.map(key => counts[key]) };
}

function access(file, fn) {
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  try {
    db.exec(`PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS receipts(
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, session TEXT NOT NULL, source TEXT NOT NULL,
        at INTEGER NOT NULL, day TEXT NOT NULL, agent TEXT NOT NULL, modelRef TEXT NOT NULL,
        currency TEXT NOT NULL, quality TEXT NOT NULL, known INTEGER NOT NULL,
        ${metrics.map(key => key + ' INTEGER NOT NULL').join(', ')}
      );
      CREATE INDEX IF NOT EXISTS receipts_scope_day ON receipts(scope, day);`);
    return fn(db);
  } finally { db.close(); }
}

function bucket(key, label, row = {}) {
  const item = { key, label, sessions: row.sessions || 0 };
  for (const metric of metrics) item[metric] = row[metric] || 0;
  return item;
}

function overview(db, scope, requestedDays) {
  const days = Math.max(1, Math.min(365, Math.floor(Number(requestedDays)) || 30));
  const now = Date.now();
  const first = dayOf(now - dayMs * (days - 1)), last = dayOf(now);
  const where = ' FROM receipts WHERE scope = ? AND day BETWEEN ? AND ?';
  const bounds = [scope, first, last];
  const totals = metrics.map(key => 'SUM(' + key + ') AS ' + key).concat('COUNT(DISTINCT session) AS sessions').join(', ');
  const group = (fields, order) => db.prepare('SELECT ' + fields + ', ' + totals + where +
    ' GROUP BY ' + fields + ' ORDER BY ' + order).all(...bounds);
  const summary = bucket('all', '全部用量', db.prepare('SELECT ' + totals + where).get(...bounds));
  const bySource = group('source', 'tokens DESC, source').map(row => bucket(row.source, labels[row.source], row));
  const byAgent = group('agent, modelRef', 'tokens DESC, agent, modelRef').map(row => ({
    ...bucket(row.agent + '|' + row.modelRef, row.agent, row), agent: row.agent, modelRef: row.modelRef,
    model: '本地模型', provider: '',
  }));
  const byDay = new Map(group('day', 'day').map(row => [row.day, row]));
  const trend = Array.from({ length: days }, (_, i) => {
    const key = dayOf(now - dayMs * (days - 1 - i));
    return bucket(key, key.slice(5), byDay.get(key));
  });
  const recent = db.prepare('SELECT *' + where + ' ORDER BY at DESC, id LIMIT 30').all(...bounds).map(row => ({
    id: row.id, sourceId: row.session, sourceType: row.source, sourceLabel: labels[row.source], title: labels[row.source],
    taskId: '', agent: row.agent, model: '本地模型', modelRef: row.modelRef, costKnown: Boolean(row.known),
    ...Object.fromEntries(metrics.map(key => [key,
      row.quality === 'unknown' && !row.tokens &&
      ['tokens', 'input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'].includes(key) ? null : row[key]])),
    currency: row.currency, quality: row.quality, occurredAt: new Date(row.at).toISOString(),
  }));
  const quality = { reported: 0, reconciled: 0, estimated: 0, unknown: 0 };
  for (const row of db.prepare('SELECT quality, COUNT(*) AS n' + where + ' GROUP BY quality').all(...bounds))
    quality[row.quality] = row.n;
  const costQuality = { ...db.prepare('SELECT COUNT(*) AS records, COUNT(*) FILTER (WHERE known=0) AS unknown,' +
    " COUNT(*) FILTER (WHERE currency<>'USD') AS otherCurrency" + where).get(...bounds), currency: 'USD' };
  quality.coveragePct = Math.round(100 * (quality.reported + quality.reconciled) / Math.max(1, costQuality.records));
  const agentNames = Object.fromEntries(byAgent.map(({ agent }) => [
    agent, agent === 'app-ai' ? '应用直接调用模型' : catalog.runtime(agent)?.displayName,
  ]));
  return { days, summary, bySource, byAgent, agentNames, trend, recent, quality, costQuality };
}

function createLocalUsage(app) {
  const file = path.join(app.getPath('userData'), 'device-model-usage', 'usage.sqlite');
  const previous = new WeakMap();
  function observe(handle, snapshot) {
    const receipts = snapshot?.usageReceipts;
    if (!handle?.sessionId || !Array.isArray(receipts) || !receipts.length ||
        handle.localReplica || snapshot.cloudHandoff?.phase === 'committed' || !handle.usageIdentity?.accountScope) return;
    try {
      const scope = scopeKey(handle.usageIdentity);
      const session = digest([handle.sessionId]);
      const prior = previous.get(handle);
      if (prior?.scope === scope && prior.session === session && prior.receipts === receipts) return;
      const source = Object.hasOwn(labels, handle.usageSourceType) ? handle.usageSourceType : handle.taskRef ? 'task' : 'chat';
      const occurrences = new Map(), ids = new Set(), rows = [];
      for (const receipt of receipts) {
        const row = fact(receipt);
        if (!row) continue;
        // Live and archive projections normalize to the same counters. The
        // ordinal distinguishes identical calls within a millisecond while a
        // clipped or replayed list cannot remove an already-recorded fact.
        const signature = JSON.stringify([row.at, row.agent, row.modelRef, row.counts]);
        const ordinal = occurrences.get(signature) || 0;
        occurrences.set(signature, ordinal + 1);
        const id = row.agent === 'app-ai' && typeof receipt.requestId === 'string' && receipt.requestId
          ? digest([session, 'app-ai', receipt.requestId]) : digest([session, signature, ordinal]);
        ids.add(id);
        if (prior?.scope === scope && prior.ids.has(id)) continue;
        rows.push([id, scope, session, source, row.at, dayOf(row.at), row.agent, row.modelRef,
          row.currency, row.quality, row.known, ...row.counts]);
      }
      if (rows.length) access(file, db => {
        db.exec('BEGIN IMMEDIATE');
        const insert = db.prepare('INSERT OR IGNORE INTO receipts VALUES (' + rows[0].map(() => '?').join(',') + ')');
        for (const row of rows) insert.run(...row);
        db.exec('COMMIT');
      });
      previous.set(handle, { scope, session, receipts, ids });
    } catch (_) { console.warn('[usage] Device usage could not be saved'); }
  }
  const recoveredScopes = new Set();
  function recoverRunnerReceipts(identity) {
    const root = app.getPath('userData');
    const folder = path.join(root, 'runner', 'data', 'local-runs');
    const { assertNoLinks } = require('../plugin-resources');
    const { read: readMetadata } = require('../conversation/metadata-snapshot.cjs');
    const history = require('../conversation/history-access');
    const hub = new URL(identity.hub).origin;
    let entries;
    try {
      assertNoLinks(root, folder);
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('[usage] Runner archives unavailable');
      return;
    }
    for (const entry of entries) {
      const ref = entry.name;
      if (!entry.isDirectory() || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(ref)) continue;
      try {
        const archive = JSON.parse(readMetadata(root, path.join(folder, ref, 'meta.json')).bytes);
        // Old receipts froze funding but not the account making each turn.
        // Only an original local chat dispatch can use its creator's binding.
        if (archive.ref !== ref || archive.eventDestination !== 'local' || archive.round !== 1 ||
            archive.admissionKey !== 'dispatch:' + ref || !archive.taskId?.startsWith('chat-') ||
            !archive.usageReceipts?.some(receipt => receipt?.localOnly === true && receipt.agent === archive.cli)) continue;
        const row = { id: ref, nativeHistory: true };
        const local = history.classifyLocal(app, ref, row);
        if (local.kind !== 'ordinary' || local.ids.length !== 1) continue;
        const { records, legacy } = local.ownership(ref);
        const owners = records.concat(legacy || []);
        if (!owners.some(record => record.hub === hub) ||
            owners.some(record => record.owner !== identity.accountScope || (record.hub && record.hub !== hub))) continue;
        observe({ sessionId: ref, usageIdentity: identity }, {
          usageReceipts: archive.usageReceipts.filter(receipt => receipt?.agent === archive.cli),
        });
      } catch (_) { /* An incomplete or unverifiable archive cannot establish usage. */ }
    }
  }
  function read(identity, days) {
    const scope = scopeKey(identity);
    if (!recoveredScopes.has(scope)) {
      recoverRunnerReceipts(identity);
      recoveredScopes.add(scope);
    }
    return access(file, db => {
      db.exec('BEGIN');
      const report = overview(db, scope, days);
      db.exec('COMMIT');
      return report;
    });
  }
  return { observe, read };
}

module.exports = { createLocalUsage, usageModelKey };
