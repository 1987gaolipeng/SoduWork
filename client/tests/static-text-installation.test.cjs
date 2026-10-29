const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { inventory } = require('../scripts/prepare-installer.cjs');
const { verify, run, STATIC_TEXT_BUNDLE } = require('../build/verify-payload.cjs');
const name = 'resources/shell/etc/package-versions.txt';
async function fixture(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-text-policy-'));
  await fs.mkdir(path.join(root, path.dirname(name)), {recursive:true});
  await fs.writeFile(path.join(root, name), 'vendor version inventory\n');
  await fs.writeFile(path.join(root, 'SoduWork.exe'), 'executable-fixture');
  await inventory(root);
  try { await fn(root); } finally { await fs.rm(root,{recursive:true,force:true}); }
}
test('known static text storage overhead uses verified originals only during installation', async () => fixture(async root => {
  const file=path.join(root,name), bytes=await fs.readFile(file);
  await fs.writeFile(file,Buffer.concat([Buffer.alloc(4096,65),bytes]));
  await assert.rejects(verify(root), /Incomplete payload/);
  const report=path.join(root,'report.json');
  assert.equal(await run(root,report,null,null,{installationMode:true}),0);
  const result=JSON.parse(await fs.readFile(report,'utf8'));
  assert.equal(result.fullContentVerified,false);
  assert.equal(result.staticTextDifferences.length,1);
  assert.equal(result.staticTextDifferences[0].sourceSha256,result.staticTextDifferences[0].expectedSha256);
  assert.equal((await fs.readFile(file)).length,bytes.length+4096);
}));
test('ordinary edits, truncation and missing text still fail installation', async () => fixture(async root => {
  const file=path.join(root,name), bytes=await fs.readFile(file);
  const changed=Buffer.from(bytes); changed[0]^=1;
  for (const value of [changed,Buffer.alloc(0),Buffer.concat([bytes,Buffer.alloc(4095)])]) {
    await fs.writeFile(file,value);
    await assert.rejects(verify(root,[],{installationMode:true}));
  }
  await fs.unlink(file);
  await assert.rejects(verify(root,[],{installationMode:true,sleep:async()=>{}}));
}));
test('unverified source bundle cannot justify any compatibility difference', async () => fixture(async root => {
  const file=path.join(root,name), bytes=await fs.readFile(file);
  await fs.writeFile(file,Buffer.concat([Buffer.alloc(4096),bytes]));
  await fs.appendFile(path.join(root,STATIC_TEXT_BUNDLE),'corrupt');
  await assert.rejects(verify(root,[],{installationMode:true}),/Corrupt static text bundle/);
}));
test('programs and unlisted text never inherit the fixed resource policy', async () => fixture(async root => {
  const other='resources/shell/custom.txt';
  await fs.writeFile(path.join(root,other),'unlisted');
  await inventory(root);
  for (const name of ['SoduWork.exe',other]) {
    const file=path.join(root,name),bytes=await fs.readFile(file);
    await fs.writeFile(file,Buffer.concat([Buffer.alloc(4096),bytes]));
    await assert.rejects(verify(root,[],{installationMode:true}),/Incomplete payload/);
    await fs.writeFile(file,bytes);
  }
}));
