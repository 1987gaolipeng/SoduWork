const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const spec = require('../main/conversation/session-spec');

function resolved() {
  return { capabilityIds: ['browser'], skillDirs: ['skills/base'], warnings: [] };
}

test('conversation permission is frozen from the preflight choice', () => {
  const readonly = spec.build({ mode: 'readonly' }, resolved(), { cwd: 'C:/work', readOnly: false });
  const collaborative = spec.build({ mode: 'full' }, resolved(), { cwd: 'C:/work', readOnly: true });
  const unknown = spec.build({ mode: 'unexpected' }, resolved(), { cwd: 'C:/work', readOnly: true });
  assert.equal(readonly.readOnly, true);
  assert.equal(collaborative.readOnly, false);
  assert.equal(unknown.readOnly, true);
  assert.ok(Object.isFrozen(readonly));
  assert.ok(Object.isFrozen(readonly.capabilityIds));
});

test('conversation keeps the selected workspace and capability contract', () => {
  const current = spec.build({ cwd: 'D:/project', modelName: 'company-model' }, resolved(), { cwd: 'C:/fallback' });
  assert.equal(current.cwd, 'D:/project');
  assert.equal(current.modelName, 'company-model');
  assert.deepEqual(current.capabilityIds, ['browser']);
});

test('new and active conversations share one composer without a blue focus frame', () => {
  const desk = read('desk.html');
  const compose = read('components', 'panels', 'panels-compose.js');
  const chat = read('components', 'panels', 'panels-chat.js');
  const css = read('components', 'panels', 'work-composer.css');
  const theme = read('theme', 'workspace-experience.css');
  const composer = read('components', 'panels', 'work-composer.js');
  assert.match(desk, /work-composer\.js[\s\S]*panels-chat\.js[\s\S]*panels-compose\.js/);
  assert.match(compose, /WorkComposer\.replace/);
  assert.match(compose, /cwd: (?:ctx\.)?_workspace\.direct/);
  assert.match(compose, /accessMode: global\.ComposeRuntime\?\.accessSupported\?\.\(\) \? (?:ctx\.)?_mode/);
  assert.match(compose, /revision === (?:ctx\.)?_setupRevision/);
  assert.match(chat, /WorkComposer\.upgradeChat/);
  assert.match(composer, /wc-tools[\s\S]*o\.context[\s\S]*wc-actions/);
  assert.match(css, /\.work-composer:focus-within\{border-color:[^}]*var\(--line\)/);
  assert.doesNotMatch(css, /\.work-composer:focus-within[^}]*var\(--accent\)/);
  assert.match(theme, /\.cp-box:focus-within\{[^}]*var\(--line\)/);
  assert.doesNotMatch(theme, /\.cp-box:focus-within\{[^}]*var\(--accent\)/);
});

test('temporary work is isolated below the configured root', () => {
  const ipc = read('main', 'pi-session', 'ipc.js');
  assert.match(ipc, /path\.join\(workDir\(app\), 'temp', ref\)/);
  assert.match(ipc, /(?:ctx\.)?_newSessionCwd\(app, ref, opts\)/);
  assert.match(ipc, /pi-session-pick-cwd/);
});
