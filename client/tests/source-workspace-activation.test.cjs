'use strict';

const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { listen } = require('../main/source-workspace-activation.cjs');

function profile(t) {
  const app = new EventEmitter();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-activate-'));
  app.getPath = name => { assert.equal(name, 'userData'); return directory; };
  t.after(() => {
    app.emit('before-quit');
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { app, file: path.join(directory, 'source-workspace-activation.json') };
}

async function ready(file, previous) {
  const deadline = Date.now() + 3000;
  do {
    if (fs.existsSync(file)) {
      const contents = fs.readFileSync(file, 'utf8');
      if (contents !== previous) return JSON.parse(contents);
    }
    await delay(10);
  } while (Date.now() < deadline);
  assert.fail('Workspace activation descriptor was not published');
}

// A fresh client socket models a separate invocation of the source launcher.
function send(port, packet, timeout) {
  return new Promise((resolve, reject) => {
    const client = dgram.createSocket('udp4');
    const timer = setTimeout(() => { client.close(); resolve(null); }, timeout);
    client.once('error', error => { clearTimeout(timer); client.close(); reject(error); });
    client.once('message', message => { clearTimeout(timer); client.close(); resolve(message.toString()); });
    client.send(packet, port, '127.0.0.1');
  });
}

test('only valid requests for a live source desktop receive a workspace acknowledgement', async t => {
  const { app, file } = profile(t);
  let available = true, opens = 0;
  listen(app, () => { if (!available) return false; opens++; return true; });
  const { port, token } = await ready(file);
  const request = 'open-workspace ' + token;
  assert.match(token, /^[a-f0-9]{64}$/);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(await send(port, 'open-workspace wrong-session', 100), null);
  assert.equal(await send(port, 'quit ' + token, 100), null);
  assert.equal(opens, 0);
  assert.deepEqual(await Promise.all([send(port, request, 2000), send(port, request, 2000)]), ['opened', 'opened']);
  assert.equal(opens, 2);
  available = false;
  assert.equal(await send(port, request, 100), null);
  app.emit('before-quit');
  assert.equal(fs.existsSync(file), false);
  assert.equal(await send(port, request, 100), null);
  assert.equal(opens, 2);
});

test('quitting before publication and a replaced descriptor both clean up only the old listener', async t => {
  const { app, file } = profile(t);
  listen(app, () => true);
  app.emit('before-quit');
  await delay(20);
  assert.equal(fs.existsSync(file), false);

  listen(app, () => true);
  await ready(file);
  const replacement = JSON.stringify({ token: 'new-session' });
  fs.writeFileSync(file, replacement);
  app.emit('before-quit');
  assert.equal(fs.readFileSync(file, 'utf8'), replacement);
});

test('publishes a private descriptor when same-directory rename fails without overwriting a linked file', async t => {
  const { app, file } = profile(t);
  const directory = path.dirname(file);
  const original = path.join(directory, 'original.json');
  const stale = '{"token":"expired"}';
  fs.writeFileSync(original, stale);
  fs.linkSync(original, file);
  t.mock.method(fs, 'renameSync', () => {
    throw Object.assign(new Error('Cross-device rename'), { code: 'EXDEV' });
  });

  listen(app, () => true);
  const { port, token } = await ready(file, stale);
  assert.equal(fs.readFileSync(original, 'utf8'), stale);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(await send(port, 'open-workspace ' + token, 2000), 'opened');
  app.emit('before-quit');
  assert.deepEqual(fs.readdirSync(directory), ['original.json']);
});
