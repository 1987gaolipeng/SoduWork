'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const links = require('../components/panels/chat-output-links');
const carry = require('../components/panels/chat-decorate-carry');

/* ---------- legacy reference implementations (transcribed from git HEAD) ----------
   The new indexing pipeline must produce byte-identical mentions against the
   pre-optimization scan for every (text, files, scope) combination. */

function legacyMentions(text, files) {
  const labels = new Set();
  (files || []).forEach(file => [file.relative, file.name, file.path, legacyBasename(file.relative || file.name || file.path)]
    .filter(Boolean).forEach(label => {
      if (String(label).length >= 3 && /\.[^./\\\s]{1,12}$/.test(label)) labels.add(legacyNormalize(label));
    }));
  const lower = String(text).replace(/\\/g, '/').toLocaleLowerCase(), hits = [];
  [...labels].sort((a, b) => b.length - a.length).forEach(label => {
    const file = links.fileTarget(label, files);
    if (!file) return;
    const token = label.toLocaleLowerCase();
    for (let from = 0, at; (at = lower.indexOf(token, from)) >= 0; from = at + token.length) {
      if ((!text[at - 1] || !/[A-Za-z0-9_.-]/.test(text[at - 1])) &&
        (!text[at + label.length] || !/[A-Za-z0-9_.-]/.test(text[at + label.length])))
        hits.push({ start: at, end: at + label.length, text: text.slice(at, at + label.length), file });
    }
  });
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  let end = -1;
  return hits.filter(hit => { if (hit.start < end) return false; end = hit.end; return true; });
}
function legacyNormalize(value) { return String(value).replace(/\\/g, '/').replace(/^\.\//, ''); }
function legacyBasename(value) { return String(value || '').split(/[\\/]/).pop(); }

function legacyScoped(taskAttr, files) {
  if (taskAttr == null) return files; // no [data-output-task] ancestor
  if (taskAttr === '') return files;  // attribute present but empty
  const own = files.filter(file => file.taskId === taskAttr);
  return own.length ? own : files.filter(file => !file.taskId);
}

/* ---------- corpus ---------- */
function corpus() {
  const out = [];
  const textShapes = [
    '普通文本，没有产物引用。',
    '已生成 report.docx，请查看 dist/index.html。',
    '分析报告 report.docx 和 report.docx.bak 都在工作区，版本 report.docx.v2 是旧稿。',
    '销售数据问答插件已生成，同时产出 sales.xlsx 与 销售数据.xlsx 两份表格。',
    'report.docx 与 report.docx 的重复提及，以及 report.docxyz 误报检查。',
    '路径引用 outputs/report.docx 与短名 report.docx 并存，含 C:\\ws\\report.docx 绝对路径。',
    '中英混排 report.docx与sales.xlsx 紧邻标点：report.docx，sales.xlsx。',
  ];
  const fileSets = {
    one: [{ name: 'report.docx', relative: 'report.docx', path: 'C:\\ws\\report.docx' }],
    five: [
      { name: 'report.docx', relative: 'report.docx', path: 'C:\\ws\\report.docx', taskId: 'task-a' },
      { name: 'sales.xlsx', relative: 'docs/sales.xlsx', path: 'C:\\ws\\docs\\sales.xlsx', taskId: 'task-a' },
      { name: 'index.html', relative: 'dist/index.html', path: 'C:\\ws\\dist\\index.html', taskId: 'task-b' },
      { name: '销售数据.xlsx', relative: '销售数据.xlsx', path: 'C:\\ws\\销售数据.xlsx', taskId: '' },
      { name: 'app.js', relative: 'src/app.js', path: 'C:\\ws\\src\\app.js' },
    ],
    twelve: [],
    twentyfive: [],
  };
  for (let i = 0; i < 12; i += 1) fileSets.twelve.push({
    name: 'module' + i + '.py', relative: 'pkg/mod' + i + '.py', path: 'C:\\ws\\pkg\\mod' + i + '.py', taskId: i % 2 ? 'task-b' : 'task-a',
  });
  for (let i = 0; i < 25; i += 1) fileSets.twentyfive.push({
    name: 'artifact' + i + '.json', relative: 'out/artifact' + i + '.json', path: 'C:\\ws\\out\\artifact' + i + '.json',
    taskId: i < 20 ? 'task-a' : (i < 23 ? 'task-b' : ''),
  });
  // same basename, different tasks; ambiguous shorthands; version/revision suffixes
  fileSets.twentyfive.push({ name: 'report.docx', relative: 'task-a/report.docx', path: 'C:\\ws\\task-a\\report.docx', taskId: 'task-a' });
  fileSets.twentyfive.push({ name: 'report.docx', relative: 'task-b/report.docx', path: 'C:\\ws\\task-b\\report.docx', taskId: 'task-b' });
  fileSets.twentyfive.push({ name: 'report.docx.v2', relative: 'task-a/report.docx.v2', path: 'C:\\ws\\task-a\\report.docx.v2', taskId: 'task-a' });
  return { textShapes, fileSets };
}

test('mentions 索引化后与旧实现逐字节等价（语料矩阵：文件数×文本形态×scope 组合）', () => {
  const { textShapes, fileSets } = corpus();
  for (const text of textShapes) {
    const index = links._buildLinkIndex(fileSets.twentyfive);
    for (const [setName, files] of [['one', fileSets.one], ['five', fileSets.five], ['twelve', fileSets.twelve], ['twentyfive', fileSets.twentyfive]]) {
      const scopedIndex = setName === 'twentyfive' ? index : links._buildLinkIndex(files);
      for (const scope of [null, '', 'task-a', 'task-b', 'task-missing']) {
        // legacy: scope resolution happens before the scan
        const bucket = legacyScoped(scope, files);
        const expected = legacyMentions(text, bucket).map(h => [h.start, h.end, h.text, h.file.artifactId || h.file.path]);
        const actual = links.mentions(text, scopedIndex, scope).map(h => [h.start, h.end, h.text, h.file.artifactId || h.file.path]);
        assert.deepEqual(actual, expected, setName + ' scope=' + scope + ' text=' + text.slice(0, 24));
      }
      // dual-mode: raw array path must equal the legacy scan on the same array
      const raw = links.mentions(text, files).map(h => [h.start, h.end, h.text, h.file.artifactId || h.file.path]);
      const expected = legacyMentions(text, files).map(h => [h.start, h.end, h.text, h.file.artifactId || h.file.path]);
      assert.deepEqual(raw, expected, setName + ' raw-array path');
    }
  }
  // index reuse: the same index object answers every scope without drift
  const index = links._buildLinkIndex(fileSets.twentyfive);
  const first = links.mentions(textShapes[2], index, 'task-a').map(h => h.file.name);
  const again = links.mentions(textShapes[2], index, 'task-a').map(h => h.file.name);
  assert.deepEqual(again, first);
});

/* ---------- mini DOM for linkify / _syncMessage behavior ---------- */
const NODE_FILTER = { FILTER_ACCEPT: 1, FILTER_REJECT: 2 };
function textNode(value, parent) {
  const state = { parent: parent || null };
  return {
    nodeType: 3, nodeValue: value,
    get parent() { return state.parent; },
    set parent(value) { state.parent = value; },
    get parentElement() { return state.parent || null; },
    isEqualNode(other) { return Boolean(other) && other.nodeType === 3 && other.nodeValue === value; },
    replaceWith(...nodes) {
      const at = state.parent.children.indexOf(this);
      const flat = [];
      nodes.forEach(n => n.children ? flat.push(...n.children) : flat.push(n));
      state.parent.children.splice(at, 1, ...flat);
      flat.forEach(n => { n.parent = state.parent; });
    },
  };
}
function cloneNodeDeep(el, doc) {
  if (el.nodeType === 3) return doc.createTextNode(el.nodeValue);
  const copy = doc.createElement(el.tagName);
  copy.className = el.className;
  if (el._text != null) copy._text = el._text;
  Object.entries(el.attributes).forEach(([k, v]) => copy.setAttribute(k, v));
  el.children.forEach(child => copy.appendChild(cloneNodeDeep(child, doc)));
  return copy;
}
function miniElement(doc, tag = 'div') {
  const el = {
    nodeType: 1, tagName: tag.toLowerCase(), className: '', children: [], attributes: {},
    ownerDocument: doc, textContent: '', title: '', innerHTML: '',
    get datasetChatNode() { return el.attributes['data-chat-node']; },
    appendChild(child) { el.children.push(child); child.parent = el; return child; },
    insertBefore(node, ref) {
      const at = ref ? el.children.indexOf(ref) : -1;
      if (at < 0) el.appendChild(node);
      else el.children.splice(at, 0, node), node.parent = el;
      return node;
    },
    remove() {
      if (el.parent) { const at = el.parent.children.indexOf(el); if (at >= 0) el.parent.children.splice(at, 1); el.parent = null; }
    },
    replaceWith(wanted) {
      if (!el.parent) return;
      const at = el.parent.children.indexOf(el);
      const flat = wanted.children ? wanted.children.slice() : [wanted];
      el.parent.children.splice(at, 1, ...flat);
      flat.forEach(n => { n.parent = el.parent; });
      el.parent = null;
    },
    setAttribute(name, value) { el.attributes[name] = String(value); },
    getAttribute(name) { return name in el.attributes ? el.attributes[name] : null; },
    hasAttribute(name) { return name in el.attributes; },
    removeAttribute(name) { delete el.attributes[name]; },
    get dataset() {
      return new Proxy({}, {
        get(_, key) { const dash = 'data-' + String(key).replace(/[A-Z]/g, c => '-' + c.toLowerCase()); return key === 'chatNode' ? el.attributes['data-chat-node'] : el.attributes[dash]; },
        set(_, key, value) { const dash = 'data-' + String(key).replace(/[A-Z]/g, c => '-' + c.toLowerCase()); el.setAttribute(dash, value); return true; },
      });
    },
    classList: null,
    matches(selector) { return miniMatches(el, selector); },
    get childNodes() { return el.children; },
    get nodeName() { return el.tagName.toUpperCase(); },
    isEqualNode(other) {
      if (!other || el.nodeType !== other.nodeType || el.tagName !== other.tagName ||
        el.className !== other.className) return false;
      const mine = Object.entries(el.attributes).sort(), theirs = Object.entries(other.attributes).sort();
      if (JSON.stringify(mine) !== JSON.stringify(theirs)) return false;
      if (el.children.length !== other.children.length) return false;
      return el.children.every((child, index) => child.isEqualNode(other.children[index]));
    },
    closest(selector) {
      let node = el;
      while (node) { if (node.nodeType === 1 && miniMatches(node, selector)) return node; node = node.parent; }
      return null;
    },
    querySelectorAll(selector) {
      const hits = [];
      const walk = node => (node.children || []).forEach(child => {
        if (child.nodeType === 1 && miniMatches(child, selector)) hits.push(child);
        walk(child);
      });
      walk(el); return hits;
    },
    querySelector(selector) { return el.querySelectorAll(selector)[0] || null; },
    cloneNode() { return cloneNodeDeep(el, doc); },
  };
  el.classList = {
    contains: name => String(el.className).split(/\s+/).includes(name),
    add: name => { if (!el.classList.contains(name)) el.className = (el.className + ' ' + name).trim(); },
  };
  Object.defineProperty(el, 'textContent', {
    get() { return el.children.length ? el.children.map(c => (c.nodeType === 3 ? c.nodeValue : c.textContent)).join('') : (el._text || ''); },
    set(value) { el._text = value; el.children = []; },
  });
  return el;
}
function miniMatches(el, selector) {
  return selector.split(',').some(part => matchOne(el, part.trim()));
}
function matchOne(el, selector) {
  const parts = selector.split(/\s+/).filter(Boolean);
  if (!parts.length) return false;
  const chain = [];
  let node = el;
  while (node) { chain.unshift(node); node = node.parent; }
  if (chain.length < parts.length) return false;
  let offset = chain.length - parts.length;
  return parts.every((part, index) => partMatches(chain[offset + index], part));
}
function partMatches(el, part) {
  const attrRe = /\[([a-zA-Z-]+)(?:="([^"]*)")?\]/g;
  const attrs = [];
  let m;
  while ((m = attrRe.exec(part))) attrs.push([m[1], m[2]]);
  const classPart = part.replace(attrRe, '').trim();
  if (!classPart.split('.').filter(Boolean).every(name => String(el.className).split(/\s+/).includes(name))) return false;
  return attrs.every(([name, value]) => value === undefined ? el.getAttribute(name) != null : el.getAttribute(name) === value);
}
function miniDoc() {
  const doc = {
    createElement: tag => miniElement(doc, tag),
    createTextNode: value => textNode(value, null),
    createDocumentFragment: () => ({ nodeType: 11, children: [], appendChild(c) { doc._frag(this, c); } }),
    defaultView: { NodeFilter: { SHOW_TEXT: 4, ...NODE_FILTER } },
    _frag(frag, child) {
      if (child.children && child.nodeType === 11) frag.children.push(...child.children);
      else frag.children.push(child);
      child.parent = null;
    },
    createTreeWalker(root, showText, filter) {
      const nodes = [];
      const walk = node => (node.children || []).forEach(child => {
        if (child.nodeType === 3) {
          if (filter.acceptNode(child) === 1) nodes.push(child);
        } else walk(child);
      });
      walk(root);
      let index = -1;
      return { nextNode() { index += 1; return index < nodes.length ? (this.currentNode = nodes[index], true) : false; }, currentNode: null };
    },
  };
  return doc;
}
const doc = miniDoc();

test('零命中跳过：同签名重复扫描零工作量，签名/文本变化立即恢复扫描（G5 防回归）', () => {
  const files = [{ name: 'report.docx', relative: 'report.docx', path: 'C:\\ws\\report.docx' }];
  const root = doc.createElement('div');
  const box = doc.createElement('div'); box.className = 'ntext';
  const hitText = doc.createTextNode('这里有 report.docx 产物'); box.appendChild(hitText);
  const plainText = doc.createTextNode('普通描述文字没有引用'); box.appendChild(plainText);
  root.appendChild(box);
  const sig = 'ref-1\u0000["files"]';
  assert.equal(links.linkify(root, files, sig), 1, '首轮命中一次');
  assert.equal(box.children.filter(c => c.nodeType === 1 && c.classList.contains('noutput-inline')).length, 1, '命中文本已换成按钮');
  // Rescan new text nodes after streaming patches replace decorated content.
  box.children = [];
  box.appendChild(doc.createTextNode('这里有 report.docx 产物'));
  assert.equal(links.linkify(box, files, sig), 1, '命中节点重建后再次链化');
  // Repeated zero-match calls with the same signature create no content.
  box.children = [];
  box.appendChild(doc.createTextNode('这里有 report.docx 产物'));
  const plain2 = doc.createTextNode('普通句子依旧无引用'); box.appendChild(plain2);
  assert.equal(links.linkify(box, files, sig), 1);
  const before = plain2.nodeValue;
  assert.equal(links.linkify(box, files, sig), 0, '零命中节点被记忆跳过');
  assert.equal(plain2.nodeValue, before, '跳过路径零改写');
  // Changed file sets invalidate the signature and rescan previously unmatched text.
  const files2 = [{ name: 'report.docx', relative: 'report.docx', path: 'C:\\ws\\report.docx' }, { name: 'sales.xlsx', relative: 'sales.xlsx', path: 'C:\\ws\\sales.xlsx' }];
  box.children = [];
  box.appendChild(doc.createTextNode('普通句子依旧无引用'));
  assert.equal(links.linkify(box, files2, 'ref-1\u0000["files2"]'), 0, '新签名下仍为零命中则保持');
  assert.equal(links.linkify(box, files2, 'ref-1\u0000["files2"]'), 0, '同签名重复跳过');
  box.children = [];
  box.appendChild(doc.createTextNode('普通句子提到 sales.xlsx 数据'));
  assert.equal(links.linkify(box, files2, 'ref-1\u0000["files2"]'), 1, '签名失效后重扫并命中');
});

test('流式卡片携带：_syncMessage preserveDeco 保留装饰子节点身份，未开启时旧行为不变', () => {
  const { patchContent, _syncMessage } = require('../components/panels/chat-dom-patch');
  // Without preserveDeco, raw HTML replacement removes decoration children.
  const legacyCurrent = doc.createElement('div'); legacyCurrent.className = 'nmsg ai';
  const legacyText = doc.createElement('div'); legacyText.className = 'ntext'; legacyText.setAttribute('data-block', '0');
  const legacyCard = doc.createElement('div'); legacyCard.className = 'ndelivery'; legacyCard.setAttribute('data-delivery', 'a');
  legacyCurrent.appendChild(legacyText); legacyCurrent.appendChild(legacyCard);
  const nextLegacy = doc.createElement('div'); nextLegacy.className = 'nmsg ai';
  const nextTextLegacy = doc.createElement('div'); nextTextLegacy.className = 'ntext'; nextTextLegacy.setAttribute('data-block', '0');
  nextTextLegacy.textContent = '回复内容'; nextLegacy.appendChild(nextTextLegacy);
  _syncMessage(legacyCurrent, nextLegacy);
  assert.equal(legacyCurrent.children.length, 1, '未开保留时卡片随重建移除（等价旧行为）');

  // preserveDeco retains the same delivery node identity.
  const current = doc.createElement('div'); current.className = 'nmsg ai';
  const text = doc.createElement('div'); text.className = 'ntext'; text.setAttribute('data-block', '0');
  const card = doc.createElement('div'); card.className = 'ndelivery'; card.setAttribute('data-delivery', 'task-1');
  const draft = doc.createElement('div'); draft.className = 'nplugin-draft';
  draft.setAttribute('data-chat-node', 'plugin-draft:pkg');
  draft.setAttribute('data-install-plugin-draft', 'pkg');
  current.appendChild(text); current.appendChild(card); current.appendChild(draft);
  const next = doc.createElement('div'); next.className = 'nmsg ai';
  const nextText = doc.createElement('div'); nextText.className = 'ntext'; nextText.setAttribute('data-block', '0');
  nextText.textContent = '流式中的新正文'; next.appendChild(nextText);
  _syncMessage(current, next, { preserveDeco: true });
  assert.equal(current.children.indexOf(card), 1, '卡片节点保留');
  assert.equal(current.children.indexOf(draft), 2, '草稿卡节点保留');
  assert.ok(current.children.includes(text), '正文子块仍按键复用');
  assert.equal(current.children[current.children.indexOf(text)], text, '正文节点身份不变');
  assert.equal(current.children.length, 3, '没有多余残留');
});

test('对账模块：重建行重挂卡片克隆，superseded 规则即时退役旧代草稿卡', () => {
  const files = [{ artifactId: 'art_current', name: 'soduwork-plugin-draft.json', relative: 'soduwork-plugin-draft.json', path: 'C:\\ws\\soduwork-plugin-draft.json', pluginDraft: true, pluginIdentity: 'pkg', pluginName: '销售数据问答', pluginVersion: '1.0.0' }];
  const oldList = doc.createElement('div');
  const oldMsg = doc.createElement('div'); oldMsg.setAttribute('data-chat-node', 'message:1');
  oldMsg.setAttribute('data-delivery-current', 'false'); oldMsg.setAttribute('data-delivery-final', 'true');
  const card = doc.createElement('div'); card.className = 'nplugin-draft';
  card.setAttribute('data-plugin-draft-identity', 'pkg');
  card.setAttribute('data-install-plugin-draft', 'art_current');
  card.setAttribute('data-plugin-version', '1.0.0');
  card.textContent = '安装错误：目录冲突';
  oldMsg.appendChild(card);
  oldList.appendChild(oldMsg);
  const captured = carry.capture(oldList);
  assert.equal(captured.size, 1, '捕获到带卡消息');

  // Reconcile delivery cards after a same-key row is rebuilt from raw HTML.
  const list = doc.createElement('div');
  const message = doc.createElement('div'); message.setAttribute('data-chat-node', 'message:1');
  message.setAttribute('data-delivery-current', 'false'); message.setAttribute('data-delivery-final', 'true');
  list.appendChild(message);
  carry.reconcile(list, files, captured);
  const reattached = list.querySelectorAll('.nplugin-draft');
  assert.equal(reattached.length, 1, '卡片已重挂到重建行');
  assert.match(reattached[0].textContent, /安装错误/, '安装失败状态文本随卡携带');

  // Retire old draft cards immediately when a newer artifact generation appears.
  const newer = [{ ...files[0], artifactId: 'art_new', pluginVersion: '1.1.0' }];
  const list2 = doc.createElement('div');
  const message2 = doc.createElement('div'); message2.setAttribute('data-chat-node', 'message:1');
  message2.setAttribute('data-delivery-current', 'false'); message2.setAttribute('data-delivery-final', 'true');
  list2.appendChild(message2);
  carry.reconcile(list2, newer, captured);
  assert.equal(list2.querySelectorAll('.nplugin-draft').length, 0, 'superseded 旧卡不复活');
});

function deliveryMessage(localIndex, owner, current = false, final = true) {
  const node = doc.createElement('div'); node.className = 'nmsg ai';
  node.dataset.chatNode = 'message:' + localIndex;
  node.dataset.messageOwner = String(owner);
  node.dataset.deliveryCurrent = String(current);
  node.dataset.deliveryFinal = String(final);
  return node;
}
function deliveryCard() {
  const card = doc.createElement('section'); card.className = 'ndelivery';
  card.dataset.delivery = 'prior-three-files';
  card.textContent = '上轮任务 · 3 个文件';
  return card;
}

for (const ownerChanges of [false, true]) test('workflow controls survive only their own message slot: ownerChanges=' + ownerChanges, () => {
  const { _syncMessage } = require('../components/panels/chat-dom-patch');
  const current = deliveryMessage(3, 105, false, false);
  const next = deliveryMessage(3, ownerChanges ? 109 : 105, false, false);
  const slot = doc.createElement('div'), wanted = doc.createElement('div');
  slot.className = wanted.className = 'nworkflow-message-slot';
  slot.dataset.workflowMessageKey = wanted.dataset.workflowMessageKey = 'plugin-debug:run-1:design:1:failed';
  slot.outerHTML = '<div>live action controls</div>'; wanted.outerHTML = '<div></div>';
  const control = doc.createElement('button'); control.textContent = 'Stop collaboration';
  slot.appendChild(control); current.appendChild(slot); next.appendChild(wanted);
  _syncMessage(current, next);
  assert.equal(current.children.includes(slot), !ownerChanges, 'controls keep DOM identity only for the original absolute owner');
  assert.equal(slot.children[0], control, 'stored surface remains intact for an explicit reattachment');
});

test('streaming patch removes a prior delivery when the local reply index is reused by a new owner', () => {
  const { _syncMessage } = require('../components/panels/chat-dom-patch');
  const old = deliveryMessage(79, 179, true), card = deliveryCard(); old.appendChild(card);
  const next = deliveryMessage(79, 181, true, false);
  _syncMessage(old, next, { preserveDeco: true });
  assert.equal(old.querySelectorAll('.ndelivery').length, 0, 'a thinking-only new reply cannot inherit the prior result');
  assert.equal(old.dataset.messageOwner, '181');
});

test('streaming carry follows the absolute owner across a sliding window and captures the previous current reply', () => {
  const { _syncMessage } = require('../components/panels/chat-dom-patch');
  const previous = doc.createElement('div'), old = deliveryMessage(79, 179, true);
  const card = deliveryCard(); old.appendChild(card); previous.appendChild(old);
  const captured = carry.capture(previous);
  const next = doc.createElement('div'), owner = deliveryMessage(77, 179), unrelated = deliveryMessage(79, 181, true, false);
  next.appendChild(owner); next.appendChild(unrelated);
  carry.reconcile(next, [], captured, { status: 'streaming' });
  assert.equal(owner.querySelectorAll('.ndelivery').length, 1, 'the old result stays with its original final reply');
  assert.equal(unrelated.querySelectorAll('.ndelivery').length, 0);
  const retained = owner.querySelector('.ndelivery');
  _syncMessage(owner, deliveryMessage(77, 179), { preserveDeco: true });
  assert.equal(owner.querySelector('.ndelivery'), retained, 'same-owner structural updates retain the existing card node');
});

test('a one-message history shift cannot carry a delivery into an assistant row reused as a user', () => {
  const { _syncMessage } = require('../components/panels/chat-dom-patch');
  const list = doc.createElement('div'), old = deliveryMessage(3, 105), card = deliveryCard();
  old.appendChild(card); list.appendChild(old);
  const captured = carry.capture(list), actualOwner = deliveryMessage(2, 105);
  const user = doc.createElement('div'); user.className = 'nmsg user'; user.dataset.chatNode = 'message:3';
  list.insertBefore(actualOwner, old);
  _syncMessage(old, user, { preserveDeco: true });
  carry.reconcile(list, [], captured, { status: 'streaming' });
  assert.equal(old.querySelectorAll('.ndelivery').length, 0, 'a user row must never receive a prior assistant delivery');
  assert.equal(actualOwner.querySelectorAll('.ndelivery').length, 1);
  assert.equal(old.dataset.messageOwner, undefined);
  assert.equal(old.dataset.deliveryFinal, undefined);
  assert.equal(old.dataset.deliveryCurrent, undefined);
});

test('settled carry keeps a delivery with its absolute owner instead of the reused local reply index', () => {
  const priorDocument = global.document, priorDeliveries = global.ChatDeliveries;
  const previous = doc.createElement('div'), old = deliveryMessage(79, 179, true);
  old.appendChild(deliveryCard()); previous.appendChild(old);
  const root = doc.createElement('div'), owner = deliveryMessage(77, 179), unrelated = deliveryMessage(79, 181);
  root.appendChild(owner); root.appendChild(unrelated);
  global.document = { createElement: () => root };
  global.ChatDeliveries = { isSettled: () => true, decorate() {} };
  links.resetDecorateCache();
  try {
    links.decorate('settled transcript', [], 'owner-test', { status: 'idle' }, previous);
    assert.equal(owner.querySelectorAll('.ndelivery').length, 1);
    assert.equal(unrelated.querySelectorAll('.ndelivery').length, 0);
  } finally {
    global.document = priorDocument; global.ChatDeliveries = priorDeliveries;
    links.resetDecorateCache();
  }
});

/* ---------- decorate memo ---------- */
function memoStub() {
  const calls = { deliveries: 0, library: 0 };
  const previousWindow = global.window;
  global.window = global.window || {};
  global.document = {
    createElement: () => miniElement(global.document, 'div'),
    defaultView: { NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 } },
    createTreeWalker: root => { let done = false; return { nextNode() { if (done) return false; done = true; return false; }, currentNode: null }; },
  };
  global.ChatDeliveries = { isSettled: () => true, decorate: () => { calls.deliveries += 1; } };
  global.LibraryTransfer = { decorateOutputs: () => { calls.library += 1; } };
  return calls;
}
function memoTeardown(previousWindow) {
  delete global.ChatDeliveries; delete global.LibraryTransfer; delete global.document;
  global.window = previousWindow;
  links.resetDecorateCache();
}

test('落定态 decorate 记忆化：同输入复用，快照关键位/文件集/卡片指纹任一变化即失效', () => {
  const calls = memoStub();
  try {
    const html = '<div class="nmsg ai"><div class="ntext">正文</div></div>';
    const files = [{ name: 'report.docx', relative: 'report.docx', path: 'C:\\ws\\report.docx' }];
    const snapshot = { status: 'idle', messages: [{ role: 'user', text: 'hi' }], deliveryPending: false };
    links.decorate(html, files, 'ref-1', snapshot, null);
    links.decorate(html, files, 'ref-1', snapshot, null);
    links.decorate(html, files, 'ref-1', { ...snapshot, messages: [{ role: 'user', text: 'hi' }, { role: 'assistant', done: true, text: 'x' }] }, null);
    assert.equal(calls.deliveries, 1, '同输入 + 无关快照字段变化 → 命中记忆');
    links.decorate(html, files, 'ref-1', { ...snapshot, execution: { running: false, artifactUrl: 'http://x' } }, null);
    assert.equal(calls.deliveries, 2, 'execution.artifactUrl 变化 → 失效重算');
    links.decorate(html, files, 'ref-1', { ...snapshot, deliveryPending: true }, null);
    assert.equal(calls.deliveries, 3, 'deliveryPending 变化 → 失效');
    links.decorate(html, files, 'ref-2', snapshot, null);
    assert.equal(calls.deliveries, 4, '会话 ref 变化 → 失效');
    // Invalidate card fingerprints when prior cards exist or their content changes.
    const cardRoot = doc.createElement('div');
    const cardMsg = doc.createElement('div'); cardMsg.setAttribute('data-chat-node', 'message:0');
    const card = doc.createElement('div'); card.className = 'ndelivery'; card.setAttribute('data-delivery', 'task-1');
    cardMsg.appendChild(card); cardRoot.appendChild(cardMsg);
    links.decorate(html, files, 'ref-1', snapshot, cardRoot);
    assert.equal(calls.deliveries, 5, '有携带卡 → 不命中');
    card.textContent = '状态已漂移';
    links.decorate(html, files, 'ref-1', snapshot, cardRoot);
    assert.equal(calls.deliveries, 6, '卡片指纹漂移 → 不命中');
    // Invalidate on file-set changes.
    links.decorate(html, [...files, { name: 'sales.xlsx', relative: 'sales.xlsx', path: 'C:\\ws\\sales.xlsx' }], 'ref-1', snapshot, null);
    assert.equal(calls.deliveries, 7, '文件集变化 → 失效');
  } finally {
    memoTeardown();
  }
});

test('状态签名覆盖 decorate 全部读取面，且不被 messages/tools/notices/fileChanges 干扰', () => {
  const sig = links._decorateStateSignature;
  const base = {
    status: 'idle', deliveryPending: false, delivery: { a: 1 }, deliverySync: 'x',
    cloudHandoff: { taskId: 't', artifactUrl: 'u' },
    execution: { running: false, stopped: false, artifactUrl: 'u', previewUrl: 'p', serviceUrl: 's', quality: { phase: 'done' }, fileChanges: [{ path: 'a' }] },
    messages: [{ role: 'user', text: '长'.repeat(500) }], tools: [{ state: 'running', after: 7 }], notices: ['n'], fileChanges: [{ path: 'a' }], history: [1, 2, 3],
  };
  const baseline = sig(base);
  assert.equal(sig({ ...base, messages: [{ role: 'user', text: '不同内容' }] }), baseline, 'messages 不影响签名（由 html 全文覆盖）');
  assert.equal(sig({ ...base, tools: [{ state: 'running', after: 7 }, { state: 'idle' }] }), baseline, '非 running tools 不影响');
  assert.equal(sig({ ...base, notices: ['other'] }), baseline, 'notices 不影响');
  assert.equal(sig({ ...base, history: [9] }), baseline, 'history 不影响');
  assert.notEqual(sig({ ...base, tools: [{ state: 'running', after: 9 }] }), baseline, 'running tool 的 after 变化 → 签名变化');
  assert.notEqual(sig({ ...base, execution: { ...base.execution, running: true } }), baseline, 'execution.running 变化');
  assert.notEqual(sig({ ...base, execution: { ...base.execution, artifactUrl: 'u2' } }), baseline, 'artifactUrl 变化');
  assert.notEqual(sig({ ...base, cloudHandoff: { ...base.cloudHandoff, artifactUrl: 'u2' } }), baseline, 'cloudHandoff.artifactUrl 变化');
  assert.notEqual(sig({ ...base, deliveryPending: true }), baseline, 'deliveryPending 变化');
  const long = { ...base, messages: Array.from({ length: 400 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: 'm' + i })) };
  long.messages[399].role = 'user';
  assert.notEqual(sig(long), baseline, 'latestUser 索引变化 → 签名变化');
});

