'use strict';
/*
 * Use production chat and draft recovery with minimal DOM doubles to simulate sidebar
 * switching and restoration.
 */

/* Minimal DOM implementation. */
class El {
  constructor(tag, id) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.id = id || '';
    this.children = [];
    this.parent = null;
    this.attrs = {};
    this.dataset = {};
    this.classes = new Set();
    this.value = '';
    this.hidden = false;
    this.style = {};
    this._listeners = {};
    this._html = '';
  }
  get classList() {
    const self = this;
    return {
      add: (...cs) => cs.forEach(c => self.classes.add(c)),
      remove: (...cs) => cs.forEach(c => self.classes.delete(c)),
      contains: c => self.classes.has(c),
      toggle: (c, on) => { (on === undefined ? !self.classes.has(c) : on) ? self.classes.add(c) : self.classes.delete(c); },
    };
  }
  set className(v) { this.classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get className() { return [...this.classes].join(' '); }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); }
  getAttribute(k) { return this.attrs[k] != null ? this.attrs[k] : null; }
  setAttributeNS(_, k, v) { this.setAttribute(k, v); }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  insertBefore(c, ref) { c.parent = this; const i = this.children.indexOf(ref); if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parent = null; return c; }
  replaceWith(next) { if (!this.parent) return; const i = this.parent.children.indexOf(this); if (i >= 0) this.parent.children[i] = next; next.parent = this.parent; }
  remove() { if (this.parent) this.parent.removeChild(this); }
  contains(n) { while (n) { if (n === this) return true; n = n.parent; } return false; }
  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
  removeEventListener() {}
  dispatchEvent(ev) {
    const list = (this._listeners[ev.type] || []).slice();
    list.forEach(fn => { try { fn.call(this, ev); } catch (e) { /* harness swallows */ } });
    return true;
  }
  focus() { global.document.activeElement = this; }
  blur() {}
  scrollIntoView() {}
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const out = [];
    const walk = (node) => {
      for (const c of node.children) {
        if (_matches(c, sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  get childElementCount() { return this.children.length; }
  get firstChild() { return this.children[0] || null; }
  get isConnected() { let n = this; while (n.parent) n = n.parent; return n === global.document.documentElement || n === global.document.body || !n.parent; }
  getBoundingClientRect() { return { left: 0, right: 800, top: 0, bottom: 600, width: 800, height: 600 }; }
}
function _matches(el, sel) {
  if (!el || el.tagName === '#text') return false;
  return sel.split(',').some(s => {
    s = s.trim();
    const id = s.match(/^#([\w-]+)$/);
    if (id) return el.id === id[1];
    const cls = s.match(/^\.([\w-]+)$/);
    if (cls) return el.classes.has(cls[1]);
    const tag = s.match(/^([\w-]+)$/);
    if (tag) return el.tagName === tag[1].toUpperCase();
    const tagId = s.match(/^([\w-]+)#([\w-]+)$/); // textarea#nchatInput
    if (tagId) return el.tagName === tagId[1].toUpperCase() && el.id === tagId[2];
    return false;
  });
}
/* Register IDs from assigned HTML so querySelector can resolve generated nodes. */
function defineInnerHTML() {
  Object.defineProperty(El.prototype, 'innerHTML', {
    configurable: true,
    set(html) {
      this.children = [];
      const VOID = new Set(['input', 'br', 'img', 'hr', 'meta', 'link']);
      const re = /<\/(\w+)>|<(\w+)((?:[^>"]|"[^"]*")*)>/g;
      const stack = [this];
      let m;
      while ((m = re.exec(html))) {
        if (m[1]) { // close
          for (let i = stack.length - 1; i > 0; i--) {
            if (stack[i].tagName === m[1].toUpperCase()) { stack.length = i; break; }
          }
          continue;
        }
        const tag = m[2].toLowerCase();
        const attrs = m[3] || '';
        const idM = attrs.match(/\sid="([\w-]+)"/);
        const clsM = attrs.match(/\sclass="([^"]*)"/);
        const node = new El(tag, idM ? idM[1] : '');
        if (clsM) node.className = clsM[1];
        stack[stack.length - 1].appendChild(node);
        if (!VOID.has(tag)) stack.push(node);
      }
    },
    get() { return this._html; },
  });
}

/* Global environment. */
function makeGlobals() {
  const registry = new Map();
  defineInnerHTML();
  const byId = (id) => { let hit = null; (function walk(n) { if (hit) return; for (const c of n.children) { if (c.id === id) { hit = c; return; } walk(c); } })(document.body); return hit; };
  const q = (sel) => { let hit = null; (function walk(n) { if (hit) return; for (const c of n.children) { if (_matches(c, sel)) { hit = c; return; } walk(c); } })(document.body); return hit; };
  const document = {
    body: new El('body'),
    documentElement: new El('html'),
    activeElement: null,
    getElementById: (id) => (id === 'body' ? document.body : byId(id)),
    querySelector: q,
    querySelectorAll: (sel) => { const out = []; (function walk(n) { for (const c of n.children) { if (_matches(c, sel)) out.push(c); walk(c); } })(document.body); return out; },
    createElement: (t) => new El(t),
    createTextNode: () => new El('#text'),
    addEventListener() {}, removeEventListener() {},
    visibilityState: 'visible',
    addEventListenerOnce() {},
  };
  // Provide the compose, chat, and input skeleton.
  const panel = new El('div', 'composePanel');
  const cpChat = new El('div', 'cpChat');
  panel.appendChild(cpChat);
  document.body.appendChild(panel);

  const storage = new Map();
  const storageApi = {
    getItem: k => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: k => storage.delete(k),
  };
  const g = {
    document, sessionStorage: storageApi, localStorage: storageApi,
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: fn => setTimeout(fn, 0),
    navigator: { language: 'zh-CN' },
    location: { href: 'app://test' },
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() {},
    CustomEvent: class { constructor(t, d) { this.type = t; this.detail = d && d.detail; } },
    Event: class { constructor(type, opts) { this.type = type; this.bubbles = Boolean(opts && opts.bubbles); } },
    innerWidth: 1440, innerHeight: 900,
    petSay() {},
    setTimeoutHack: setTimeout,
  };
  return { g, document, sessionStorage: storageApi, localStorage: storageApi };
}

/* Component doubles implementing required interfaces. */
function stubGlobals(g, opts) {
  const noop = () => {};
  const factory = (members) => () => members;
  g.ChatTaskController = { create: () => ({
    _collabState: null, _ensureCollabView: noop, _collabAction: noop, _openTaskPicker: noop,
    _selectCollabTask: noop, _loadCollabTask: async () => false, _loadCollabRun: noop,
    _scheduleCollabPoll: noop, _taskSnapshotIsStale: () => false, _isEmptyStalledSnapshot: () => false,
    _collabTerminal: () => false, _collabRunning: () => false, _collabStatus: () => '',
    _collabEntryStatus: () => '', _collabEntries: () => [], _collabQueueMode: () => 'serial',
    _collabProjectId: () => '', _setCollabEntryStatus: noop, _nextCollabEntry: () => null,
    _persistTaskBinding: noop, _bindCollaborationTask: noop, _restoreCollaboration: async () => {},
    _openTask: async () => true, _renderTaskStartPrompt: noop, _startTask: async () => true,
    _startTaskCommand: noop, enqueueTask: noop,
  }) };
  g.ChatMessageRenderer = { create: () => ({
    reset: noop, rich: s => String(s || ''), _richPlain: s => String(s || ''),
    CARET: '', _ensureHlCss: noop, _inject: noop, _blockHtml: () => '',
    _MCP_SAY: {}, _friendlyTool: () => '', _toolHtml: () => '', _render: () => {},
    _ctxText: () => '', _tokenText: () => '', _ctxHtml: () => '', _uiHtml: () => '',
  }) };
  g.ChatSendQueue = { create: () => ({ _queueRows: () => [], _renderQueue: noop, _queueAction: noop, _updateQueueOrder: noop, _cancelQueued: noop }) };
  g.ChatWorkIntent = { create: () => ({
    _chatDraftBridge: {}, _workModel: () => '', _workConversationContext: () => ({}),
    _openPluginDebug: noop, _openWorkAction: noop, _pickProposal: () => null,
    _maybeProposal: noop, _renderProposal: noop, _dismissProposal: noop, _proposalAction: noop,
  }) };
  g.ChatChrome = { reset: noop, resume: noop, sessionTitle: '', header: () => '',
    identify: noop, begin: noop, confirmHistory: noop, bind: noop, openSummary: noop,
    setWorkspace: noop, cancelPending: noop };
  g.ChatTools = { paintSendButton: noop, composerHasPayload: () => false };
  g.WorkComposer = { upgradeChat: node => node, replace: node => node };
  g.ComposeSkills = null;
  g.ChatPluginMention = null;
  g.ChatMateMention = null;
  g.ChatComposerControls = null;
  g.AccessControls = { destroy: noop };
  g.WorkIntent = { showGoal: noop, mount: () => ({ reset: noop }), rail: () => '', acceptanceItems: () => [] };
  g.SessionMemoryEntry = { clear: noop, set: noop };
  g.WorkspaceShell = {};
  g.ChatWorkbench = { reset: noop, bind: noop, syncAnnotations: noop };
  g.ChatWorkbenchAnnotations = { render: noop, detach: noop, bind: noop, syncAnnotations: noop, format: () => '' };
  g.ChatCollaborationStore = { remove: noop, removeTask: noop };
  g.PluginDebugCard = { close: noop, restore: noop };
  g.ComposeDraft = { clear: noop };
  g.ChatCollaboration = null;
  g.ChatOpening = null;
  g.SoduWorkI18n = { html: (k, d) => d };
  g.TaskPriority = { labels: { normal: '普通' }, descriptions: { normal: '' } };
  g.ComposeSelectionPosition = { position: noop };
  g.SoduWorkAPI = opts.api || {};
  g.soduWorkAPI = opts.piSession ? { piSession: opts.piSession } : { piSession: opts.api || {} };
  g.require = require;
  return g;
}

module.exports = { makeGlobals, stubGlobals, El };
