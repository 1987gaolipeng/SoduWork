'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('local profile preserves the existing identity and display name without a skin service', async () => {
  const values = new Map([['soduwork_work_user_id', 'existing-device'], ['soduwork_work_user_name', 'Existing']]);
  let requests = 0;
  const source = fs.readFileSync(require.resolve('../core/user.js'), 'utf8');
  const load = () => vm.runInNewContext(source + '\nUser;', {
    localStorage: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) },
    fetch: async () => { requests++; throw Error('No skin service is available'); }, console,
  });
  const user = load();
  assert.equal(user.id, 'existing-device');
  assert.equal(user.name, 'Existing');
  assert.equal(await user.setName('Updated'), 'Updated');
  await user.fetchProfile();
  assert.equal(load().name, 'Updated');
  assert.equal(load().id, 'existing-device');
  assert.equal(requests, 0);
});
