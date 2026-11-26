'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const delivery = require('../main/pi-session/task-delivery.cjs');
const outputs = require('../main/pi-session/outputs');

test('an explicit file contract cannot silently complete with an empty output inventory', async t => {
  const f = workspace(t), actions = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    if (String(url).endsWith('/attachments')) return Response.json([]);
    if (options?.body) { const body = JSON.parse(options.body); actions.push(body.action); return Response.json({turn:{state:'queued'}}); }
    return Response.json({id:'t', workRouting:{outputContract:{deliverables:[{path:'report.md'}]}}});
  });
  const turn = await require('../main/pi-session/task-input').prepare({hub:'https://fixture.invalid'},
    't', 'chat', 'turn', 'Write a report', {}, {handle:f.handle});
  await assert.rejects(turn.afterTurn('completed'), /未采集到.*交付文件/);
  await turn.afterTurn('failed');
  assert.deepEqual(actions, ['prepare', 'fail']);
});

for (const contract of [{}, {kind:'repository-change'}, {kind:'office-artifact'}]) {
  test('text and kind-only contracts retain normal no-file completion: ' + (contract.kind || 'text'), async t => {
    const f = workspace(t), actions = [];
    t.mock.method(global, 'fetch', async (url, options) => {
      if (String(url).endsWith('/attachments')) return Response.json([]);
      if (options?.body) { const body = JSON.parse(options.body); actions.push(body.action); return Response.json({turn:{state:'queued'}}); }
      return Response.json({id:'t', workRouting:{outputContract:contract}});
    });
    const turn = await require('../main/pi-session/task-input').prepare({hub:'https://fixture.invalid'},
      't', 'chat', 'turn', 'Answer', {}, {handle:f.handle});
    await turn.afterTurn('completed');
    assert.deepEqual(actions, ['prepare', 'complete']);
  });
}

test('an incomplete scan cannot present a partial explicit file delivery as complete', async t => {
  const f = workspace(t); f.write('report.md', '# Report');
  const original = f.handle.outputSnapshotAsync;
  f.handle.outputSnapshotAsync = async () => ({...await original(), truncated:true});
  await assert.rejects(delivery.capture(f.handle, 'completed', {}, {requiresFiles:true}), /扫描.*不完整/);
});

test('completed journal recovers a generated file with preserved old mtime without uploading unrelated old files', async t => {
  const f = workspace(t), journal = require('../main/conversation/file-change-journal');
  const since = Date.now() - 1000;
  f.write('unrelated.md', '# Historical', 1000);
  const before = await journal.snapshot(f.cwd);
  f.write('winter-poem.md', '# Winter poem', 1000);
  const changes = journal.compare(before, await journal.snapshot(f.cwd), {turnId:'turn'});
  f.handle.outputSnapshotAsync = async () => ({
    ...outputs.withJournal(await outputs.scanAsync(f.cwd, since, since, changes), changes), fileChanges: changes,
  });
  const payload = await delivery.capture(f.handle, 'completed');
  assert.deepEqual(payload?.files.map(x => x.name), ['winter-poem.md']);
  assert.equal(Buffer.from(payload.files[0].data, 'base64').toString(), '# Winter poem');
});

test('journal-authorized capture rejects replacement content even when size and mtime are preserved', async t => {
  const f = workspace(t), journal = require('../main/conversation/file-change-journal');
  const since = Date.now() - 1000, before = await journal.snapshot(f.cwd);
  f.write('report.md', '# First', 1000);
  const changes = journal.compare(before, await journal.snapshot(f.cwd), {turnId:'turn'});
  f.handle.outputSnapshotAsync = async () => ({
    ...outputs.withJournal(await outputs.scanAsync(f.cwd, since, since, changes), changes), fileChanges: changes,
  });
  f.write('report.md', '# Other', 1000);
  await assert.rejects(delivery.capture(f.handle, 'completed'), /变化|更新/);
});

