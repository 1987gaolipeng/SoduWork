'use strict';

const crypto = require('node:crypto');
const { redact } = require('./import-redaction');
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_EVENTS = 2000;
const MAX_TEXT = 6000;
const MAX_TOTAL = 600000;
const IMPORTER_VERSION = '3';
const SAFETY = Object.freeze({
  instructionsImported: false,
  commandsExecuted: false,
  attachmentsUploaded: false,
  credentialsRedacted: true,
});

function safeTime(value) {
  if (Number.isFinite(value)) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return String(value || '').slice(0, 40);
}

function sourceFormat(filename, source) {
  if (/\.(?:md|markdown)$/i.test(filename)) return 'markdown';
  if (/\.jsonl$/i.test(filename)) return 'jsonl';
  if (/\.json$/i.test(filename) || source.trimStart().startsWith('[')) return 'json';
  return 'jsonl';
}

function messageText(value, onAttachment) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map(block => {
    if (typeof block === 'string') return block;
    if (!block || typeof block !== 'object') return '';
    if (['text', 'input_text', 'output_text'].includes(block.type)) return String(block.text || '');
    if (['image', 'input_image', 'image_url', 'file', 'input_file'].includes(block.type)) {
      onAttachment?.(); return '[附件引用：未导入文件内容]';
    }
    return '';
  }).filter(Boolean).join('\n');
}

