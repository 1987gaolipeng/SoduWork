'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path');
const {project} = require('../main/personal-plugin-permissions.cjs');
const base = {requestId:'request-1',policyRevision:1};
test('native edit approval shows its files without leaking replacement content',()=>{
  const cwd=path.resolve('test-workspace');
  const row=project({...base,action:'native.tool',kind:'edit',arguments:{changes:[{path:path.join(cwd,'index.html'),newText:'secret body'}]}},{cwd});
  assert.equal(row.summary,'修改文件');assert.equal(row.detail,'index.html');assert.equal(row.reviewable,true);
  assert.doesNotMatch(JSON.stringify(row),/secret body/);
});
test('commands retain actual operation while masking credential forms and caller secrets',()=>{
  const row=project({...base,action:'native.command',arguments:{command:'curl https://alice:password@example.invalid/?token=one --password "two words" -H "Authorization: Bearer abc123"; KEY=value; token="three words"; opaque-private-secret'}},{redact:x=>x.replaceAll('opaque-private-secret','[hidden]')});
  assert.match(row.detail,/curl/);assert.match(row.detail,/KEY=value/);
  for(const secret of ['alice:password','token=one','two words','abc123','three words','opaque-private-secret'])assert.equal(row.detail.includes(secret),false,secret);
});
test('absolute outside targets remain visible and overlong operations cannot be approved blindly',()=>{
  const cwd=path.resolve('test-workspace'), outside=path.resolve('outside.txt');
  assert.equal(project({...base,action:'file.read',target:outside},{cwd}).detail,outside);
  const row=project({...base,action:'command.execute',target:'a'.repeat(12001)});
  assert.equal(row.reviewable,false);assert.equal(row.detail.length,12000);
  assert.equal(project({...base,policyRevision:'1'}),null);
});

test('a vague command title cannot substitute for a reviewable operation',()=>{
const row=project({...base,action:'native.command',title:'Please allow my command'});assert.equal(row.reviewable,false);assert.equal(row.detail,'');
});
