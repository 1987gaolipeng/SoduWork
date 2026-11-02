'use strict';

// Runtime placeholders are presentation fallbacks, never conversation names.
// Explicit user renames remain authoritative in conversation/titles.decorate.
const helpers = require('../pi-session/session-helpers');
const history = require('../pi-session/history-state');
const catalog = require('../agent-runtime/runtime-catalog');

function resolve(value, snapshot) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const placeholder = !text || ['新对话', '未命名对话', 'Agent 工作会话'].includes(text) ||
    catalog.runtimes().some(runtime => text === runtime.displayName + ' 工作会话');
  if (!placeholder) return helpers.repairPersistedTitle(text);
  return history.messageTitle(snapshot) || '';
}

module.exports = { resolve };
