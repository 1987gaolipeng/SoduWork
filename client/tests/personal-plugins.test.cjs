'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const personal = require('../main/personal-plugins');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-personal-plugin-'));
  const handlers = new Map();
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from('cipher:' + value, 'utf8'),
    decryptString: (value) => value.toString('utf8').replace(/^cipher:/, ''),
    getSelectedStorageBackend: () => 'dpapi',
  };
  return {
    root, handlers, safeStorage,
    app: { getPath: () => root },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    close: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

const body = {
  skills: ['browser-use'],
  template: 'workflow', name: '周报整理', version: '0.1.0', description: '整理本周工作并输出周报',
  instructions: '读取本周任务、成果和风险，生成结构清晰、可直接提交的周报。', mcpServers: '',
};


test('install-time setup is versioned, exportable, and rejects secret-shaped preferences', async () => {
  const f = fixture();
  try {
    const setup = {
      title: '配置报告偏好', description: '安装后配置一次，后续任务自动复用', preferences: [
        { key: 'language', label: '语言', type: 'select', required: true,
          options: [{ value: 'zh', label: '中文' }, { value: 'en', label: 'English' }], default: 'zh' },
        { key: 'audiences', label: '阅读对象', type: 'multiselect',
          options: ['管理层', '项目组'], default: ['管理层'] },
        { key: 'referenceUrl', label: '参考地址', type: 'url', default: 'https://example.com/docs' },
      ],
    };
    const preview = personal.preflight({ ...body, setup });
    const normalizedSetup = preview.manifest.setup;
    assert.deepEqual(normalizedSetup.title, setup.title);
    assert.equal(normalizedSetup.preferences.length, 3);
    assert.ok(preview.capabilities.components.some((item) => item.kind === 'setup' && item.count === 3));
    assert.ok(preview.checks.some((row) => row.key === 'setup' && row.ok));
    const made = personal.create(f.app, { ...body, setup });
    const detail = personal.get(f.app, made.plugin.pluginId);
    assert.deepEqual(detail.localDraft.setup, normalizedSetup);
    const draft = personal.exportDraft(f.app, made.plugin.pluginId);
    assert.deepEqual(draft.setup, normalizedSetup);
    assert.throws(() => personal.preflight({ ...body, setup: {
      preferences: [{ key: 'apiToken', label: '令牌', type: 'text' }],
    } }), /不能收集凭据/);
    assert.throws(() => personal.preflight({ ...body, setup: {
      preferences: [{ key: 'endpoint', label: '地址', type: 'url', default: 'file:///secret' }],
    } }), /http\/https/);
    assert.throws(() => personal.preflight({ ...body, setup: {
      preferences: [{ key: 'tooLong', label: 'x'.repeat(101), type: 'text' }],
    } }), /不能超过/);
  } finally { f.close(); }
});

test('personal plugins install locally and never become enterprise-visible by default', () => {
  const f = fixture();
  try {
    const made = personal.create(f.app, body);
    assert.equal(made.ok, true);
    assert.equal(made.plugin.personal, true);
    assert.equal(made.plugin.organizationWide, false);
    assert.ok(made.plugin.capabilities.skills.includes('browser-use'));
    assert.match(made.plugin.pluginId, /^local:/);
    assert.match(made.plugin.checksum, /^[a-f0-9]{64}$/);
    assert.equal(personal.catalog(f.app, false).filter(item => !item.builtIn).length, 1);
    assert.ok(personal.catalog(f.app, false).some(item => item.pluginId === personal.PRODUCT_INCUBATOR_ID));
    const raw = JSON.parse(fs.readFileSync(path.join(f.root, 'personal-plugins.json'), 'utf8'));
    assert.equal(raw.plugins.length, 1);
    assert.equal(JSON.stringify(raw).includes('secretRefs'), false);
  } finally { f.close(); }
});

test('same version is immutable while a raised version becomes current', () => {
  const f = fixture();
  try {
    personal.create(f.app, body);
    assert.throws(() => personal.create(f.app, { ...body, instructions: body.instructions + ' 更改' }), /提升版本号/);
    const next = personal.create(f.app, { ...body, version: '0.2.0', instructions: body.instructions + ' 更改' });
    assert.equal(next.plugin.version, '0.2.0');
    assert.equal(personal._read(f.app).plugins[0].versions.length, 2);
  } finally { f.close(); }
});

test('personal plugin can switch between immutable versions without rewriting history', () => {
  const f = fixture();
  try {
    const first = personal.create(f.app, body);
    personal.create(f.app, { ...body, version: '0.2.0', instructions: body.instructions + ' 第二版' });
    const switched = personal.setVersion(f.app, first.plugin.pluginId, '0.1.0');
    assert.equal(switched.plugin.version, '0.1.0');
    assert.match(switched.message, /个人对话试用/);
    assert.doesNotMatch(switched.message, /新任务/);
    assert.equal(switched.plugin.localVersions.length, 2);
    assert.equal(switched.plugin.localVersions.find((x) => x.version === '0.1.0').current, true);
    assert.equal(personal._read(f.app).plugins[0].versions.length, 2);
  } finally { f.close(); }
});

test('current immutable version exports as a portable archive and imports on another device', async () => {
  const source = fixture();
  const target = fixture();
  try {
    const first = personal.create(source.app, body);
    personal.create(source.app, {
      ...body, version: '0.2.0', instructions: body.instructions + ' 第二版',
    });
    const destination = path.join(source.root, 'weekly-report.soduwork-plugin.json');
    const exported = await personal.exportToFile(source.app, {
      showSaveDialog: async () => ({ canceled: false, filePath: destination }),
    }, first.plugin.pluginId);
    assert.equal(exported.ok, true);
    assert.equal(exported.archive, true);
    assert.equal(exported.filename, 'weekly-report.soduwork-plugin');
    assert.equal(exported.version, '0.2.0');
    assert.equal(fs.existsSync(destination), false);
    const archive = fs.readFileSync(exported.filePath);
    assert.equal(archive.subarray(0, 4).toString('hex'), '504b0304');
    const nameLength = archive.readUInt16LE(26);
    const extraLength = archive.readUInt16LE(28);
    const size = archive.readUInt32LE(18);
    const entryName = archive.subarray(30, 30 + nameLength).toString('utf8');
    assert.equal(entryName, 'plugin.json');
    const draft = JSON.parse(archive.subarray(30 + nameLength + extraLength, 30 + nameLength + extraLength + size).toString('utf8'));
    assert.equal(draft.schemaVersion, 1);
    assert.equal(draft.version, '0.2.0');
    assert.equal(draft.pluginId, undefined);
    assert.equal(draft.currentVersion, undefined);
    assert.equal(personal.preflight(draft).manifest.name, body.name);
    const installed = personal.create(target.app, draft);
    assert.equal(installed.plugin.version, '0.2.0');
    assert.equal(installed.plugin.personal, true);
  } finally {
    source.close();
    target.close();
  }
});

test('entrypoints are live policy, not stored snapshots: old data cannot advertise dead task actions or hide automation', () => {
  const f = fixture();
  try {
    personal.create(f.app, body);
    const file = path.join(f.root, 'personal-plugins.json');
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    /* Recompute entrypoint policy for legacy records with missing or obsolete snapshots. */
    delete stored.plugins[0].versions[0].capabilities.entrypoints;
    fs.writeFileSync(file, JSON.stringify(stored), 'utf8');
    const card = personal.catalog(f.app, false).find((item) => !item.builtIn);
    assert.deepEqual(card.entrypoints, {
      conversation: true, task: false, automation: true,
    });
    /* Exclude the conversation-only plugin development assistant from automation choices. */
    const builder = personal.catalog(f.app, false).find((item) => item.builtIn);
    assert.equal(builder.entrypoints.automation, false);
  } finally { f.close(); }
});

test('personal plugin resolution returns bounded per-turn guidance and the built-in builder', () => {
  const f = fixture();
  try {
    const made = personal.create(f.app, body);
    const result = personal.resolve(f.app, [personal.BUILDER_ID, made.plugin.pluginId]);
    assert.equal(result.items.length, 2);
    assert.match(result.items[1].context, /browser-use/);
    assert.equal(result.items[0].scopeLabel, '仅自己');
    assert.match(result.items[0].context, /soduwork-plugin-draft\.json/);
    assert.match(result.items[0].context, /\.soduwork\/delivery\.json/);
    assert.match(result.items[0].context, /primary/);
    assert.match(result.items[1].context, /周报/);
    assert.match(result.items[1].context, /个人工作流草稿/);
    assert.match(result.items[1].context, /上传企业并审核发布后/);
    assert.ok(result.items.every((item) => item.context.length <= 10000));
  } finally { f.close(); }
});

test('connector drafts require a connection or CLI and reject embedded credentials', () => {
  assert.throws(() => personal.preflight({ ...body, template: 'connector' }), /需要声明连接器、平台账号连接/);
  const preview = personal.preflight({ ...body, template: 'connector', mcpServers: 'oa-system' });
  assert.equal(preview.capabilities.network, true);
  assert.deepEqual(preview.capabilities.mcpServers, ['oa-system']);
  assert.throws(() => personal.preflight({ ...body, apiKey: 'sk-real-secret-1234567890' }), /不能包含真实密码或密钥/);
  assert.throws(() => personal.preflight({ ...body, instructions: 'token=very-secret-value-123456' }), /疑似包含真实密码或密钥/);
});

test('SoduWork virtual media capability is ready without an external MCP binding', () => {
  const preview = personal.preflight({ ...body, template: 'connector',
    name: '视频制作', description: '生成视频成片',
    instructions: '生成脚本后调用内置媒体服务输出视频。', mcpServers: 'soduwork-media' });
  const component = preview.capabilities.components.find((item) => item.kind === 'mcp');
  assert.equal(component.state, 'ready');
  assert.deepEqual(preview.capabilities.permissionSummary.reasons, []);
});

test('personal plugin trial carries declared tools and acceptance criteria into the actual turn', () => {
  const f = fixture();
  try {
    const made = personal.create(f.app, {
      ...body,
      template: 'connector',
      name: 'OA 待办整理',
      mcpServers: 'oa-system',
      runtimeCapabilities: ['browser'],
      evaluationInstruction: '读取待办并整理',
      evaluationCriteria: '不得遗漏紧急事项\n无法访问时明确说明',
    });
    const item = personal.resolve(f.app, [made.plugin.pluginId]).items[0];
    assert.match(item.context, /本轮依赖外部 MCP：oa-system/);
    assert.match(item.context, /本轮需要的基础执行能力：browser/);
    assert.match(item.context, /完成标准：/);
    assert.match(item.context, /不得遗漏紧急事项/);
    assert.match(item.context, /不可用时必须明确说明/);
  } finally { f.close(); }
});

test('adapted Codex or Claude package keeps safe import provenance in local trial', () => {
  const f = fixture();
  try {
    const checksum = 'a'.repeat(64);
    const made = personal.create(f.app, {
      ...body,
      sourceKind: 'codex',
      importChecksum: checksum,
      importWarnings: ['MCP 需要在 SoduWork 中重新绑定'],
      unsupportedComponents: ['hooks', '可执行文件'],
    });
    assert.equal(made.plugin.sourceKind, 'codex');
    assert.equal(made.plugin.capabilities.permissionSummary.riskLevel, 'high');
    assert.deepEqual(made.plugin.capabilities.unsupportedComponents,
      ['hooks', '可执行文件']);
    assert.ok(made.plugin.capabilities.components.some(
      (item) => item.kind === 'unsupported' && item.state === 'blocked'));
    const detail = personal.get(f.app, made.plugin.pluginId);
    assert.equal(detail.localDraft.importChecksum, checksum);
    assert.deepEqual(detail.localDraft.importWarnings,
      ['MCP 需要在 SoduWork 中重新绑定']);
  } finally { f.close(); }
});

test('publisher identity stays local, is stable, and signs only canonical plugin payloads', async () => {
  const f = fixture();
  try {
    personal.install({
      app: f.app, ipcMain: f.ipcMain, safeStorage: f.safeStorage,
      dialog: { showSaveDialog: async () => ({ canceled: true }) },
    });
    const identityCall = f.handlers.get('personal-plugin-publisher-identity');
    const signCall = f.handlers.get('personal-plugin-sign');
    const first = (await identityCall()).identity;
    const second = (await identityCall()).identity;
    assert.deepEqual(second, first);
    assert.match(first.keyId, /^soduwork\.[a-f0-9]{24}$/);
    assert.equal(Buffer.from(first.publicKey, 'base64').length, 32);
    assert.equal(first.privateKey, undefined);
    assert.equal(first.privateKeyCipher, undefined);

    const storedText = fs.readFileSync(
      path.join(f.root, 'plugin-publisher-identity.json'), 'utf8');
    assert.doesNotMatch(storedText, /BEGIN PRIVATE KEY/);
    assert.match(storedText, /privateKeyCipher/);

    const payload = {
      schema: 'soduwork.plugin-signature/v1', algorithm: 'Ed25519',
      keyId: first.keyId, contentChecksum: 'a'.repeat(64),
      pluginKey: 'weekly-report', version: '0.1.0',
      signedAt: new Date().toISOString(),
    };
    const envelope = (await signCall(null, payload)).signature;
    assert.equal(Buffer.from(envelope.signature, 'base64').length, 64);
    const publicKey = crypto.createPublicKey({
      key: {
        kty: 'OKP', crv: 'Ed25519',
        x: Buffer.from(first.publicKey, 'base64').toString('base64url'),
      },
      format: 'jwk',
    });
    assert.equal(crypto.verify(
      null, personal._canonicalBytes(payload), publicKey,
      Buffer.from(envelope.signature, 'base64')), true);
    assert.throws(() => personal.signPayload(f.app, {
      ...payload, keyId: 'soduwork.' + '0'.repeat(24),
    }), /不一致/);
  } finally { f.close(); }
});
