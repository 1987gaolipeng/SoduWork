'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { environment, initialize } = require('../main/managed-runtime.cjs');

test('packaged children use private tools without changing host environment', () => {
  const base = { Path: 'C:\\host', PYTHONPATH: 'C:\\unsafe', PYTHONHOME: 'C:\\old', NODE_OPTIONS: '--inspect', NODE_PATH: 'C:\\modules' };
  const env = environment(base, { platform: 'win32', resourcesPath: 'C:\\SoduWork\\resources', exists: () => true });
  assert.ok(env.Path.startsWith('C:\\SoduWork\\resources\\node;C:\\SoduWork\\resources\\python;'));
  assert.equal(env.PYTHONNOUSERSITE, '1');
  assert.equal(env.SODUWORK_OFFICE_PYTHON, 'C:\\SoduWork\\resources\\python\\python.exe');
  for (const name of ['PYTHONPATH', 'PYTHONHOME', 'NODE_OPTIONS', 'NODE_PATH']) assert.equal(env[name], undefined);
  assert.equal(base.PYTHONPATH, 'C:\\unsafe');
});
test('POSIX runtimes use bin and missing components do not add phantom paths', () => {
  const env = environment({ PATH: '' }, { platform: 'linux', resourcesPath: '/product', exists: file => file === '/product/node/bin/node' });
  assert.equal(env.PATH, '/product/node/bin');
  assert.equal(env.SODUWORK_MANAGED_PYTHON, undefined);
});
test('source development retains its explicit environment', () => {
  const env = { PATH: '/dev', PYTHONPATH: '/dev/libs' };
  initialize({ isPackaged: false }, env, '/product');
  assert.deepEqual(env, { PATH: '/dev', PYTHONPATH: '/dev/libs' });
});
test('Windows PATH aliases and stale Python overrides cannot bypass a missing product runtime', () => {
  const env = environment({ PATH: 'C:\\one', Path: 'C:\\two', SODUWORK_OFFICE_PYTHON: 'evil', SODUWORK_MANAGED_PYTHON: 'evil' },
    { platform: 'win32', resourcesPath: 'C:\\product', exists: () => false });
  assert.equal(Object.keys(env).filter(key => key.toLowerCase() === 'path').length, 1);
  assert.equal(env.SODUWORK_OFFICE_PYTHON, undefined);
  assert.equal(env.SODUWORK_MANAGED_PYTHON, undefined);
  assert.deepEqual(require('../main/conversation/office-engine').pythonCandidates(env, 'win32'), []);
});
