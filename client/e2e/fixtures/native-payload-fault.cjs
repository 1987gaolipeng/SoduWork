'use strict';
// Test-only corruption happens AFTER the production build has frozen and checked
// its inputs. Never add a skip-verification option to the production packager.
const fs = require('node:fs/promises'), path = require('node:path');
const os = require('node:os'), assert = require('node:assert/strict');
async function mutateStagedPayload(prepackaged, output, relative, transform) {
  const fixture = path.resolve(prepackaged, '../..');
  assert.equal(path.dirname(fixture), os.tmpdir());
  assert.ok(path.basename(fixture).startsWith('soduwork-update-e2e-'));
  const manifest = JSON.parse(await fs.readFile(path.join(prepackaged, '.soduwork-payload.json')));
  const index = manifest.files.findIndex(item => item.path === relative);
  assert.ok(index >= 0, 'Fixture resource is inventoried: ' + relative);
  const staged = require('../../scripts/native-payload.cjs').stagedSourcePath(output, index);
  const original = await fs.readFile(staged);
  assert.deepEqual(original, await fs.readFile(path.join(prepackaged, relative)));
  await fs.writeFile(staged, transform(original));
}
module.exports = { mutateStagedPayload };
