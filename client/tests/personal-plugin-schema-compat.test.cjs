'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const personal = require('../main/personal-plugins');

// Immutable installed versions must keep their checksum and exported bytes when
// the draft parser moves between modules. These hashes precede that extraction.
const draft = {
  key: 'schema-compat', name: '兼容性样例', version: '1.2.3',
  description: '保留既有插件的结构与校验和', instructions: '读取资料，输出可验证的工作结果。',
  skills: ['browser-use', 'browser-use', 'schema-compat'],
  platforms: ['feishu'], runtimeCapabilities: ['browser'],
  evaluationInstruction: '整理示例资料', evaluationCriteria: '保留事实；给出来源',
  sourceKind: 'adapter', importChecksum: 'a'.repeat(64),
  importWarnings: ['检查连接', '检查连接'], unsupportedComponents: ['hooks'],
  inputs: [
    { key: 'title', label: '标题', type: 'string', multiline: true, default: '工作结果' },
    { key: 'enabled', type: 'bool', default: false },
    { key: 'count', type: 'number', default: 0 },
    { key: 'style', type: 'enum', options: ['brief', 'full'], default: 'brief' },
  ],
  setup: [
    { key: 'audience', label: '读者', type: 'multiselect', options: ['团队', '个人'], default: ['团队', '团队'] },
    { key: 'referenceUrl', type: 'url', default: 'https://example.invalid/guide' },
  ],
  ui: { contributions: [
    { id: 'web', title: '资料', slot: 'task.detail.tab', order: 2,
      source: { type: 'external', url: 'https://example.invalid/tasks/{{task.id}}',
        bridge: { version: 1, capabilities: ['context.read', 'context.read'] } } },
    { id: 'create', title: '新建', slot: 'workspace.navigation', order: 1,
      source: { type: 'builtin', actionId: 'work.task.create' } },
  ] },
  resources: [{ path: 'references/资料.txt', kind: 'reference', encoding: 'utf8', content: '兼容性资料\n' }],
};

const expected = {
  method: [
    '6a9862ed9eb80e8726db80dda4aaddaf5c527ee929b65b97818b41031765ffb7',
    '8a1e304699400a16f35fbd7fa42e4e7e2f0875779559f8c142227247e03eff53',
    'b18d9be5c3dde19bc4cf6bddc5c3cc389f00a62eb940aad8898d921305b80ac9',
  ],
  connector: [
    '238ae933b41fa88e1899a738a018f1446cdf4bd8a1623877153b81d9bc4f0a02',
    '8a1e304699400a16f35fbd7fa42e4e7e2f0875779559f8c142227247e03eff53',
    '5394d018cd0f3e3b756129b9df4e888edd76ef3374c84b748dd29716b7d62cec',
  ],
  workflow: [
    'e1e99a19b7455e49935b36618f2d2e64fe64af7ff2401c08f8df0de5057869a7',
    'cffaea9ecb4b3c0e4ade766b3ef66b6f11e2ca61029cdc30be3b5931814aa8ac',
    '7f781fa36c756ea9c30227f18002eb751b739e0e4a800b69b4d394f6afa5551d',
  ],
};

for (const template of Object.keys(expected)) {
  test(template + ' preserves immutable normalized content, checksum and archive bytes', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-schema-compat-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const app = { getPath: () => root };
    const raw = { ...draft, template };
    const before = JSON.stringify(raw);
    const built = personal.build(raw);
    const installed = personal.create(app, raw).plugin;
    const exported = await personal.exportToFile(app, {
      showSaveDialog: async () => ({ canceled: false, filePath: path.join(root, 'portable.soduwork-plugin') }),
    }, installed.pluginId);
    const hash = value => crypto.createHash('sha256').update(value).digest('hex');
    assert.equal(JSON.stringify(raw), before, 'normalization must leave the caller draft intact');
    assert.deepEqual([
      hash(JSON.stringify(built.body)), built.checksum, hash(fs.readFileSync(exported.filePath)),
    ], expected[template]);
    const preview = personal.preflightArchive(fs.readFileSync(exported.filePath).toString('base64'));
    assert.deepEqual(preview.manifest.inputs, built.manifest.inputs);
    assert.deepEqual(preview.manifest.setup, built.manifest.setup);
  });
}
