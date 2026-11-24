'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const runtime = require('../main/conversation/artifact-runtime');
const packages = require('../main/conversation/delivery-package');
const taskDelivery = require('../main/pi-session/task-delivery.cjs');
const {create} = require('../main/conversation/local-delivery-sync');

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-delivery-selection-'));
  t.after(() => fs.rmSync(cwd, {recursive:true, force:true}));
  const now = Date.now(), turnSince = now - 5000;
  const state = {status:'idle', messages:[], tools:[]};
  const handle = {cwd, sessionId:'selection', snapshot:()=>state,
    outputSnapshot:()=>require('../main/pi-session/outputs').scan(cwd, 0, turnSince)};
  const write = (name, content, old = false) => {
    const target = path.join(cwd, name); fs.mkdirSync(path.dirname(target), {recursive:true}); fs.writeFileSync(target, content);
    const at = new Date(now - (old ? 10000 : 0)); fs.utimesSync(target, at, at); return target;
  };
  const manifest = value => write('.soduwork/delivery.json', JSON.stringify({schemaVersion:1, ...value}));
  const messages = (request, answer) => { state.messages = [{role:'user', content:request}, {role:'assistant', content:answer}]; };
  return {cwd, handle, state, write, manifest, messages};
}
const names = snapshot => snapshot.delivery.items.map(item => item.relative).sort();

test('Word conversion selects the new document in both local cards and requirement transport', async t => {
  const f = fixture(t);
  f.write('课表.md', '# draft', true); f.write('中学生课表.md', '# previous', true);
  f.write('中学生课表.docx', await require('../main/conversation/zip-archive').createEntries([
    {name:'[Content_Types].xml', bytes:Buffer.from('<Types/>')}, {name:'word/document.xml',bytes:Buffer.from('<document/>')},
  ]));
  f.messages('生成word', 'Word 已生成：[中学生课表.docx](中学生课表.docx)');
  // A legacy manifest that accumulates every document must not defeat conversion intent.
  f.manifest({deliverables:[{path:'课表.md'}, {path:'中学生课表.md'}, {path:'中学生课表.docx'}]});
  let snapshot = runtime.snapshot(f.handle);
  assert.deepEqual(names(snapshot), ['中学生课表.docx']);
  assert.equal(snapshot.items.filter(item => item.kind === 'document').length, 3, 'historical sources remain addressable');
  const captured = await taskDelivery.capture(f.handle, 'completed');
  assert.deepEqual(captured.files.map(item => item.name), ['中学生课表.docx']);
  const now = Math.floor(Date.now()/1000);
  create().bind(f.handle, {hub:'http://fixture.invalid', clientId:'desktop',
    session:Buffer.from(JSON.stringify({typ:'device',uid:'fixture',cid:'desktop',iat:now,exp:now+3600})).toString('base64url')+'.'+'a'.repeat(64)});
  await f.handle.captureDelivery();
  assert.deepEqual(f.handle.deliverySync.artifactIds, snapshot.delivery.items.map(item => item.artifactId));
  f.messages('把 Markdown 转换为 Word', '[Word](中学生课表.docx)');
  assert.deepEqual(names(runtime.snapshot(f.handle)), ['中学生课表.docx']);
  f.messages('生成 Word，保留 Markdown，两种格式都要', 'Two formats');
  f.manifest({deliverables:[{path:'中学生课表.md'},{path:'中学生课表.docx'}]});
  snapshot = runtime.snapshot(f.handle);
  assert.deepEqual(names(snapshot), ['中学生课表.docx', '中学生课表.md']);
});

test('exclusive final-format requests exclude old manifest roots from cards and transport', async t => {
  const f = fixture(t);
  f.write('report.txt', 'Original report', true);
  f.write('report.html', '<!doctype html><html><body>Final report</body></html>');
  f.manifest({deliverables:[{path:'report.txt'}, {path:'report.html'}]});
  for (const request of [
    '请把交付格式改成 HTML，只保留最终网页',
    '改成 HTML，仅保留 HTML 文件',
    'Convert to HTML and keep only the final HTML file.',
    'Convert to HTML; only keep the final HTML.',
  ]) {
    f.messages(request, 'Final result: [report.html](report.html)');
    assert.deepEqual(names(runtime.snapshot(f.handle)), ['report.html'], request);
    assert.deepEqual((await taskDelivery.capture(f.handle, 'completed')).files.map(item => item.name),
      ['report.html'], request);
  }
  assert.equal(fs.readFileSync(path.join(f.cwd, 'report.txt'), 'utf8'), 'Original report',
    'selection must not delete historical workspace files');
});

