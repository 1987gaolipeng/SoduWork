const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const manager = fs.readFileSync(path.join(root, 'components/skin-manager/skin-manager.js'), 'utf8');
const registry = fs.readFileSync(path.join(root, 'core/skin-registry.js'), 'utf8');
const store = fs.readFileSync(path.join(root, 'core/store.js'), 'utf8');

test('skin settings no longer renders or auto-connects the cloud status bar', () => {
  assert.equal(manager.includes('skin-cloud-bar'), false);
  assert.equal(manager.includes('refreshRemoteSkins'), false);
  assert.equal(manager.includes('loadRemote(SKIN_REMOTE_ENDPOINT)'), false);
});

test('retired bunny skin is not listed and old config falls back safely', () => {
  assert.equal(registry.includes("id:'bunny-cream'"), false);
  assert.match(store, /cfg\._lastSkinId==='bunny-cream'/);
  assert.match(store, /cfg\._lastSkinId='bear-vivid'/);
});

test('flat glass ball uses the real preview content instead of the blank top crop', () => {
  assert.match(registry, /id:'flat-azure-glass'.*shotPosition:'center center'/);
  assert.match(manager, /object-position:' \+ esc\(s\.shotPosition \|\| 'center top'\)/);
  assert.equal(fs.existsSync(path.join(root, 'components/skin-manager/previews/flat-azure-glass.png')), true);
  assert.equal(fs.existsSync(path.join(root, 'components/skin-manager/previews/bunny-cream.png')), false);
});

test('section hint keeps its translatable text as its own DOM node', () => {
  /* Keep hints in separate text nodes for exact dictionary lookup. */
  assert.match(manager, /<span class="hint">· <span>' \+ esc\(sec\.hint\) \+ '<\/span><\/span>/);
  assert.equal(/class="hint">· [^<]/.test(manager), false);
});

test('applying a skin announces the translated skin name', () => {
  const model = fs.readFileSync(path.join(root, 'components/skin-manager/skin-model.js'), 'utf8');
  assert.match(model, /translateText\(s\.name\)/);
  assert.match(model, /换上「' \+ shownName \+ '」~/);
});

test('non-Chinese locales load localized preview shots with the zh fallback wired', () => {
  /* Load locale-specific previews, then fall back to the original image and failure styling. */
  assert.match(manager, /'components\/skin-manager\/previews\/' \+ esc\(locale\) \+ '\/' \+ esc\(shotFile\) \+ '\.png/);
  assert.match(manager, /data-fallback/);
  assert.match(manager, /this\.src=this\.dataset\.fallback/);
  const locales = ['en-US', 'ja-JP', 'ko-KR'];
  /* Built-in skin previews use shotFile (ruby/flat), falling back to character (bear/box/diamond). */
  const shotFiles = [...registry.matchAll(/\{[^{}]*?id:'([a-z-]+)'[^{}]*?\}/g)]
    .filter(m => /shot:\s*true/.test(m[0]))
    .map(m => { const b = m[0]; return (b.match(/shotFile:\s*'([a-z-]+)'/) || [])[1]
      || (b.match(/character:\s*'([a-z-]+)'/) || [])[1]; })
    .filter(Boolean);
  assert.ok(shotFiles.length >= 6);
  for (const locale of locales) {
    for (const shotFile of [...new Set(shotFiles)]) {
      if (shotFile === 'flat-azure-glass') continue;   /* Reuse text-free previews across locales. */
      const file = path.join(root, 'components/skin-manager/previews', locale, shotFile + '.png');
      assert.equal(fs.existsSync(file), true, 'missing localized preview: ' + file);
      const png = fs.readFileSync(file);
      assert.deepEqual([...png.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'not a PNG: ' + file);
      assert.ok(png.length > 4000, 'suspiciously small preview: ' + file);
    }
  }
});
