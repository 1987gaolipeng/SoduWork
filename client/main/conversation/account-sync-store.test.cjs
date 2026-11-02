'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('the durable outbox keeps only the newest complete checkpoint per source session', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-account-sync-'));
  const file = path.join(root, 'outbox.json');
  const store = require('./account-sync-store').create(file);
  const job = revision => ({
    id: 'job-' + revision, ownerKey: 'account', clientId: 'desktop',
    body: { sourceSessionId: 'session', sourceRevision: revision },
  });
  store.enqueue(job(1));
  store.enqueue(job(2));
  assert.deepEqual(store.jobs().map(item => item.body.sourceRevision), [2]);
  fs.rmSync(root, { recursive: true, force: true });
});
