'use strict';
// Seed a real native upload, then exit without running its in-memory expiry.
const files = require('../../main/app-files.cjs');
const settings = require('../../main/app-settings-store.cjs');
const root = process.argv[2], binding = JSON.parse(process.argv[3]);
const app = {getPath: () => root};
settings.configure({app, ownerOf: () => process.argv[4] || 'account-a'});
const call = (method, params) => files.execute(app, binding, method, params);
(async () => {
  const input = {projectId: 'restart', name: 'pending.bin', type: 'application/octet-stream', size: 3};
  const abandoned = await call('files.begin', input);
  await call('files.append', {id: abandoned.id, offset: 0, data: Buffer.from('old')});
  const recent = await call('files.begin', input);
  await call('files.append', {id: recent.id, offset: 0, data: Buffer.from('new')});
  const saved = await call('files.begin', {...input, projectId: 'preserved', size: 4});
  await call('files.append', {id: saved.id, offset: 0, data: Buffer.from('kept')});
  const file = (await call('files.finish', {id: saved.id})).file;
  process.stdout.write(JSON.stringify({abandoned, recent, file, scope: settings.scope(binding)}) + '\n', () => process.exit(0));
})().catch(error => {console.error(error.message); process.exit(1);});