function parse(input, filename = '') {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(String(input || ''), 'utf8');
  if (!bytes.length || bytes.length > MAX_BYTES) throw Error('请选择非空且不超过 20 MB 的会话文件');
  let source;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''); }
  catch (_) { throw Error('文件不是 UTF-8 文本，请先导出为 UTF-8 会话文件'); }
  const warnings = new Set(), events = [];
  let sourceId = '', total = 0, rawCount = 0, trimmed = 0, attachmentCount = 0;
  let scannedCount = 0;
  function add(role, raw, at = '', extra = {}) {
    if (!['user', 'assistant', 'tool'].includes(role)) return;
    const content = String(raw || '').trim();
    if (!content) return;
    rawCount++;
    const clean = redact(content);
    if (clean !== content) warnings.add('已隐藏检测到的凭据和本机路径，请确认预览中没有其他敏感内容。');
    const text = clean.length > MAX_TEXT ? clean.slice(0, MAX_TEXT) + '\n[内容过长，已截取]' : clean;
    if (clean.length > MAX_TEXT) warnings.add('部分长消息已截取；原始文件保持不变。');
    const time = safeTime(at);
    events.push({ role, text, at: time, ...extra });
    total += text.length;
    while (events.length > MAX_EVENTS || total > MAX_TOTAL) {
      total -= events.shift().text.length;
      trimmed++;
    }
  }
  function response(payload, at) {
    if (!payload || typeof payload !== 'object') return;
    if (payload.type === 'message') {
      // System/developer instructions and hidden reasoning are not imported.
      if (!['analysis', 'reasoning'].includes(payload.channel)) add(payload.role, messageText(payload.content, () => attachmentCount++), at);
    } else if (['function_call', 'custom_tool_call'].includes(payload.type)) {
      const name = /^[a-zA-Z0-9_.:-]{1,120}$/.test(payload.name || '') ? payload.name : 'tool';
      add('tool', '[工具调用记录] ' + name, at,
        { kind: 'call', callId: String(payload.call_id || '').slice(0, 160) });
    } else if (['function_call_output', 'custom_tool_call_output'].includes(payload.type)) {
      add('tool', messageText(payload.output, () => attachmentCount++), at,
        { kind: 'result', callId: String(payload.call_id || '').slice(0, 160) });
    }
  }
  if (/\.(?:md|markdown)$/i.test(filename)) {
    let role = '', buffer = [], fence = '', markdownSections = 0;
    const flush = () => { add(role, buffer.join('\n')); buffer = []; };
    for (const line of source.split(/\r?\n/)) {
      const marker = /^\s*([~]{3,}|[\x60]{3,})/.exec(line);
      if (marker) {
        if (!fence) fence = marker[1];
        else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = '';
      }
      const match = !fence && /^#{1,6}\s+(User|Assistant|Codex|用户|助手)\s*[:：]?\s*$/i.exec(line);
      if (match) { flush(); role = /^(user|用户)$/i.test(match[1]) ? 'user' : 'assistant'; }
      else buffer.push(line);
    }
    flush();
    scannedCount = markdownSections;
    warnings.add('Markdown 仅识别 User / Assistant / Codex / 用户 / 助手标题，工具与附件不会执行或下载。');
  } else {
    let rows;
    const trimmedSource = source.trimStart();
    let jsonDocument = /\.json$/i.test(filename) || trimmedSource.startsWith('[');
    if (!jsonDocument && trimmedSource.startsWith('{')) {
      try {
        const candidate = JSON.parse(source);
        jsonDocument = Boolean(candidate && (Array.isArray(candidate.messages) || Array.isArray(candidate.events)));
      } catch (_) { /* A multi-line object may be JSONL; parse it below. */ }
    }
    if (jsonDocument) {
      let doc;
      try { doc = JSON.parse(source); } catch (_) { throw Error('JSON 文件格式不正确'); }
      if (Array.isArray(doc)) rows = doc;
      else if (doc && Array.isArray(doc.messages)) {
        sourceId = String(doc.sessionId || doc.session_id || doc.id || '').slice(0, 160);
        rows = doc.messages.map(m => ({ type: 'response_item', timestamp: m.timestamp,
          payload: { ...m, type: m.type || 'message' } }));
      } else if (doc && Array.isArray(doc.events)) rows = doc.events;
      else throw Error('不支持该 JSON 结构，请使用 Codex rollout JSONL 或包含 messages 的会话 JSON');
    } else {
      rows = [];
      const lines = source.split(/\r?\n/).filter(line => line.trim());
      for (let i = 0; i < lines.length; i++) {
        try { rows.push(JSON.parse(lines[i])); }
        catch (_) {
          if (i !== lines.length - 1) throw Error('会话文件第 ' + (i + 1) + ' 条记录损坏，未导入');
          warnings.add('忽略了文件末尾尚未写完的一条记录。');
        }
      }
    }
    const mirrored = new Map();
    for (const r of rows) if (r?.type === 'response_item' && r.payload?.type === 'message') {
      const key = r.payload.role + '\n' + messageText(r.payload.content).trim();
      mirrored.set(key, (mirrored.get(key) || 0) + 1);
    }
    scannedCount = rows.length;
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      if (row.type === 'session_meta') {
        const next = String(row.payload?.id || '').slice(0, 160);
        if (next && sourceId && next !== sourceId) throw Error('文件包含多个会话，请分别导入');
        sourceId = next || sourceId;
      } else if (row.type === 'response_item') response(row.payload, row.timestamp);
      else if (row.type === 'event_msg') {
        const p = row.payload || {};
        const role = p.type === 'user_message' ? 'user' : p.type === 'agent_message' ? 'assistant' : '';
        // Rollout mirrors messages as event_msg and response_item.
        const text = messageText(p.message), key = role + '\n' + text.trim();
        if (mirrored.get(key)) mirrored.set(key, mirrored.get(key) - 1);
        else if (role && !['analysis', 'reasoning'].includes(p.phase)) add(role, messageText(p.message, () => attachmentCount++), row.timestamp);
      } else if (['user', 'assistant'].includes(row.role) && !['analysis', 'reasoning'].includes(row.channel)) {
        add(row.role, messageText(row.content, () => attachmentCount++), row.timestamp);
      }
    }
  }
  if (attachmentCount) warnings.add('\u9644\u4ef6\u53ea\u4fdd\u7559\u5f15\u7528\uff0c\u672a\u4e0a\u4f20\u539f\u4ef6\u6216\u81ea\u52a8\u6267\u884c');
  if (!events.some(e => e.role === 'user' || e.role === 'assistant')) throw Error('文件中没有可导入的用户或助手消息');
  if (trimmed) warnings.add('长会话仅保留最近 ' + events.length + ' 条记录，共省略 ' + trimmed + ' 条。');
  const normalized = events.map((event, i) => ({ ...event, id: 'e' + (i + 1) }));
  const users = normalized.filter(e => e.role === 'user');
  const assistants = normalized.filter(e => e.role === 'assistant');
  const last = assistants.at(-1);
  const fields = { goal: users.at(-1)?.text.slice(0, 3000) || '',
    summary: last?.text.slice(0, 6000) || users.at(-1)?.text.slice(0, 6000) || '',
    decisions: '', constraints: '', pending: '', outcomes: '' };
  // Only explicit labels become draft structured fields; users review before saving.
  for (const event of assistants.slice(-5)) {
    const groups = { decisions: /^(?:决策|决定|已确认|Decision)/i, constraints: /^(?:约束|限制|Constraint)/i,
      pending: /^(?:待办|待确认|未完成|下一步|TODO|Next steps)/i, outcomes: /^(?:交付|产物|结果|Deliverable)/i };
    for (const line of event.text.split('\n')) {
      const text = line.replace(/^[#*\-\s]+/, '').replace(/\*\*/g, '');
      for (const [key, pattern] of Object.entries(groups)) if (pattern.test(text)) {
        fields[key] = (fields[key] + (fields[key] ? '\n' : '') + text).slice(0, 3000);
      }
    }
  }
  const format = sourceFormat(filename, source);
  const ignored = Math.max(0, scannedCount - rawCount);
  return { schema: 'soduwork.session-import.v1', source: 'codex', sourceSessionId: sourceId,
    sourceHash: crypto.createHash('sha256').update(bytes).digest('hex'),
    title: (users[0]?.text || 'Codex 导入会话').replace(/\s+/g, ' ').slice(0, 120),
    fields, events: normalized, warnings: [...warnings],
    stats: { retained: events.length, total: rawCount, scanned: scannedCount, ignored,
      omitted: trimmed, attachmentCount, bytes: bytes.byteLength },
    sourceMeta: { fileName: String(filename || '').split(/[\\/]/).pop().slice(0, 180),
      format, bytes: bytes.byteLength, retained: events.length, total: rawCount, scanned: scannedCount,
      ignored, omitted: trimmed, attachmentCount, security: SAFETY,
      importerVersion: IMPORTER_VERSION, importedAt: new Date().toISOString() },
    safety: SAFETY, summaryMethod: 'extractive-v3' };
}
module.exports = { parse, messageText, MAX_BYTES, MAX_EVENTS, MAX_TEXT, MAX_TOTAL, IMPORTER_VERSION, SAFETY };
