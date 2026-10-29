'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const window = {};
vm.runInNewContext(fs.readFileSync(require.resolve('../components/settings/client-update-view.js'), 'utf8'), { window });
const describe = window.ClientUpdateView.describe;
test('release notes are plain text, preserve expansion across progress and clear stale versions', () => {
  const summary = {}, body = { textContent: '' };
  const host = { dataset: {}, open: true, querySelector: selector => selector === 'summary' ? summary : body };
  const render = window.ClientUpdateView.renderReleaseNotes;
  const status = { targetVersion: '2.0.0', releaseNotes: '<img src=x onerror=alert(1)>\n修复问题' };
  render(host, status); assert.equal(host.hidden, false); assert.equal(host.open, false);
  assert.equal(body.textContent, status.releaseNotes); assert.match(summary.textContent, /2.0.0/);
  host.open = true; render(host, { ...status, progress: 50 }); assert.equal(host.open, true);
  render(host, { targetVersion: '2.0.1' }); assert.equal(host.hidden, true); assert.equal(host.open, false);
  assert.equal(body.textContent, ''); render(null, status);
});
test('update view uses real transfer bytes and phase progress, never download 100% for installation', () => {
  const downloading = describe({ state: 'downloading', phase: 'downloading', phaseProgress: 42, receivedBytes: 42 * 1024 ** 2, totalBytes: 100 * 1024 ** 2 });
  assert.equal(downloading.percent, 42); assert.equal(downloading.amount, '42 MB / 100 MB');
  for (const phase of ['preparing', 'installing', 'restarting', 'waiting']) {
    const row = describe({ state: phase === 'waiting' ? 'waiting' : 'installing', phase, progress: 100, phaseProgress: null });
    assert.equal(row.percent, null, phase); assert.equal(row.metrics, '');
  }
  assert.equal(describe({ state: 'downloading', phase: 'verifying', phaseProgress: 17, progress: 99 }).percent, 17);
});
test('old updater payloads stay compatible and failed/current states override stale phase', () => {
  assert.equal(describe({ state: 'downloading', progress: 37 }).percent, 37);
  assert.equal(describe({ state: 'downloaded', targetVersion: '1.2.3' }).installable, true);
  assert.equal(describe({ state: 'failed', phase: 'downloading', progress: 98 }).phase, 'failed');
  assert.equal(describe({ state: 'current', phase: 'restarting' }).visible, false);
  assert.equal(describe({ state: 'downloading', phaseProgress: null }).percent, null);
  assert.equal(describe({ state: 'downloading', progress: Infinity }).percent, null);
});
test('waiting does not invent blocked work or report success, quiet checks stay unobtrusive', () => {
  assert.match(describe({ state: 'waiting', blockers: [] }).detail, /正在确认/);
  assert.match(describe({ state: 'waiting', blockers: [{}, {}] }).detail, /2 项/);
  assert.match(describe({ state: 'waiting', blockers: [{ kind: 'drain-barrier' }] }).detail, /正在确认/);
  assert.match(describe({ state: 'waiting', blockers: [{ kind: 'drain-barrier' }, { kind: 'runtime-cleanup' }] }).detail, /1 项/);
  assert.equal(describe({ state: 'checking' }).visible, false);
  assert.equal(describe({ state: 'checking', interactive: true }).visible, true);
  assert.equal(describe({ state: 'installed' }).stage, 3);
  assert.equal(describe({ state: 'downloaded' }).stage, 2);
});

test('failed automatic checks stay quiet until a real update is known, with errors still available in settings', () => {
  const background = describe({ state: 'failed', interactive: false, error: 'HTTP 503' });
  assert.equal(background.visible, false);
  assert.equal(background.detail, 'HTTP 503');
  assert.equal(describe({ state: 'failed', interactive: true, error: 'HTTP 503' }).visible, true);
  assert.equal(describe({ state: 'failed', interactive: false, targetVersion: '1.12.97', error: 'HTTP 503' }).visible, true);
});
test('ready and waiting remain pending, only an active install highlights the installation step', () => {
  const ready = describe({ state: 'downloaded', targetVersion: '1.2.3', progress: 100 });
  assert.deepEqual(Array.from(ready.steps), ['下载完成', '校验通过', '待重启']);
  assert.equal(ready.currentStage, -1);
  assert.equal(ready.percent, null);
  const waiting = describe({ state: 'waiting', blockers: [{}] });
  assert.equal(waiting.steps[2], '安装前等待');
  assert.equal(waiting.currentStage, -1);
  assert.equal(describe({ state: 'installing', phase: 'installing' }).currentStage, 2);
  assert.equal(describe({ state: 'downloading', phase: 'verifying' }).currentStage, 1);
  const installed = describe({ state: 'installed' });
  assert.equal(installed.steps[2], '安装完成');
  assert.equal(installed.currentStage, -1);
});

function detailsFixture(useEntry) {
  const frames = [], events = [], panel = { scrollTop: 900 };
  const openSettings = () => {
    events.push('settings');
    panel.scrollTop = 0;
    frames.push(() => { panel.scrollTop = 0; });
  };
  const sandbox = {
    openSettings,
    requestAnimationFrame: callback => frames.push(callback),
  };
  if (useEntry) sandbox.openSettingsEntry = () => { events.push('navigation'); openSettings(); };
  const card = { scrollIntoView: () => { panel.scrollTop = 900; events.push('reveal'); } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../components/settings/client-update-view.js'), 'utf8'), {
    window: sandbox,
    document: { getElementById: id => id === 'clientUpdateBadge' ? { closest: () => card }
      : id === 'clientUpdateAction' ? { focus: options => events.push(['focus', options.preventScroll]) } : null },
  });
  sandbox.ClientUpdateView.showDetails();
  while (frames.length) frames.shift()();
  return { events, panel };
}

test('details navigate through the settings entry and reveal the update card after its scroll reset', () => {
  const { events, panel } = detailsFixture(true);
  assert.deepEqual(events, ['navigation', 'settings', 'reveal', ['focus', true]]);
  assert.equal(panel.scrollTop, 900);
});

test('details remain available in standalone settings without the window routing bridge', () => {
  const { events, panel } = detailsFixture(false);
  assert.deepEqual(events, ['settings', 'reveal', ['focus', true]]);
  assert.equal(panel.scrollTop, 900);
});
