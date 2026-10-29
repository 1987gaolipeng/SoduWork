'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { waitForRenderer } = require('../../tools/ci/installed-client-inspection.cjs');

test('installed renderer acceptance waits for actual page load completion', async () => {
  const states = ['loading', 'interactive', 'complete'];
  const observed = [];
  const dom = await waitForRenderer(async (method, params) => {
    assert.equal(method, 'Runtime.evaluate');
    assert.match(params.expression, /document.readyState/);
    const ready = states.shift(); observed.push(ready);
    return { result: { value: { ready, body: 'Rendered application', scripts: 2 } } };
  }, { pollMs: 1 });
  assert.deepEqual(observed, ['loading', 'interactive', 'complete']);
  assert.equal(dom.body, 'Rendered application');
});

test('a renderer that stays loading fails with a bounded timeout', async () => {
  await assert.rejects(waitForRenderer(async () => ({ result: { value: { ready: 'loading' } } }),
    { timeoutMs: 20, pollMs: 1 }), /did not finish loading.*"ready":"loading"/);
});

test('renderer inspection exceptions cannot produce a passing result', async () => {
  await assert.rejects(waitForRenderer(async () => ({ exceptionDetails: { text: 'DOM evaluation failed' } })),
    { code: 'ERR_ASSERTION' });
});

test('a complete navigation with empty application content waits for the real renderer', async () => {
  const states = [
    { ready: 'complete', scripts: 0, body: '' },
    { ready: 'complete', scripts: 2, body: '' },
    { ready: 'complete', scripts: 2, body: 'Rendered application' },
  ];
  let calls = 0;
  const dom = await waitForRenderer(async () => ({ result: { value: states[calls++] } }), { pollMs: 1 });
  assert.equal(calls, 3); assert.equal(dom.body, 'Rendered application');
});

test('a page that remains complete but empty still fails and reports the last state', async () => {
  await assert.rejects(waitForRenderer(async () => ({ result: { value: {
    ready: 'complete', scripts: 2, body: '', url: 'file:///app/index.html',
  } } }), { timeoutMs: 20, pollMs: 1 }), /did not finish loading.*"bodyChars":0.*index.html/);
});
