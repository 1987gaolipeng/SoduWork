const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const brand = require('../components/panels/agent-brand');

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