function workspace(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-task-delivery-'));
  t.after(() => fs.rmSync(cwd, {recursive:true, force:true}));
  let turnSince = Date.now() - 1000;
  const handle = {cwd, sessionId:'chat', snapshot:()=>({status:'idle'}),
    outputSnapshot:()=>outputs.scan(cwd, 0, 0),
    outputSnapshotAsync:()=>outputs.scanAsync(cwd, 0, turnSince)};
  const write = (name, data, at = Date.now()) => {
    const target = path.join(cwd, name); fs.mkdirSync(path.dirname(target), {recursive:true});
    fs.writeFileSync(target, data); fs.utimesSync(target, at / 1000, at / 1000);
  };
  return {cwd, handle, write, since:value=>{turnSince=value;}};
}

test('a completed turn captures the standalone JSON result after an unsuccessful bash attempt', async t => {
  const f = workspace(t), bytes = JSON.stringify({ title: 'Spring', paragraphs: ['Synthetic prose'] });
  f.write('spring-parallel-prose.json', bytes);
  f.write('previous-prose.json', '{"historical":true}', Date.now() - 10000);
  f.write('package-lock.json', '{}');
  f.write('credentials.json', '{"token":"synthetic-only"}');
  f.write('.soduwork/evidence/bash-result.json', '{"exitCode":1}');
  f.handle.snapshot = () => ({ status: 'idle', tools: [
    { name: 'bash', state: 'error', isError: true, args: { command: 'missing-fixture-command' }, result: 'Command exited with code 1' },
    { name: 'write', state: 'done', isError: false, args: { path: 'spring-parallel-prose.json', content: bytes } },
  ], messages: [
    { role: 'user', content: [{ type: 'text', text: 'Generate spring-parallel-prose.json.' }] },
    { role: 'toolResult', toolName: 'bash', isError: true, content: [{ type: 'text', text: 'Command exited with code 1' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Created the requested JSON file.' }] },
  ] });
  const payload = await delivery.capture(f.handle, 'completed', {}, { requiresFiles: true });
  assert.equal(payload.outcome, 'completed');
  assert.deepEqual(payload.files.map(item => [item.name, item.category]), [['spring-parallel-prose.json', 'primary']]);
  assert.equal(Buffer.from(payload.files[0].data, 'base64').toString(), bytes);
});

test('task delivery uses the asynchronous turn boundary and captures website dependencies without verification screenshots', async t => {
  const f = workspace(t);
  f.write('site/index.html', '<link rel="stylesheet" href="style.css"><script src="main.js"></script>');
  f.write('site/style.css', `body{background:url("data:image/svg+xml,%3Csvg%3E%3Cg filter='url(%23n)'/%3E%3C/svg%3E")}`);
  f.write('site/main.js', 'document.title="Ready";');
  f.write('shots/verify-top.png', Buffer.from([137,80,78,71]));
  f.write('server.log', 'verification only');
  const payload = await delivery.capture(f.handle, 'completed');
  assert.deepEqual(payload.files.map(x=>x.name).sort(), ['site/index.html','site/main.js','site/style.css']);
  assert.equal(payload.files.find(x=>x.name.endsWith('style.css')).category, 'supporting');
  assert.equal(payload.files.find(x=>x.name.endsWith('index.html')).category, 'primary');
});

test('local model delivery retains real artifacts without storing or uploading model references', async t => {
  const f = workspace(t), ref = 'local:model-' + 'a'.repeat(32);
  f.write('report.md', 'Completed task report');
  const requests = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    requests.push({ url, body: options.body });
    return Response.json({ ok: true });
  });
  for (const model of [ref, 'local:private:wire-model', 'image::device:private::' + ref,
    { id: ref, localOnly: true }]) {
    f.handle.model = model;
    const payload = await delivery.capture(f.handle, 'completed');
    assert.equal(payload.model, '');
    assert.deepEqual(payload.files.map(row => row.name), ['report.md']);
    assert.doesNotMatch(JSON.stringify(payload), /local:|wire-model/);
    await delivery.send({ hub: 'https://fixture.invalid' }, '/tasks/task',
      { conversationId: 'chat', turnId: 'turn' }, { ...payload, model });
    const body = requests.at(-1).body;
    assert.equal(body.get('model'), '');
    assert.equal(body.get('conversationId'), 'chat');
    assert.equal(body.get('outcome'), 'completed');
    assert.equal(await body.get('files').text(), 'Completed task report');
  }
  f.handle.model = 'managed-model';
  assert.equal((await delivery.capture(f.handle, 'completed')).model, 'managed-model');
});

test('a changed dependency revises its unchanged entry but an unchanged prior delivery is not resubmitted', async t => {
  const f = workspace(t), now = Date.now();
  f.since(now - 1000);
  f.write('site/index.html', '<link rel="stylesheet" href="theme.css">', now - 10000);
  f.write('site/theme.css', 'body {color:purple}', now);
  f.write('obsolete.md', 'Previous rejected draft', now - 10000);
  const payload = await delivery.capture(f.handle, 'completed');
  assert(payload.files.some(x=>x.name==='site/index.html'));
  assert(payload.files.some(x=>x.name==='site/theme.css'));
  assert(!payload.files.some(x=>x.name==='obsolete.md'));
  f.since(now + 10000);
  assert.equal(await delivery.capture(f.handle, 'completed'), null);
  await assert.rejects(delivery.capture(f.handle, 'completed', {}, {requiresFiles:true}), /未采集到.*交付文件/);
});

test('local result cards and task transport agree on an entry changed only through CSS', async t => {
  const f = workspace(t), now = Date.now();
  f.since(now - 1000);
  f.write('index.html', '<link rel="stylesheet" href="theme.css">', now - 10000);
  f.write('theme.css', 'body {color:purple}', now);
  const identity = {hub:'https://fixture.invalid',clientId:'device',session:
    Buffer.from(JSON.stringify({typ:'device',uid:'owner',cid:'device',iat:1,exp:9e9})).toString('base64url')+'.'+'0'.repeat(64)};
  const sync = require('../main/conversation/local-delivery-sync').create();
  sync.bind(f.handle, identity);
  await f.handle.captureDelivery();
  assert.equal(f.handle.deliverySync.currentTurn, true);
  assert.equal(f.handle.deliverySync.artifactIds.length, 1);
  const previous = f.handle.deliverySync.revision;
  f.write('theme.css', 'body {color:green}', now + 1);
  await f.handle.captureDelivery();
  assert.notEqual(f.handle.deliverySync.revision, previous);
});

test('native skill packages survive local indexing and task delivery alongside installation candidates', async t => {
  const f = workspace(t);
  const localRef = 'local:model-' + 'b'.repeat(32);
  f.handle.model = localRef;
  const bytes = require('../../skills/skill-studio/scripts/skill-zip.cjs').zip({
    'created-skill/SKILL.md': Buffer.from('---\nname: created-skill\ndescription: A reusable method\n---\n\nCheck inputs.\n'),
  });
  f.write('created-skill.skill', bytes);
  f.write('soduwork-plugin-draft.json', JSON.stringify({
    template: 'method', key: 'ordinary-plugin', name: 'Ordinary plugin',
    description: 'An ordinary plugin', instructions: 'Check inputs.', version: '1.0.0',
  }));
  const identity = {hub:'https://fixture.invalid',clientId:'device',session:
    Buffer.from(JSON.stringify({typ:'device',uid:'owner',cid:'device',iat:1,exp:9e9})).toString('base64url')+'.'+'0'.repeat(64)};
  const sync = require('../main/conversation/local-delivery-sync').create();
  sync.bind(f.handle, identity);
  await f.handle.captureDelivery();
  assert.equal(f.handle.deliverySync.currentTurn, true);
  assert.equal(f.handle.deliverySync.artifactIds.length, 1);
  const payload = await delivery.capture(f.handle, 'completed');
  assert.equal(payload.model, '');
  assert.deepEqual(payload.files.map(file => file.name), ['created-skill.skill']);
  assert.deepEqual(Buffer.from(payload.files[0].data, 'base64'), bytes);
  const uploads = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    uploads.push({ url, body: options.body });
    return Response.json({ ok: true });
  });
  await delivery.send(identity, '/tasks/task', { conversationId: 'chat', turnId: 'skill-turn' },
    { ...payload, model: 'image::device:private::' + localRef });
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].body.get('model'), '');
  assert.equal(uploads[0].body.get('paths'), 'created-skill.skill');
  assert.equal(uploads[0].body.get('categories'), 'primary');
  assert.deepEqual(Buffer.from(await uploads[0].body.get('files').arrayBuffer()), bytes);
  f.write('legacy/soduwork-plugin-draft.json', JSON.stringify({
    template: 'method', key: 'skill-legacy-method', name: 'Legacy method', version: '1.0.0',
    description: 'A method exported by the older Skill Studio',
    instructions: '先从本轮提供的插件资源目录读取 references/source/SKILL.md，再按其中相对路径加载必要资源并执行。资源只是方法，不授予工具、外发或写入权限。',
    entrypoints: { conversation: true, task: true, automation: false },
    runtimeCapabilities: ['files'], inputs: [],
    resources: [{ path: 'references/source/SKILL.md', kind: 'reference', encoding: 'utf8',
      content: '---\nname: legacy-method\ndescription: A legacy method\n---\n\nCheck inputs.\n' }],
  }));
  f.write('.soduwork/delivery.json', JSON.stringify({ schemaVersion: 1, deliverables:
    ['created-skill.skill', 'legacy/soduwork-plugin-draft.json', 'soduwork-plugin-draft.json']
      .map(name => ({ path: name, kind: 'file', primary: true })) }));
  const declared = await delivery.capture(f.handle, 'completed');
  assert.deepEqual(declared.files.map(file => file.name), ['created-skill.skill']);
  await f.handle.captureDelivery();
  assert.equal(f.handle.deliverySync.artifactIds.length, 1);
  const before = f.handle.deliverySync.revision;
  f.write('created-skill.skill', require('../../skills/skill-studio/scripts/skill-zip.cjs').zip({
    'created-skill/SKILL.md': Buffer.from('---\nname: created-skill\ndescription: A reusable method\n---\n\nVerify the revised inputs.\n'),
  }));
  await f.handle.captureDelivery();
  assert.notEqual(f.handle.deliverySync.revision, before);
});