test('explicit retention of both formats or original versions survives exclusive-format wording', async t => {
  const f = fixture(t);
  f.write('report.txt', 'Original report', true);
  f.write('report.html', '<!doctype html><html><body>Final report</body></html>');
  f.manifest({deliverables:[{path:'report.txt'}, {path:'report.html'}]});
  for (const request of [
    '改成 HTML，同时保留原来的 TXT',
    '改成 HTML，保留旧版',
    '改成 HTML，只保留最终网页，同时保留旧版 TXT 以供审核',
    '改成 HTML，不只保留最终网页',
    '改成 HTML，只保留旧版 HTML',
    'Convert to HTML and keep both formats.',
    'Convert to HTML, keep the original TXT.',
    'Convert to HTML; keep only the final HTML; keep the original TXT for audit.',
    'Convert to HTML; keep only the final HTML; retain the original TXT for audit.',
    'Convert to HTML; keep only the final HTML; preserve the original TXT for audit.',
    'Convert to HTML; keep only the final HTML; do not discard the original TXT.',
    'Convert to HTML; retain the original TXT for audit; keep only the final HTML.',
    '改成 HTML，只保留最终网页，原 TXT 也留着以供审核',
    '改成 HTML，只保留最终网页，原 TXT 不要删除',
    '改成 HTML，原 TXT 也留着以供审核，只保留最终网页',
    '改成 HTML，原 TXT 不要删除，只保留最终网页',
    'Convert to HTML; do not keep only the final HTML.',
    '不要这么做：改成 HTML，只保留最终网页',
    'Do not do this: convert to HTML and keep only the final HTML.',
    'Convert to HTML; the original TXT must remain available; keep only the final HTML.',
    'Convert to HTML while the original TXT remains available and keep only the final HTML.',
    '改成 HTML，原 TXT 别删，只保留最终网页',
    'Convert to HTML and keep only the final HTML and the original TXT.',
  ]) {
    f.messages(request, 'Final result: [report.html](report.html)');
    assert.deepEqual(names(runtime.snapshot(f.handle)), ['report.html', 'report.txt'], request);
    assert.deepEqual((await taskDelivery.capture(f.handle, 'completed')).files.map(item => item.name).sort(),
      ['report.html', 'report.txt'], request);
  }
});

test('explicit final links disambiguate drafts without losing referenced website resources', async t => {
  const f = fixture(t);
  f.write('课表.md', '# draft'); f.write('中学生课表.md', '# final');
  f.messages('生成一份课表', '文件已生成：[中学生课表.md](中学生课表.md)');
  assert.deepEqual(names(runtime.snapshot(f.handle)), ['中学生课表.md']);
  f.write('index.html', '<link rel="stylesheet" href="assets/app.css"><img src="assets/hero.png">');
  f.write('assets/app.css','body{color:purple}'); f.write('assets/hero.png', 'asset');
  f.messages('改成网页', '[预览](index.html)');
  const snapshot = runtime.snapshot(f.handle);
  assert.deepEqual(names(snapshot), ['index.html']);
  const result = await packages.prepare(f.handle, snapshot.delivery.items.map(item=>item.artifactId));
  assert.deepEqual(result.manifest.files.map(item=>item.path), ['assets/app.css', 'assets/hero.png', 'index.html']);
  assert.equal(result.manifest.entryPath, 'index.html');
});

test('rework receipts preserve requested paths and explicit replacements without promoting review notes', async t => {
  const {requestedExtension} = require('../main/conversation/delivery-selection');
  assert.equal(requestedExtension('Do not convert to HTML.', {explicitOnly:true}), '');
  assert.equal(requestedExtension('Generate an analysis of the current HTML.', {explicitOnly:true}), '');
  assert.equal(requestedExtension('Convert to HTML.', {explicitOnly:true}), '.html');
  const f = fixture(t);
  f.write('findings.md', 'The original is still incorrect.');
  f.messages('Fix the original delivery.', 'Reviewed again: [findings](findings.md)');
  let form;
  t.mock.method(global, 'fetch', async (_url, options) => {
    form = options.body;
    return Response.json({ok:true});
  });
  async function replay(options) {
    const payload = await taskDelivery.capture(f.handle, 'completed', {}, options);
    await taskDelivery.send({hub:'https://fixture.invalid'}, '/tasks/test', {}, JSON.parse(JSON.stringify(payload)));
    return form;
  }
  await replay();
  assert.deepEqual(form.getAll('paths'), ['findings.md']);
  assert.deepEqual(form.getAll('declaredPaths'), []);
  assert.equal(form.get('replacements'), null);
  f.manifest({deliverables:[{path:'findings.md'}]});
  await replay();
  assert.deepEqual(form.getAll('declaredPaths'), []);
  assert.equal(form.get('replacements'), null);

  f.write('site/index.html', '<link rel="stylesheet" href="theme.css">');
  f.write('site/theme.css', 'body { color: navy }');
  f.manifest({deliverables:[{path:'site/index.html', replaces:['docs/source.md']}]});
  await replay({requestedFormat:'.html'});
  assert.deepEqual(form.getAll('declaredPaths'), ['site/index.html']);
  assert.deepEqual(JSON.parse(form.get('replacements')), {'site/index.html':['docs/source.md']});
  await replay({paths:{required:new Set(['site/index.html']), named:new Set()}});
  assert.deepEqual(form.getAll('declaredPaths'), ['site/index.html']);
});

