'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadHost() {
  const requests = [];
  const sent = [];
  const proposals = [];
  const window = {
    soduWorkAPI: {
      workPreviewAppHost: {
        authorize: async () => ({ ok: true }),
        onRequest(handler) { requests.push(handler); return () => {}; },
        respond() {},
      },
      conversationSession: {
        async open(options) { return { ok: true, ref: 'native-secret-ref', options }; },
        async send(ref, text, attachments, options) {
          sent.push({ ref, text, attachments, options }); return { ok: true, accepted: true };
        },
      },
    },
    SoduWorkAPI: {
      async sendMateMessage(recipientUserId, text) {
        return { ok: true, id: recipientUserId + ':' + text };
      },
    },
    WorkEntrySheet: {
      openTask(value) { proposals.push(value); },
    },
    WorkspaceShell: { activeChatId: 'active-chat' },
    PluginUIHost: { assertUse: async () => {} }, // Installed-app permission adapter; this fixture tests routing.
    addEventListener() {},
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, 'soduwork-app-bridge-host.js'), 'utf8'),
    { window, console, Promise, Map, String, Date },
  );
  assert.equal(requests.length, 1);
  return { host: window.SoduWorkAppBridgeHost, sent, proposals, window };
}

test('web app bridge keeps native conversation refs private and routes through existing APIs', async () => {
  const { host, sent } = loadHost();
  const request = { appId: 'plugin:ops', contributionId: 'console', tabId: 'tab-1' };
  const opened = await host._handle({ ...request, method: 'conversation.open', params: {
    title: '运营台', projectId: 'project-1',
  } });
  assert.equal(opened.ok, true);
  assert.match(opened.conversationId, /^conversation-/);
  assert.doesNotMatch(JSON.stringify(opened), /native-secret-ref/);
  const accepted = await host._handle({ ...request, method: 'conversation.send', params: {
    conversationId: opened.conversationId, text: '请生成今日运营摘要',
  } });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.conversationId, opened.conversationId);
  assert.equal(sent[0].ref, 'native-secret-ref');
  assert.equal(sent[0].options.source, 'web-app');
});

test('context exposes the host interface locale, with English fallback and no native credentials', async () => {
  const {host, window} = loadHost();
  const request = {appId: 'plugin:ops', contributionId: 'console', tabId: 'locale', method: 'context.get'};
  assert.equal((await host._handle(request)).locale, 'en-US');
  window.SoduWorkI18n = {getLocale: () => 'zh-CN'};
  const result = await host._handle(request);
  assert.equal(result.locale, 'zh-CN');
  assert.doesNotMatch(JSON.stringify(result), /token|native-secret|filesystem/);
});

test('web app bridge uses review flow for requirements and organization API for notifications', async () => {
  const { host, proposals } = loadHost();
  const request = { appId: 'plugin:ops', contributionId: 'console', tabId: 'tab-2' };
  const context = await host._handle({ ...request, method: 'context.get', params: {} });
  assert.equal(context.ok, true);
  assert.equal(context.appId, 'plugin:ops');
  assert.equal(context.contributionId, 'console');
  assert.equal(context.tabId, 'tab-2');
  assert.equal(context.activeConversationId, 'active-chat');
  const proposal = await host._handle({ ...request, method: 'requirements.propose', params: {
    title: '跟进高价值客户', note: '整理今日需要回访的客户并创建执行需求', projectId: 'p-1',
  } });
  assert.equal(proposal.ok, true);
  assert.equal(proposal.state, 'review');
  assert.equal(proposals[0].saveOnly, true);
  assert.equal(proposals[0].proposal.kind, 'requirement');
  const notice = await host._handle({ ...request, method: 'notifications.send', params: {
    recipientUserId: 'u-1', text: '运营摘要已生成',
  } });
  assert.equal(notice.ok, true);
  assert.equal(notice.notificationId, 'u-1:运营摘要已生成');
});

test('queued prior-account requests and missing native authorization cannot invoke current-account APIs', async () => {
  for (const method of ['conversation.open', 'requirements.propose', 'notifications.send', 'automation.create']) {
    const { host, window } = loadHost(); let actions = 0;
    window.soduWorkAPI.workPreviewAppHost.authorize = async () => ({ ok: false });
    window.soduWorkAPI.conversationSession.open = async () => { actions++; return {}; };
    window.WorkEntrySheet.openTask = () => { actions++; };
    window.SoduWorkAPI.sendMateMessage = async () => { actions++; return {}; };
    window.WorkAutomationDirect = { create: async () => { actions++; return {}; } };
    await assert.rejects(host._handle({ id: 'old-account', appId: 'plugin:installed-in-b', method, params: {} }), /authorization expired/);
    assert.equal(actions, 0);
    delete window.soduWorkAPI.workPreviewAppHost.authorize;
    await assert.rejects(host._handle({ id: 'missing-api', method: 'context.get' }), /authorization expired/);
  }
});

test('account changes while native authorization is pending reject before the first action', async () => {
  const { host, window } = loadHost(); let owner = 'account-a', resolve, actions = 0;
  window.SoduWorkAPI.taskStorageKey = () => owner;
  window.soduWorkAPI.workPreviewAppHost.authorize = () => new Promise(done => { resolve = done; });
  window.SoduWorkAPI.sendMateMessage = async () => { actions++; return {}; };
  const pending = host._handle({ id: 'waiting', appId: 'plugin:installed-in-b', method: 'notifications.send', params: {} });
  owner = 'account-b'; resolve({ ok: true });
  await assert.rejects(pending, /account changed/);
  assert.equal(actions, 0);
});
