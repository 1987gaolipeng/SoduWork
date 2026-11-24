'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { identity } = require('../../tests/helpers/platform-session-fixture.cjs');
const { scope } = require('../../main/platform-connections/runtime.cjs');
const name = 'created-skill-fixture';
const references = 'Read the supplied sample and preserve its meaning.\n';
const skillChat = 'created-skill-session', otherChat = 'other-session';

function historyFor(app, root, rows = []) {
  const store = require('../../main/conversation/replica-store.cjs').create(path.join(root, 'history.sqlite'));
  const session = {
    async historyEntry(_app, id) {
      const entry = rows.find(row => row.id === id);
      return entry ? { ok: true, entry } : { ok: false, notFound: true };
    },
    archivedConversation: async () => null, findBySessionId: () => null,
  };
  return require('../../main/conversation/shared-history.cjs').create({ app, session, store, identityOf: identity });
}

async function seed(app, root) {
  const source = path.join(root, name);
  fs.mkdirSync(path.join(source, 'references'), { recursive: true });
  fs.writeFileSync(path.join(source, 'SKILL.md'), '---\nname: ' + name +
    '\ndescription: Preserve the meaning of a supplied sample.\n---\n\n# Created skill fixture\n\nRead [the rules](references/rules.md).\n');
  fs.writeFileSync(path.join(source, 'references/rules.md'), references);
  const rows = [skillChat, otherChat].map(id => {
    const cwd = path.join(root, 'workspaces', id);
    fs.mkdirSync(cwd, { recursive: true });
    const archive = path.join(app.getPath('userData'), 'pi-agent', 'sessions', id + '.jsonl');
    fs.mkdirSync(path.dirname(archive), { recursive: true });
    fs.writeFileSync(archive, [
      { type: 'session', id, cwd },
      { type: 'message', message: { role: 'user', content: 'Synthetic task' } },
      { type: 'message', message: { role: 'assistant', content: 'Synthetic answer' } },
    ].map(entry => JSON.stringify(entry)).join('\n'));
    return { id, adapterId: 'pi', path: archive, cwd, count: 2, workOwner: scope(identity()),
      creator: { account: 'one', hub: identity().hub } };
  });
  const history = historyFor(app, root, rows);
  try {
    const cwd = rows[0].cwd, delivery = path.join(cwd, 'delivery');
    const built = require('../../../skills/skill-studio/scripts/skill-package.cjs').build({ source, out: delivery, targets: 'soduwork' });
    const relative = 'delivery/' + built.exports[0].file;
    const bytes = fs.readFileSync(path.join(cwd, relative));
    await history.register(rows);
    await history.backfill(skillChat, { journal: { cwd, turnId: 'skill-turn', files: [{ path: relative, action: 'created',
      after: { path: relative, exists: true, size: bytes.length, hash: crypto.createHash('sha256').update(bytes).digest('hex') } }] } });
    await history.backfill(otherChat);
    fs.writeFileSync(path.join(root, 'package-location.json'), JSON.stringify(relative));
  } finally { await history.close(); }
  // Exercise the SQLite fallback without leaving a live provider transcript.
  for (const row of rows) fs.unlinkSync(row.path);
}

module.exports = { seed, historyFor, skillChat, otherChat, name, references };

if (process.versions.electron && path.resolve(process.argv[1]) === __filename) {
  const { app } = require('electron');
  const root = process.argv[2];
  assert.ok(path.basename(root).startsWith('soduwork-skill-e2e-'));
  app.setPath('userData', path.join(root, 'profile'));
  app.disableHardwareAcceleration();
  app.whenReady().then(() => seed(app, root)).then(() => app.exit(0), error => { console.error(error); app.exit(1); });
}
