'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createService, catalog } = require('../main/release-notes');
const storage = require('../main/release-notes-state');
const root = path.resolve(__dirname, 'fixtures/release-notes');
function fixture(t, initial = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-release-notes-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  if (initial.schema) storage.save(directory, initial);
  return { directory, root, version: '1.12.50' };
}
test('first encounter is neutral; claim is exclusive; closing persists across restart and languages', t => {
  const options = fixture(t), service = createService(options);
  assert.equal(service.claim(1, 'en-US').kind, 'new');
  assert.equal(service.claim(2, 'zh-CN'), null);
  assert.equal(service.acknowledge(2), false);
  assert.equal(service.acknowledge(1), true);
  assert.equal(createService(options).claim(3, 'zh-CN'), null);
});
test('crash/reload before dismissal preserves pending and releases ownership', t => {
  const options = fixture(t), service = createService(options);
  service.claim(1, 'zh-CN'); service.release(1);
  assert(service.claim(2, 'en-US'));
  assert(createService(options).claim(3, 'zh-CN'));
});
test('upgrade records source; downgrade does not prompt or overwrite pending', t => {
  const options = fixture(t, { schema: 1, lastVersion: '1.12.40', seen: ['1.12.40'], pending: null });
  const service = createService(options);
  const pending = service.claim(1, 'zh-CN');
  assert.equal(pending.kind, 'updated'); assert.equal(pending.from, '1.12.40');
  assert.equal(createService({ ...options, version: '1.12.45' }).claim(2, 'zh-CN'), null);
  assert(createService(options).claim(3, 'zh-CN'));
  service.acknowledge(1);
  assert.equal(createService(options).claim(3, 'en-US'), null);
});
test('historical content excludes future versions; language is selected explicitly', () => {
  assert.equal(catalog(root, '1.12.49', 'zh-CN').length, 0);
  assert.equal(catalog(root, '1.12.50', 'en-US')[0].locale, 'en-US');
  for (const locale of ['ja-JP', 'ko-KR']) {
    const release = catalog(root, '1.12.95', locale)[0];
    assert.equal(release.version, '1.12.95');
    assert.equal(release.locale, 'zh-CN');
    assert.equal(release.fallback, true);
  }
});
test('missing content never consumes acknowledgement', t => {
  const options = fixture(t), service = createService({ ...options, version: '1.12.99' });
  assert.equal(service.claim(1, 'en-US'), null);
  assert.equal(service.acknowledge(1), false);
});

test('delayed publication stays pending and prompts once in the selected language', t => {
  for (const locale of ['zh-CN', 'en-US', 'ja-JP', 'ko-KR']) {
    const options = fixture(t);
    let releases = [];
    const service = createService({ ...options, catalogOf: () => releases });
    assert.equal(service.claim(1, locale), null);
    assert.equal(service.acknowledge(1), false);
    releases = [{ version: options.version, locale, summary: 'Published notes', sections: [] }];
    assert.equal(service.claim(1, locale).releases[0].locale, locale);
    assert.equal(service.acknowledge(1), true);
    assert.equal(service.claim(1, locale), null);
  }
});
test('torn checkpoints preserve acknowledgement; later valid checkpoints recover', t => {
  const options = fixture(t), service = createService(options);
  service.claim(1, 'en-US'); service.acknowledge(1);
  fs.appendFileSync(path.join(options.directory, 'release-notes-state.jsonl'), '{"payload":');
  assert.equal(createService(options).claim(2, 'zh-CN'), null);
  storage.save(options.directory, { schema: 1, lastVersion: '1.12.51', seen: ['1.12.50', '1.12.51'], pending: null });
  assert.equal(storage.load(options.directory).lastVersion, '1.12.51');
});
test('failed persistence never acknowledges a release', t => {
  const options = fixture(t), service = createService(options);
  service.claim(1, 'en-US');
  const original = storage.save;
  storage.save = () => { throw new Error('disk unavailable'); };
  try { assert.throws(() => service.acknowledge(1), /disk unavailable/); }
  finally { storage.save = original; }
  assert(createService(options).claim(2, 'en-US'));
  assert.equal(service.acknowledge(1), true);
});
test('invalid English content falls back as a whole and missing bilingual data fails release gate', async t => {
  const options = fixture(t);
  const copy = path.join(options.directory, 'notes');
  // Keep fixture cloning on the portable async implementation: Node 22's
  // native synchronous copy can abort on Windows before the test executes.
  await fs.promises.cp(root, copy, { recursive: true });
  fs.writeFileSync(path.join(copy, 'en-US/1.12.50.json'), '{}');
  const result = catalog(copy, '1.12.50', 'en-US')[0];
  assert.equal(result.locale, 'zh-CN'); assert.equal(result.fallback, true);

});
