'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function node() {
  const attributes = new Map();
  const value = {
    children: [],
    dataset: {},
    hidden: false,
    isConnected: false,
    textContent: '',
    disabled: false,
    className: '',
    setAttribute(name, text) {
      attributes.set(name, String(text));
      if (name === 'class') this.className = String(text);
      if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(text);
    },
    getAttribute(name) { return attributes.get(name) || null; },
    append(...children) { this.children.push(...children); },
    before(child) { this.parentElement?.children?.push(child); child.isConnected = true; },
    addEventListener() {},
    querySelector(selector) {
      const matches = child => {
        if (selector.startsWith('[data-')) {
          const key = selector.slice(6, -1).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
          return Object.hasOwn(child.dataset || {}, key);
        }
        return false;
      };
      const visit = children => {
        for (const child of children || []) {
          if (matches(child)) return child;
          const found = visit(child.children);
          if (found) return found;
        }
        return null;
      };
      return visit(this.children);
    },
  };
  Object.defineProperty(value, 'classList', { value: { contains: name => String(value.className).split(/\s+/).includes(name) } });
  return value;
}

function fixture() {
  const calls = [];
  const document = { createElement: () => node() };
  const ctx = {
    window: null,
    console,
    document,
    addEventListener() {},
    SoduWorkI18n: { translateText: value => value, getLocale: () => 'zh-CN' },
    SoduWorkQuota: {
      detail: value => ({ code: 'TOKEN_QUOTA_EXCEEDED', quota: value.quota }),
      copy: () => ({ title: '本期额度已用完', guidance: '联系管理员调整额度后，即可继续。', used: '已用 100 / 100', timing: '' }),
    },
    SoduWorkAPI: {
      clientAuthSnapshot: () => ({ user: { id: 'user-a' } }),
      clientAuthMe: async () => ({ user: { id: 'user-a' }, quota: { enabled: true, exceeded: false, remaining: 100 } }),
      hubConfig: () => ({ hub: 'test' }),
    },
    ClientAuth: {
      clearQuotaNotice: () => calls.push('clear'),
      updateIdentity: (_user, quota) => calls.push(['identity', quota.exceeded]),
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../components/client-auth/quota-notice.js'), 'utf8'), ctx);
  return { ctx, calls };
}

test('额度恢复通知立即隐藏额度卡，并在后台确认最新额度', async () => {
  const f = fixture(), composer = { parentElement: {}, previousElementSibling: null, before(card) { card.isConnected = true; this.card = card; } };
  const card = f.ctx.SoduWorkQuotaNotice.mount(composer);
  f.ctx.SoduWorkQuotaNotice.show({ quota: { enabled: true, exceeded: true, used: 100, limit: 100 } });
  assert.equal(card.hidden, false);
  const refresh = f.ctx.SoduWorkQuotaNotice.markRestored();
  assert.equal(card.hidden, true, '恢复通知处理后不应继续遮挡对话输入区');
  assert.deepEqual(f.calls, ['clear']);
  await refresh;
  assert.equal(card.hidden, true);
  assert.deepEqual(f.calls, ['clear', ['identity', false]]);
});

test('没有额度卡时恢复通知不会触发无意义的刷新请求', () => {
  const f = fixture();
  assert.equal(f.ctx.SoduWorkQuotaNotice.markRestored(), false);
  assert.deepEqual(f.calls, []);
});
