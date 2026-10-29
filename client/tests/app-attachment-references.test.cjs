'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { EventEmitter } = require('node:events');
const store = require('../main/work-preview-app-attachments.cjs');
const contract = require('../main/soduwork-app-bridge-contract.cjs');
const attachments = require('../main/pi-session/attachments');
const item = () => { const wc = new EventEmitter(); wc.isDestroyed = () => false;
  const value = { view: { webContents: wc }, appBridge: { appId: 'plugin:local:attachment-fixture', origin: 'https://fixture.invalid' } };
  require('../main/work-preview-app-owner.cjs').capture(value, { app: { getPath: () => os.tmpdir() } });
  return value; };
async function binary(owner, name='paste.txt', data=Buffer.from('clipboard content')) {
  const started = await store.handle(owner, 'attachments.begin', {name,type:'text/plain',size:data.length});
  assert.equal(started.ok,true);
  assert.equal((await store.handle(owner,'attachments.append',{id:started.id,offset:0,data})).ok,true);
  const finished=await store.handle(owner,'attachments.finish',{id:started.id});assert.equal(finished.ok,true);
  return finished.item;
}
test('native file picking registers metadata without a copy; page isolation and release never remove originals', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'soduwork-app-ref-test-')),owner=item(),other=item();
  const source=path.join(root,'reference.pdf');await fs.writeFile(source,'original document');
  try {
    const result=await store.handle(owner,'attachments.pick',{}, {dialog:{showOpenDialog:async()=>({filePaths:[source]})}});
    assert.equal(result.ok,true);assert.equal(result.items[0].name,'reference.pdf');assert.equal(result.items[0].type,'application/pdf');
    assert.equal(JSON.stringify(result).includes(root),false);assert.equal('path' in result.items[0],false);
    const ids=[result.items[0].id];
    assert.equal((await store.handle(other,'attachments.check',{ids})).ok,false);
    const lease=await store.checkout(owner,ids);assert.equal(lease.files[0].path,source);
    await lease.release();await store.handle(owner,'attachments.release',{ids});
    assert.equal(await fs.readFile(source,'utf8'),'original document');
    assert.equal((await store.handle(owner,'attachments.check',{ids})).ok,false);
  } finally {await store.dispose(owner);await store.dispose(other);await fs.rm(root,{recursive:true,force:true});}
});
test('binary staging is complete and ordered; removal deletes only app-owned temporary data', async () => {
  const owner=item();
  try {
    const started=await store.handle(owner,'attachments.begin',{name:'../clip.txt',size:3,type:'text/plain'});
    assert.equal((await store.handle(owner,'attachments.append',{id:started.id,offset:1,data:Buffer.from('abc')})).ok,false);
    assert.equal((await store.handle(owner,'attachments.finish',{id:started.id})).ok,false);
    assert.equal((await store.handle(owner,'attachments.append',{id:started.id,offset:0,data:Buffer.from('abc')})).ok,true);
    assert.equal((await store.handle(owner,'attachments.finish',{id:started.id})).ok,true);
    const lease=await store.checkout(owner,[started.id]),temporary=lease.files[0].path;
    assert.equal(await fs.readFile(temporary,'utf8'),'abc');await lease.release();
    await store.handle(owner,'attachments.release',{ids:[started.id]});
    await assert.rejects(fs.stat(temporary),{code:'ENOENT'});
    await assert.rejects(fs.stat(path.dirname(temporary)),{code:'ENOENT'});
  } finally {await store.dispose(owner);}
});
test('a copying conversation keeps temporary input alive through removal and window close; its normal copy survives', async () => {
  const owner=item(),root=await fs.mkdtemp(path.join(os.tmpdir(),'soduwork-copy-test-'));
  try {
    const file=await binary(owner),lease=await store.checkout(owner,[file.id]),source=lease.files[0].path;
    const copying=store.protect(lease.files);
    await store.handle(owner,'attachments.release',{ids:[file.id]});await store.dispose(owner);await lease.release();
    assert.equal(await fs.readFile(source,'utf8'),'clipboard content');
    const staged=await attachments.stage(root,lease.files);
    assert.equal(staged.files.length,1);assert.equal(staged.files[0].sourceRef,undefined);
    assert.notEqual(staged.files[0].path,source);await copying();
    await assert.rejects(fs.stat(source),{code:'ENOENT'});
    assert.equal(await fs.readFile(staged.files[0].path,'utf8'),'clipboard content');
    assert.equal((await attachments.stage(root,staged.files)).files.length,1);
  } finally {await store.dispose(owner);await fs.rm(root,{recursive:true,force:true});}
});
test('source changes fail before admission, quota and binary contract reject oversized or forged inputs', async () => {
  const owner=item(),root=await fs.mkdtemp(path.join(os.tmpdir(),'soduwork-invalid-test-')),source=path.join(root,'input.txt');
  await fs.writeFile(source,'a');
  try {
    const result=await store.handle(owner,'attachments.pick',{}, {dialog:{showOpenDialog:async()=>({filePaths:[source]})}});
    await fs.writeFile(source,'changed');await assert.rejects(store.checkout(owner,[result.items[0].id]),/变化/);
    assert.equal((await store.handle(owner,'attachments.begin',{name:'huge.mp4',size:store.limits.MAX_BYTES+1,type:'video/mp4'})).ok,false);
    const request=params=>contract.normalizeRequest({id:'fixture',method:'attachments.begin',params});
    assert.throws(()=>request({name:'x',size:Infinity}));assert.throws(()=>request({name:'x',size:store.limits.MAX_BYTES+1}));
    assert.throws(()=>contract.normalizeRequest({id:'x',method:'attachments.append',params:{id:result.items[0].id,offset:0,data:[]}}));
    assert.throws(()=>contract.normalizeRequest({id:'x',method:'composer.send',params:{text:'x',requestId:'x',attachmentIds:[source]}}));
    assert.deepEqual(contract.normalizeRequest({id:'x',method:'attachments.pick',params:{path:source}}).params,{});
  } finally {await store.dispose(owner);await fs.rm(root,{recursive:true,force:true});}
});
test('native send deduplicates the text plus attachment set and acknowledges only the owned composer', async () => {
  const owner=item(),wc=new EventEmitter(),chat=require('../main/work-preview-app-chat.cjs');wc.isDestroyed=()=>false;
  owner.composer={view:{webContents:wc}};let delivered;const sent=new Promise(resolve=>{wc.send=(_channel,payload)=>{delivered=payload;resolve();};});
  try {
    const row=await binary(owner),params={text:'Use these files',requestId:'with-files',attachmentIds:[row.id]};
    const pending=chat.send(owner,params);assert.equal(chat.send(owner,params),pending);await sent;
    assert.equal(delivered.attachments[0].attachmentId,row.id);
    assert.equal((await chat.send(owner,{...params,attachmentIds:[]})).ok,false);
    assert.equal(chat.finish({}, {id:delivered.id,ok:true}).ok,false);
    chat.finish(wc,{id:delivered.id,ok:true});assert.equal((await pending).accepted,true);
    assert.equal((await chat.send(owner,params)).accepted,true);
  } finally {await store.dispose(owner);}
});

test('closing an app waits for attachment admission, while a rejected send leaves its error available', async () => {
  for (const accepted of [true,false]) {
    const owner=item(),wc=new EventEmitter(),chat=require('../main/work-preview-app-chat.cjs');wc.isDestroyed=()=>false;
    owner.composer={view:{webContents:wc}};let payload,closed=0,blocked=0;
    const delivered=new Promise(resolve=>{wc.send=(_channel,value)=>{payload=value;resolve();};});
    const file=await binary(owner),sending=chat.send(owner,{text:'Keep reference',requestId:'close-gate',attachmentIds:[file.id]});
    await delivered;
    chat.deferClose(owner,{isDestroyed:()=>false,close:()=>closed++},{preventDefault:()=>blocked++});
    assert.equal(blocked,1);assert.equal(closed,0);
    chat.finish(wc,{id:payload.id,ok:accepted});await sending;await new Promise(resolve=>setImmediate(resolve));
    assert.equal(closed,accepted?1:0);await store.dispose(owner);
  }
});
