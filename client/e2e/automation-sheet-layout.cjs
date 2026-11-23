'use strict';
// Use real Chromium styles and forms with stub APIs and temporary user data.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)],
    { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill(), 60000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
  const { pathToFileURL } = require('node:url');
  const client = path.resolve(__dirname, '..');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-automation-layout-'));
  const out = path.resolve(process.argv[2] || path.join(client, '../outputs/automation-sheet-layout-20261016'));
  fs.mkdirSync(out, { recursive: true }); app.setPath('userData', path.join(temporary, 'profile'));
  const report = { ok: false, cases: [], errors: [], networkRequests: [] };
  let win;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const js = code => win.webContents.executeJavaScript(code, true);
  const rect = selector => js(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return {x:r.x,y:r.y,bottom:r.bottom,right:r.right,width:r.width,height:r.height}})()`);
  async function open(inline = false) {
    await js(`WorkAutomationSheet.close(true);document.querySelector('#opener').focus();
      WorkAutomationSheet.open({${inline ? "host:document.querySelector('#inlineHost')," : ''}text:'每天18点检查报告',
        proposal:{title:'隔离自动化',note:'任务原文\\n'.repeat(100),acceptance:['保留所有内容','只使用替身服务']}})`);
    await delay(350);
  }
  async function key(keyCode, modifiers = []) {
    for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode, modifiers });
    await delay(50);
  }
  async function run(name, action) {
    const row = { name, ok: false };
    try { await action(row); row.ok = true; } catch (error) { row.error = String(error.stack || error); }
    report.cases.push(row);
  }
  app.whenReady().then(async () => {
    const desk = fs.readFileSync(path.join(client, 'desk.html'), 'utf8');
    const css = [...desk.matchAll(/<link\b[^>]*href=["']([^"']+\.css)["'][^>]*>/g)].map(m => m[1]);
    const href = file => pathToFileURL(path.join(client, file)).href;
    const fixture = path.join(temporary, 'fixture.html');
    fs.writeFileSync(fixture, '<!doctype html><html data-window-menu="true" data-window-titlebar="overlay"><head><meta charset="utf-8">' +
      css.map(file => '<link rel="stylesheet" href="' + href(file) + '">').join('') +
      '<style>#background{position:fixed;inset:34px 0 0;overflow:auto}#background>div{height:2000px;padding:40px}' +
      '#inlineHost{position:fixed;inset:50px 20px 20px;overflow:auto}#inlineHost:empty{display:none}</style></head><body>' +
      '<div class="window-menu">隔离验证 · 系统标题栏</div><main id="background"><div><button id="opener">创建自动化</button>' +
      '<p>背景需求池，滚动位置应保持</p></div></main><div id="inlineHost"></div></body></html>');
    win = new BrowserWindow({ show: false, width: 1200, height: 800, useContentSize: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (request, cb) => {
      report.networkRequests.push(request.url); cb({ cancel: true });
    });
    await win.loadFile(fixture);
    await js(`window.errors=[];addEventListener('error',e=>errors.push(e.message));
      window.saves=[];window._schmLoad=async()=>[{key:'report',name:'报告插件',version:'1.0.0',checksum:'a'.repeat(64),inputs:[]}];window.SoduWorkAPI={
        taskExecutionOptions:async()=>({substrates:['Pi','Codex Harness','OpenCode','Codex','Qwen Code','DeepSeek Harness','Kimi Code']
          .map(name=>({key:'local:'+name.toLowerCase().replaceAll(' ','-'),name,available:true,
            locationLabel:'本机 · 测试工作站',onlineSeats:1})),repos:[]}),
        preflightSchedule:async()=>({state:'ready',message:'执行条件已就绪',checks:[{label:'隔离验证，无真实 Runner'}]}),
        createSchedule:async body=>{saves.push(body);return {...body,id:'fixture'}}};void 0;`);
    for (const file of ['plugin-ui-host', 'schedule-timing', 'panels-forward-select', 'work-automation-bindings', 'work-automation-view', 'work-automation-card-state','work-automation-sheet'])
      await js(fs.readFileSync(path.join(client, 'components/panels', file + '.js'), 'utf8') + '\nvoid 0;');

    await run('弹窗只滚动正文，头尾与完整遮罩保持位置', async row => {
      await open();
      const head = await rect('.waz-head'), foot = await rect('.waz-foot');
      const area = await rect('.waz-body');
      win.webContents.sendInputEvent({ type: 'mouseWheel', x: Math.round(area.x + area.width - 10), y: 400,
        deltaX: 0, deltaY: -1800, canScroll: true });
      await delay(400);
      row.geometry = { head, afterHead: await rect('.waz-head'), foot, afterFoot: await rect('.waz-foot'), backdrop: await rect('.pui-backdrop') };
      fs.writeFileSync(path.join(out, 'scrolled.png'), (await win.webContents.capturePage()).toPNG());
      assert.ok(Math.abs(head.y - row.geometry.afterHead.y) < 1, '滚动不能带走头部');
      assert.ok(foot.bottom <= 800 && Math.abs(foot.y - row.geometry.afterFoot.y) < 1, '操作区始终可见');
      assert.ok(row.geometry.backdrop.y <= 34 && row.geometry.backdrop.bottom >= 800, '遮罩持续覆盖工作区');
      assert.equal(await js('document.querySelector(".pui-layer").scrollTop'), 0);
      assert.ok(await js('document.querySelector(".waz-fields").scrollTop>0'), '字段区域实际发生滚动');
      assert.equal(await js('document.querySelector("#background").scrollTop'), 0);
    });
    for (const [width, height, zoom] of [[1200, 800, 1], [760, 560, 1], [480, 640, 1], [1200, 800, 1.5]]) {
      await run(`窗口 ${width}×${height} 缩放 ${zoom}：标题栏留白、关闭及提交可见`, async row => {
        win.setContentSize(width, height); win.webContents.setZoomFactor(zoom); await open();
        const viewport = await js('({w:innerWidth,h:innerHeight})');
        const dialog = await rect('.pui-dialog'), close = await rect('.waz-close'), save = await rect('[data-waz-save]');
        row.geometry = { viewport, dialog, close, save };
        assert.ok(dialog.y >= 34, '避开原生窗口标题栏');
        assert.ok(dialog.bottom <= viewport.h && dialog.x >= 0 && dialog.right <= viewport.w, '弹窗不能越过视口');
        assert.ok(close.y >= 34 && save.bottom <= viewport.h, '关闭与提交可见');
        assert.ok(await js('document.querySelector(".pui-dialog").scrollWidth<=document.querySelector(".pui-dialog").clientWidth+1'), '没有横向溢出');
        fs.writeFileSync(path.join(out, `viewport-${width}-${height}-${zoom}.png`), (await win.webContents.capturePage()).toPNG());
      });
    }
    await run('键盘留在弹窗中，关闭后返回发起按钮', async () => {
      win.setContentSize(1200, 800); win.webContents.setZoomFactor(1); await open();
      assert.equal(await js('document.activeElement.classList.contains("waz-close")'), true);
      assert.equal(await js('document.querySelector(".waz-sheet").getAttribute("aria-modal")'), 'true');
      await js('document.querySelector("[data-waz-save]").focus();void 0;');
      await key('Tab'); assert.equal(await js('document.activeElement.classList.contains("waz-close")'), true);
      await key('Tab', ['shift']); assert.equal(await js('document.activeElement.hasAttribute("data-waz-save")'), true);
      await js('document.querySelector(".waz-close").click();void 0;'); await delay(150);
      assert.equal(await js('document.activeElement.id'), 'opener');
    });
    await run('顶部修改后直接提交也能看到校验错误，草稿不丢失', async () => {
      await open(); await js('document.querySelector("[name=title]").value="";document.querySelector("[data-waz-save]").click();void 0;');
      const error = await rect('#wazError');
      assert.ok(error.y >= 34 && error.bottom <= 800, '校验反馈必须可见');
      assert.match(await js('document.querySelector("#wazError").textContent'), /名字/);
      assert.equal(await js('saves.length'), 0);
      assert.equal(await js('document.querySelector("[name=note]").value'), '任务原文\n'.repeat(100));
    });
    await run('切换工作方法重绘后保持滚动位置和键盘焦点', async () => {
      await open();
      const before = await js(`(()=>{const field=document.querySelector('[name=personalPluginKey]');
        field.focus();const top=document.querySelector('.waz-fields').scrollTop;
        field.value='report';field.dispatchEvent(new Event('change',{bubbles:true}));return top})()`);
      assert.ok(before > 0);
      assert.equal(await js('document.querySelector(".waz-fields").scrollTop'), before);
      assert.equal(await js('document.activeElement.name'), 'personalPluginKey');
      assert.equal(await js('document.querySelector("[name=personalPluginKey]").value'), 'report');
    });
    await run('Escape 只关闭自动化弹窗并恢复背景入口', async () => {
      await open(); await key('Escape'); await delay(150);
      assert.equal(await js('!!document.querySelector(".pui-layer")'), false);
      assert.equal(await js('document.activeElement.id'), 'opener');
    });
    await run('固定操作区仍通过原表单保存完整正文、标准和启用状态', async () => {
      await open(); await js('document.querySelector("[name=enabled]").checked=false;document.querySelector("[data-waz-save]").click();void 0;');
      await delay(100);
      assert.equal(await js('saves.length'), 1);
      assert.equal(await js('saves[0].enabled'), false);
      assert.ok(await js('saves[0].note.includes("任务原文\\n".repeat(99))'));
      assert.ok(await js('saves[0].note.includes("保留所有内容")'));
      assert.ok((await rect('.waz-saved')).bottom <= 800);
    });
    await run('长失败说明可完整查看，提交按钮保持可见并能重试', async () => {
      await open();
      await js(`window.originalPreflight=SoduWorkAPI.preflightSchedule;
        SoduWorkAPI.preflightSchedule=async()=>{throw Error('隔离失败原因与处理建议。'.repeat(120))};
        document.querySelector('[data-waz-save]').click();void 0;`);
      await delay(100);
      const save = await rect('[data-waz-save]');
      assert.ok(save.bottom <= 800 && save.y >= 34, '长错误不能把提交按钮推出视口');
      assert.equal(await js('document.querySelector("[data-waz-save]").disabled'), false);
      assert.ok(await js('document.querySelector("#wazError").textContent.length > 1000'));
      await js('SoduWorkAPI.preflightSchedule=originalPreflight;document.querySelector("[data-waz-save]").click();void 0;');
      await delay(100);
      assert.equal(await js('!!document.querySelector(".waz-saved")'), true, '预检失败后可以重试并成功创建');
    });
    await run('创建结果未确认时禁止重复提交，提供管理页查询入口', async () => {
      await open();
      await js(`window.originalCreate=SoduWorkAPI.createSchedule;
        SoduWorkAPI.createSchedule=async()=>{throw Error('创建请求连接中断')};
        document.querySelector('[data-waz-save]').click();void 0;`);
      await delay(100);
      assert.equal(await js('document.querySelector("[data-waz-save]").disabled'), true);
      assert.match(await js('document.querySelector("#wazError").textContent'), /创建结果尚未确认/);
      assert.equal(await js('!!document.querySelector("[data-waz-open]")'), true);
      await js('SoduWorkAPI.createSchedule=originalCreate;void 0;');
    });
    await run('创建表单通过有限选项选择时间，并保存所选时分', async () => {
      await open();
      assert.deepEqual(await js(`['clockHour','clockMinute','minute'].map(name=>{
        const field=document.querySelector('[name='+name+']');return [field.tagName,field.options.length];})`),
        [['SELECT',24],['SELECT',60],['SELECT',60]]);
      await js(`document.querySelector('[name=clockHour]').focus();void 0;`);
      await key('End');
      assert.ok((await rect('.fwd-select-compact-time')).height <= 220);
      await key('Enter');
      await js(`document.querySelector('[name=clockMinute]').focus();void 0;`);
      await key('End');
      assert.ok((await rect('.fwd-select-compact-time')).height <= 220);
      fs.writeFileSync(path.join(out, 'compact-minute-menu.png'), (await win.webContents.capturePage()).toPNG());
      await key('Enter');
      assert.equal(await js('document.querySelector("[name=clockHour]").value'), '23');
      assert.equal(await js('document.querySelector("[name=clockMinute]").value'), '59');
      await js(`document.querySelector('[data-waz-save]').click();void 0;`);
      await delay(100);
      assert.deepEqual(await js('({hour:saves.at(-1).atHour,minute:saves.at(-1).atMinute})'), {hour:23,minute:59});
    });
    await run('每周和每月多选与可选日期范围保持完整保存', async () => {
      for (const mode of ['weekly','monthly']) {
        await open();
        const before=await js('saves.length');
        await js(`(()=>{const field=document.querySelector('[name=every]');field.value=${JSON.stringify(mode)};
          field.dispatchEvent(new Event('change',{bubbles:true}));
          for(const input of document.querySelectorAll('[name=${mode === 'weekly' ? 'weekdays' : 'monthDays'}]')) {
            const selected=${mode === 'weekly' ? '[1,3,5]' : '[30,31]'}.includes(Number(input.value));
            if(input.checked!==selected)input.click();
          }
          document.querySelector('[name=startDate]').value='2099-01-01';
          document.querySelector('[name=endDate]').value='2098-12-31';
          document.querySelector('[data-waz-save]').click();})()`);
        assert.equal(await js('saves.length'),before);
        await js(`(()=>{const end=document.querySelector('[name=endDate]');end.value='2099-12-31';
          end.dispatchEvent(new Event('input',{bubbles:true}));
          document.querySelector('[data-waz-${mode === 'weekly' ? 'weekday' : 'monthday'}]').scrollIntoView({block:'center'});})()`);
        await delay(80);
        fs.writeFileSync(path.join(out, mode+'-sheet.png'), (await win.webContents.capturePage()).toPNG());
        await js(`document.querySelector('[data-waz-save]').click();void 0;`);await delay(100);
        assert.equal(await js('saves.length'),before+1);
        assert.deepEqual(await js(`(()=>{const v=saves.at(-1);return [v.every,v.${mode === 'weekly' ? 'weekdays' : 'monthDays'},v.startDate,v.endDate]})()`),
          [mode,mode==='weekly'?[1,3,5]:[30,31],'2099-01-01','2099-12-31']);
      }
    });
    await run('自定义规则保存完整文本，空规则阻止提交；反复打开关闭不残留菜单', async row => {
      await open();
      const before=await js('saves.length');
      await js(`(()=>{const cadence=document.querySelector('[name=every]');cadence.value='custom';
        cadence.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      await js(`(()=>{const field=document.querySelector('[name=customRule]');field.value='';
        field.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-waz-save]').click();})()`);
      assert.equal(await js('saves.length'),before);
      assert.equal(await js('document.querySelector("[data-waz-save]").disabled'),true);
      const rule='DTSTART;TZID=Asia/Shanghai:20990101T105100\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=10';
      await js(`(()=>{const field=document.querySelector('[name=customRule]');field.value=${JSON.stringify(rule)};
        field.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      fs.writeFileSync(path.join(out, 'custom-rule-sheet.png'), (await win.webContents.capturePage()).toPNG());
      await js(`document.querySelector('[data-waz-save]').click();void 0;`);await delay(100);
      assert.equal(await js('saves.at(-1).customRule'),rule);
      row.pressure=await js(`(async()=>{const start=performance.now();
        for(let i=0;i<50;i++){WorkAutomationSheet.close(true);
          await WorkAutomationSheet.open({text:'每天18点检查报告'});
          document.querySelector('[name=clockMinute]').nextElementSibling.querySelector('button').click();
          WorkAutomationSheet.close(true);}
        return{ms:performance.now()-start,popups:document.querySelectorAll('.fwd-select-popup').length,
          controls:document.querySelectorAll('.waz-sheet .fwd-select').length};})()`);
      assert.equal(row.pressure.popups,0);assert.equal(row.pressure.controls,0);
    });
    await run('四种语言下自定义规则和紧凑时间菜单保持完整布局与主题色', async row => {
      for (const file of JSON.parse(fs.readFileSync(path.join(client,'core/locales/manifest.json'),'utf8')))
        await js(fs.readFileSync(path.join(client,'core/locales',file),'utf8')+'\nvoid 0;');
      await js(fs.readFileSync(path.join(client,'core/i18n-dom.js'),'utf8')+'\nvoid 0;');
      await js(fs.readFileSync(path.join(client,'core/i18n.js'),'utf8')+'\nvoid 0;');
      row.locales=[];
      for(const locale of ['zh-CN','en-US','ja-JP','ko-KR']) {
        await js(`SoduWorkI18n.setLocale(${JSON.stringify(locale)});document.documentElement.dataset.theme='warm';void 0;`);
        await open();
        await js(`(()=>{const cadence=document.querySelector('[name=every]');cadence.value='custom';
          cadence.dispatchEvent(new Event('change',{bubbles:true}));
          document.querySelector('[name=customRule]').scrollIntoView({block:'center'});})()`);
        await delay(80);
        const label=await js('document.querySelector("[name=every] option:checked").textContent');
        if(locale!=='zh-CN')assert.notEqual(label,'自定义');
        if(locale==='en-US') {
          assert.ok(!/[\u4e00-\u9fff]/.test(await js('document.querySelector("[data-waz-custom]").textContent')));
          assert.ok(!/[\u4e00-\u9fff]/.test(await js('document.querySelector("#wazProbe").textContent')));
        }
        await js(`(()=>{const field=document.querySelector('[name=customRule]');
          field.value='DTSTART;TZID=Asia/Shanghai:20990101T105100\\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=10';
          field.dispatchEvent(new Event('input',{bubbles:true}));})()`);
        await delay(350);
        assert.equal(await js('document.querySelector(".waz-form").scrollWidth<=document.querySelector(".waz-form").clientWidth+1'),true);
        fs.writeFileSync(path.join(out, 'custom-'+locale+'.png'), (await win.webContents.capturePage()).toPNG());
        row.locales.push({locale,label});
      }
      await js(`SoduWorkI18n.setLocale('zh-CN');void 0;`);
    });
    await run('聊天内嵌表单保持自然高度，不增加弹窗内滚动与焦点锁', async () => {
      await open(true);
      assert.equal(await js('document.querySelector(".pui-layer")'), null);
      assert.equal(await js('document.querySelector(".waz-sheet").getAttribute("aria-modal")'), null);
      assert.equal(await js('getComputedStyle(document.querySelector(".waz-body")).overflowY'), 'visible');
      assert.ok((await rect('.waz-sheet')).height > 800);
    });
    await run('刷新按钮紧邻底座标签，可用键盘刷新', async () => {
      await open(true);
      for (const width of [1200, 390]) {
        win.setContentSize(width, 800);
        await delay(100);
        const button = await rect('#wazForm [data-waz-reload-agents]'), label = await rect('label[for=wazAssignee]');
        assert.ok(button.x >= label.right && button.x - label.right <= 8);
        assert.ok(button.width >= 24 && button.height >= 24);
      }
      win.setContentSize(1200, 800);
      await js(`window.originalExecutionOptions = SoduWorkAPI.taskExecutionOptions;
        window.refreshCount = 0;
        SoduWorkAPI.taskExecutionOptions = (...args) => { refreshCount++; return originalExecutionOptions(...args); };
        document.querySelector('#wazForm [data-waz-reload-agents]').focus();`);
      assert.ok(await js('document.activeElement.matches("[data-waz-reload-agents]")'));
      await key('Space');
      assert.equal(await js('refreshCount'), 1);
      assert.equal(await js('document.querySelector("#wazForm [data-waz-reload-agents]").disabled'), false);
      await js('SoduWorkAPI.taskExecutionOptions = originalExecutionOptions; void 0;');
    });
    await run('底座菜单在宽窄窗口内与字段对齐，Esc 保留原选择', async () => {
      await open(true);
      const original = await js('wazAssignee.value');
      for (const width of [1200, 390]) {
        win.setContentSize(width, 800);
        await js('wazAssignee.scrollIntoView({block:"center"}); wazAssignee.focus(); wazAssignee.showPicker()');
        await delay(100);
        assert.ok(await js('wazAssignee.matches(":open")'));
        const field = await rect('#wazAssignee'), row = await rect('#wazAssignee option:last-child');
        assert.ok(row.width > 0 && row.x >= field.x - 1 && row.right <= field.right + 1);
        const name = await rect('#wazAssignee .automation-runtime-name');
        const location = await rect('#wazAssignee .automation-runtime-location');
        const status = await rect('#wazAssignee .automation-runtime-status');
        assert.ok(name.height > 0 && location.y >= name.bottom && status.x >= location.right);
        fs.writeFileSync(path.join(out, 'runtime-menu-' + width + '.png'), (await win.webContents.capturePage()).toPNG());
        await key('Escape');
        assert.ok(await js('!wazAssignee.matches(":open")'));
        assert.equal(await js('wazAssignee.value'), original);
      }
      win.setContentSize(1200, 800);
    });
    await run('相对时间草稿允许补充，创建后修改原任务并可取消修改和停用', async () => {
      await js(fs.readFileSync(path.join(client,'components/panels/panels-chat-work-actions.js'),'utf8')+'\nvoid 0;');
      await js(`(async()=>{WorkAutomationSheet.close(true);window.originalNow=Date.now;
        window.messageTime=Date.parse('2099-11-16T08:00:13.628Z');Date.now=()=>messageTime;
        window.updates=[];window.createdBefore=saves.length;
        SoduWorkAPI.parseTaskText=async text=>text.includes('生成日报')
          ? {title:'日报',note:'生成日报'} : {title:'待明确的任务',note:'帮我做个任务'};
        SoduWorkAPI.updateSchedule=async(id,body)=>{updates.push({id,body});return{...saves.at(-1),...body,id}};
        await WorkAutomationSheet.open({cardId:'conversation-fixture',host:document.querySelector('#inlineHost'),
          text:'五分钟后帮我做个任务',requestedAt:messageTime,proposal:{timeZone:'Asia/Shanghai'}});
        window.automationControl=selector=>document.querySelector('#wazBody').querySelector(selector);
        window.sendAutomationChange=async text=>ChatWorkActions.route({text,mention:{action:()=>null}},{});})()`);
      assert.equal(await js('document.querySelector("[name=every]").value'),'once');
      assert.equal(await js('document.querySelector("[name=runAt]").value'),'2099-11-16T16:05');
      assert.equal(await js('document.querySelector("[name=runAt]").step'),'60');
      await delay(350);
      await js('automationControl(".waz-rhythm").scrollIntoView({block:"center",behavior:"instant"})');
      await delay(150);
      const cadence = await rect('[name=every]'), date = await rect('[name=runAt]');
      assert.ok(Math.abs(cadence.y - date.y) < 1 && cadence.height === date.height);
      fs.writeFileSync(path.join(out,'once-chat.png'),(await win.webContents.capturePage()).toPNG());
      win.setContentSize(390, 800);
      await delay(100);
      assert.ok((await rect('[name=runAt]')).y >= (await rect('[name=every]')).bottom);
      assert.ok((await rect('[name=runAt]')).right <= (await rect('.waz-rhythm')).right);
      win.setContentSize(1200, 800);
      assert.equal(await js('document.querySelector("[data-waz-save]").disabled'),true);
      await js(`automationControl('[data-waz-chat-exit]').click();void 0;`);
      assert.equal(await js('WorkAutomationSheet.acceptsFollowup("普通聊天")'),false);
      assert.equal((await js('sendAutomationChange("普通聊天")')).handled,false);
      await js(`automationControl('[data-waz-chat-resume]').click();void 0;`);
      const supplemented = await js(`messageTime+=60000;sendAutomationChange('帮我生成日报');`);
      assert.equal(supplemented.accepted, true, JSON.stringify(await js('WorkAutomationSheet.capture()')));
      assert.equal(await js('document.querySelector("[name=runAt]").value'),'2099-11-16T16:05');
      assert.equal(await js('automationControl("[data-waz-save]").disabled'),false,
        JSON.stringify(await js('({snapshot:WorkAutomationSheet.capture(),probe:document.querySelector("#wazProbe").textContent})')));
      await js(`automationControl('[data-waz-save]').click();void 0;`);await delay(100);
      assert.equal(await js('saves.length-createdBefore'),1);
      assert.equal(await js('saves.at(-1).runAt'),'2099-11-16T08:05:00.000Z');
      assert.equal(await js('!!automationControl("[data-waz-edit]")'),true);
      await js(`sendAutomationChange('改为十分钟后生成日报');`);
      assert.equal(await js('document.querySelector("[name=runAt]").value'),'2099-11-16T16:11');
      assert.equal(await js('automationControl("[data-waz-save]").textContent'),'保存修改');
      await js(`automationControl('[data-waz-cancel]').click();void 0;`);
      assert.equal(await js('WorkAutomationSheet.capture().phase'),'succeeded');
      assert.equal(await js('updates.length'),0);
      await js(`(async()=>{await sendAutomationChange('改为十分钟后生成日报');automationControl('[data-waz-save]').click();})()`);await delay(100);
      assert.equal(await js('saves.length-createdBefore'),1);
      assert.equal(await js('updates.length'),1);
      assert.equal(await js('updates[0].id'),'fixture');
      assert.equal(await js('updates[0].body.runAt'),'2099-11-16T08:11:00.000Z');
      await js(`automationControl('[data-waz-pause]').click();void 0;`);await delay(100);
      assert.deepEqual(await js('updates[1].body'),{enabled:false});
      assert.match(await js('automationControl(".waz-saved").textContent'),/已停用/);
      await js('Date.now=originalNow;void 0;');
    });
    await run('未确认草稿从20:18连续修改到20:23和20:29，解析不可用时也同步全部时间字段', async () => {
      await js(`(async()=>{WorkAutomationSheet.close(true);window.originalNow=Date.now;
        window.messageTime=Date.parse('2099-11-16T12:13:00Z');Date.now=()=>messageTime;
        window.createdBefore=saves.length;window.timeEditParses=0;
        SoduWorkAPI.parseTaskText=async()=>({title:'5分钟后发送一句话提醒',
          note:'关键约束：\\n1. 时间：5分钟后（相对时间，自需求提出时刻起算）；\\n2. 内容：分析5分钟采样日志；',
          acceptanceCriteria:['确认5分钟倒计时的起始时间点','保留5分钟采样日志']});
        await WorkAutomationSheet.open({cardId:'repeat-time',host:document.querySelector('#inlineHost'),
          text:'五分钟后发送一句话提醒',requestedAt:messageTime,proposal:{timeZone:'Asia/Shanghai'}});
        SoduWorkAPI.parseTaskText=async()=>{timeEditParses++;throw Error('parser unavailable')};})()`);
      assert.equal(await js('automationControl("[name=runAt]").value'),'2099-11-16T20:18');
      assert.equal((await js('sendAutomationChange("修改为10分钟以后")')).accepted,true);
      assert.equal(await js('automationControl("[name=runAt]").value'),'2099-11-16T20:23');
      assert.equal(await js('automationControl("[name=title]").value'),'10分钟后发送一句话提醒');
      assert.match(await js('automationControl("[name=note]").value'),/时间：10分钟后/);
      assert.match(await js('automationControl("[name=acceptance]").value'),/确认10分钟倒计时/);
      assert.equal((await js('messageTime+=60000;sendAutomationChange("再改为十五分钟后")')).accepted,true);
      assert.equal(await js('automationControl("[name=runAt]").value'),'2099-11-16T20:29');
      assert.equal(await js('automationControl("[name=title]").value'),'15分钟后发送一句话提醒');
      assert.match(await js('automationControl("[name=note]").value'),/时间：15分钟后/);
      assert.match(await js('automationControl("[name=note]").value'),/分析5分钟采样日志/);
      assert.match(await js('automationControl("[name=acceptance]").value'),/确认15分钟倒计时/);
      assert.equal(await js('saves.length-createdBefore'),0);
      assert.equal(await js('timeEditParses'),0);
      await js(`(async()=>{const snapshot=WorkAutomationSheet.capture();WorkAutomationSheet.close(true);
        messageTime+=60000;
        await WorkAutomationSheet.open({cardId:'repeat-time',cardState:snapshot,host:document.querySelector('#inlineHost')});})()`);
      assert.equal(await js('automationControl("[name=runAt]").value'),'2099-11-16T20:29');
      await js(`automationControl('[data-waz-save]').click();void 0;`);await delay(100);
      assert.equal(await js('saves.length-createdBefore'),1);
      assert.equal(await js('saves.at(-1).runAt'),'2099-11-16T12:29:00.000Z');
      assert.match(await js('saves.at(-1).note'),/时间：15分钟后/);
      await js('Date.now=originalNow;void 0;');
    });
    await run('错字时间不能回退到18点，底部取消退出草稿且不创建任务', async () => {
      await js(`Date.now=originalNow;window.beforeCancel=saves.length;
        WorkAutomationSheet.open({host:document.querySelector('#inlineHost'),text:'五分钟红帮我做个任务'});`);
      assert.equal(await js('document.querySelector("[name=every]").value'),'');
      assert.equal(await js('document.querySelector("[name=clockHour]").value'),'');
      assert.equal(await js('document.querySelector("[data-waz-save]").disabled'),true);
      await js(`document.querySelector('[data-waz-cancel]').click();void 0;`);
      assert.equal(await js('WorkAutomationSheet.hasSurface()'),false);
      assert.equal(await js('saves.length-beforeCancel'),0);
      assert.equal(await js('WorkAutomationSheet.acceptsFollowup("改为十分钟后")'),false);
    });
    await js(fs.readFileSync(path.join(client, 'components/panels/chat-work-cards.js'), 'utf8') + '\nvoid 0;');
    await run('对话自动化关闭后显示草稿入口，继续编辑及恢复会话保留手动内容', async () => {
      await js(`(async()=>{
        WorkAutomationSheet.close(true);
        const host=document.querySelector('#inlineHost');
        host.innerHTML='<div id="nchatList"></div><div class="nchat-draft"></div>';
        window.cardArchive=new Map();window.beforeCollapse=saves.length;
        SoduWorkAPI.taskStorageKey=()=> 'isolated-collapse';
        SoduWorkAPI.parseTaskText=async()=>({title:'检查报告',note:'检查报告并提醒我'});
        window.WorkEntrySheet={close:(_from,silent)=>WorkAutomationSheet.close(silent)};
        window.cardContext={_sessionId:'collapse-chat',_viewEpoch:0,_sessionOptions:{},_snap:{messages:[]},
          _mount:()=>host,_api:()=>({
            saveWorkCard:async(_id,card)=>{cardArchive.set(card.id,structuredClone(card));return {ok:true,card};},
            workCards:async()=>({ok:true,workOnly:true,cards:[...cardArchive.values()]})}),
          _render:()=>{for(const item of conversationCards.timeline([])){
            if(!document.querySelector('[data-work-card-slot="'+item.id+'"]')){
              const slot=document.createElement('section');slot.dataset.workCardSlot=item.id;
              host.querySelector('#nchatList').appendChild(slot);
            }
          }},
          _openWorkAction:async(command,options)=>{
            const seed=await conversationCards.prepare(command,options);
            await WorkAutomationSheet.open({...seed,text:command.text,host:seed.cardHost});
          }};
        window.conversationCards=ChatWorkCards.create(cardContext);
        const command={id:'work.automation.create',text:'每天9点提醒我检查报告'};
        const seed=await conversationCards.prepare(command,{proposal:{title:'检查报告',note:'检查报告并提醒我'}});
        await WorkAutomationSheet.open({...seed,text:command.text,host:seed.cardHost});
        document.querySelector('[name=title]').value='手动修改后的提醒';
        document.querySelector('[data-waz-close]').click();
        await conversationCards.flush();
      })()`);
      assert.equal(await js('document.querySelector(".nchat-work-record button").textContent'), '继续编辑');
      assert.ok(await js('document.querySelector(".nchat-work-record").getBoundingClientRect().height>0'));
      assert.match(await js('document.querySelector(".nchat-work-record").textContent'), /草稿 · 尚未创建.*手动修改后的提醒/);
      await js('document.querySelector(".nchat-work-record button").click();void 0;'); await delay(100);
      assert.equal(await js('document.querySelector("[name=title]").value'), '手动修改后的提醒');
      await js(`(async()=>{
        document.querySelector('[data-waz-close]').click();await conversationCards.flush();
        conversationCards=ChatWorkCards.create(cardContext);
        document.querySelector('#nchatList').replaceChildren();
        await conversationCards.restore('collapse-chat');
      })()`);
      assert.ok(await js('document.querySelector(".nchat-work-record").getBoundingClientRect().height>0'));
      assert.equal(await js('WorkAutomationSheet.hasSurface()'), false);
      await js('document.querySelector(".nchat-work-record button").click();void 0;'); await delay(100);
      assert.equal(await js('document.querySelector("[name=title]").value'), '手动修改后的提醒');
      assert.equal(await js('saves.length-beforeCollapse'), 0);
    });
    for (const file of ['compose-candidate-navigation', 'chat-plugin-mention-model', 'chat-plugin-mention']) {
      await js(fs.readFileSync(path.join(client, 'components/panels', file + '.js'), 'utf8') + '\nvoid 0;');
    }
    await js(`WorkAutomationSheet.close(true);
      const composer = document.createElement('section');
      composer.innerHTML = '<textarea id="nchatInput"></textarea>';
      document.body.append(composer);
      const input = composer.querySelector('textarea');
      const picker = ChatPluginMention.create({input, host:composer, actions:()=>PluginUIHost.actions(), catalog:async()=>({items:[]})});
      const context = {mount:()=>document.body, dismissProposal(){}, bridge:()=>({}),
        open:(command, options)=>ChatWorkActions.open(command, {...options, cardHost:document.querySelector('#inlineHost'),
          proposal:{timeZone:'Asia/Shanghai'}}, context)};
      const sentAt = Date.parse('2026-11-20T03:15:13.628Z');
      Date.now = () => sentAt;
      SoduWorkAPI.parseTaskText = async (text, model, attachments, options) => {
        if (text === '5分钟发一首关于秋天的诗') {
          window.poemInstruction = options.instruction;
          return {title:'每5分钟发送一首关于秋天的诗', note:'实现每5分钟发送一首关于秋天的诗。',
            checklist:['配置触发间隔为每五分钟','验证诗句发送结果']};
        }
        return {title:'示例任务', note:text};
      };
      window.sendExample = text => {
        input.value = text; input.dispatchEvent(new Event('input', {bubbles:true}));
        return ChatWorkActions.route({text, input, mention:picker, requestedAt:sentAt}, context);
      };
      window.activeExample = selector => document.querySelector('[data-plugin-surface="work-automation"]:not(.is-archived)').querySelector(selector);
      window.selectAutomation = async () => {
        WorkAutomationSheet.close(true);
        input.value='/创建自动化'; input.focus();
        input.dispatchEvent(new Event('input', {bubbles:true}));
        await new Promise(resolve=>setTimeout(resolve, 30));
        input.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}));
        return picker.action()?.actionId || picker.action()?.id;
      };void 0;`);
    const rule = 'DTSTART;TZID=Asia/Shanghai:20261201T090000\nRRULE:FREQ=HOURLY;INTERVAL=2;COUNT=3';
    const examples = [
      ['5分钟发一首关于秋天的诗', {every:'once', runAt:'2026-11-20T03:20:00.000Z'}],
      ['5分钟后发秋天的诗', {every:'once', runAt:'2026-11-20T03:20:00.000Z'}],
      ['明晚八点半发一首秋天的诗', {every:'once', runAt:'2026-11-21T12:30:00.000Z'}],
      ['每早七点半提醒我喝水', {every:'daily', atHour:7, atMinute:30}],
      ['每天下午三点一刻生成日报', {every:'daily', atHour:15, atMinute:15}],
      ['每周一到周五上午九点发送日报', {every:'weekly', weekdays:[1,2,3,4,5], atHour:9, atMinute:0}],
      ['每周一、三、五下午四点发送周报', {every:'weekly', weekdays:[1,3,5], atHour:16, atMinute:0}],
      ['每个周末晚上八点发一首诗', {every:'weekly', weekdays:[6,7], atHour:20, atMinute:0}],
      ['每个月一号，十五号上午九点发送月报', {every:'monthly', monthDays:[1,15], atHour:9, atMinute:0}],
      ['每个月最后一天晚上八点生成月报', {every:'monthly', monthDays:[31], monthDayPolicy:'last_day', atHour:20, atMinute:0}],
      ['每小时第十五分钟检查日志', {every:'hourly', atMinute:15}],
      ['每小时整点提醒我喝水', {every:'hourly', atMinute:0}],
      ['这个月25号到30号每天下午给我发一个写日报的提醒',
        {every:'daily',startDate:'2026-11-25',endDate:'2026-11-30'}, /补充下午/],
      ['本月二十五号至三十号每天下午三点发日报',
        {every:'daily',startDate:'2026-11-25',endDate:'2026-11-30',atHour:15,atMinute:0}],
      ['请在这个月25号到31号每天九点发送日报', {every:'daily',atHour:9,atMinute:0}, /结束日期无效/],
      ['生成一份巡检摘要\n' + rule, {every:'custom', customRule:rule}],
      ['每周上午九点发送日报', {every:'weekly', weekdays:[], atHour:9}, /星期/],
      ['每小时第六十分检查日志', {every:'hourly'}, /分钟/],
      ['改为每月三十号', {every:'monthly', monthDays:[30], monthDayPolicy:'skip', atHour:20, atMinute:0}],
    ];
    for (const [phrase, expected, error] of examples) {
      await run(phrase, async () => {
        assert.equal(await js('selectAutomation()'), 'work.automation.create');
        if (phrase === '改为每月三十号') {
          assert.ok((await js('sendExample("每个月最后一天晚上八点生成月报")')).accepted);
        }
        assert.ok((await js('sendExample(' + JSON.stringify(phrase) + ')')).accepted);
        const draft = await js('WorkAutomationSheet.capture().proposal');
        for (const [field, value] of Object.entries(expected)) assert.deepEqual(draft[field], value, field);
        const before = await js('saves.length');
        assert.ok(await js('Math.abs(activeExample("[name=assigneeId]").getBoundingClientRect().top - activeExample("[name=modelName]").getBoundingClientRect().top) < 1'));
        assert.equal(await js('activeExample("[name=every]").value'), expected.every);
        if (expected.startDate) {
          assert.equal(await js('activeExample("[name=startDate]").value'), expected.startDate);
          assert.equal(await js('activeExample("[name=endDate]").value'), expected.endDate);
        }
        assert.equal(await js('activeExample("[data-waz-save]").disabled'), Boolean(error));
        await js('activeExample("[data-waz-save]").click();void 0;');
        if (error) {
          assert.match(await js('activeExample("#wazProbe").textContent'), error);
          assert.equal(await js('saves.length'), before);
          if (expected.startDate) {
            assert.equal(await js('activeExample("[name=clockHour]").value'), '');
            assert.ok((await js('sendExample("三点")')).accepted);
            assert.equal(await js('activeExample("[name=clockHour]").value'), '15');
            await js('activeExample("[data-waz-save]").click();void 0;');
            const saved = await js('saves.at(-1)');
            assert.equal(await js('saves.length'), before + 1);
            assert.deepEqual([saved.startDate,saved.endDate,saved.atHour,saved.atMinute],
              [expected.startDate,expected.endDate,15,0]);
          }
          if (phrase.includes('到31号')) {
            await js(`const end = activeExample('[name=endDate]'); end.value = '2026-11-30';
              end.dispatchEvent(new Event('change', {bubbles:true})); activeExample('[data-waz-save]').click();void 0;`);
            assert.equal(await js('saves.length'), before + 1);
            assert.deepEqual(await js('[saves.at(-1).startDate,saves.at(-1).endDate]'), ['2026-11-25','2026-11-30']);
          }
        } else {
          assert.equal(await js('saves.length'), before + 1);
          const saved = await js('saves.at(-1)');
          if (phrase === '5分钟发一首关于秋天的诗') {
            assert.equal(await js('poemInstruction'), '5分钟后发一首关于秋天的诗');
            assert.equal(draft.title, '5分钟后发送一首关于秋天的诗');
            assert.match(saved.note, /5分钟后发送一首关于秋天的诗/);
            assert.match(saved.note, /配置触发时间为5分钟后/);
            assert.doesNotMatch(saved.note, /每[5五]分钟/);
          }
          for (const [field, value] of Object.entries(expected)) assert.deepEqual(saved[field], value, field);
        }
      });
    }
    await js('Date.now=originalNow;void 0;');
    report.errors = await js('errors');
    report.ok = report.cases.every(row => row.ok) && !report.errors.length && !report.networkRequests.length;
  }).catch(error => { report.error = String(error.stack || error); }).finally(() => {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2)); if (win) win.destroy(); app.exit(report.ok ? 0 : 1);
  });
}
