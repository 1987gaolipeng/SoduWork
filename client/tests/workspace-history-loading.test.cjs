'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
for (const folder of ['', 'tests', 'e2e/fixtures']) {
  for (const name of fs.readdirSync(path.join(root, folder)).filter(n => n.endsWith('.html'))) {
    const file = path.join(root, folder, name), source = fs.readFileSync(file, 'utf8');
    const match = source.match(/<script src="([^"]*)workspace-shell\.js"><\/script>/);
    if (!match) continue;
    test(`${folder}/${name} loads history before workspace shell`, () => {
      const history = `<script src="${match[1]}workspace-chat-history.js"></script>`;
      assert.ok(source.indexOf(history) >= 0 && source.indexOf(history) < match.index);
    });
  }
}
