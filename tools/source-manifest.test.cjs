"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {sourceFiles, snapshotFiles, snapshotApprovals} = require('./source-files.cjs');
const {check, canonicalBytes} = require('./check-source-manifest.cjs');
const {execFileSync} = require('node:child_process');
function fixture(t, content = 'hello') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-inventory-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const dest = path.join(root,'public');
  fs.mkdirSync(dest);
  fs.writeFileSync(path.join(dest,'README.md'),content);
  execFileSync('git',['init'],{cwd:dest,stdio:'pipe'});
  execFileSync('git',['add','README.md'],{cwd:dest,stdio:'pipe'});
  check(dest,{writeManifest:true});
  fs.rmSync(path.join(dest,'.git'),{recursive:true});
  return {root,dest};
}
test('standalone source archive never consults a parent repository', t => {
  const {root,dest}=fixture(t);
  fs.mkdirSync(path.join(root,'.git')); // deliberately not a usable Git repository
  assert.deepEqual(sourceFiles(dest),['README.md']);
  assert.deepEqual(snapshotApprovals(dest,[{file:'README.md'},{file:'private/company.md'}]),[{file:'README.md'}]);
});
test('missing own Git and manifest fails rather than finding a parent checkout', t => {
  const {root}=fixture(t);
  assert.throws(()=>sourceFiles(root),/neither its own/);
});
test('missing published file cannot silently reduce the checks', t => {
  const {dest}=fixture(t);
  fs.unlinkSync(path.join(dest,'README.md'));
  assert.throws(()=>sourceFiles(dest),/ENOENT/);
});
test('manifest rejects traversal, duplicate entries and invalid file identity', t => {
  const {dest}=fixture(t), file=path.join(dest,'tools/distribution/SOURCE-MANIFEST.json');
  const original=JSON.parse(fs.readFileSync(file));
  for (const name of ['../README.md','/etc/passwd','C:/file','x\\y','a/./b']) {
    const copy=structuredClone(original);copy.files[0].path=name;
    fs.writeFileSync(file,JSON.stringify(copy));assert.throws(()=>snapshotFiles(dest),/Invalid/);
  }
  for(const mutate of [x=>x.files.push(x.files[0]),x=>x.files[0].sha256='invalid',x=>x.files[0].bytes=-1,x=>x.ok=false]) {
    const copy=structuredClone(original);mutate(copy);
    fs.writeFileSync(file,JSON.stringify(copy));assert.throws(()=>snapshotFiles(dest),/Invalid/);
  }
});
test('snapshot refuses symbolic-link content', t => {
  const {root,dest}=fixture(t), nested=path.join(dest,'link');
  fs.symlinkSync(root,nested,process.platform==='win32'?'junction':'dir');
  const file=path.join(dest,'tools/distribution/SOURCE-MANIFEST.json'), manifest=JSON.parse(fs.readFileSync(file));
  manifest.files[0].path='link/README.md';fs.writeFileSync(file,JSON.stringify(manifest));
  assert.throws(()=>sourceFiles(dest),/symbolic link/);
});

test('standalone inventory verifies bytes and rejects extra files', t => {
  const {dest}=fixture(t);
  assert.equal(check(dest).ok,true);
  fs.writeFileSync(path.join(dest,'extra.txt'),'extra');
  assert.throws(()=>check(dest),/Unlisted/);
  fs.unlinkSync(path.join(dest,'extra.txt'));
  fs.writeFileSync(path.join(dest,'README.md'),'changed');
  assert.throws(()=>check(dest),/does not match/);
});
test('standalone inventory cannot be regenerated from an incomplete directory', t => {
  const {dest}=fixture(t);
  fs.unlinkSync(path.join(dest,'README.md'));
  assert.throws(()=>check(dest,{writeManifest:true}),/own Git checkout/);
});

test('Windows CRLF and archive LF verify the same text without hiding content changes', t => {
  const {dest}=fixture(t,'hello\nworld\n'), file=path.join(dest,'README.md');
  fs.writeFileSync(file,'hello\r\nworld\r\n');
  assert.equal(check(dest).ok,true);
  fs.writeFileSync(file,'Hello\r\nworld\r\n');
  assert.throws(()=>check(dest),/does not match/);
});

test('newline normalization preserves binary bytes including non-UTF8 payloads', () => {
  for (const data of [Buffer.from([0,13,10,255]),Buffer.from([255,13,10])]) {
    assert.deepEqual(canonicalBytes(data),data);
  }
});