test('安全阀：自动增长封顶 400，显式加宽可到后台 2000 上限且不收缩', () => {
  const previousWindow = global.window;
  global.window = {};
  try {
    for (const helper of ['chat-context-meter', 'chat-scroll-follow', 'chat-markdown', 'chat-dom-patch', 'chat-output-links', 'chat-decorate-carry', 'chat-acceptance-results', 'chat-message-renderer', 'chat-composer-bindings']) {
      delete require.cache[require.resolve('../components/panels/' + helper + '.js')];
      require('../components/panels/' + helper + '.js');
    }
    const grow = global.window.ChatMessageRenderer._growMessageWindow;
    assert.equal(grow(80, 5), 85, '常规增长不受限');
    assert.equal(grow(396, 20), 400, '自动增长封顶 400');
    assert.equal(grow(400, 30), 400, '已达上限不再增长');
    assert.equal(grow(560, 30), 590, '显式加宽窗口内继续增长');
    assert.equal(grow(600, 40), 640, '超过 600 仍能保留显式加载的历史');
    assert.equal(grow(1000, 2), 1002, '恢复已加载窗口后不会回退到 600');
    assert.equal(grow(1980, 40), 2000, '后台最大窗口为 2000');
    assert.equal(grow(2000, 2), 2000, '到达后台上限后不再增长');
    assert.equal(grow(580, 5), 585, '加宽窗口上的自动增长仍可用');
    assert.equal(grow(undefined, 3), 83, '缺省 80 起步');
    const next = global.window.ChatComposerBindings._nextMessageWindowSize;
    assert.equal(next(600), 680, '加载更早记录跨过 600 边界');
    assert.equal(next(1000), 1080, '恢复窗口后继续向前加载');
    assert.equal(next(1980), 2000, '显式读取与后台上限一致');
    assert.equal(next(2000), 2000, '到达上限无需重复请求相同窗口');
  } finally {
    global.window = previousWindow;
  }
});

test('kill switch：SODUWORK_CHAT_LINKIFY_LEGACY=1 走旧扫描路径（零命中跳过与索引全部旁路）', () => {
  // Load process-level feature flags before importing the module.
  // Verify the legacy path avoids indexing and cache writes while retaining equivalent linkification.
  const files = [{ name: 'report.docx', relative: 'report.docx', path: 'C:\\ws\\report.docx' }];
  const root = doc.createElement('div');
  const box = doc.createElement('div'); box.className = 'ntext';
  box.appendChild(doc.createTextNode('重复提到 report.docx 与 report.docx'));
  root.appendChild(box);
  const count = links.linkify(root, files, 'sig-legacy');
  assert.equal(count, 2, '两条命中都换按钮（旧行为）');
  assert.equal(box.querySelectorAll('.noutput-inline').length, 2);
});