test('an explicit revised manifest replaces older roots and summary work does not manufacture files', async t => {
  const f = workspace(t);
  f.write('old.md', 'Old output'); f.write('final.html', '<html>Final delivery</html>');
   f.write('.soduwork/delivery.json', JSON.stringify({schemaVersion:1, deliverables:[{path:'final.html',kind:'website'}]}));
  assert.deepEqual((await delivery.capture(f.handle, 'completed')).files.map(x=>x.name), ['final.html']);
   f.write('.soduwork/delivery.json', JSON.stringify({schemaVersion:1,presentation:'summary',summary:'Repository change',deliverables:[]}));
  assert.equal(await delivery.capture(f.handle, 'completed'), null);
});

test('missing real dependencies remain an error and cannot silently complete the task receipt', async t => {
  const f = workspace(t); f.write('index.html', '<script src="missing.js"></script>');
  const actions = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    if (String(url).endsWith('/attachments')) return Response.json([]);
    if (options?.body) { const body = JSON.parse(options.body); actions.push(body.action); return Response.json({turn:{state:'queued'}}); }
    return Response.json({id:'t',title:'Website'});
  });
  const prepared = await require('../main/pi-session/task-input').prepare({hub:'https://fixture.invalid'},
    't', 'chat', 'turn', 'Build', {}, {handle:f.handle});
  await assert.rejects(prepared.afterTurn('completed'), /missing.js/);
  await prepared.afterTurn('failed');
  assert.deepEqual(actions, ['prepare', 'fail']);
});