test('website verification captures cannot enter a bundle through primary or supporting declarations', async t => {
  const f = fixture(t);
  f.write('index.html','<img src="assets/hero.png">'); f.write('assets/hero.png','page asset');
  f.write('final-hero.png','capture'); f.write('verify-top.png','capture'); f.write('check.md','validation');
  f.write('.soduwork/evidence/report.txt','validation details');
  f.messages('生成一个网站', '[打开网页](index.html)');
  f.state.tools = [{name:'bash',state:'done',args:{command:"const shot = await cdp.send('Page.captureScreenshot'); fs.writeFileSync('final-hero.png', Buffer.from(shot.data, 'base64'));"}}];
  f.manifest({processFiles:['check.md','.soduwork/evidence/report.txt'],deliverables:[{path:'index.html',files:['assets/hero.png','final-hero.png','verify-top.png','check.md','.soduwork/evidence/report.txt']},
    {path:'final-hero.png'}, {path:'check.md',role:'evidence'}]});
  const snapshot = runtime.snapshot(f.handle);
  assert.deepEqual(names(snapshot), ['index.html']);
  const payload = await taskDelivery.capture(f.handle, 'completed');
  assert.deepEqual(payload.files.map(item=>item.name), ['assets/hero.png','index.html']);
  const worker = await require('../main/conversation/delivery-package-worker').prepare(f.handle, snapshot.delivery.items.map(item=>item.artifactId));
  assert.deepEqual(worker.manifest.files.map(item=>item.path), ['assets/hero.png','index.html'], 'worker packaging preserves the same provenance rules');
  assert.equal(snapshot.items.find(item=>item.relative==='final-hero.png').processEvidence, true);
  f.write('index.html','<img src="final-hero.png">');
  await assert.rejects(taskDelivery.capture(f.handle, 'completed'), /交付物引用了过程或验证文件/,
    'a conflicting runtime dependency must not produce a broken website silently');
});

test('requested screenshots, explicit replacements, and summary-only work retain their contracts', async t => {
  const f = fixture(t);
  f.write('final-hero.png','requested image');
  f.state.tools = [{name:'browser_screenshot',state:'done',args:{filename:'final-hero.png'}}];
  f.messages('提供网页截图作为交付物', '[截图](final-hero.png)');
  f.manifest({deliverables:[{path:'final-hero.png'}]});
  assert.deepEqual(names(runtime.snapshot(f.handle)), ['final-hero.png']);
  assert.deepEqual((await taskDelivery.capture(f.handle,'completed')).files.map(item=>item.name), ['final-hero.png']);
  f.write('old.md','# old'); f.write('new.html','<h1>new</h1>');
  f.manifest({deliverables:[{path:'old.md'}, {path:'new.html',replaces:['old.md']}]});
  f.messages('修改成新版', '[新版本](new.html)');
  assert.deepEqual(names(runtime.snapshot(f.handle)), ['new.html']);
  f.manifest({presentation:'summary',deliverables:[]});
  assert.equal(await taskDelivery.capture(f.handle,'completed'), null);
});

function nativeTurn(acc, request, content) {
  acc.push({type:'message_end', message:{role:'user',content:request}});
  acc.push({type:'message_start', message:{role:'assistant'}});
  for (const [index, block] of content.entries()) {
    acc.push({type:'message_update',assistantMessageEvent:{type:block.kind + '_end',contentIndex:index,
      ...(block.kind === 'toolcall' ? {toolCall:block.toolCall} : {content:block.text})}});
  }
  acc.push({type:'message_end',message:{role:'assistant',stopReason:'stop'}});
  acc.push({type:'agent_settled'});
}

