'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const contract = require('./soduwork-app-bridge-contract.cjs');

test('manifest bridge only accepts the versioned capability allowlist', () => {
  assert.deepEqual(contract.normalizeManifestBridge({ capabilities: [
    'conversation.send', 'context.read', 'conversation.send',
  ] }), { version: 1, capabilities: ['conversation.send', 'context.read'] });
  assert.throws(() => contract.normalizeManifestBridge({ capabilities: ['shell.exec'] }), /未开放/);
  assert.throws(() => contract.normalizeManifestBridge({ version: 2, capabilities: [] }), /版本/);
  assert.throws(() => contract.normalizeManifestBridge({ capabilities: [], extra: true }), /不支持/);
});

test('request validation keeps writes bounded and rejects unknown methods', () => {
  const request = contract.normalizeRequest({ id: 'r-1', method: 'notifications.send', params: {
    recipientUserId: 'u-1', text: '  hello  ',
  } });
  assert.equal(request.version, 1);
  assert.equal(request.params.text, 'hello');
  assert.throws(() => contract.normalizeRequest({ id: 'r-2', method: 'shell.exec', params: {} }), /未开放/);
  assert.throws(() => contract.normalizeRequest({ id: 'r-3', method: 'notifications.send', params: {
    recipientUserId: 'u-1', text: '',
  } }), /需要收件人/);
});

test('origin checks reject credentials and path/query confusion', () => {
  assert.equal(contract.normalizeOrigin('https://ops.example.com/'), 'https://ops.example.com');
  assert.equal(contract.normalizeOrigin('https://user:pass@ops.example.com/'), '');
  assert.equal(contract.normalizeOrigin('https://ops.example.com/app'), '');
  assert.equal(contract.validateOrigin('https://ops.example.com/', 'https://ops.example.com'), true);
  assert.equal(contract.validateOrigin('https://evil.example.com', 'https://ops.example.com'), false);
});
