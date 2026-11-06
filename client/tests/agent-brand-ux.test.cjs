const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const brand = require('../components/panels/agent-brand');

for (const raw of ['@openma/deepseek-harness-acp 0.4.40', '@openma/deepseek-harness-acp@0.4.40', 'v0.4.40', '0.4.40']) {
  const agent = { key: 'runner:local:dsh', version: raw };
  assert.equal(brand.version(agent), '0.4.40');
  assert.equal(agent.version, raw, 'display formatting must not mutate runtime metadata');
}
assert.equal(brand.version({ key: 'dsh', version: '@openma/deepseek-harness-acp 0.5.0-beta.2+build.1' }), '0.5.0-beta.2+build.1');
assert.equal(brand.version({ key: 'dsh', version: 'unknown' }), 'unknown');
assert.equal(brand.version({ key: 'pi', version: '0.84.4' }), '0.84.4');

[
  ['runner:pc-01:pi', 'pi'],
  [{ key: 'codex-harness', name: 'Codex Harness' }, 'codex-harness'],
  [{ cli: 'Claude Code', key: 'runner:pc-01:claude' }, 'claude'],
  ['OpenCode', 'opencode'],
  ['DeepSeek Harness', 'dsh'],
  ['pipeline', 'custom'],
].forEach(([value, expected]) => {
  assert.equal(brand.canonical(value), expected,
    'wrong Agent brand mapping for ' + JSON.stringify(value));
});

const codex = brand.html('codex', { className: 'test-slot' });
assert.match(codex, /agent-brand-codex/);
assert.match(codex, /aria-label="Codex"/);
assert.match(codex, />CX<\/span>/);
assert.match(codex, /test-slot/);

for (const [id, mark] of Object.entries(brand.MONOGRAMS)) {
  const html = brand.html(id);
  assert.ok(html.includes('>' + mark + '</span>'));
  assert.ok(html.includes('aria-label="' + brand.LABELS[id] + '"'));
  assert.doesNotMatch(html, /<img|https?:|assets\//);
}

const agents = fs.readFileSync(path.join(__dirname,
  '../components/panels/panels-agents.js'), 'utf8');
const context = { AgentBrand: brand, addEventListener() {}, esc: value => String(value || '') };
context.window = context;
require('node:vm').runInNewContext(agents, context);
const deepseek = { key: 'dsh', name: 'DeepSeek Harness', installed: true, version: '@openma/deepseek-harness-acp 0.4.40' };
assert.match(context._agRowHtml(deepseek), /class="ag-ver[^"]*"[^>]*>0\.4\.40<\/span>/);
context.fixtureAgents = [deepseek];
require('node:vm').runInContext("_agData = { machines: [{ runnerId: 'local', scope: 'current-instance', agents: fixtureAgents }] }; _agOpen = 'local~dsh'", context);
assert.match(context._agDrawer(), /class="ag-ver">0\.4\.40<\/span>/);
const aidesk = fs.readFileSync(path.join(__dirname,
  '../components/panels/panels-aidesk-office.js'), 'utf8');
const aideskCss = fs.readFileSync(path.join(__dirname,
  '../components/panels/panels-aidesk-office.css'), 'utf8');

assert.match(agents, /AgentBrand\.html\(a, \{ className: 'ag-agent-brand'/,
  'Agent Management must use the shared commercial identity');
[
  'aio-agent-avatar',
  'aio-work-bot',
].forEach((slot) => {
  assert.ok(aidesk.includes("className: '" + slot + "'"),
    'AI Team is missing the shared brand in ' + slot);
  assert.ok(aideskCss.includes('.' + slot + '.agent-brand'),
    'AI Team is missing stable sizing for ' + slot);
});
assert.doesNotMatch(aidesk, /_robotSvg\(/,
  'AI Team must not fall back to decorative robot identities');

for (const htmlName of ['desk.html', 'index.html']) {
  const html = fs.readFileSync(path.join(__dirname, '..', htmlName), 'utf8');
  assert.ok(html.indexOf('components/panels/agent-brand.js') <
    html.indexOf('components/panels/panels-agents.js'),
  htmlName + ' must load the brand contract before Agent Management');
  assert.match(html, /components\/panels\/agent-brand\.css/);
}

console.log('agent brand UX: shared commercial identity passed');
