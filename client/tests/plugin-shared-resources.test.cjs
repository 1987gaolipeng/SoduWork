'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const resources = require('../main/plugin-resources');
const grants = require('../main/pi-session/plugin-grant');
const context = require('../main/pi-session/plugin-context');

test('shared plugin materializes complete skill and files beside the ordinary conversation', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-shared-plugin-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const full = '# Skill\n' + 'Method and acceptance criteria\n'.repeat(900) + 'FINAL-MARKER';
  const files = resources.normalize([
    {path:'references/plugin-package/skills/business/SKILL.md',kind:'reference',encoding:'utf8',content:full},
    {path:'references/plugin-package/skills/business/scripts/check.js',kind:'script',encoding:'utf8',content:'throw Error("not executed on install")'},
  ]);
  const resolve = bundle => grants.resolve({
    app:{getPath:()=>root},cwd:root,pluginIds:['shared-plugin'],ref:'chat',
    identityOf:async()=>({hub:'https://example.invalid',clientId:'device',session:'fixture'}),
    fetchImpl:async()=>({ok:true,json:async()=>({ok:true,items:[{
      pluginId:'shared-plugin',key:'business',name:'Business',version:'1.0.0',
      context:'Follow the installed skill.\n' + 'x'.repeat(10000),
      capabilities:{skills:[],mcpServers:[],runtime:[]},resourceBundle:bundle,
    }]})}),
  });
  const response = await resolve({resources:files,digest:resources.digest(files)});
  assert.equal(response.grant,null);
  assert.equal(response.items[0].resourceBundle,undefined);
  const materialized = resources.materialize(files,root,'business');
  assert.deepEqual(response.readRoots, [materialized.directory]);
  assert.deepEqual(response.resourceBundles, [{ pluginId: 'shared-plugin', key: 'business',
    digest: materialized.digest, resources: files }]);
  const scope = require('../main/access-control/resource-read-scope').create(response.readRoots);
  const access = require('../main/access-control/policy');
  assert.equal(access.operation(access.create('standard', root), 'read',
    { path: path.join(materialized.directory, files[0].path) }, root, scope).verdict, 'allow');
  assert.equal(fs.readFileSync(path.join(materialized.directory,files[0].path),'utf8'),full);
  assert.ok(context.compact(response.items)[0].context.includes(materialized.directory));
  assert.equal(fs.existsSync(path.join(root,'unexpected-output')),false);
  await assert.rejects(resolve({resources:files,digest:'invalid'}),/校验/);
  /* Preserve modified resources before restoring manifest content. */
  fs.writeFileSync(path.join(materialized.directory,files[0].path),'tampered');
  const repaired = await resolve({resources:files,digest:resources.digest(files)});
  assert.equal(fs.readFileSync(path.join(materialized.directory,files[0].path),'utf8'),full,
    'a tampered resource file is restored verbatim from the manifest');
  const backupDirectories = fs.readdirSync(materialized.directory).filter(name => name.startsWith('.local-'));
  assert.equal(backupDirectories.length, 1);
  const backup = backupDirectories[0] + '/' + files[0].path;
  assert.equal(fs.readFileSync(path.join(materialized.directory,backup),'utf8'),'tampered',
    'the local edit remains recoverable in its own backup directory');
  assert.ok(repaired.items[0].context.includes(files[0].path + ' → ' + backup));
});
