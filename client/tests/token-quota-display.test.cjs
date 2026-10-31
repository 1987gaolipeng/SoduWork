'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const quota = require('../core/token-quota');

test('quota guidance recognizes structured proxy, queue and legacy receipts without hiding ordinary errors', () => {
  const status = { enabled: true, exceeded: true, reason: 'trial_expired', limit: 100000, used: 12 };
  for (const value of [
    { code: quota.CODE, quota: status },
    { detail: { code: quota.CODE, quota: status } },
    { execution: { turnQueue: { failure: { code: quota.CODE, quota: status } } } },
    { completion: { error: JSON.stringify({ error: { code: quota.CODE, quota: status } }) } },
    new Error('403 ' + JSON.stringify({ detail: { code: quota.CODE, quota: status } })),
  ]) assert.equal(quota.detail(value).quota.reason, 'trial_expired');
  assert.equal(quota.detail('开不了对话（本月 AI Token 额度已用完，请联系管理员调整额度）').code, quota.CODE);
  for (const value of ['Upstream quota exceeded', 'Database connection failed', { code: 'MODEL_NOT_FOUND', status: 403 },
    { quota: { enabled: true, exceeded: false } }]) assert.equal(quota.detail(value), null);
});

test('trial, total, paused and model allowance have distinct next steps and no monthly trial reset', () => {
  const base = { enabled: true, limit: 100000, used: 100000, exceeded: true };
  assert.equal(quota.copy({ ...base, reason: 'trial_expired' }).title, '试用已结束');
  assert.equal(quota.copy({ ...base, expiresAt: '2026-11-01T02:00:00Z' }).title, '试用额度已用完');
  assert.equal(quota.copy({ ...base, limit: 0 }).title, 'AI 使用已暂停');
  assert.equal(quota.copy({ ...base, reason: 'model_exhausted', totalLimited: false }).title, '当前模型的额度已用完');
  assert.match(quota.copy({ ...base, totalLimited: false }).used, /不限额/);
  assert.doesNotMatch(quota.copy({ ...base, reason: 'trial_expired' }).guidance, /下月|month/);
  assert.match(quota.copy({ ...base, reason: 'model_not_allowed', models: [{ model: 'available-model', remaining: 1000, exceeded: false }] }).guidance, /其他可用模型/);
  assert.doesNotMatch(quota.copy({ ...base, reason: 'model_not_allowed', models: [] }).guidance, /其他可用模型/);
  assert.doesNotMatch(quota.copy({ ...base, reason: 'model_exhausted', models: [{ remaining: 0, exceeded: true }] }).guidance, /其他可用模型/);
  assert.doesNotMatch(quota.copy({ ...base, reason: 'total_exhausted' }).guidance, /其他可用模型/);
});

test('all supported locales translate quota states, details, dates and actions', () => {
  for (const locale of ['en-US', 'ja-JP', 'ko-KR']) {
    const messages = require('../core/locales/' + locale + '-gap-pages');
    const keys = [];
    for (const reason of ['trial_expired', 'total_exhausted', 'model_not_allowed', 'model_exhausted']) {
      const result = quota.copy({ enabled: true, limit: 100000, used: 100000, reason,
        expiresAt: '2026-11-01T02:00:00Z' }, key => { keys.push(key); return messages[key] || key; }, locale);
      assert.ok(result.title);
      assert.ok(result.used.includes('100,000'));
      assert.doesNotMatch(result.timing, /\{date\}/);
    }
    for (const key of [...keys, '额度详情', '刷新额度', '正在刷新', '暂时无法刷新，请稍后重试。', '总额度不限额', '其中 {tokens} Tokens 来自旧版用量，已计入当前模型额度']) {
      assert.ok(messages[key], locale + ': ' + key);
      assert.notEqual(messages[key], key);
    }
  }
});
