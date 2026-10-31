'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
test('five characters export self-contained UI and the same persona skill used for headless schedules',async t=>{
  const out=fs.mkdtempSync(path.join(os.tmpdir(),'jiyong-characters-'));t.after(()=>fs.rmSync(out,{recursive:true,force:true}));
  const maker=require('../scripts/create-jiyong-robots.cjs'),reader=require('../main/plugin-package-reader.cjs'),personal=require('../main/personal-plugins');
  const rows=await maker.create({out});assert.equal(rows.length,5);
  for(const row of rows){const body=reader.readPersonalArchive(fs.readFileSync(row.package)),manifest=personal.preflight(body).manifest;assert.equal(manifest.entrypoints.automation,true);assert.equal(manifest.jiyong.mcp.server,'soduwork-jiyong');assert.ok(body.instructions.includes('角色：'));assert.ok(body.instructions.includes('写后读取确认'));assert.ok(body.locales['en-us'].name);for(const name of ['ui/index.html','ui/app.js','ui/soduwork-app.js','ui/avatar.svg','ui/icon.png','references/character-skill.md'])assert.ok(body.resources.some(r=>r.path===name),name);}
  const upgraded=await maker.create({out});for(let n=0;n<rows.length;n++){assert.equal(upgraded[n].pluginId,rows[n].pluginId);assert.equal(upgraded[n].version,'1.0.1');assert.ok(fs.existsSync(rows[n].package),'older portable packages remain reviewable');}
});
