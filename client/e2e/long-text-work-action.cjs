'use strict';
// Production paste handler -> explicit action selection -> automation form.
// ClipboardEvent + Chromium insertText; no system clipboard, model or Hub access.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const name of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[name];
  const child = require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)], { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => { child.kill(); process.exitCode = 1; }, 60000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-long-text-action-'));
  const client = path.resolve(__dirname, '..'), output = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(client, '../outputs/long-text-work-action-20261014');
  const report = { ok: false, realModel: false, realHub: false, systemClipboardTouched: false, cases: [], errors: [] };
  app.setPath('userData', path.join(root, 'profile'));
  let win;
  const js = code => win.webContents.executeJavaScript(code, true);
  app.whenReady().then(async () => {
    const page = path.join(root, 'fixture.html');
    fs.writeFileSync(page, '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="host"></div>' +
      '<div id="testInputs"><textarea id="cpInput" placeholder="输入新的补充"></textarea><textarea id="nchatInput" placeholder="输入新的补充"></textarea></div></body></html>');
    win = new BrowserWindow({ show: false, width: 1100, height: 900, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
    win.webContents.on('console-message', event => { if (event.level === 'error') report.errors.push(event.message); });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, callback) => callback({ cancel: true }));
    await win.loadFile(page);
    const { pathToFileURL } = require('node:url');
    for (const file of ['theme/variables.css', 'components/panels/plugin-ui-host.css', 'components/panels/work-automation-sheet.css'])
      await js(`new Promise(resolve=>{const style=document.createElement('link');style.rel='stylesheet';style.href=${JSON.stringify(pathToFileURL(path.join(client, file)).href)};style.onload=style.onerror=resolve;document.head.appendChild(style)})`);
    await js(`(()=>{const style=document.createElement('style');style.textContent='body{margin:0;background:var(--bg-0);font-family:var(--font-ui)}#host{max-width:920px;margin:24px auto;padding-bottom:150px}#testInputs{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);width:920px;background:var(--bg-0)}#testInputs textarea{box-sizing:border-box;width:100%;height:88px;padding:14px;border:1px solid var(--line);border-radius:14px;font:inherit;resize:none}';document.head.appendChild(style)})()`);
    for (const name of ['conversation-attachments', 'plugin-ui-host', 'compose-candidate-navigation', 'chat-plugin-mention-model', 'chat-plugin-mention', 'panels-compose-skills', 'panels-compose-work-actions', 'panels-chat-work-actions', 'schedule-timing', 'work-automation-bindings', 'work-automation-view', 'work-automation-card-state','work-automation-sheet'])
      await js(fs.readFileSync(path.join(client, 'components/panels', name + '.js'), 'utf8') + '\nvoid 0;');
    await js(`window.controllers={};window.calls=[];window.errors=[];window.drafts={new:'',chat:''};window.draftKey='new';
      addEventListener('error',e=>errors.push(e.message));addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
      for(const id of ['cpInput','nchatInput']){const input=document.getElementById(id);controllers[id]=ConversationAttachments.create({input});input.addEventListener('input',()=>drafts[draftKey]=input.value)}
      window.SoduWorkAPI={parseTaskText:(text,model,attachments)=>{calls.push({text,attachments});return new Promise(resolve=>window.finishParse=()=>resolve({title:'报表自动化',note:text,checklist:['交付CSV']}))},
        taskExecutionOptions:async()=>({substrates:[{key:'local:pi',name:'Fixture Pi',available:true}],repos:[]})};
      window.NativeChat={prepare(){const input=document.getElementById('nchatInput');input.value=drafts.new;input.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('cpInput').hidden=true;input.hidden=false},
        clearDraft:key=>drafts[key||draftKey]='',openWorkAction:async(command,options)=>WorkAutomationSheet.open({
        host:document.getElementById('host'),text:command.text,...options})}; void 0;`);
    const text = '每日上午9点生成报告。' + '用户原文和执行边界。'.repeat(250) + '\n最后要求：交付CSV';
    for (const id of ['cpInput', 'nchatInput']) {
      for (const selectedAction of [false, true]) {
        const pasted = selectedAction ? text : '/自动化 ' + text;
        await js(`draftKey=${JSON.stringify(id === 'cpInput' ? 'new' : 'chat')};finishParse=null;document.getElementById('cpInput').hidden=${id !== 'cpInput'};document.getElementById('nchatInput').hidden=${id !== 'nchatInput'};void 0;`);
        const allowed = await js(`(()=>{const input=document.getElementById('${id}');input.value='';input.focus();
          const data=new DataTransfer();data.setData('text/plain',${JSON.stringify(pasted)});
          return input.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}))})()`);
        assert.equal(allowed, true);
        await win.webContents.insertText(pasted);
        assert.equal(await js(`document.getElementById('${id}').value`), pasted);
        await js(`window.routeOptions={text:document.getElementById('${id}').value,input:document.getElementById('${id}'),
          hasAttachments:controllers.${id}.has(),attachments:controllers.${id}};
          window.selectedAction=${selectedAction ? "PluginUIHost.actions().find(row=>row.id==='work.automation.create')" : 'null'};
          routeOptions.${id === 'cpInput' ? 'pluginMention' : 'mention'}={action:()=>window.selectedAction};
          window.callCountBefore=calls.length;
          window.pendingRoute=${id === 'cpInput' ? 'ComposeWorkActions.route(routeOptions)' : 'ChatWorkActions.route(routeOptions,{open:NativeChat.openWorkAction})'};void 0;`);
        if (!selectedAction) {
          assert.equal((await js('pendingRoute')).handled, false);
          assert.equal(await js(`document.getElementById('${id}').value`), pasted);
          assert.equal(await js('drafts[draftKey]'), pasted);
          assert.equal(await js('calls.length === callCountBefore'), true);
          assert.equal(await js('Boolean(window.finishParse)'), false);
          assert.equal(await js('Boolean(document.querySelector(".waz-layer"))'), false);
          report.cases.push({ input: id, selectedAction, literalSlashBodyPreserved: true, parserNotStarted: true });
          continue;
        }
        const deadline = Date.now() + 5000;
        while (!await js('Boolean(window.finishParse)')) {
          if (Date.now() >= deadline) throw Error('Parser did not start');
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        const during = await js(`({input:document.getElementById('${id}').value,nativeInput:document.getElementById('nchatInput').value,
          draft:drafts[draftKey],full:document.querySelector('.pui-prompt-full')?.textContent,
          expanded:document.querySelector('.pui-prompt-long')?.open,
          bubbleHeight:document.querySelector('.pui-turn-prompt-bubble').getBoundingClientRect().height})`);
        assert.equal(during.input, ''); assert.equal(during.nativeInput, ''); assert.equal(during.draft, '');
        assert.equal(during.expanded, false); assert.ok(during.bubbleHeight < 160);
        assert.equal(during.full, '【自动化】：' + text);
        const firstSelected = !report.cases.some(row => row.selectedAction);
        await js(`document.querySelector('.pui-prompt-long summary').focus();void 0;`);
        win.webContents.focus();
        assert.equal(await js('document.activeElement.tagName'), 'SUMMARY');
        for (const type of ['keyDown', 'char', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: type === 'char' ? '\r' : 'Return' });
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(await js(`document.querySelector('.pui-prompt-long').open`), true, 'keyboard can expand the full prompt');
        for (const type of ['keyDown', 'char', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: type === 'char' ? '\r' : 'Return' });
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(await js(`document.querySelector('.pui-prompt-long').open`), false);
        fs.mkdirSync(output, { recursive: true });
        if (firstSelected) {
          await new Promise(resolve => setTimeout(resolve, 120));
          fs.writeFileSync(path.join(output, 'collapsed.png'), (await win.webContents.capturePage()).toPNG());
        }
        await js(`document.querySelector('.pui-prompt-long summary').click();void 0;`);
        assert.equal(await js(`document.querySelector('.pui-prompt-long').open`), true);
        if (firstSelected) {
          await new Promise(resolve => setTimeout(resolve, 120));
          fs.writeFileSync(path.join(output, 'expanded.png'), (await win.webContents.capturePage()).toPNG());
        }
        await js(`(()=>{document.querySelector('.pui-prompt-long summary').click();const input=document.getElementById('nchatInput');input.value='下一条补充';input.dispatchEvent(new Event('input',{bubbles:true}));finishParse()})()`);
        assert.equal((await js('pendingRoute')).accepted, true);
        assert.equal(await js(`document.getElementById('nchatInput').value`), '下一条补充');
        assert.equal(await js(`drafts[draftKey]`), '下一条补充');
        const actual = await js(`({request:calls.at(-1),note:document.querySelector('#wazForm textarea[name="note"]').value})`);
        assert.equal(actual.request.text, text);
        assert.deepEqual(actual.request.attachments, []);
        assert.equal(actual.note, text);
        report.cases.push({ input: id, selectedAction, longInstructionReachedParserAndForm: true,
          clearedBeforeParserFinished: true, nextDraftPreserved: true, foldedAndExpandable: true });
        await js('WorkAutomationSheet.close(true); void 0;');
      }
    }
    assert.deepEqual(await js('errors'), []);
    report.ok = true;
  }).catch(error => { report.errors.push(error.stack); }).finally(() => {
    fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report)); win?.destroy(); app.exit(report.ok ? 0 : 1);
  });
}
