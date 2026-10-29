'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createService, normalize } = require('../main/file-type-icons.cjs');
const { typeOf, markup } = require('../components/panels/library-file-icons.js');

test('real filename wins over a renamed title, library category and incorrect MIME', () => {
  assert.equal(typeOf({ filename: '报告.DOCX', title: '演示.pptx', kind: 'document', contentType: 'application/pdf' }), 'docx');
  assert.equal(typeOf({ filename: 'slides.pptx', kind: 'document' }), 'pptx');
  assert.equal(typeOf({ filename: 'budget.xlsm', kind: 'document' }), 'xlsm');
  assert.equal(typeOf({ filename: 'report.docx.exe', contentType: 'application/msword' }), 'exe');
  assert.equal(typeOf({ filename: 'Report', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document; charset=utf-8' }), 'docx');
  assert.equal(typeOf({ filename: 'data.unknown', kind: 'document' }), 'unknown');
  assert.equal(typeOf({ title: 'Word.docx', kind: 'document' }), '');
  assert.equal(typeOf({ filename: 'README', contentType: 'text/markdown' }), 'md');
});

test('icon requests cannot supply a path or inject markup', async () => {
  for (const value of ['../private.docx', 'file:///secret.txt', 'C:\\secret', 'docx:stream', '<img onerror=alert(1)>', { extension: 'docx' }]) assert.equal(normalize(value), '');
  assert.equal(normalize('PPTX'), 'pptx');
  assert(!markup({filename:'"/><script>bad</script>'}).includes('<script>'));
});

test('native lookup is shared and cached by extension without inspecting a real document', async () => {
  let calls = 0, resolve;
  const request = new Promise(r => { resolve = r; });
  const service = createService({ platform: 'win32', app: { getPath: () => 'D:/isolated', getFileIcon: async (target, options) => {
    calls++; assert.match(target, /soduwork-file-type-icons-[^/\\]+[/\\]type\.docx$/);
    assert.equal(options.size, 'normal'); await request;
    return { isEmpty: () => false, toDataURL: () => 'data:image/png;base64,AA==' };
  } } });
  const one = service.get('docx'), two = service.get('DOCX'); resolve();
  assert.deepEqual(await one, await two); assert.equal(calls, 1);
  assert.equal((await service.get('docx')).ok, true); assert.equal(calls, 1);
});

test('a broken shell handler times out to the real system generic icon', async () => {
  const service = createService({ platform: 'win32', timeoutMs: 10, app: { getPath: () => 'D:/isolated', getFileIcon: target => {
    if (target.endsWith('.pdf')) return new Promise(() => {});
    return Promise.resolve({ isEmpty: () => false, toDataURL: () => 'data:image/png;base64,AA==' });
  } } });
  const result = await service.get('pdf');
  assert.equal(result.ok, true); assert.equal(result.fallback, true);
  assert.equal(result.dataUrl, 'data:image/png;base64,AA==');
});