test('stylesheet URL tokenization ignores nested data content, comments and strings while preserving local dependencies', () => {
  const refs = require('../main/conversation/stylesheet-references').references;
  assert.deepEqual(refs(`/* url(fake.png) */ .a{content:"url(fake2.png)";background:url("data:image/svg+xml,<svg filter='url(%23n)'/>")} @import "theme.css"; .b{src:url(font.woff2);background:url('hero image.png')}`),
    ['data:image/svg+xml,<svg filter=\'url(%23n)\'/>', 'theme.css', 'font.woff2', 'hero image.png']);
});

test('website delivery follows quoted CSS imports separated by comments', async t => {
  const f = workspace(t);
  f.write('site/index.html', '<link rel="stylesheet" href="main.css">');
  f.write('site/main.css', '@import/* generated theme */ "theme.css";');
  f.write('site/theme.css', 'body{background:url(bg.png)}');
  f.write('site/bg.png', Buffer.from([137,80,78,71]));
  const payload = await delivery.capture(f.handle, 'completed');
  assert.deepEqual(payload.files.map(row => row.name).sort(),
    ['site/bg.png', 'site/index.html', 'site/main.css', 'site/theme.css']);
  const refs = require('../main/conversation/stylesheet-references').references;
  assert.deepEqual(refs('@import /* one */ /* two */ "a.css"; /* @import "fake.css"; */'), ['a.css']);
  assert.deepEqual(refs('@import /* unclosed'), []);
});

