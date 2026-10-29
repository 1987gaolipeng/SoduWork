'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { pathToFileURL } = require('node:url');
const loader = require('../main/pi-session/sdk-loader');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-sdk-loader-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('soduwork-sdk-loader-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  return root;
}

test('concurrent cold loads share one SDK instance and preserve public exports', async t => {
  const root = fixture(t), entry = path.join(root, 'index.js');
  fs.writeFileSync(entry, 'export const marker={}; export function createAgentSession(){return marker};');
  const first = loader.load(entry), second = loader.load(entry);
  assert.equal(first, second);
  const sdk = await first;
  assert.equal(sdk, await import(pathToFileURL(entry).href));
  assert.equal(sdk.createAgentSession(), sdk.marker);
});

test('optional warmup files do not mask authoritative SDK import failures', async t => {
  const root = fixture(t), entry = path.join(root, 'index.js');
  fs.writeFileSync(entry, 'throw new Error("SDK installation damaged");');
  await assert.rejects(loader.load(entry), /SDK installation damaged/);
  await assert.rejects(loader.load(entry), /SDK installation damaged/);
});

test('warmup follows nested import exports and respects missing subpaths', async t => {
  const root = fixture(t), entry = path.join(root, 'index.js');
  const pkg = path.join(root, 'node_modules', 'example'); fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ exports: {
    '.': { types: './types.d.ts', import: { default: './esm.js' }, require: './cjs.cjs' },
    './feature': { node: { import: './feature.js' } },
    './require-only': { require: './cjs.cjs' },
    './array': ['./fallback.js'],
  } }));
  assert.equal(await loader.resolveStage(entry, 'example'), path.join(pkg, 'esm.js'));
  assert.equal(await loader.resolveStage(entry, 'example/feature'), path.join(pkg, 'feature.js'));
  assert.equal(await loader.resolveStage(entry, 'example/missing'), '');
  assert.equal(await loader.resolveStage(entry, 'example/require-only'), '');
  assert.equal(await loader.resolveStage(entry, 'example/array'), '');
});
