'use strict';

// Runs inside requirement-draft-model-handoff.cjs: real Electron DOM and composer,
// isolated public API responses, no model requests and no personal directories.
const assert = require('node:assert/strict');

module.exports = async ({ runCase, js, click, type, until, setup, reloadPage }) => {
  const a = '/isolated-directory-a', b = '/isolated-directory-b';
  const selected = () => js('({agent:ComposeRuntime.value(),model:ComposeModelPicker.value().modelName})');
  const pair = (agent, model) => ({ agent, model });
  async function open(cwd) {
    await js(`openComposePanel(${JSON.stringify({ newSession: true, ...(cwd ? { cwd } : {}) })});void 0;`);
    await js('Promise.resolve(ComposeDirectoryPreferences.ready()).then(()=>true)');
    await js('Promise.all([ComposeRuntime.ready(),ComposeModelPicker.ready()]).then(()=>true)');
  }
  async function fresh(cwd = a) {
    await setup({ defaults: true });
    await js('localStorage.clear();void 0;'); await reloadPage(); await open(cwd);
  }
  async function choose(agent, model) {
    await click('#cpRuntime'); await click(`[data-runtime="${agent}"]`);
    await until(`ComposeRuntime.value()===${JSON.stringify(agent)}`, 'explicit Agent');
    await js('Promise.resolve(ComposeModelPicker.ready()).then(()=>true)');
    await click('#cpModelBtn'); await click(`[data-model="${model}"]`);
    await until(`ComposeModelPicker.value().modelName===${JSON.stringify(model)}`, 'explicit model');
  }
  async function send() {
    const count = await js('calls.sends.length');
    await type('#cpInput', 'Verify this isolated directory selection.'); await click('#cpGo');
    await until(`calls.sends.length===${count + 1}`, 'accepted first message');
    await until("document.querySelector('#composePanel').dataset.stage==='chat'", 'conversation opened');
    // Let the accepted send finish its caller-side preference save.
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  }
  async function pickDirectory(cwd) {
    await js(`soduWorkAPI.conversationSession.pickCwd=async()=>({ok:true,dir:${JSON.stringify(cwd)},name:${JSON.stringify(cwd)}});void 0;`);
    await click('#cpWorkspace'); await click('[data-workspace="pick"]');
    await until(`document.querySelector('#cpWorkspaceName').textContent===${JSON.stringify(cwd)}`, 'chosen workspace');
    await js('Promise.resolve(ComposeDirectoryPreferences.ready()).then(()=>true)');
  }
  async function saveA() { await fresh(); await choose('qwen', 'fixture-chosen'); await send(); }

  await runCase('directory defaults restore complete pairs across reload and manual folder selection', async () => {
    await saveA(); await open(b); await choose('pi', 'fixture-history'); await send();
    await reloadPage(); await open(a);
    assert.deepEqual(await selected(), pair('qwen', 'fixture-chosen'));
    await pickDirectory(b);
    assert.deepEqual(await selected(), pair('pi', 'fixture-history'), 'manual folder picker restores both controls');
    await pickDirectory(a);
    assert.deepEqual(await selected(), pair('qwen', 'fixture-chosen'));
    await send();
    assert.deepEqual(await js('({agent:calls.opens.at(-1).adapterId,model:calls.opens.at(-1).modelName,cwd:calls.opens.at(-1).cwd})'),
      { agent: 'qwen', model: 'fixture-chosen', cwd: a }, 'actual open receives the restored pair and directory');
  });

  await runCase('directory defaults ignore unsent drafts failed starts and historical conversations', async () => {
    await saveA(); await open(a); await choose('pi', 'fixture-history');
    await reloadPage(); await open(a);
    assert.deepEqual(await selected(), pair('qwen', 'fixture-chosen'), 'an unsent draft does not replace the last used pair');
    await choose('pi', 'fixture-history');
    await js("soduWorkAPI.conversationSession.open=async()=>({ok:false,reason:'Fixture start rejected'});void 0;");
    await type('#cpInput', 'This startup must fail.'); await click('#cpGo');
    await until("notices.some(text=>String(text).includes('Fixture start rejected')) || document.body.innerText.includes('Fixture start rejected')", 'visible startup failure');
    await reloadPage(); await open(a);
    assert.deepEqual(await selected(), pair('qwen', 'fixture-chosen'), 'failed session startup does not replace the last used pair');
    await js("openComposePanel({chatId:'history-session'}).then(()=>true)");
    assert.equal(await js("document.querySelector('#nchatModel .nmodel-button span').textContent"), '历史会话模型');
    await open(a);
    assert.deepEqual(await selected(), pair('qwen', 'fixture-chosen'), 'history keeps its own selection without becoming directory default');
  });

  await runCase('directory defaults do not treat a parsed requirement draft as a successful model session', async () => {
    await saveA(); await open(a); await choose('pi', 'fixture-history');
    await type('#cpInput', '/');
    await until("Boolean(document.querySelector('#cpTask .nplugin-option.is-action:not([disabled])'))", 'requirement action');
    await click('#cpTask .nplugin-option.is-action');
    await type('#cpInput', 'Create an isolated requirement draft, without starting its work.');
    const before = await js('calls.sends.length');
    await click('#cpGo'); await until('Boolean(pendingParse)', 'requirement parsing');
    await js("pendingParse('success');void 0;");
    await until("calls.saves.some(row=>row.card.state?.phase==='draft')", 'requirement draft saved');
    assert.equal(await js('calls.sends.length'), before);
    await reloadPage(); await open(a);
    assert.deepEqual(await selected(), pair('qwen', 'fixture-chosen'), 'draft card persistence does not remember an unused model');
  });

  await runCase('directory defaults preserve unavailable models and require an explicit replacement', async () => {
    await saveA(); await reloadPage();
    await js("catalog.usable=models.filter(row=>row.name!=='fixture-chosen');void 0;");
    await open(a);
    assert.equal(await js('ComposeDirectoryPreferences.ready()'), false);
    assert.ok((await js('notices')).length, 'missing saved model is explained');
    await type('#cpInput', 'Do not silently send through a different model.'); await click('#cpGo');
    assert.equal(await js('calls.opens.length'), 0, 'missing remembered model blocks the first session open');
    await reloadPage(); await open(a);
    assert.deepEqual(await selected(), pair('qwen', 'fixture-chosen'), 'temporary unavailability never overwrites saved preference');
    await js("catalog.usable=models.filter(row=>row.name!=='fixture-chosen');void 0;");
    await open(a);
    await choose('pi', 'fixture-default'); await send();
    await reloadPage(); await open(a);
    assert.deepEqual(await selected(), pair('pi', 'fixture-default'), 'only a successful explicit replacement updates the preference');
  });

  await runCase('directory defaults preserve unavailable Agents without silently sending through Pi', async () => {
    await saveA(); await reloadPage();
    await js("runtimeRows=runtimeRows.filter(row=>row.id!=='qwen');void 0;");
    await open(a);
    assert.equal(await js('ComposeDirectoryPreferences.ready()'), false);
    await type('#cpInput', 'Do not substitute another Agent.'); await click('#cpGo');
    assert.equal(await js('calls.opens.length'), 0);
    assert.ok((await js('notices')).length, 'missing saved Agent is explained');
    await reloadPage(); await open(a);
    assert.deepEqual(await selected(), pair('qwen', 'fixture-chosen'));
  });

  await runCase('directory defaults are isolated from temporary workspaces and other account scopes', async () => {
    await saveA(); await open();
    assert.equal(await js("document.querySelector('#cpWorkspaceName').textContent"), '默认工作区');
    await choose('pi', 'fixture-history'); await send();
    await reloadPage(); await open(a);
    assert.deepEqual(await selected(), pair('qwen', 'fixture-chosen'), 'temporary sends do not overwrite a concrete directory');
    await open();
    assert.deepEqual(await selected(), pair('pi', 'fixture-default'), 'unrelated temporary workspaces do not share remembered choices');
    for (const owner of ['other-account', 'other-hub/same-account', 'other-device/same-account']) {
      await js(`fixtureOwner=${JSON.stringify(owner)};dispatchEvent(new Event('soduwork-data-scope-changed'));void 0;`);
      await open(a);
      assert.deepEqual(await selected(), pair('pi', 'fixture-default'), owner + ' must not inherit personal directory preferences');
    }
    await js("fixtureOwner='fixture-owner';dispatchEvent(new Event('soduwork-data-scope-changed'));void 0;");
    await open(a); assert.deepEqual(await selected(), pair('qwen', 'fixture-chosen'));
  });

  await runCase('directory defaults preserve cloud draft choices across local visits and clear them for a new conversation', async () => {
    async function location(value) {
      await click('#cpTask [data-execution-menu]'); await click(`#cpTask [data-execution="${value}"]`);
      await until(`ComposeExecution.value()===${JSON.stringify(value)}`, value + ' execution selected');
      await js('Promise.resolve(ComposeDirectoryPreferences.ready()).then(()=>true)');
      await js('Promise.all([ComposeRuntime.ready(),ComposeModelPicker.ready()]).then(()=>true)');
    }
    await saveA(); await open(a); await location('cloud'); await choose('pi', 'fixture-history');
    assert.equal(await js('ComposeDirectoryPreferences.capture()'), null, 'remote selection cannot be saved under a local path');
    await location('local');
    assert.deepEqual(await selected(), pair('qwen', 'fixture-chosen'), 'local visit restores its own saved pair');
    await pickDirectory(b);
    await location('cloud');
    assert.deepEqual(await selected(), pair('pi', 'fixture-history'), 'local restoration and folder changes preserve the cloud draft');
    await open(a);
    assert.deepEqual(await selected(), pair('qwen', 'fixture-chosen'));
    await location('cloud');
    assert.deepEqual(await selected(), pair('pi', 'fixture-default'), 'a genuinely new conversation starts with a fresh cloud model');
    assert.equal(await js('calls.sends.length'), 1, 'execution switching never starts an extra local or cloud request');
  });

  await runCase('directory defaults discard late model results after directory change or explicit choice', async () => {
    await saveA(); await open(b); await choose('pi', 'fixture-history'); await send();
    await reloadPage();
    await js(`slowCatalog=true;openComposePanel({newSession:true,cwd:${JSON.stringify(a)}});void 0;`);
    await until('Boolean(pendingCatalog)', 'delayed first directory models');
    await js(`slowCatalog=false;openComposePanel({newSession:true,cwd:${JSON.stringify(b)}});void 0;`);
    await until("ComposeRuntime.value()==='pi' && ComposeModelPicker.value().modelName==='fixture-history'", 'second directory restored');
    await js('pendingCatalog();void 0;');
    assert.deepEqual(await selected(), pair('pi', 'fixture-history'), 'late A response cannot overwrite B');
    await reloadPage();
    await js(`slowCatalog=true;openComposePanel({newSession:true,cwd:${JSON.stringify(a)}});void 0;`);
    await until('Boolean(pendingCatalog)', 'delayed saved selection');
    await js('slowCatalog=false;void 0;');
    await choose('qwen', 'fixture-history');
    await js('pendingCatalog();void 0;');
    assert.deepEqual(await selected(), pair('qwen', 'fixture-history'), 'late restore cannot overwrite an explicit user choice');
  });

  await runCase('directory defaults cancel a waiting submission when its request is edited', async () => {
    await fresh(); await reloadPage();
    await js(`slowCatalog=true;openComposePanel({newSession:true,cwd:${JSON.stringify(a)}});void 0;`);
    await until('Boolean(pendingCatalog)', 'initial model directory held');
    await type('#cpInput', '/');
    await until("Boolean(document.querySelector('#cpTask .nplugin-option.is-action:not([disabled])'))", 'requirement action');
    await click('#cpTask .nplugin-option.is-action');
    await type('#cpInput', 'Original request submitted before readiness.'); await click('#cpGo');
    await type('#cpInput', 'New request written while model discovery was pending.');
    await js('pendingCatalog();Promise.resolve(ComposeDirectoryPreferences.ready()).then(()=>true)');
    assert.equal(await js('calls.parse.length'), 0); assert.equal(await js('calls.opens.length'), 0);
    assert.equal(await js("document.querySelector('#cpInput').value"), 'New request written while model discovery was pending.');
    await click('#cpGo'); await until('Boolean(pendingParse)', 'explicit submission of the edited request');
    assert.equal(await js('calls.parse[0].text'), 'New request written while model discovery was pending.');
    await js("pendingParse('success');void 0;");
  });
};