test('stylesheet URL tokenization preserves literal comment-like paths', () => {
  const refs = require('../main/conversation/stylesheet-references').references;
  for (const [css, expected] of [
    ['url(/*comment*/image.png)', '/*comment*/image.png'],
    ['url( \t/*comment*/image.png )', '/*comment*/image.png'],
    ['url(/*one*//*two*/image.png)', '/*one*//*two*/image.png'],
    ['url(/*unfinished-image.png)', '/*unfinished-image.png'],
    ['url(images/*comment*/image.png)', 'images/*comment*/image.png'],
    ['url("/*comment*/image.png")', '/*comment*/image.png'],
    ['@import/* import comment */url(/*literal*/theme.css)', '/*literal*/theme.css'],
  ]) assert.deepEqual(refs(css), [expected], css);
  assert.deepEqual(refs('@import/* comment */url( theme.css );'), ['theme.css']);
});

for (const [label, css, dependency] of [
  ['image', 'body{background-image:url(/*comment*/image.png)}', 'image.png'],
  ['import', '@import/* import comment */url(/*literal*/theme.css);', 'theme.css'],
]) test('website delivery rejects a literal comment-like ' + label + ' URL instead of stripping it', async t => {
  const f = workspace(t);
  f.write('site/index.html', '<link rel="stylesheet" href="main.css">');
  f.write('site/main.css', css);
  f.write('site/' + dependency, dependency.endsWith('.css') ? 'body{color:purple}' : Buffer.from([137,80,78,71]));
  await assert.rejects(delivery.capture(f.handle, 'completed'), /不适合交付的路径/);
  assert.equal(fs.readFileSync(path.join(f.cwd, 'site/main.css'), 'utf8'), css);
});

test('only named current-turn files join inferred requirement delivery', async t => {
  const f = workspace(t);
  for (const name of ['report.md', 'check.py', 'helper.py', 'verify.py', 'old.py'])
    f.write(name, 'test data', name === 'old.py' ? 1000 : Date.now());
  const {outputPaths} = require('../main/pi-session/task-output-paths.cjs');
  const paths = outputPaths({}, ['Deliver check.py as a standalone script.', 'Run helper.py to verify the report.',
    'Do not deliver verify.py.', '请交付 old.py', 'Include helper.py in the test command.']);
  const payload = await delivery.capture(f.handle, 'completed', {}, {paths});
  assert.deepEqual(payload.files.map(file => file.name), ['check.py', 'report.md']);
  assert.deepEqual([...paths.named].sort(), ['check.py', 'old.py']);
  assert.deepEqual((await delivery.capture(f.handle, 'incomplete', {}, {paths})).files.map(file => file.name), ['report.md']);
});

