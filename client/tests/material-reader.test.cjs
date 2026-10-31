'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { readMaterials } = require('../main/conversation/material-reader.cjs');

async function fixture(name, data) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'materials-')); const file = path.join(dir, name); await fs.writeFile(file, data); return file; }

test('reads trusted text with BOM, hash, and source ranges', async () => {
  const file = await fixture('notes.txt', Buffer.from([0xef,0xbb,0xbf,...Buffer.from('one\ntwo')]));
  const out = await readMaterials({ attachments: [{ attachmentId: 'a1', name: 'notes.txt', stagedPath: file, trusted: true }] });
  assert.equal(out.materials[0].status, 'read');
  assert.equal(out.materials[0].text, 'one\ntwo');
  assert.equal(out.materials[0].sourceRanges.length, 2);
  assert.match(out.materials[0].hash, /^[a-f0-9]{64}$/);
});

test('reads JSON and log files through the same bounded text path as Markdown', async () => {
  const json = await fixture('records.json', '{"ok":true}');
  const log = await fixture('run.log', 'started');
  const out = await readMaterials({ attachments: [
    { attachmentId: 'json', name: 'records.json', stagedPath: json, trusted: true },
    { attachmentId: 'log', name: 'run.log', stagedPath: log, trusted: true },
  ] });
  assert.deepEqual(out.materials.map(item => item.status), ['read', 'read']);
});

test('caps a large text file and reports partial while preserving aggregate cap', async () => {
  const file = await fixture('big.md', 'x'.repeat(300000));
  const out = await readMaterials({ attachments: [{ attachmentId: 'big', name: 'big.md', stagedPath: file, trusted: true }] });
  assert.equal(out.materials[0].status, 'partial');
  assert.equal(out.materials[0].text.length, 240000);
});

test('images expose metadata and controlled bytes without visual claims', async () => {
  const file = await fixture('photo.png', Buffer.from([1,2,3,4]));
  const out = await readMaterials({ attachments: [{ attachmentId: 'img', name: 'photo.png', stagedPath: file, trusted: true }] }, { includeImageBytes: true, maxImageBytes: 3 });
  assert.equal(out.materials[0].status, 'read');
  assert.equal(out.materials[0].kind, 'image');
  assert.equal(out.materials[0].data.length, 3);
  assert.equal(out.materials[0].visualUnderstanding, false);
});

test('office and PDF use injected readers and unsupported files are unreadable', async () => {
  const office = await fixture('report.docx', 'raw');
  const pdf = await fixture('report.pdf', 'raw');
  const unknown = await fixture('data.bin', 'raw');
  const out = await readMaterials({ attachments: [
    { attachmentId: 'o', name: 'report.docx', stagedPath: office, trusted: true },
    { attachmentId: 'p', name: 'report.pdf', stagedPath: pdf, trusted: true },
    { attachmentId: 'u', name: 'data.bin', stagedPath: unknown, trusted: true },
  ] }, { readers: { office: async () => ({ text: 'office text' }), pdf: async () => ({ text: 'pdf text' }) } });
  assert.deepEqual(out.materials.map(x => x.status), ['read','read','unreadable']);
  assert.equal(out.materials[0].text, 'office text');
});

test('oversized Office files are rejected before an injected reader runs', async () => {
  const office = await fixture('large.docx', '1234567890');
  let calls = 0;
  const out = await readMaterials({ attachments: [{ attachmentId: 'o', name: 'large.docx', stagedPath: office, trusted: true }] }, {
    maxFileBytes: 4, readers: { office: async () => { calls++; return { text: 'must not run' }; } },
  });
  assert.equal(calls, 0);
  assert.equal(out.materials[0].status, 'unreadable');
  assert.equal(out.materials[0].reason, 'file-too-large');
});

test('preserves explicit material roles and hashes bounded Office/PDF inputs', async () => {
  const office = await fixture('rules.docx', 'office');
  const pdf = await fixture('source.pdf', 'pdf');
  const out = await readMaterials({ attachments: [
    { attachmentId: 'o', name: 'rules.docx', role: 'steps', stagedPath: office, trusted: true },
    { attachmentId: 'p', name: 'source.pdf', stagedPath: pdf, trusted: true },
  ] }, { readers: { office: async () => ({ text: 'rules' }), pdf: async () => ({ text: 'source' }) } });
  assert.equal(out.materials[0].hash.length, 64);
  assert.equal(out.materials[1].hash.length, 64);
  assert.equal(out.materials[0].role, 'steps');
});

test('cancellation stops reads', async () => {
  const file = await fixture('slow.txt', 'hello');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => readMaterials({ attachments: [{ attachmentId: 'x', name: 'slow.txt', stagedPath: file, trusted: true }] }, { signal: controller.signal }), /aborted|cancel/i);
});
