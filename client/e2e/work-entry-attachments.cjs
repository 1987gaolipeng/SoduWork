'use strict';
// Production sheet, attachment controller, library transfer and CSS in Chromium.
// Only external APIs are replaced; the profile is disposable and all network is blocked.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const child = require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)],
    { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill(), 60000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
  const client = path.resolve(__dirname, '..');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-attachments-e2e-'));
  const out = path.resolve(process.argv[2] || path.join(client, '../outputs/requirement-routing-fix-20261015/attachments'));
  fs.mkdirSync(out, { recursive: true }); app.setPath('userData', path.join(temporary, 'profile'));
  const report = { ok: false, layouts: [], actions: [], errors: [] };
  let win;
  const js = code => win.webContents.executeJavaScript(code, true).catch(error => { report.failedScript=code.slice(0,500);throw error; });
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(code) {
    for (let i = 0; i < 150; i++) { if (await js(code)) return; await delay(20); }
    throw Error('Timed out: ' + code);
  }
  async function click(selector) {
    await js(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`);
    await delay(220);
    const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();
      const p={x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};
      if(!e.contains(document.elementFromPoint(p.x,p.y)))throw Error('Covered button');return p})()`);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({type, ...point, button:'left', clickCount:1});
    await delay(30);
  }
  async function measure(name, width) {
    win.setContentSize(width, 1050); await delay(120);
    await js("document.querySelector('.wes-attach-zone').scrollIntoView({block:'center'})");
    const metrics = await js(`(()=>{
      const box=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};
      const rows=Array.from(document.querySelectorAll('#wesAttachTray .catt-item')).map(e=>{
        const badge=e.querySelector('.catt-file,.catt-dir,img'),copy=e.querySelector('.catt-copy'),name=e.querySelector('b'),state=e.querySelector('.catt-library-state');
        const range=document.createRange();range.selectNodeContents(badge);
        return {box:box(e),badge:box(badge),badgeText:badge.matches('.catt-file')?box(range):null,
          copy:copy?box(copy):null,name:name?box(name):null,imageTile:e.classList.contains('catt-image'),
          state:state?box(state):null,status:state?.innerText,text:name?.textContent,title:name?.title,remove:box(e.querySelector('[data-catt-remove]'))};
      });return {width:innerWidth,zone:box(document.querySelector('.wes-attach-zone')),tray:box(document.querySelector('#wesAttachTray')),rows};
    })()`);
    report.layouts.push({name, ...metrics});
    fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG());
  }
  app.whenReady().then(async () => {
    const html = fs.readFileSync(path.join(client, 'desk.html'), 'utf8');
    const cssPaths = [...html.matchAll(/<link\b[^>]*href=["']([^"']+\.css)["'][^>]*>/g)].map(m => m[1]);
    const css = cssPaths.map(file => fs.readFileSync(path.join(client, file), 'utf8')).join('\n');
    const fixture = path.join(temporary, 'fixture.html');
    fs.writeFileSync(fixture, '<!doctype html><meta charset="utf-8"><style>' + css + '</style><style>body{margin:0;background:var(--bg-1);font-family:var(--font-ui)}</style>');
    win = new BrowserWindow({show:false, width:1200, height:1050, webPreferences:{contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});
    win.webContents.on('console-message', event => { if(event.level==='error') report.errors.push(event.message); });
    win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']}, (_request, cb) => cb({cancel:true}));
    await win.loadFile(fixture);
    await js(`window.uploads=[];window.pending=[];window.toasts=[];window.petSay=m=>toasts.push(m);window.tasks=[];
      window.SoduWorkAPI={taskStorageKey:()=> 'isolated-attachments',listTeammates:async()=>({mates:[]}),
        taskExecutionOptions:async()=>({substrates:[],workflows:[],repos:[]}),workCatalog:async()=>({scenarios:[]}),
        uploadLibraryFile:async file=>{uploads.push(file.name);if(file.name.endsWith('.pdf'))return new Promise(resolve=>pending.push(resolve));
          if(file.name.endsWith('.csv')&&uploads.filter(x=>x===file.name).length===1)throw Error('isolated upload failure');return {ok:true,item:{id:file.name}};}};
      window.Requirements={dateTimestamp:()=>null};void 0;`);
    for (const name of ['task-priority','task-execution-client','plugin-ui-host','requirement-routing','panels-compose-submit','panels-compose-draft','library-transfer','conversation-attachments','work-entry-sheet']) {
      await js(fs.readFileSync(path.join(client, 'components/panels', name + '.js'), 'utf8') + '\nvoid 0;');
    }
    await js(`window.fixtureFiles=[new File(['<html>'+ 'x'.repeat(26300)+'</html>'],'工作目标分析智能体-完整缺陷分析与验收清单-20261015-最终修订版本.html',{type:'text/html'}),
      new File(['%PDF fixture'],'正在归档的补充说明.pdf',{type:'application/pdf'}),new File(['a,b\\n1,2'],'上传失败后可以重试的验收清单.csv',{type:'text/csv'})];
      WorkEntrySheet.openTask({text:'根据附件修复缺陷',proposal:{title:'修复工作目标分析智能体',note:'根据附件缺陷清单完成修复',assignee:'me'},bridge:{atts:()=>fixtureFiles}});void 0;`);
    await until("document.querySelector('#cpCreate')&&document.querySelectorAll('#wesAttachTray .catt-item').length===3");
    assert.equal(await js("document.querySelectorAll('.catt-library-state').length"),0);
    await measure('wide', 1200); await measure('narrow', 400); await measure('small', 320);
    win.webContents.setZoomFactor(1.25);
    await measure('zoom-125',500);
    win.webContents.setZoomFactor(1);
    await js("document.documentElement.style.setProperty('--font-min-readable','18px');void 0;");
    await measure('large-font',400);
    await js("document.documentElement.style.removeProperty('--font-min-readable');void 0;");
    report.actions.push({name:'conversation attachments stay visible without automatic library upload',ok:await js("document.querySelectorAll('#wesAttachTray .catt-item').length===3&&!document.querySelector('[data-catt-library-retry]')&&!document.querySelector('.catt-library-state')&&uploads.length===0")});
    await click('[data-catt-remove="1"]');
    report.actions.push({name:'remove keeps other filenames',ok:await js("document.querySelectorAll('#wesAttachTray .catt-item').length===2&&!document.querySelector('#wesAttachTray').innerText.includes('正在归档的补充说明.pdf')")});
    await js("window.pickerClicks=0;document.querySelector('#wesAttachInput').addEventListener('click',e=>{pickerClicks++;e.preventDefault()});void 0;");
    await click('#wesAttachPick');
    await js(`const transfer=new DataTransfer();transfer.items.add(new File(['extra'],'新补充资料.txt',{type:'text/plain'}));
      document.querySelector('#wesAttachInput').files=transfer.files;document.querySelector('#wesAttachInput').dispatchEvent(new Event('change'));void 0;`);
    await until("document.querySelectorAll('#wesAttachTray .catt-item').length===3&&document.querySelector('#wesAttachTray').innerText.includes('新补充资料.txt')");
    report.actions.push({name:'pick reaches input and adds without losing existing files',ok:await js("pickerClicks===1&&document.querySelector('#wesAttachTray b').title===fixtureFiles[0].name&&document.querySelector('#wesAttachInput').value===''")});
    await measure('narrow-after-actions',400);
    await js(`window.pngFile=new File([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG9sAAAAASUVORK5CYII='),c=>c.charCodeAt(0))],'缺陷截图.png',{type:'image/png'});
      const imageTransfer=new DataTransfer();imageTransfer.items.add(pngFile);
      document.querySelector('#wesAttachInput').files=imageTransfer.files;document.querySelector('#wesAttachInput').dispatchEvent(new Event('change'));
      const dir=new File([],'完整材料目录'),drop=new Event('drop',{bubbles:true,cancelable:true});
      Object.defineProperty(drop,'dataTransfer',{value:{items:[{kind:'file',getAsFile:()=>dir,webkitGetAsEntry:()=>({isDirectory:true})}]}});
      document.querySelector('.wes-attach-zone').dispatchEvent(drop);void 0;`);
    await until("document.querySelector('#wesAttachTray img')&&document.querySelector('#wesAttachTray .catt-dir')");
    await measure('mixed-types',400);
    await click('#wesAttachTray .catt-openable');
    await until("document.querySelector('.catt-preview img')?.complete");
    report.actions.push({name:'image preview opens from real attachment',ok:await js("document.querySelector('.catt-preview-title').innerText.includes('缺陷截图.png')")});
    await click('[data-catt-preview-close]');
    await click('[data-catt-remove="3"]');
    report.actions.push({name:'image removal preserves directory',ok:await js("!document.querySelector('#wesAttachTray img')&&Boolean(document.querySelector('#wesAttachTray .catt-dir'))")});
    // The same surface can be nested in a composer; its existing image tile stays a tile.
    await js(`document.querySelector('#workEntryLayer').classList.add('work-composer');
      const nestedTransfer=new DataTransfer();nestedTransfer.items.add(pngFile);
      document.querySelector('#wesAttachInput').files=nestedTransfer.files;document.querySelector('#wesAttachInput').dispatchEvent(new Event('change'));void 0;`);
    await until("document.querySelector('#wesAttachTray .catt-image')");
    await measure('nested-image-tile',400);
    await click('#wesAttachTray .catt-image-preview');
    await until("document.querySelector('.catt-preview img')?.complete");
    await click('[data-catt-preview-close]');
    await click('#wesAttachTray .catt-image [data-catt-remove]');
    report.actions.push({name:'nested image tile previews and removes',ok:await js("!document.querySelector('#wesAttachTray .catt-image')&&Boolean(document.querySelector('#wesAttachTray .catt-dir'))")});
    for(const layout of report.layouts) {
      for(const row of layout.rows) {
        if(row.badgeText) {
          assert(row.badgeText.left>=row.badge.left-1&&row.badgeText.right<=row.badge.right+1,layout.name+': extension label overflows badge');
          assert(row.badgeText.right<row.copy.left,layout.name+': extension overlaps filename or size');
        }
        assert(row.box.left>=layout.tray.left-1&&row.box.right<=layout.tray.right+1,layout.name+': card overflows attachment tray');
        if(row.name) assert(row.name.right<=row.remove.left&&row.copy.right<=row.remove.left,layout.name+': filename/status overlaps removal');
        if(row.imageTile) assert(Math.abs(row.box.width-row.box.height)<=1&&row.box.width<=112,layout.name+': image tile stretched to file row');
        assert(row.title===row.text,layout.name+': full filename unavailable');
        assert(!row.state||row.state.height<=44,layout.name+': archive status unnecessarily fragmented');
      }
    }
    for(const action of report.actions) assert(action.ok, action.name);
    report.ok=true;
  }).catch(error=>{report.error=String(error.stack||error);}).finally(()=>{
    fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify({ok:report.ok,error:report.error,layouts:report.layouts.map(x=>({name:x.name,cards:x.rows.length,badge:x.rows[0].badge,badgeText:x.rows[0].badgeText})),actions:report.actions},null,2));
    win?.destroy();app.exit(report.ok?0:1);
  });
}
