'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sessionEvents = require('../main/pi-session/session-events');
const fileChangeJournal = require('../main/conversation/file-change-journal');

test('a stalled workspace snapshot is aborted at the session journal deadline', async () => {
  let signal;
  const pending = sessionEvents._snapshotWithTimeout({
    snapshot(_cwd, options) {
      signal = options.signal;
      return new Promise(() => {});
    },
  }, 'fixture-workspace', 5);

  await assert.rejects(pending, error =>
    error && error.code === 'SODUWORK_JOURNAL_SNAPSHOT_TIMEOUT');
  assert.equal(signal.aborted, true);
});

test('the file change journal honors an already cancelled snapshot', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fileChangeJournal.snapshot('.', { signal: controller.signal }), error =>
    error && error.name === 'AbortError' && error.code === 'ABORT_ERR');
});
