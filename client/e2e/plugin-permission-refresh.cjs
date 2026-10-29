'use strict';
// Production detail renderer and policy listener, with in-memory API replies.
// No model, business backend, logged-in profile or external network is used.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-plugin-permission-'));
  const child = spawn(require('../node_modules/electron'), [__filename, profile],
    { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => {
    process.exitCode = code || 0;
    const target = path.resolve(profile), temporary = path.resolve(os.tmpdir()) + path.sep;
    if (!target.startsWith(temporary) || !path.basename(target).startsWith('soduwork-plugin-permission-')) {
      throw Error('Unexpected isolated profile path');
    }
    fs.rmSync(target, { recursive: true, force: true });
  });
} else {
  const assert = require('node:assert/strict');
  const { app, BrowserWindow } = require('electron');
  const profile = process.argv[2];
  if (!profile || !path.resolve(profile).startsWith(path.resolve(os.tmpdir()) + path.sep)) {
    throw Error('Explicit isolated temporary profile required');
  }
  app.setPath('userData', profile); app.disableHardwareAcceleration();
  let win;
  const js = code => win.webContents.executeJavaScript(code, true);
  const checks = [];
  async function wait(code, name) {
    for (let i = 0; i < 100; i++) {
      if (await js(code)) { checks.push(name); return; }
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw Error('Timed out: ' + name);
  }
  app.whenReady().then(async () => {
    win = new BrowserWindow({ show: false, width: 1100, height: 800,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
    await win.loadFile(path.join(__dirname, '../tests/plugin-presentation.html'));
    await js(fs.readFileSync(path.join(__dirname, '../components/panels/plugin-access.js'), 'utf8'));
    await js(`(async () => {
      window.accessRights = {canUse:false,canEdit:true};
      window.accessItem = {...structuredClone(fixtureItems[1]),installed:false,
        installationState:'available',permissions:{...accessRights}};
      SoduWorkAPI.pluginCatalog = async () => ({items:[structuredClone(accessItem)],submissions:[],categories:[]});
      SoduWorkAPI.enterprisePluginPermissions = async () => ({...accessRights});
      window.pushRights = next => {
        accessRights = next; accessItem.permissions = {...next};
        dispatchEvent(new CustomEvent('soduwork-plugin-policy',{detail:{pluginId:accessItem.pluginId}}));
      };
      await openCapabilityPanel();
      document.querySelector('[data-plugin="enterprise-0"]').click();
      document.querySelector('#capDetailResourcesTab').click();
    })()`);
    assert.equal(await js('Boolean(document.querySelector("#capEnterpriseInstall"))'), false);
    assert.equal(await js('document.querySelector("[data-lifecycle]").dataset.lifecycle'), 'editOnly');
    await js('pushRights({canUse:true,canEdit:true})');
    await wait('Boolean(document.querySelector("#capEnterpriseInstall"))', 'grant creates installation action in the open detail');
    assert.equal(await js('document.querySelector("#capEnterpriseInstall").disabled'), false);
    assert.equal(await js('document.querySelector("#capDetailResourcesTab").getAttribute("aria-selected")'), 'true');
    assert.equal(await js('document.querySelector("[data-lifecycle]").dataset.lifecycle'), 'install');
    await js('pushRights({canUse:true,canEdit:false})');
    await wait('document.querySelector("#capEnterpriseEdit").hidden', 'withdrawing edit hides authoring independently of use');
    await js('pushRights({canUse:false,canEdit:true})');
    await wait('!document.querySelector("#capEnterpriseInstall") && !document.querySelector("#capEnterpriseEdit").hidden',
      'withdrawing use preserves granted authoring and removes installation');
    await js(`accessItem.dependencyReadiness = {missingMcp:['company-connector'],requiredMcp:['company-connector'],availableMcp:[]};
      accessItem.marketPolicy = {installation:'available',authentication:'on_install'};
      pushRights({canUse:true,canEdit:true})`);
    await wait('Boolean(document.querySelector("#capEnterpriseInstall"))', 'use grant refreshes dependency state');
    assert.equal(await js('document.querySelector("#capEnterpriseInstall").disabled'), true);
    await js('pushRights({canUse:false,canEdit:false})');
    await wait('document.querySelector("[data-lifecycle]").dataset.lifecycle === "permissionDenied"', 'revocation refreshes lifecycle');
    await js(`window.previewEffects=[];window.soduWorkAPI=window.soduWorkAPI||{};
      soduWorkAPI.workPreview={show:async()=>{previewEffects.push('show');return {ok:true}},
        updateBounds(){},onState:()=>()=>{},destroy:()=>previewEffects.push('destroy'),
        command:()=>previewEffects.push('command')};
      accessItem.installed=true;accessItem.dependencyReadiness={missingMcp:[]};
      accessItem.ui={contributions:[{id:'ui',slot:'task.detail.tab',source:{type:'external',url:'https://example.invalid/'}}]};
      pushRights({canUse:true,canEdit:true});`);
    await wait('Boolean(document.querySelector("#capPluginOpenUI"))', 'installed UI plugin receives its authorized open action');
    await js('document.querySelector("#capPluginOpenUI").click()');
    await wait('previewEffects.includes("show")', 'authorized UI mounts its isolated preview');
    await js(`window.delayedUiRights=[];SoduWorkAPI.enterprisePluginPermissions=()=>new Promise(resolve=>delayedUiRights.push(resolve));
      pushRights({canUse:false,canEdit:true});pushRights({canUse:true,canEdit:true});`);
    await wait('delayedUiRights.length===4', 'open UI policy checks can finish out of order');
    await js(`delayedUiRights[2]({canUse:true,canEdit:true});delayedUiRights[3]({canUse:true,canEdit:true});`);
    await new Promise(resolve => setTimeout(resolve,30));
    await js(`delayedUiRights[0]({canUse:false,canEdit:true});delayedUiRights[1]({canUse:false,canEdit:true});
      SoduWorkAPI.enterprisePluginPermissions=async()=>({...accessRights});void 0;`);
    await new Promise(resolve => setTimeout(resolve,30));
    assert.equal(await js('Boolean(document.querySelector(".pui-layer-external"))'),true);
    checks.push('late older denial cannot close the currently authorized UI');
    // A lost policy event cannot leave already-open UI commands authorized.
    await js(`accessRights={canUse:false,canEdit:true};document.querySelector('.pui-external-actions button').click()`);
    await wait('previewEffects.includes("destroy")', 'already-open UI reload checks current authority and destroys denied preview');
    await js(`document.querySelectorAll('.pui-external-actions button')[1].click()`);
    await new Promise(resolve => setTimeout(resolve,50));
    assert.equal(await js('previewEffects.includes("command")'),false);
    await js('pushRights({canUse:false,canEdit:true})');
    await wait('!document.querySelector(".pui-layer-external") && !document.querySelector("#capPluginOpenUI")',
      'withdrawal closes the live UI and removes its detail entry while preserving edit');
    await js(`SoduWorkAPI.pluginCatalog = () => new Promise(resolve => {window.completeAccessCatalog=resolve});
      pushRights({canUse:true,canEdit:true});`);
    await wait('typeof completeAccessCatalog === "function"', 'catalog response can be held for stale-modal check');
    await js(`document.querySelector('#capModalClose').click();
      completeAccessCatalog({items:[structuredClone(accessItem)],submissions:[],categories:[]});`);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await js('document.querySelector("#capModalLayer").hidden'), true);
    assert.deepEqual(await js('fixtureErrors'), []);
    checks.push('closed modal stays closed after delayed grant');
    console.log(JSON.stringify({ ok: true, checks }, null, 2));
    app.exit(0);
  }).catch(error => { console.error(error); app.exit(1); });
}
