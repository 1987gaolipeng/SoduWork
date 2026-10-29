// Real Hub issuer with a disposable signing key; no database, account or network access.
'use strict';
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
let fixtures;
const backend = path.resolve(__dirname, '../../../hub-backend');
const python = process.env.SODUWORK_TEST_PYTHON || path.join(backend, '.venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
function backendAvailable() { return !!process.env.SODUWORK_TEST_PYTHON || fs.existsSync(python); }
function backendSessions() {
  if (fixtures) return fixtures;
  const code = `
import json, time
from types import SimpleNamespace
from app import auth
from app.services.device_auth import issue_session
# Never use the configured Hub signing key in a fixture.
auth.get_settings = lambda: SimpleNamespace(auth_secret='isolated-platform-session-contract-key')
def issue(uid, cid='device'):
    token, ttl = issue_session(SimpleNamespace(id=cid, user_ref=uid, auth_state='active', auth_version=1))
    assert auth.verify_claims(token, token_type='device')['uid'] == uid
    return token
one = issue('one')
claims = auth.verify_claims(one, token_type='device')
def variant(patch, typ='device', issued_at=None):
    return auth.sign_claims({**claims, **patch}, ttl_seconds=1800, token_type=typ, issued_at=issued_at)
print(json.dumps(dict(one=one, two=issue('two'), otherDevice=issue('one', 'device-two'),
    renewed=issue('one'), expired=variant({}, issued_at=int(time.time())-3600),
    future=variant({}, issued_at=int(time.time())+3600),
    wrongType=variant({}, typ='user'), missingUid=variant({'uid': ''}))))
`;
  const result = spawnSync(python, ['-c', code], {
    cwd: backend, env: { ...process.env, PYTHONIOENCODING: 'utf-8',
      DATABASE_URL: 'sqlite+aiosqlite:///:memory:', CLUSTER_REDIS_URL: '',
      AUTH_SECRET: 'isolated-platform-session-fixture-key', ADMIN_PASS: 'isolated-platform-session-fixture-password' },
    encoding: 'utf8', windowsHide: true, shell: false, timeout: 30000,
  });
  if (result.error || result.status !== 0) throw Error('Hub session fixture failed: ' + (result.error?.message || result.stderr));
  fixtures = JSON.parse(result.stdout);
  return fixtures;
}
// Node-only unit fixtures match the wire format. The contract test and Electron
// suite below require backendSessions() to catch drift in the real Hub issuer.
function sessions() {
  const now = Math.floor(Date.now() / 1000);
  const token = (patch = {}) => Buffer.from(JSON.stringify({ uid: 'one', cid: 'device',
    typ: 'device', iat: now, exp: now + 1800, jti: 'fixture', ...patch })).toString('base64url') + '.' + 'a'.repeat(64);
  return { one: token(), two: token({ uid: 'two' }), otherDevice: token({ cid: 'device-two' }),
    renewed: token({ jti: 'renewed' }), expired: token({ iat: now - 3600, exp: now - 1800 }),
    future: token({ iat: now + 3600, exp: now + 5400 }), wrongType: token({ typ: 'user' }), missingUid: token({ uid: '' }) };
}
function identity(uid = 'one') {
  const session = sessions()[uid];
  if (!session) throw Error('Unknown isolated user');
  return { hub: 'https://fixture.invalid', clientId: 'device', session };
}
module.exports = { sessions, identity, backendSessions, backendAvailable };
