'use strict';
// Compare production menu and message-plugin styles using temporary data, a stub directory, and blocked external networking.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const child = require('node:child_process').spawn(electron,[__filename,...process.argv.slice(2)],{env,windowsHide:true,stdio:'inherit'});
  const timer = setTimeout(()=>child.kill(),30000);
  child.on('exit',code=>{clearTimeout(timer);process.exitCode=code??1;});
} else {
  const {app,BrowserWindow}=electron, fs=require('node:fs'), path=require('node:path'), os=require('node:os'), assert=require('node:assert/strict');
  const {pathToFileURL}=require('node:url'), client=path.resolve(__dirname,'..');
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-plugin-appearance-'));
  const out=path.resolve(process.argv[2]||path.join(client,'../outputs/message-plugin-appearance-20261016'));
  fs.mkdirSync(out,{recursive:true}); app.setPath('userData',path.join(temp,'profile'));
  let win; const report={ok:false,checks:[],network:[]};
  const js=code=>win.webContents.executeJavaScript(code,true);
  app.whenReady().then(async()=>{
    const css=[...fs.readFileSync(path.join(client,'desk.html'),'utf8').matchAll(/<link\b[^>]*href=["']([^"']+\.css)["'][^>]*>/g)].map(m=>m[1]);
    const file=path.join(temp,'fixture.html');
    fs.writeFileSync(file,'<!doctype html><html><head><meta charset="utf-8">'+css.map(p=>'<link rel="stylesheet" href="'+pathToFileURL(path.join(client,p)).href+'">').join('')+
      '<style>body{padding:24px;overflow:auto}#message{max-width:760px;margin:0 auto 30px}#menu{max-width:760px;margin:auto;padding:12px;border:1px solid var(--line);border-radius:12px}h3{margin:12px;color:var(--ink-3)}</style></head>'+
      '<body><div id="message"><div class="nmsg user"><div class="nbubble">制作插件：帮我设计小游戏插件</div><div class="nmessage-plugins" id="badges"></div></div></div><section id="menu"><h3>＋ 菜单中的插件</h3><div id="rows"></div></section></body></html>');
    win=new BrowserWindow({show:false,width:1000,height:660,webPreferences:{offscreen:true,contextIsolation:true,nodeIntegration:false}});
    win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(r,cb)=>{report.network.push(r.url);cb({cancel:true});});
    await win.loadFile(file);
    for(const p of ['core/plugin-icon.js','components/panels/chat-plugin-mention-model.js','components/panels/work-composer.js','components/panels/chat-message-plugins.js']) await js(fs.readFileSync(path.join(client,p),'utf8')+'\nvoid 0;');
    await js(`window.items=[{pluginId:'builder',name:'插件开发助手',conversationCapabilities:{skills:['builder']},description:'把工作方法整理为可安装、可发布的插件'},
      {pluginId:'flow',name:'产品孵化',capabilities:{executionMode:'workflow'}},
      {pluginId:'custom',name:'自定义图标插件',icon:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jxqkAAAAASUVORK5CYII='}];
      window.ChatPluginMention={availability:()=>({available:true})};
      window.SoduWorkAPI={pluginCatalog:async()=>({items})};
      window.escapeText=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      window.paint=()=>{badges.innerHTML=badgeView.html(items);rows.innerHTML=WorkComposer.pluginRows(ChatPluginMentionModel.normalizeCatalog({items}),[])};
      window.badgeView=ChatMessagePlugins.create({esc:escapeText,_ref:'fixture'},paint);paint();void 0;`);
    await new Promise(r=>setTimeout(r,150));
    const same=await js(`items.map((_,index)=>{const a=document.querySelectorAll('.nmessage-plugin .wc-plugin-icon')[index],b=document.querySelectorAll('.wc-more-plugin .wc-plugin-icon')[index];
      const style=e=>{const c=getComputedStyle(e);return [c.width,c.height,c.borderRadius,c.color].join('|')};return a.innerHTML===b.innerHTML&&style(a)===style(b)})`);
    assert.ok(same.every(Boolean)); report.checks.push('默认技能、工作流及自定义 PNG：图标内容、尺寸、圆角、颜色与加号菜单相同');
    assert.equal(await js(`[...document.querySelectorAll('.nmessage-plugin .wc-plugin-icon')].every(e=>getComputedStyle(e).backgroundColor==='rgba(0, 0, 0, 0)')`),true);
    assert.equal(await js(`[...document.querySelectorAll('.wc-more-plugin .wc-plugin-icon')].every(e=>getComputedStyle(e).backgroundColor!=='rgba(0, 0, 0, 0)')`),true);
    report.checks.push('消息中的关联图标背景透明，加号菜单原有图标底色保留');
    assert.equal(await js('getComputedStyle(document.querySelector(".nmessage-plugin"),"::before").content'),'none');
    assert.equal(await js('getComputedStyle(document.querySelector(".nmessage-plugin")).borderTopWidth'),'0px');
    report.checks.push('没有斜杠伪图标和外层描边');
    fs.writeFileSync(path.join(out,'comparison.png'),(await win.webContents.capturePage()).toPNG());
    win.setContentSize(420,660);
    await new Promise(r=>setTimeout(r,150));
    await js(`items[0].name='很长的插件名称'.repeat(20);paint();void 0;`);
    const bounds=await js(`(()=>{const root=document.querySelector('#badges'),r=root.getBoundingClientRect();return {overflow:root.scrollWidth>root.clientWidth+1,
      within:[...root.children].every(e=>e.getBoundingClientRect().right<=r.right+1),full:root.firstChild.title.includes(items[0].name)}})()`);
    assert.deepEqual(bounds,{overflow:false,within:true,full:true}); report.checks.push('窄窗口多插件换行、长名称省略且完整名称可查看');
    fs.writeFileSync(path.join(out,'narrow.png'),(await win.webContents.capturePage()).toPNG());
    assert.deepEqual(report.network,[]); report.ok=true;
  }).catch(error=>{report.error=String(error.stack||error);}).finally(()=>{
    fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));win?.destroy();app.exit(report.ok?0:1);
  });
}