test('a script can be the only requirement output, and absent mandatory members block partial submission', async t => {
  const f = workspace(t);
  f.write('tool.py', 'print(1)');
  const {outputPaths} = require('../main/pi-session/task-output-paths.cjs');
  const paths = outputPaths({expectedArtifacts: [{entry: 'tool.py'}, {path: 'optional.py', required: false}]}, []);
  assert.deepEqual((await delivery.capture(f.handle, 'completed', {}, {paths})).files.map(file => file.name), ['tool.py']);
  paths.required.add('missing.py');
  await assert.rejects(delivery.capture(f.handle, 'completed', {}, {paths}), /missing\.py/);
});

test('settled Pi receipts use only their own completed journal to collect named files after the execution clock clears', async t => {
  const f = workspace(t), journal = require('../main/conversation/file-change-journal');
  f.write('older.py', '# historical');
  const before = await journal.snapshot(f.cwd);
  f.write('check.py', 'print(60)');
  f.write('orders.csv', 'order,amount\nA,60');
  const changes = journal.compare(before, await journal.snapshot(f.cwd), {turnId: 'first'});
  const aliases = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-workspace-alias-'));
  t.after(() => fs.rmSync(aliases, {recursive: true, force: true}));
  const alias = path.join(aliases, 'work');
  fs.symlinkSync(f.cwd, alias, process.platform === 'win32' ? 'junction' : 'dir');
  f.handle.cwd = alias;
  const paths = require('../main/pi-session/task-output-paths.cjs').outputPaths({}, ['请交付 check.py、older.py。']);
  f.handle.outputSnapshotAsync = async () => ({...await outputs.scanAsync(alias, 0, 0), fileChanges: changes});
  const capture = async turnId => (await delivery.capture(f.handle, 'completed', {turnId}, {paths})).files.map(f => f.name).sort();
  assert.deepEqual(await capture('first'), ['check.py', 'orders.csv']);
  assert.deepEqual(await capture('next'), ['orders.csv']);
  const originalRoot = changes.cwd;
  changes.cwd = await fs.promises.realpath(aliases);
  assert.deepEqual(await capture('first'), ['orders.csv']);
  changes.cwd = originalRoot;
  changes.truncated = true;
  assert.deepEqual(await capture('first'), ['orders.csv']);
});

test('explicitly marked process files stay out of the submitted manifest', async t => {
  const f = workspace(t);
  f.write('check.py', 'print(1)'); f.write('summary.md', '# Report');
  f.write('.soduwork/delivery.json', JSON.stringify({schemaVersion:1, deliverables:[{path:'summary.md'}], processFiles:['check.py']}));
  const {outputPaths} = require('../main/pi-session/task-output-paths.cjs');
  const paths = outputPaths({}, ['请交付 check.py']);
  const payload = await delivery.capture(f.handle, 'completed', {}, {paths});
  assert.deepEqual(payload.files.map(file => file.name), ['summary.md']);
});

test('named changed script omitted from a partial manifest is captured with its current bytes', async t => {
  const f = workspace(t);
  f.write('summary.md', '# Corrected report');
  f.write('check.py', 'print("current")');
  f.write('unused.py', 'print("private working note")');
  f.write('.soduwork/delivery.json', JSON.stringify({schemaVersion:1, deliverables:[{path:'summary.md'}]}));
  const {outputPaths} = require('../main/pi-session/task-output-paths.cjs');
  const paths = outputPaths({}, ['`check.py` must run standalone']);
  const result = await delivery.capture(f.handle, 'completed', {}, {paths});
  assert.deepEqual(result.files.map(file => file.name), ['check.py', 'summary.md']);
  assert.equal(Buffer.from(result.files[0].data, 'base64').toString(), 'print("current")');
});