test('native rework final links exclude an edited intermediate document without erasing history', async t => {
  const f=fixture(t), acc=require('../main/pi-session/event-stream').create();
  f.handle.snapshot=()=>acc.snapshot();
  f.write('report.md','# Original rejected report',true);
  nativeTurn(acc,'Write a report',[{kind:'text',text:'[Original report](report.md)'}]);
  f.write('report.md','# Intermediate revision');
  f.write('report-v2.md','# Final revised report');
  nativeTurn(acc,'Revise the report based on the review feedback',[
    {kind:'thinking',text:'Maybe deliver [old draft](report.md)'},
    {kind:'text',text:'[Final revised report](report-v2.md)'},
  ]);
  assert.equal(acc.snapshot().messages.at(-1).text,'','use the real public snapshot shape');
  assert.deepEqual(names(runtime.snapshot(f.handle)),['report-v2.md']);
  assert.deepEqual((await taskDelivery.capture(f.handle,'completed')).files.map(row=>row.name),['report-v2.md']);
  assert.equal(acc.snapshot().messages.length,4,'both conversation turns remain');
  assert.equal(fs.readFileSync(path.join(f.cwd,'report.md'),'utf8'),'# Intermediate revision');
  assert.equal(runtime.snapshot(f.handle).items.some(row=>row.relative==='report.md'),true);
});

test('native final links retain multiple deliverables and their unchanged required resources', async t => {
  const f=fixture(t), acc=require('../main/pi-session/event-stream').create();
  f.handle.snapshot=()=>acc.snapshot();
  f.write('report.md','# Intermediate revision');
  f.write('report-v2.md','# Final report');
  f.write('report-v2.html','<!doctype html><html><head><link rel="stylesheet" href="assets/style.css"></head><body>Final report</body></html>');
  f.write('assets/style.css','body{color:purple}',true);
  nativeTurn(acc,'Revise the report',[
    {kind:'text',text:'[Final report](report-v2.md) and [Website](report-v2.html)'},
  ]);
  assert.deepEqual(names(runtime.snapshot(f.handle)),['report-v2.html','report-v2.md']);
  assert.deepEqual((await taskDelivery.capture(f.handle,'completed')).files.map(row=>row.name),
    ['assets/style.css','report-v2.html','report-v2.md']);
  f.manifest({deliverables:[{path:'report.md'},{path:'report-v2.md'}]});
  assert.deepEqual(names(runtime.snapshot(f.handle)),['report-v2.md','report.md'],
    'an explicit complete manifest retains its declared multi-file set');
  f.manifest({deliverables:[{path:'report.md'},{path:'report-v2.md',replaces:['report.md']}]});
  assert.deepEqual(names(runtime.snapshot(f.handle)),['report-v2.md']);
});

test('delivery selection ignores pre-tool prose, hidden scopes and unfinished replies in native snapshots', t => {
  const select=require('../main/conversation/delivery-selection');
  const user={role:'user',text:'Revise the report'};
  const blocks=[{kind:'text',text:'[Intermediate](report.md)',done:true},
    {kind:'toolcall',toolCall:{name:'write',arguments:{content:'[Unrelated](other.md)'}}},
    {kind:'thinking',text:'[Thought](thought.md)'},
    {kind:'text',text:'[Final](report-v2.md)',done:true}];
  const assistant={role:'assistant',text:'',blocks,done:true,stopReason:'stop',scope:'normal'};
  const answer=value=>select.turn({messages:[user,value]}).answer;
  assert.equal(answer(assistant),'[Final](report-v2.md)');
  assert.equal(answer({...assistant,blocks:blocks.slice(0,2)}),'');
  for (const scope of ['goal-progress','goal-execution','goal-review','runtime-notice'])
    assert.equal(answer({...assistant,scope}),'',scope);
  for (const patch of [{done:false},{errorMessage:'failed'},{stopReason:'error'},{stopReason:'length'},
    {blocks:[{kind:'text',text:'[Partial](report.md)',done:false}]}])
    assert.equal(answer({...assistant,...patch}),'');
  assert.equal(answer({...assistant,scope:'goal-final'}),'[Final](report-v2.md)');
});

test('legacy empty-block and Runner block replies retain their final-file selection', async t => {
  const f=fixture(t);
  f.write('report.md','# Intermediate revision');f.write('report-v2.md','# Final revised report');
  const final='[Final revised report](report-v2.md)';
  for (const reply of [
    {text:final,blocks:[]},
    {content:final,blocks:[]},
    {content:[{type:'text',text:final}],blocks:[]},
    // Runner's public reply has blocks without scope or per-block done flags.
    {blocks:[{kind:'text',text:final}],done:true},
  ]) {
    f.state.messages=[{role:'user',text:'Revise the report'},{role:'assistant',...reply}];
    assert.deepEqual((await taskDelivery.capture(f.handle,'completed')).files.map(row=>row.name),['report-v2.md']);
  }
  f.state.messages=[{role:'user',text:'Revise the report'},
    {role:'assistant',text:final,blocks:[{kind:'thinking',text:'Private deliberation'}]}];
  assert.deepEqual((await taskDelivery.capture(f.handle,'completed')).files.map(row=>row.name).sort(),['report-v2.md','report.md'],
    'nonempty structured blocks remain authoritative instead of falling back to stale flattened text');
});
