'use strict';
const electron = require('electron');
if (typeof electron === 'string') {
  const env = {...process.env};
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE']) delete env[key];
  const result = require('node:child_process').spawnSync(electron, [__filename], {
    env, windowsHide: true, stdio: 'inherit', timeout: 90000,
  });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}
const {app, BrowserWindow} = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {execFileSync} = require('node:child_process'), {pathToFileURL} = require('node:url');
const assert = require('node:assert/strict');
const client = path.resolve(__dirname, '..'), backend = path.resolve(client, '../hub-backend');
const output = path.resolve(client, '../outputs/requirement-tags-20261020');
fs.mkdirSync(output, {recursive: true});
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-tags-ui-'));
app.setPath('userData', profile);
app.disableHardwareAcceleration();
const report = {ok: false, checks: [], errors: [], boundary:
  'Hidden Electron, native pointer/keyboard and Chromium IME; production renderer and full desk CSS. Hub DTOs from in-memory Task/Client serializers and ASGI/SQLite fixtures; no business database, external network, model or user window.'};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const styles = [...fs.readFileSync(path.join(client, 'desk.html'), 'utf8').matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)/g)]
  .map(match => pathToFileURL(path.join(client, match[1])).href);
const dtoScript = `
import asyncio,json
from datetime import datetime,timezone
from app import models
from app.schemas import task_to_api
from app.services import task_access,task_requirements
async def main():
    client=models.Client(id="viewer-device",user_ref="creator-user")
    rows=[]
    for key,status,owner in [("shared-todo","todo","other-device"),("shared-doing","doing","other-device"),
                             ("shared-done","done","other-device"),("shared-archived","done","other-device"),
                             ("owned-doing","doing","viewer-device")]:
        task=models.Task(id=key,title="Requirement "+key,note="Requirement context",status=status,
            owner_client_id=owner,created_by="creator-user",requester_user_id="creator-user",
            tags=["existing","keep"],kind="requirement",priority="normal",triage_stage="intake",
            requirement_version=1,acceptance_criteria=["Complete"],origin="local",
            requirement_content={"title":"Requirement "+key,"note":"Requirement context"})
        if key == "shared-archived":
            task.archived_at=datetime.now(timezone.utc)
        dto=task_access.decorate(task,task_to_api(task),client,{"creator-user":"Creator"})
        rows.append(await task_requirements.decorate(None,client,task,dto))
    from test_unified_requirements import UnifiedRequirementTests
    fixture=UnifiedRequirementTests()
    await fixture.asyncSetUp()
    try:
        response=await fixture.call("GET","tasks/shared","peer")
        assert response.status_code == 200
        readonly=response.json()
        assert readonly["readOnly"] and not readonly["canEditRequirement"]
        rows.append(readonly)
    finally:
        await fixture.asyncTearDown()
    print(json.dumps(rows,ensure_ascii=True))
asyncio.run(main())
`;
let win;
app.whenReady().then(async () => {
  try {
    console.log('tags fixture: Hub DTO serialization');
    const python = process.env.SODUWORK_E2E_PYTHON || path.join(backend, '.venv',
      process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    const dtos = JSON.parse(execFileSync(python, ['-c', dtoScript],
      {cwd: profile, encoding: 'utf8', windowsHide: true, timeout: 15000,
        env: {...process.env, PYTHONPATH: backend, PYTHONIOENCODING: 'utf-8',
          DATABASE_URL: 'sqlite+aiosqlite:///:memory:', AUTH_SECRET: 'isolated-tags-fixture-only',
          ADMIN_PASS: 'isolated-tags-fixture-only'}}));
    assert.equal(dtos[0].readOnly, true); assert.equal(dtos[0].canEditRequirement, true);
    win = new BrowserWindow({show: false, width: 1280, height: 960,
      webPreferences: {offscreen: true, contextIsolation: true, sandbox: true, backgroundThrottling: false}});
    win.webContents.session.webRequest.onBeforeRequest({urls: ['http://*/*', 'https://*/*']}, (_request, done) => done({cancel: true}));
    win.webContents.on('console-message', event => {if (event.level === 'error') report.errors.push(event.message);});
    const js = source => win.webContents.executeJavaScript(source, true);
    const click = async selector => {
      const point = await js(`(async()=>{const n=[...document.querySelectorAll(${JSON.stringify(selector)})].find(n=>n.getClientRects().length&&!n.disabled);if(!n)throw Error('Unavailable '+${JSON.stringify(selector)});n.scrollIntoView({block:'nearest'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect(),x=Math.round(b.x+b.width/2),y=Math.round(b.y+b.height/2);if(!n.contains(document.elementFromPoint(x,y)))throw Error('Occluded '+${JSON.stringify(selector)});return{x,y}})()`);
      const zoom = win.webContents.getZoomFactor();
      point.x = Math.round(point.x * zoom); point.y = Math.round(point.y * zoom);
      for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) win.webContents.sendInputEvent({type, ...point,
        ...(type === 'mouseMove' ? {} : {button: 'left', clickCount: 1})});
      await wait(70);
    };
    const key = async (keyCode, modifiers = []) => {
      for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({type, keyCode, modifiers});
      await wait(40);
    };
    const text = async value => {await win.webContents.insertText(value); await wait(40);};
    const css = async () => {
      await js(`Promise.all(${JSON.stringify(styles)}.map(href=>new Promise((resolve,reject)=>{const link=document.createElement('link');link.rel='stylesheet';link.href=href;const timer=setTimeout(()=>reject(Error('CSS load timed out: '+href)),8000);link.onload=()=>{clearTimeout(timer);resolve()};link.onerror=()=>{clearTimeout(timer);reject(Error(href))};document.head.append(link)})))`);
      await js(`document.documentElement.dataset.deskPanel='workspace';document.documentElement.dataset.workspaceView='history';document.documentElement.dataset.theme='azure';void 0;`);
    };
    const cleanFocus = async selector => {
      await click(selector);
      const style = await js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)}),s=getComputedStyle(n),o=getComputedStyle(n.closest('.rq-tag-editor'));return{border:s.borderTopWidth,shadow:s.boxShadow,outline:s.outlineStyle,outer:o.borderTopWidth,focus:document.activeElement===n}})()`);
      assert.equal(style.focus, true); assert.equal(style.border, '0px');
      assert.equal(style.shadow, 'none'); assert.equal(style.outline, 'none');
      assert.ok(parseFloat(style.outer) > 0 && parseFloat(style.outer) <= 1, 'one physical border remains at fractional zoom');
    };
    const shot = async name => {await wait(80);fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());};
    console.log('tags fixture: creation form');
    await win.loadFile(path.join(__dirname, 'fixtures/requirement-sheet-receipt.html'));
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {enabled: true});
    await css();
    await js(fs.readFileSync(path.join(client, 'components/requirements/requirement-fields.js'), 'utf8'));
    await js('openSheet()'); await wait(150);
    await cleanFocus('#cpTagsInput');
    await text('先添加'); await key('Return');
    assert.deepEqual(await js('JSON.parse(document.querySelector("#cpTags").value)'), ['先添加']);
    await text('保存尾项');
    await click('[data-rq-tag-remove="0"]');
    assert.deepEqual(await js('JSON.parse(document.querySelector("#cpTags").value)'), []);
    assert.equal(await js('document.querySelector("#cpTagsInput").value'), '保存尾项');
    await key('a', ['control']); await key('Backspace');
    await win.webContents.debugger.sendCommand('Input.imeSetComposition', {text: '中文候选', selectionStart: 4, selectionEnd: 4});
    await key('Return');
    assert.deepEqual(await js('JSON.parse(document.querySelector("#cpTags").value)'), []);
    await win.webContents.debugger.sendCommand('Input.insertText', {text: '中文标签'});
    await key('Return');
    assert.deepEqual(await js('JSON.parse(document.querySelector("#cpTags").value)'), ['中文标签']);
    await text('未按回车保存'); await shot('create-tags-focus');
    assert.equal(await js('tasks.length'), 0, 'candidate confirmation and tag Enter never create the requirement');
    await click('#cpCreate');
    assert.deepEqual(await js('tasks[0].tags'), ['中文标签', '未按回车保存']);
    report.checks.push('Creation: one focus frame under full desk CSS; native Enter and X; Chromium IME candidate preserved; unconfirmed tail saved once.');
    await win.loadFile(path.join(__dirname, 'fixtures/requirements-board.html')); await css();
    await js(`tasks=${JSON.stringify(dtos)};RequirementsBoard.render(true);void 0;`);
    await js(`RequirementsDetail.open('shared-todo')`); await wait(100);
    assert.deepEqual(await js(`[...document.querySelectorAll('.rq-detail-tags > span')].map(n=>n.textContent)`), ['existing', 'keep']);
    await click('[data-rq-edit]'); await cleanFocus('#rqTagsInput');
    await text('共享可编辑'); await key('Return'); await click('[data-rq-tag-remove="0"]');
    await click('#rqTagsInput'); await text('详情保存尾项');
    await shot('shared-detail-tags');
    await click('.rq-detail-footer button[type=submit]'); await wait(100);
    assert.deepEqual(await js(`tasks.find(t=>t.id==='shared-todo').tags`), ['keep', '共享可编辑', '详情保存尾项']);
    const patch = await js(`fixtureCalls.filter(c=>c[0]==='patch').at(-1)[2]`);
    assert.deepEqual(Object.keys(patch).sort(), ['requirementVersion', 'tags']);
    assert.deepEqual(await js(`[...document.querySelectorAll('.rq-detail-tags > span')].map(n=>n.textContent)`), ['keep', '共享可编辑', '详情保存尾项']);
    report.checks.push('Actual Hub DTO: readOnly=true with canEditRequirement=true and todo shows existing tags, allows editing and saves only tags plus version.');
    for (const status of ['doing', 'done', 'archived']) {
      const id = 'shared-' + status, tag = {doing: '进行中分类', done: '已完成分类', archived: '归档分类'}[status];
      await js(`RequirementsDetail.close(true);RequirementsDetail.open(${JSON.stringify(id)})`); await wait(100); await click('[data-rq-edit]');
      assert.equal(await js('document.querySelector("#rqTagsInput").disabled'), false);
      assert.equal(await js(`[...document.querySelectorAll('[data-rq-tag-remove]')].every(n=>!n.disabled)`), true);
      assert.equal(await js('document.querySelector(\'[name="title"]\').disabled'), true);
      await click('#rqTagsInput'); await text(tag);
      if (status === 'doing') {
        await js(`window.realPatch=SoduWorkAPI.patchTask;SoduWorkAPI.patchTask=async()=>{throw Object.assign(new Error('fixture save conflict'),{status:409})};void 0;`);
        await click('.rq-detail-footer button[type=submit]'); await wait(100);
        assert.match(await js('document.querySelector("[data-rq-error]").textContent'), /fixture save conflict/);
        assert.equal(await js('document.querySelector("#rqTagsInput").disabled'), false);
        assert.equal(await js(`[...document.querySelectorAll('[data-rq-tag-remove]')].every(n=>!n.disabled)`), true);
        assert.equal(await js(`[...document.querySelectorAll('[data-rq-locked]')].every(n=>n.disabled)`), true);
        assert.equal(await js('document.querySelector(\'[name="acceptance"]\').readOnly'), true);
        await js(`SoduWorkAPI.patchTask=window.realPatch;void 0;`);
        report.checks.push('Failed save restores editable tags and preserves the draft; title, note, priority, type, due date and acceptance remain locked.');
      }
      await click('.rq-detail-footer button[type=submit]'); await wait(100);
      assert.deepEqual(await js(`tasks.find(t=>t.id===${JSON.stringify(id)}).tags`), ['existing', 'keep', tag]);
      const saved = await js(`fixtureCalls.filter(c=>c[0]==='patch').at(-1)[2]`);
      assert.deepEqual(Object.keys(saved).sort(), ['requirementVersion', 'tags']);
      assert.deepEqual(await js(`[...document.querySelectorAll('.rq-detail-tags > span')].map(n=>n.textContent)`), ['existing', 'keep', tag]);
    }
    report.checks.push('Actual Hub DTOs: shared doing/done/archived requirements with edit permission save classification tags independently of execution-content locks.');
    await js(`RequirementsDetail.close(true);RequirementsDetail.open('owned-doing')`); await wait(100); await click('[data-rq-edit]');
    assert.equal(await js('document.querySelector("#rqTagsInput").disabled'), false);
    await js(`RequirementsDetail.close(true);RequirementsDetail.open('shared')`); await wait(100);
    assert.equal(await js('document.querySelectorAll("[data-rq-edit]").length'), 0);
    assert.equal(await js('document.querySelectorAll("#rqTagsInput").length'), 0);
    report.checks.push('Actual read-only Hub HTTP DTO: a team viewer without requirement edit permission has no editing entry or tag editor.');
    await js(`RequirementsDetail.close(true);tasks[0].tags='旧标签，第二项';RequirementsDetail.open('shared-todo')`); await wait(100);
    await click('[data-rq-edit]');
    assert.deepEqual(await js('JSON.parse(document.querySelector("#rqTags").value)'), ['旧标签', '第二项']);
    await click('#rqTagsInput'); await text('历史补充'); await click('.rq-detail-footer button[type=submit]'); await wait(100);
    assert.deepEqual(await js('tasks[0].tags'), ['旧标签', '第二项', '历史补充']);
    report.checks.push('Legacy delimited tags render as editable chips and preserve labels when saving an unconfirmed tail.');
    report.geometry = [];
    for (const config of [
      {name: 'wide', width: 1280, height: 960, zoom: 1},
      {name: 'narrow', width: 520, height: 760, zoom: 1},
      {name: 'zoomed', width: 1000, height: 820, zoom: 1.25},
    ]) {
      win.setContentSize(config.width, config.height);
      for (const mode of ['create', 'edit']) {
        await win.loadFile(path.join(__dirname, 'fixtures', mode === 'create' ? 'requirement-sheet-receipt.html' : 'requirements-board.html'));
        await css(); win.webContents.setZoomFactor(config.zoom); await wait(80);
        if (mode === 'create') {
          await js(fs.readFileSync(path.join(client, 'components/requirements/requirement-fields.js'), 'utf8'));
          await js('openSheet()');
        } else {
          await js(`tasks=${JSON.stringify(dtos)};tasks[0].tags=[];RequirementsBoard.render(true);RequirementsDetail.open('shared-todo');void 0;`);
          await wait(80); await click('[data-rq-edit]');
        }
        await wait(100);
        const selector = mode === 'create' ? '#cpTagsInput' : '#rqTagsInput';
        const snapshot = async state => {
          await js(`(async()=>{document.querySelector(${JSON.stringify(selector)}).closest('.rq-tag-editor').scrollIntoView({block:'center',behavior:'instant'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))})()`);
          for (const theme of ['azure', 'ruby', 'steady', 'warm', 'minimal']) {
            await js(`document.documentElement.dataset.theme=${JSON.stringify(theme)};void 0;`);
            const metrics = await js(`(()=>{const input=document.querySelector(${JSON.stringify(selector)}),editor=input.closest('.rq-tag-editor'),
              reference=document.querySelector(${JSON.stringify(mode === 'create' ? '#cpKind' : '[name="title"]')}),
              box=n=>{const b=n.getBoundingClientRect(),s=getComputedStyle(n);return{width:b.width,height:b.height,left:b.left,right:b.right,top:b.top,bottom:b.bottom,minHeight:s.minHeight,font:s.font,lineHeight:s.lineHeight,padding:s.padding,boxSizing:s.boxSizing}},
              outer=box(editor),chips=[...editor.querySelectorAll('.rq-tag-chip')].map(box);
              return{editor:outer,input:box(input),reference:box(reference),chips,viewport:innerWidth,
                overflow:editor.scrollWidth-editor.clientWidth,rows:new Set(chips.map(n=>Math.round(n.top))).size}})()`);
            report.geometry.push({config: config.name, mode, state, theme, ...metrics});
          }
          await js(`document.documentElement.dataset.theme='azure';void 0;`);
        };
        await snapshot('empty'); await shot(`tags-${mode}-${config.name}-empty`);
        await cleanFocus(selector); await text('业务'); await key('Return');
        await snapshot('single'); await shot(`tags-${mode}-${config.name}-single`);
        await text(Array.from({length: 10}, (_, index) => '验收场景与回归分类标签' + index).join(','));
        await key('Return'); await snapshot('wrapped'); await shot(`tags-${mode}-${config.name}`);
        for (let count = 0; count < 11; count++) await click('[data-rq-tag-remove="0"]');
        await snapshot('cleared');
      }
    }
    for (const sample of report.geometry) {
      const name = `${sample.mode}/${sample.config}/${sample.state}/${sample.theme}`;
      assert.ok(sample.editor.left >= -1 && sample.editor.right <= sample.viewport + 1, `${name}: editor stays inside viewport`);
      assert.ok(sample.overflow <= 1, `${name}: editor has no horizontal overflow`);
      assert.ok(sample.input.top >= sample.editor.top && sample.input.bottom <= sample.editor.bottom,
        `${name}: the text input is not clipped`);
      if (sample.state === 'wrapped') {
        assert.ok(sample.rows > 1, `${name}: chips wrap onto more than one row`);
        assert.ok(sample.editor.height > sample.reference.height + 10, `${name}: editor grows with wrapped tags`);
        assert.ok(sample.chips.every(chip => chip.top >= sample.editor.top && chip.bottom <= sample.editor.bottom),
          `${name}: all chips fit within the growing editor`);
      } else {
        assert.ok(Math.abs(sample.editor.height - sample.reference.height) <= 1,
          `${name}: tag height ${sample.editor.height} matches standard field ${sample.reference.height}`);
        const empty = report.geometry.find(other => other.config === sample.config && other.mode === sample.mode &&
          other.theme === sample.theme && other.state === 'empty');
        assert.ok(Math.abs(sample.editor.height - empty.editor.height) <= 0.01,
          `${name}: empty, single-line and cleared states have exactly the same height`);
      }
    }
    report.checks.push('Native geometry: creation/editing empty, single-row, wrapped and cleared tags match field height or grow only when needed across five themes at wide/narrow/125% zoom; no clipping or horizontal overflow.');
    assert.deepEqual(report.errors, []); report.ok = true;
  } catch (error) {
    report.error = String(error.stack || error);
    if (win && !win.isDestroyed()) fs.writeFileSync(path.join(output, 'failure.png'), (await win.webContents.capturePage()).toPNG());
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({...report, geometry: report.geometry?.length})); app.exit(report.ok ? 0 : 1);
  }
});
