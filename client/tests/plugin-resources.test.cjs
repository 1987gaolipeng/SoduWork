'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const resources = require('../main/plugin-resources');
const personal = require('../main/personal-plugins');
const reader = require('../main/pi-session/plugin-draft');
const grant = require('../main/pi-session/plugin-grant');
const draft = () => ({ template:'method', key:'template-demo', name:'模板演示', version:'1.0.0',
  description:'使用随包模板', instructions:'复制模板，填入用户内容并生成报告。',
  resources:[{path:'templates/报告.md',kind:'template',encoding:'utf8',content:'# {{title}}\n'},
    {path:'scripts/render.mjs',kind:'script',encoding:'utf8',content:'console.log("sample")'}] });
function fixture(t) { const root=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-resource-test-')); t.after(()=>fs.rmSync(root,{recursive:true,force:true})); return root; }

test('resources normalize deterministically, preserve bytes and reject mutated digests', () => {
  const first=resources.normalize(draft().resources), second=resources.normalize([...draft().resources].reverse());
  assert.deepEqual(first,second); assert.equal(resources.digest(first),resources.digest(second));
  assert.match(Buffer.from(first[1].content,'base64').toString(),/title/);
  assert.throws(()=>resources.normalize([{...first[0],content:Buffer.from('changed').toString('base64')}]),/校验不一致/);
  assert.deepEqual(resources.summary(first)[0],{path:first[0].path,kind:'script',sha256:first[0].sha256,size:first[0].size});
});

test('resources reject traversal, Windows aliases, duplicates, credentials and invalid encodings', () => {
  for (const name of ['../a','assets/../a','assets\\a','C:/a','/assets/a','assets/.env','assets/CON.txt','assets/a:stream','assets/a.','assets/run.exe']) {
    assert.throws(()=>resources.normalize([{path:name,kind:'asset',encoding:'utf8',content:'x'}]),undefined,name);
  }
  const item={path:'assets/A.txt',kind:'asset',encoding:'utf8',content:'x'};
  assert.throws(()=>resources.normalize([item,{...item,path:'assets/a.txt'}]),/重复/);
  assert.throws(()=>resources.normalize([{...item,content:'password=abcdefghi'}]),/凭据/);
  assert.throws(()=>resources.normalize([{...item,encoding:'base64',content:'eA'}]),/Base64/);
  assert.throws(()=>resources.normalize([{...item,content:'\ud800'}]),/UTF-8/);
  assert.throws(()=>resources.normalize(Array(resources.MAX_FILES+1).fill(item)),/300/);
  assert.equal(resources.normalize(Array.from({length:80},(_,i)=>({...item,path:'assets/file-'+i+'.txt'}))).length,80);
});

test('conversation draft collects declared files and fails closed for missing files and symlinks', t => {
  const root=fixture(t), file=path.join(root,reader.DRAFT_NAME);
  fs.mkdirSync(path.join(root,'templates'));
  fs.writeFileSync(path.join(root,'templates/report.txt'),'a real template');
  fs.writeFileSync(file,JSON.stringify({...draft(),resources:[{path:'templates/report.txt',kind:'template'}]}));
  const handle={cwd:root,sessionId:'test',outputSnapshot:()=>({files:[{path:file,name:reader.DRAFT_NAME,at:1}]})};
  const got=reader.readRecent([handle]);assert.equal(got.ok,true);
  assert.equal(Buffer.from(got.body.resources[0].content,'base64').toString(),'a real template');
  fs.unlinkSync(path.join(root,'templates/report.txt'));
  assert.equal(reader.readRecent([handle]).ok,false);
  const other=fixture(t); fs.writeFileSync(path.join(other,'report.txt'),'private');
  fs.rmdirSync(path.join(root,'templates')); fs.symlinkSync(other,path.join(root,'templates'),'junction');
  assert.match(reader.readRecent([handle]).reason,/链接|联接/);
});

test('install, portable export, import and real turn resolution preserve resource hashes', async t => {
  const root=fixture(t), root2=fixture(t), cwd=fixture(t), app={getPath:()=>root};
  const installed=personal.create(app,draft()).plugin;
  assert.equal(installed.capabilities.resources.length,2);
  const exported=personal.exportDraft(app,installed.pluginId);
  assert.equal(exported.resources[0].sha256,installed.capabilities.resources[0].sha256);
  const imported=personal.create({getPath:()=>root2},exported).plugin;
  assert.equal(imported.checksum,installed.checksum);
  const resolved=await grant.resolve({app,cwd,pluginIds:[installed.pluginId],identityOf:()=>{throw Error('must stay offline')}});
  assert.match(resolved.items[0].context,/本轮插件随包资源/);
  const directory=path.join(cwd,'.soduwork/plugins/template-demo',resources.digest(exported.resources));
  assert.equal(fs.readFileSync(path.join(directory,'templates/报告.md'),'utf8'),'# {{title}}\n');
  assert.equal(fs.existsSync(path.join(cwd,'sample')),false,'Install does not execute scripts');
  resources.materialize(exported.resources,cwd,'template-demo');
  fs.writeFileSync(path.join(directory,'templates/报告.md'),'changed');
  /* Repair locally modified resources through backup and manifest restoration instead of blocking every send. */
  const rescuedTurn=resources.materialize(exported.resources,cwd,'template-demo');
  assert.deepEqual(rescuedTurn.rescued,['templates/报告.md']);
  assert.equal(fs.readFileSync(path.join(directory,'templates/报告.md'),'utf8'),'# {{title}}\n','original restored');
  const firstBackup = rescuedTurn.backups[0];
  assert.equal(firstBackup.path,'templates/报告.md');
  assert.equal(fs.readFileSync(path.join(directory,firstBackup.backup),'utf8'),'changed','local edit kept');
  const rescuedGuide=resources.guidance(rescuedTurn);
  assert.match(rescuedGuide,/修改已分别备份/);
  assert.ok(rescuedGuide.includes('- templates/报告.md → ' + firstBackup.backup),'guidance identifies the actual backup');
  assert.doesNotMatch(rescuedGuide,/undefined/);
  assert.equal(resources.materialize(exported.resources,cwd,'template-demo').rescued.length,0,'idempotent resend');
  fs.writeFileSync(path.join(directory,'templates/报告.md'),'second edit');
  const again=resources.materialize(exported.resources,cwd,'template-demo');
  assert.deepEqual(again.rescued,['templates/报告.md']);
  assert.notEqual(again.backups[0].backup,firstBackup.backup);
  assert.equal(fs.readFileSync(path.join(directory,again.backups[0].backup),'utf8'),'second edit');
  assert.equal(fs.readFileSync(path.join(directory,firstBackup.backup),'utf8'),'changed','earlier edit remains available');
  assert.equal(fs.existsSync(path.join(directory,'scripts/render.mjs.local')),false,'untouched siblings stay put');
  const changed=draft();changed.resources[0].content='changed';
  assert.throws(()=>personal.create(app,changed),/提升版本/);
});

test('repair preserves edits to both a resource and its declared .local sibling plus existing backups', t => {
  const root = fixture(t);
  const files = ['templates/report.md', 'templates/report.md.local'].map((name, i) => ({
    path: name, kind: 'template', encoding: 'utf8', content: 'bundled ' + i,
  }));
  const { directory } = resources.materialize(files, root, 'backup-conflict');
  files.forEach((file, i) => fs.writeFileSync(path.join(directory, file.path), 'edited ' + i));
  const existing = path.join(directory, 'templates/report.md.local.1');
  fs.writeFileSync(existing, 'earlier user backup');
  const oldDirectory = path.join(directory, '.local-existing');
  fs.mkdirSync(oldDirectory);
  fs.writeFileSync(path.join(oldDirectory, 'report.md'), 'older backup directory');

  const repaired = resources.materialize(files, root, 'backup-conflict');
  assert.deepEqual(repaired.rescued, files.map(file => file.path));
  assert.equal(repaired.backups.length, 2);
  assert.equal(new Set(repaired.backups.map(item => item.backup)).size, 2);
  const guide = resources.guidance(repaired);
  for (const [i, file] of files.entries()) {
    assert.equal(fs.readFileSync(path.join(directory, file.path), 'utf8'), file.content);
    const backup = repaired.backups.find(item => item.path === file.path);
    assert.ok(backup, 'each edited resource has a recoverable backup');
    assert.equal(fs.readFileSync(path.join(directory, backup.backup), 'utf8'), 'edited ' + i);
    assert.ok(guide.includes('- ' + file.path + ' → ' + backup.backup));
  }
  assert.equal(fs.readFileSync(existing, 'utf8'), 'earlier user backup');
  assert.equal(fs.readFileSync(path.join(oldDirectory, 'report.md'), 'utf8'), 'older backup directory');
  assert.deepEqual(resources.materialize(files, root, 'backup-conflict').backups, []);
});

test('repair preserves a resource replaced by a directory across later edits', t => {
  const root = fixture(t), files = [{ path: 'templates/report.md', kind: 'template', encoding: 'utf8', content: 'original' }];
  const { directory } = resources.materialize(files, root, 'directory-repair');
  const file = path.join(directory, files[0].path);
  fs.unlinkSync(file);
  fs.mkdirSync(file);
  fs.writeFileSync(path.join(file, 'notes.txt'), 'user notes');
  const first = resources.materialize(files, root, 'directory-repair');
  assert.equal(fs.readFileSync(file, 'utf8'), 'original');
  const savedDirectory = path.join(directory, first.backups[0].backup);
  assert.equal(fs.readFileSync(path.join(savedDirectory, 'notes.txt'), 'utf8'), 'user notes');
  fs.writeFileSync(file, 'next edit');
  const next = resources.materialize(files, root, 'directory-repair');
  assert.equal(fs.readFileSync(path.join(directory, next.backups[0].backup), 'utf8'), 'next edit');
  assert.equal(fs.readFileSync(path.join(savedDirectory, 'notes.txt'), 'utf8'), 'user notes');
});

test('resource cache refuses a junction escape and keeps unrelated files unchanged', t => {
  const root=fixture(t), other=fixture(t);fs.symlinkSync(other,path.join(root,'.soduwork'),'junction');
  assert.throws(()=>resources.materialize(draft().resources,root,'template-demo'),/链接|联接/);
  assert.deepEqual(fs.readdirSync(other),[]);
});

test('local backups cannot overwrite manifest resources or their parent directories', t => {
  const root = fixture(t);
  const names = ['templates/a.txt', 'templates/a.txt.local', 'templates/a.txt.local.1/child.txt'];
  const items = names.map((name, i) => ({ path: name, kind: 'template', encoding: 'utf8', content: 'original ' + i }));
  const first = resources.materialize(items, root, 'collision-demo');
  for (let i = 0; i < names.length; i++) fs.writeFileSync(path.join(first.directory, names[i]), 'edit ' + i);
  const repaired = resources.materialize(items, root, 'collision-demo');
  for (let i = 0; i < names.length; i++) assert.equal(fs.readFileSync(path.join(first.directory, names[i]), 'utf8'), 'original ' + i);
  for (let i = 0; i < names.length; i++) {
    const saved = repaired.backups.find(item => item.path === names[i]);
    assert.ok(saved, 'every edited resource has a recoverable backup');
    assert.equal(fs.readFileSync(path.join(first.directory, saved.backup), 'utf8'), 'edit ' + i);
    assert.ok(resources.guidance(repaired).includes(saved.backup));
  }
});

test('EXDEV backup copies verified local bytes before removing the source', t => {
  const root = fixture(t), first = resources.materialize(draft().resources, root, 'template-demo');
  const file = path.join(first.directory, 'templates/报告.md');
  fs.writeFileSync(file, 'local edit');
  const rename = fs.renameSync;
  fs.renameSync = (source, target) => {
    if (source === file) throw Object.assign(new Error('cross-device rename'), { code: 'EXDEV' });
    return rename(source, target);
  };
  try {
    const repaired = resources.materialize(draft().resources, root, 'template-demo');
    assert.equal(fs.readFileSync(path.join(first.directory, repaired.backups[0].backup), 'utf8'), 'local edit');
    assert.equal(fs.readFileSync(file, 'utf8'), '# {{title}}\n');
  } finally { fs.renameSync = rename; }
});

test('a failed EXDEV copy preserves the modified source', t => {
  const root = fixture(t), first = resources.materialize(draft().resources, root, 'template-demo');
  const file = path.join(first.directory, 'templates/报告.md');
  fs.writeFileSync(file, 'keep this edit');
  const rename = fs.renameSync, copy = fs.copyFileSync;
  fs.renameSync = (source, target) => source === file
    ? (() => { throw Object.assign(new Error('cross-device rename'), { code: 'EXDEV' }); })() : rename(source, target);
  fs.copyFileSync = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
  try {
    assert.throws(() => resources.materialize(draft().resources, root, 'template-demo'), /无法备份/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'keep this edit');
  } finally { fs.renameSync = rename; fs.copyFileSync = copy; }
});

test('an unverified EXDEV copy never deletes the modified source', t => {
  const root = fixture(t), first = resources.materialize(draft().resources, root, 'template-demo');
  const file = path.join(first.directory, 'templates/报告.md');
  fs.writeFileSync(file, 'keep these bytes');
  const rename = fs.renameSync, copy = fs.copyFileSync;
  fs.renameSync = (source, target) => source === file
    ? (() => { throw Object.assign(new Error('cross-device rename'), { code: 'EXDEV' }); })() : rename(source, target);
  fs.copyFileSync = (source, target) => fs.writeFileSync(target, 'different bytes', { flag: 'wx' });
  try {
    assert.throws(() => resources.materialize(draft().resources, root, 'template-demo'), /无法备份/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'keep these bytes');
  } finally { fs.renameSync = rename; fs.copyFileSync = copy; }
});

test('invalid entrypoint policy and modified version resources cannot be silently accepted', t => {
  for (const entrypoints of [false, 0, '', [], { task: 'yes' }]) {
    assert.throws(() => personal.build({ ...draft(), entrypoints }), /入口/);
  }
  const root=fixture(t), app={getPath:()=>root};
  const installed=personal.create(app,draft()).plugin;
  const file=path.join(root,'personal-plugins.json'), state=JSON.parse(fs.readFileSync(file,'utf8'));
  const version=state.plugins[0].versions[0];
  version.body.resources=resources.normalize([{path:'templates/changed.md',kind:'template',encoding:'utf8',content:'changed'}]);
  fs.writeFileSync(file,JSON.stringify(state));
  assert.throws(()=>personal.resolve(app,[installed.pluginId]),/版本清单不一致/);
});

test('legacy personal resources remain usable when an example intentionally resembles a credential', async t => {
  const root = fixture(t), cwd = fixture(t), app = { getPath: () => root };
  const legacy = draft();
  legacy.resources.push({
    path: 'examples/security-fixture.py', kind: 'example', encoding: 'utf8',
    content: 'PASSWORD = "admin123456"  # fixture for the audit plugin',
  });
  assert.throws(() => personal.create(app, legacy), /凭据/);

  const installed = personal.create(app, draft()).plugin;
  const file = path.join(root, 'personal-plugins.json');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  const version = state.plugins[0].versions[0];
  const legacyResource = resources.normalize(legacy.resources, { allowLegacyContent: true });
  version.body.resources = legacyResource;
  version.manifest.resources = resources.summary(legacyResource);
  fs.writeFileSync(file, JSON.stringify(state));

  const resolved = await grant.resolve({ app, cwd, pluginIds: [installed.pluginId],
    identityOf: () => { throw Error('must stay offline'); } });
  assert.equal(resolved.items.length, 1);
  assert.match(resolved.items[0].context, /本轮插件随包资源/);
  const resourcePath = path.join(cwd, '.soduwork', 'plugins', 'template-demo',
    resources.digest(legacyResource), 'examples', 'security-fixture.py');
  assert.equal(fs.readFileSync(resourcePath, 'utf8'),
    'PASSWORD = "admin123456"  # fixture for the audit plugin');
});

test('resource manifest markup is escaped and editor preserves existing UI/resources', () => {
  const context={window:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../components/panels/panels-plugin-maker-utils.js'),'utf8'),context);
  const html=context.window.SoduWorkPluginMakerUtils.resourceMarkup([{path:'assets/<img>.txt',kind:'asset',size:24}]);
  assert.match(html,/&lt;img&gt;/);assert.doesNotMatch(html,/<img>/);assert.match(html,/随包资源/);
  const maker=fs.readFileSync(path.join(__dirname,'../components/panels/panels-plugin-maker.js'),'utf8');
  assert.match(maker,/ui: clone\(preservedUi\)/);assert.match(maker,/resources: clone\(preservedResources\)/);
});
