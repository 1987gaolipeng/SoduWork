'use strict';
// Isolated Chromium regression using real input, selection, paste, and navigation without Hub or model connections.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const client = path.resolve(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-draft-switch-'));
const baseline = process.argv.includes('--baseline');
const out = path.resolve(client, '../outputs/conversation-draft-switch-20261016', baseline ? 'baseline' : 'current');
const read = file => baseline ? require('node:child_process').execFileSync('git', ['show', 'HEAD:client/' + file],
  { cwd: client, encoding: 'utf8' }) : fs.readFileSync(path.join(client, file), 'utf8');
const report = { ok: false, baseline, cases: [], errors: [], boundary: '真实渲染组件；会话与目录响应为隔离夹具，禁止网络和模型调用。' };
app.setPath('userData', path.join(root, 'profile'));
fs.mkdirSync(out, { recursive: true });
let win;
const js = source => win.webContents.executeJavaScript(source, true);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(source) {
  for (let i = 0; i < 120; i++) { if (await js(source)) return; await delay(25); }
  throw Error('等待超时：' + source);
}
async function check(name, run) {
  try { await run(); report.cases.push({ name, ok: true }); }
  catch (error) { report.cases.push({ name, ok: false, error: error.stack }); }
}
async function type(selector, text) {
  await js(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});input.value=${JSON.stringify(text)};
    input.setSelectionRange(input.value.length,input.value.length);input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
}
async function pick(prefix, kind, id) {
  const selector = '#' + prefix + 'Input';
  const value = await js(`document.querySelector(${JSON.stringify(selector)}).value`);
  await type(selector, value + (kind === 'plugin' ? ' /' : ' #') + id);
  const option = kind === 'plugin' ? '.nplugin-option' : '[data-skill-name="' + id + '"]';
  const host = prefix === 'cp' ? '.cp-box' : '.nbox';
  await until(`!!document.querySelector('${host} ${option}')`);
  await js(`document.querySelector('${host} ${option}').click()`);
  await type(selector, value);
}
async function paste(prefix, name) {
  await js(`(()=>{const data=new DataTransfer();data.items.add(new File([Uint8Array.from(atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jxqkAAAAASUVORK5CYII='),c=>c.charCodeAt(0))],
    ${JSON.stringify(name)},{type:'image/png',lastModified:1}));
    document.querySelector('#${prefix}Input').dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));})()`);
}
async function pasteText(prefix, text) {
  const allowed = await js(`(()=>{const input=document.querySelector('#${prefix}Input');input.focus();
    const data=new DataTransfer();data.setData('text/plain',${JSON.stringify(text)});
    return input.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));})()`);
  if (allowed) await win.webContents.insertText(text);
}
async function state(prefix) {
  return js(`(()=>{const host=document.querySelector('${prefix === 'cp' ? '.cp-box' : '.nbox'}');return{
    text:document.querySelector('#${prefix}Input').value,
    plugins:[...host.querySelectorAll('.nplugin-chip:not(.is-action)>span')].map(e=>e.textContent),
    skills:[...host.querySelectorAll('[data-remove-skill]')].map(e=>e.dataset.removeSkill),
    files:[...host.querySelectorAll('[data-catt-remove]')].map(e=>e.dataset.cattName),
    actions:[...host.querySelectorAll('.nplugin-chip.is-action>span')].map(e=>e.textContent)};})()`);
}
app.whenReady().then(async () => {
  win = new BrowserWindow({ show: false, width: 1200, height: 850,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, cb) => cb({ cancel: true }));
  const html = path.join(root, 'fixture.html');
  fs.writeFileSync(html, '<!doctype html><meta charset="utf-8"><base href="' + pathToFileURL(client + path.sep).href + '">');
  await win.loadFile(html);
  await js(`window.fixtureErrors=[];window.notices=[];window.sent=[];window.failSend=false;
    addEventListener('error',e=>fixtureErrors.push(e.message));addEventListener('unhandledrejection',e=>fixtureErrors.push(String(e.reason)));
    window.petSay=value=>notices.push(value);window.owner='one';
    window.snapshot={adapterId:'pi',status:'idle',messages:[],tools:[],execution:{queue:[],turnQueue:{}}};
    window.SoduWorkAPI={online:true,taskStorageKey:()=>owner,pluginCatalog:async()=>({items:[
      {pluginId:'method-a',name:'method-a',personal:true,installed:true,enabled:true},
      {pluginId:'method-b',name:'method-b',personal:true,installed:true,enabled:true}]}),
      myModels:async()=>({usable:[{name:'fixture-model',label:'Fixture'}],defaultModel:'fixture-model'}),listTeammates:async()=>[]};
    window.PluginUIHost={actions:()=>[{actionId:'work.requirement.create',command:'需求',name:'建立需求'}]};
    window.soduWorkAPI={conversationSession:{
      open:async options=>({ok:true,ref:'ref-'+options.chatId,sessionId:options.chatId,snapshot}),
      onEvent:()=>()=>{},release:async()=>({ok:true}),history:async()=>({ok:true,chats:[]}),
      capabilities:async()=>({ok:true,items:[],skills:[{name:'report',selectable:true,installed:true}]}),
      workdir:async()=>({ok:true,dir:''}),setMode:async()=>({ok:true,mode:'full'}),
      probe:async()=>({ok:true}),runtimes:async()=>({ok:true,runtimes:[{id:'pi',displayName:'Pi',goalMode:'native'}]}),
      snapshot:async()=>({ok:true,snapshot}),
      send:async(...args)=>{sent.push(args);return failSend?{ok:false,reason:'隔离发送失败'}:{ok:true,snapshot}},
      attachmentRefs:async()=>({ok:true,attachments:[]})}};void 0;`);
  const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/workbench-annotations.html'), 'utf8');
  const scripts = [...fixture.matchAll(/<script src="\.\.\/\.\.\/([^"]+)"/g)].map(match => match[1]);
  const pickers = ['compose-candidate-navigation.js', 'chat-plugin-mention-model.js', 'chat-plugin-mention.js', 'panels-compose-skills.js'];
  for (const file of pickers) await js(read('components/panels/' + file) + '\nvoid 0;');
  for (const file of scripts) await js(read(file) + '\nvoid 0;');
  for (const file of ['panels-compose-runtime.js', 'panels-compose-capabilities.js', 'panels-compose-model-picker.js',
    'compose-surface.js', 'panels-compose.js']) await js(read('components/panels/' + file) + '\nvoid 0;');
  await js(`openComposePanel({newSession:true})`);
  await type('#cpInput', '新会话的未发送提示词');
  await pick('cp', 'plugin', 'method-a'); await pick('cp', 'skill', 'report');
  await paste('cp', 'new.png'); await paste('cp', 'new.png');
  await js(`document.querySelector('#cpIntentMenu').click()`);
  await type('#cpIntentAcceptance', '保留我填写的完成标准');
  const newDraft = await state('cp');
  assert.deepEqual(newDraft.plugins, ['method-a']); assert.deepEqual(newDraft.skills, ['report']);
  assert.equal(newDraft.files.length, 2);
  await js(`openComposePanel({chatId:'chat-a'})`);
  await type('#nchatInput', '已有会话 A 的未发送提示词');
  await pick('nchat', 'plugin', 'method-b'); await pick('nchat', 'skill', 'report');
  await paste('nchat', 'existing.png');
  const existingDraft = await state('nchat');
  await check('新建会话与已有会话往返三次，正文、图片、插件、技能均保留且不串会话', async () => {
    for (let i = 0; i < 3; i++) {
      await js(`openComposePanel({newSession:true})`);
      assert.deepEqual(await state('cp'), newDraft);
      await js(`openComposePanel({chatId:'chat-a'})`);
      assert.deepEqual(await state('nchat'), existingDraft);
    }
  });
  await check('A→B→A、同会话重入与重复恢复保留原选择且不重复图片', async () => {
    await js(`openComposePanel({chatId:'chat-b'})`);
    assert.deepEqual(await state('nchat'), { text: '', plugins: [], skills: [], files: [], actions: [] });
    await type('#nchatInput', 'B 的独立草稿'); await pick('nchat', 'plugin', 'method-a');
    const b = await state('nchat');
    await js(`openComposePanel({chatId:'chat-a'})`); assert.deepEqual(await state('nchat'), existingDraft);
    await js(`NativeChat.enter('')`); assert.deepEqual(await state('nchat'), existingDraft);
    await js(`openComposePanel({chatId:'chat-b'})`); assert.deepEqual(await state('nchat'), b);
  });
  await check('插件移除后立即重入，不会恢复旧选择', async () => {
    await js(`document.querySelector('.nbox .nplugin-chip button').click();NativeChat.enter('')`);
    assert.deepEqual((await state('nchat')).plugins, []);
  });
  await check('工作动作随未发送草稿恢复', async () => {
    await type('#nchatInput', ' /需求');
    await until(`!!document.querySelector('.nbox .nplugin-option.is-action')`);
    await js(`document.querySelector('.nbox .nplugin-option.is-action').click()`);
    const selected = await state('nchat'); assert.equal(selected.actions.length, 1);
    await js(`openComposePanel({chatId:'chat-a'});void 0;`);
    await js(`openComposePanel({chatId:'chat-b'})`); assert.deepEqual(await state('nchat'), selected);
  });
  await check('目标模式和完成标准随新会话草稿保留', async () => {
    await js(`openComposePanel({newSession:true})`);
    assert.equal(await js(`document.querySelector('.cp-box').dataset.workIntent`), 'goal');
    assert.equal(await js(`document.querySelector('#cpIntentAcceptance').value`), '保留我填写的完成标准');
  });
  await check('显式预填替换新会话草稿，附件与选择不复活', async () => {
    await js(`openComposePanel({newSession:true,prefill:'明确的新内容'})`);
    assert.deepEqual(await state('cp'), { text: '明确的新内容', files: [], plugins: [], skills: [], actions: [] });
  });
  await check('发送成功消费本轮插件和技能，不带入下轮草稿', async () => {
    await js(`openComposePanel({chatId:'chat-b'})`);
    await js(`document.querySelector('.nbox .nplugin-chip.is-action button')?.click()`);
    await type('#nchatInput', '发送这一轮'); await pick('nchat', 'plugin', 'method-a'); await pick('nchat', 'skill', 'report');
    assert.equal(await js(`NativeChat.send()`), true);
    await js(`openComposePanel({chatId:'chat-a'})`); await js(`openComposePanel({chatId:'chat-b'})`);
    assert.deepEqual(await state('nchat'), { text: '', files: [], plugins: [], skills: [], actions: [] });
    assert.deepEqual(await js(`sent.at(-1)[3].skills`), ['report']);
  });
  await check('账号变更同时清空首屏和续聊草稿', async () => {
    await js(`owner='two';dispatchEvent(new Event('soduwork-data-scope-changed'));void 0;`);
    assert.deepEqual(await state('cp'), { text: '', files: [], plugins: [], skills: [], actions: [] });
    await js(`openComposePanel({chatId:'chat-a'})`);
    assert.deepEqual(await state('nchat'), { text: '', files: [], plugins: [], skills: [], actions: [] });
  });
  await check('没有正文的图片、插件和技能草稿也能独立恢复', async () => {
    await js(`openComposePanel({newSession:true})`);
    await pick('cp', 'plugin', 'method-a'); await pick('cp', 'skill', 'report'); await paste('cp', 'only.png');
    const only = await state('cp'); assert.equal(only.text, '');
    await js(`openComposePanel({chatId:'chat-a'})`);
    await js(`openComposePanel({newSession:true})`); assert.deepEqual(await state('cp'), only);
  });
  const longBody = '原始需求：按文件中的数据生成报告。\n' + '保留每一个统计口径和用户给出的约束。'.repeat(110) + '\n最终交付 CSV，不删除尾部要求。';
  await check('首屏长正文卡与后续输入切换恢复一次，点击在文本框中显示后可继续编辑', async () => {
    await js(`openComposePanel({newSession:true,prefill:'前言：'})`);
    await pasteText('cp', longBody);
    assert.equal((await state('cp')).text, '');
    assert.equal((await state('cp')).files.length, 1);
    await type('#cpInput', '\n追加约束');
    const expected = '前言：' + longBody + '\n追加约束';
    assert.equal(await js(`NativeChat.getDraft('new')`), expected);
    await js(`openComposePanel({chatId:'long-draft-a'})`);
    await js(`openComposePanel({newSession:true})`);
    assert.equal((await state('cp')).text, '');
    assert.equal((await state('cp')).files.length, 1);
    await js(`document.querySelector('.cp-box [data-catt-restore]').click()`);
    assert.equal((await state('cp')).text, expected); assert.equal((await state('cp')).files.length, 0);
    await win.webContents.insertText('\n恢复后编辑');
    assert.equal((await state('cp')).text, expected + '\n恢复后编辑');
    assert.equal((await state('cp')).files.length, 0, 'explicit expansion stays editable');
  });
  await check('续聊长正文卡和普通图片往返恢复，正文镜像不含普通附件内容', async () => {
    await js(`openComposePanel({chatId:'long-draft-a'})`);
    await pasteText('nchat', longBody); await paste('nchat', 'long-reference.png');
    await type('#nchatInput', '\n续聊补充');
    await js(`openComposePanel({chatId:'long-draft-b'})`);
    await type('#nchatInput', 'B 的短草稿');
    await js(`openComposePanel({chatId:'long-draft-a'})`);
    const restored = await state('nchat');
    assert.equal(restored.text, ''); assert.equal(restored.files.length, 2);
    assert.equal(restored.files.filter(name => name === 'long-reference.png').length, 1);
    assert.equal(await js(`NativeChat.getDraft('long-draft-a')`), longBody + '\n续聊补充');
    await js(`dispatchEvent(new Event('pagehide'))`);
    const saved = await js(`JSON.parse(localStorage.getItem('soduwork.conversation-drafts.v1')).find(row=>row.key==='long-draft-a')`);
    assert.equal(saved.text, longBody + '\n续聊补充');
    assert.equal(JSON.stringify(saved).includes('long-reference.png'), false);
  });
  await check('新渲染窗口仅凭持久化正文重建文本卡，正文没有重复或截断', async () => {
    const mirror = new BrowserWindow({ show: false, webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false } });
    try {
      await mirror.loadFile(html);
      const evaluate = value => mirror.webContents.executeJavaScript(value, true);
      await evaluate(`document.body.innerHTML='<textarea id="nchatInput"></textarea>';void 0;`);
      for (const file of ['conversation-attachments.js', 'chat-draft-recovery.js'])
        await evaluate(read('components/panels/' + file) + '\nvoid 0;');
      const restored = await evaluate(`(()=>{const input=document.querySelector('#nchatInput');
        const attachments=ConversationAttachments.create({input});
        const context={_draftKey:'long-draft-a',_sessionId:'long-draft-a',_draftStorageKey:'soduwork.conversation-drafts.v1',
          _draftStorageLoaded:false,_conversationDrafts:new Map(),_messageAttachments:attachments};
        ChatDraftRecovery.create(context)._restoreConversationDraft();
        return {text:attachments.submissionText(input.value),files:attachments.files().length,input:input.value};})()`);
      assert.deepEqual(restored, { text: longBody + '\n续聊补充', files: 1, input: '' });
    } finally { mirror.destroy(); }
  });
  await check('长正文发送失败恢复及重试均只包含一次原文，并保留普通图片', async () => {
    await js(`failSend=true;void 0;`);
    assert.equal(await js(`NativeChat.send()`), false);
    const restored = await state('nchat');
    assert.equal(restored.text, ''); assert.equal(restored.files.length, 2);
    assert.equal(await js(`NativeChat.getDraft('long-draft-a')`), longBody + '\n续聊补充');
    assert.equal(await js(`sent.at(-1)[1]`), longBody + '\n续聊补充');
    await js(`failSend=false;void 0;`);
    assert.equal(await js(`NativeChat.send()`), true);
    const sent = await js(`sent.at(-1)`);
    assert.equal(sent[1], longBody + '\n续聊补充'); assert.equal(sent[2].length, 2);
    assert.equal(sent[2].filter(row => row.name === 'long-reference.png').length, 1);
    const textFile = sent[2].find(row => /\.txt$/.test(row.name));
    assert.equal(Buffer.from(textFile.data).toString('utf8'), longBody + '\n续聊补充');
    assert.equal((await state('nchat')).files.length, 0); assert.equal((await state('nchat')).text, '');
  });
  await check('账号切换同时清除长正文卡、展开原文和持久化镜像', async () => {
    await pasteText('nchat', longBody);
    await js(`owner='three';dispatchEvent(new Event('soduwork-data-scope-changed'));dispatchEvent(new Event('pagehide'));void 0;`);
    assert.equal((await state('nchat')).text, ''); assert.equal((await state('nchat')).files.length, 0);
    assert.equal((await state('cp')).text, ''); assert.equal((await state('cp')).files.length, 0);
    assert.equal(await js(`localStorage.getItem('soduwork.conversation-drafts.v1')`), null);
    await js(`openComposePanel({chatId:'long-draft-a'})`);
    assert.equal((await state('nchat')).text, ''); assert.equal((await state('nchat')).files.length, 0);
  });
  report.errors.push(...await js('fixtureErrors'));
  report.ok = report.cases.every(row => row.ok) && !report.errors.length;
}).catch(error => report.errors.push(error.stack)).finally(async () => {
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (win && !win.isDestroyed()) win.destroy();
  app.exit(report.ok ? 0 : 1);
});
