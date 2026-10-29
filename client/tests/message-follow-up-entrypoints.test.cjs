'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

for (const entrypoint of ['desk.html', 'index.html']) {
  test(`${entrypoint} loads message follow-up before notification panel`, () => {
    const html = fs.readFileSync(path.join(__dirname, '..', entrypoint), 'utf8');
    const helper = html.indexOf('components/panels/message-follow-up.js');
    const panel = html.indexOf('components/panels/panels-desk.js');
    assert.ok(helper >= 0, 'message follow-up helper script is present');
    assert.ok(panel >= 0, 'notification panel script is present');
    assert.ok(helper < panel, 'helper must load before notification panel');
  });
}
