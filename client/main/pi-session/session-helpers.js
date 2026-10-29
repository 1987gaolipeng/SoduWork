/* Pure helpers shared by the Pi session loader and history projection. */
const path = require('path');

function entryCandidates(app) {
  const out = [];
  if (app && app.isPackaged) {
    out.push(path.join(require('../agent-runtime/process-context').current()?.resourcesPath || process.resourcesPath, 'pi', 'node_modules', '@earendil-works',
      'pi-coding-agent', 'dist', 'index.js'));
  }
  const clientRoot = path.dirname(path.dirname(__dirname));
  out.push(path.join(clientRoot, 'node_modules', '@earendil-works',
    'pi-coding-agent', 'dist', 'index.js'));
  if (process.env.APPDATA) {
    out.push(path.join(process.env.APPDATA, 'npm', 'node_modules',
      '@earendil-works', 'pi-coding-agent', 'dist', 'index.js'));
  }
  return out;
}

function explain(error) {
  const message = String((error && error.message) || error || '');
  if (message.includes('markAsUncloneable')) {
    return '\u0041\u0049 \u5bf9\u8bdd\u9700\u8981 Electron 35 \u6216\u66f4\u65b0\u7684\u7248\u672c\uff08\u5f53\u524d Node ' + process.versions.node +
      '\uff0cpi \u4f9d\u8d56\u7684 undici \u8981 Node 22 \u7684 API\uff09\u3002\u539f\u8bdd\uff1a' + message;
  }
  if (message.includes('Cannot find module') || message.includes('ERR_MODULE_NOT_FOUND')) {
    return '\u8fd9\u53f0\u673a\u5668\u4e0a\u6ca1\u627e\u5230 pi\uff08AI \u5bf9\u8bdd\u7684\u5185\u6838\uff09\u3002\u539f\u8bdd\uff1a' + message;
  }
  return '\u52a0\u8f7d AI \u5185\u6838\u5931\u8d25\uff1a' + message;
}

function lastAssistantText(snapshot) {
  const rows = snapshot && Array.isArray(snapshot.messages) ? snapshot.messages : [];
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const item = rows[index];
    if (!item || item.role !== 'assistant') continue;
    const text = (item.blocks || []).filter((block) => block && block.kind === 'text')
      .map((block) => String(block.text || '')).join('\n').trim();
    if (text) return text;
  }
  return '';
}

function visibleTitleText(value) {
  let text = String(value).trimEnd();
  const contexts = [require('./connector-context.cjs'), require('./plugin-context')];
  for (const context of contexts) {
    if (!text.endsWith(context.END)) continue;
    const start = text.lastIndexOf(context.START);
    if (start < 0 || (start > 0 && !/\r?\n\r?\n$/.test(text.slice(0, start)))) continue;
    try {
      const payload = JSON.parse(text.slice(start + context.START.length, -context.END.length));
      const internal = context === contexts[0] ? typeof payload?.runtimeGuide === 'string' :
        Array.isArray(payload?.plugins);
      if (internal) text = text.slice(0, start).trimEnd();
    } catch (_) { /* Literal tag examples are ordinary title text. */ }
  }
  return text;
}

function title(session) {
  const value = session || {};
  const raw = value.userTitle || value.customTitle || value.firstMessage || value.name;
  let text = '';
  if (typeof raw === 'string') text = raw;
  else if (Array.isArray(raw)) {
    text = raw.filter((item) => item && (item.type === 'text' || typeof item.text === 'string'))
      .map((item) => item.text || '').join(' ');
  } else if (raw && typeof raw === 'object') {
    text = String(raw.text || raw.content || raw.message || '');
  }
  // Clean only appended runtime envelopes in automatic titles, before truncation.
  // Explicit names and the original transcript remain untouched.
  if (!value.userTitle && !value.customTitle && value.firstMessage) text = visibleTitleText(text);
  text = String(text).replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 40) : '\u672a\u547d\u540d\u5bf9\u8bdd';
}

module.exports = { entryCandidates, explain, lastAssistantText, title };
