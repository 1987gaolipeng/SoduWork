'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const personal = require('../main/personal-plugins');
const { readPersonalArchive } = require('../main/plugin-package-reader.cjs');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-plugin-archive-'));
  return {
    root,
    app: { getPath: () => root },
    close: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test('personal plugin archives keep author and resources through local preflight and install', async () => {
  const source = fixture();
  const target = fixture();
  try {
    const body = {
      template: 'method', key: 'offline-package', name: 'Offline package', version: '0.1.0',
      author: 'Alice', description: 'A portable personal plugin',
      instructions: 'Use the bundled template and return a checked result.',
      resources: [{ path: 'templates/report.md', kind: 'template', encoding: 'utf8',
        content: '# Report\n' }],
    };
    const created = personal.create(source.app, body).plugin;
    assert.equal(created.authorName, 'Alice');

    const exported = await personal.exportToFile(source.app, {
      showSaveDialog: async () => ({
        canceled: false,
        filePath: path.join(source.root, 'offline-package.soduwork-plugin'),
      }),
    }, created.pluginId);
    assert.equal(exported.ok, true);
    assert.equal(exported.archive, true);

    const archive = fs.readFileSync(exported.filePath);
    const draft = readPersonalArchive(archive);
    assert.equal(draft.author, 'Alice');
    assert.equal(draft.resources.length, 1);
    assert.equal(draft.resources[0].path, 'templates/report.md');
    assert.equal(Buffer.from(draft.resources[0].content, 'base64').toString('utf8'), '# Report\n');

    const preview = personal.preflightArchive(archive.toString('base64'));
    assert.equal(preview.ok, true);
    assert.equal(preview.local, true);
    assert.equal(preview.personalDraft.author, 'Alice');
    assert.equal(preview.personalDraft.resources[0].sha256, draft.resources[0].sha256);

    const installed = personal.create(target.app, preview.personalDraft).plugin;
    assert.equal(installed.authorName, 'Alice');
    assert.deepEqual(installed.capabilities.resources, [{
      path: 'templates/report.md', kind: 'template', sha256: draft.resources[0].sha256, size: 9,
    }]);
  } finally {
    source.close();
    target.close();
  }
});

test('personal catalog exposes external MCP readiness before a user tries the plugin', () => {
  const f = fixture();
  try {
    const item = personal.create(f.app, {
      template: 'connector', key: 'needs-connection', name: 'Needs connection', version: '0.1.0',
      author: 'Alice', description: 'A connector', instructions: 'Use the configured service.',
      mcpServers: ['knowledge-base'],
    }).plugin;
    const card = personal.catalog(f.app, false).find(row => row.pluginId === item.pluginId);
    assert.deepEqual(card.dependencyReadiness, {
      requiredMcp: ['knowledge-base'], missingMcp: ['knowledge-base'], state: 'needs_connection',
    });
  } finally { f.close(); }
});

