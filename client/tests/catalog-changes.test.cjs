 'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {pathToFileURL} = require('node:url'), path = require('node:path');
const {create} = require('../main/agent-runtime/catalog-changes.cjs');
function fixture() {
 const log = [];
 const contents = ['settings','workspace','embedded-conversation','external-page'].map((id,index)=>({
   mainFrame:{},isDestroyed:()=>false,
   getURL:()=>index===3?'https://example.com':pathToFileURL(path.join(__dirname,'../desk.html')).href,
   send:(channel)=>log.push([id,channel]),
 }));
 const changes=create({session:{invalidateRuntimes:()=>log.push('runtime-cache')},invalidateModels:()=>log.push('model-cache'),contents:()=>contents});
 return {changes,log,contents,event:sender=>({sender,senderFrame:sender.mainFrame})};
}
test('catalog invalidation precedes notifications to sender, other windows and embedded conversation views',()=>{
 const f=fixture(); assert.equal(f.changes.receive(f.event(f.contents[0]),'models'),true);
 assert.deepEqual(f.log.slice(0,2),['runtime-cache','model-cache']);
 for(const id of ['settings','workspace','embedded-conversation'])
   for(const channel of ['agent-runtimes-changed','models-changed'])assert.ok(f.log.some(row=>Array.isArray(row)&&row[0]===id&&row[1]===channel));
 assert.equal(f.log.length,8);
});
test('external pages and subframes cannot invalidate trusted catalogs',()=>{
 const f=fixture(); assert.equal(f.changes.receive(f.event(f.contents[3]),'models'),false);
 assert.equal(f.changes.receive({sender:f.contents[0],senderFrame:{}},'agent-runtimes-changed'),false);
 assert.deepEqual(f.log,[]);
});
