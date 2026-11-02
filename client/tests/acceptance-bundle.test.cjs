'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { prepare } = require('../main/pi-session/task-input');
const { load } = require('../main/pi-session/acceptance-bundle');
const identity = {hub:'http://fixture',clientId:'device',secret:'test-only'};
const bytes = Buffer.from('PK\x03\x04fixture archive');
const digest = crypto.createHash('sha256').update(bytes).digest('hex');
const bundle = {filename:'交付物.zip',artifactVersionId:'v2',attachmentIds:['html','css']};
function response(headers={}) { return new Response(bytes,{headers:{'X-Artifact-Version':'v2','X-Artifact-SHA256':digest,...headers}}); }

test('acceptance downloads one pinned ZIP; optional evidence is fetched only when selected', async t => {
  for (const optional of [false,true]) {
    const calls=[];
    t.mock.method(global,'fetch',async (url,init)=>{
      url=String(url);calls.push(url);
      if(url.includes('/artifacts.zip')) {assert.match(url,/artifactVersionId=v2$/);return response();}
      if(url.includes('/acceptance-context'))return Response.json({canDecide:true,task:{id:'t',title:'Website'},approvalId:'a',artifactVersionId:'v2',requirementVersion:1,
        attachments:[{id:'html',filename:'index.html'},{id:'css',filename:'assets/style.css'}],attachmentIds:['html','css'],deliveryBundle:bundle,
        optionalAttachments:[{id:'screenshot',filename:'verify.png'}],criteria:[]});
      if(url.includes('/tasks/t/attachments'))return Response.json([{id:'screenshot',filename:'verify.png',url:'/api/v1/attachments/screenshot?ticket=fixture',role:'verification'}]);
      if(url.includes('/attachments/screenshot'))return new Response('evidence');
      return Response.json({id:'t',title:'Website'});
    });
    const result=await prepare(identity,'t','chat','turn','Review',{acceptanceOnly:true,...(optional?{acceptanceAttachmentIds:['screenshot']}:{})},{});
    assert.deepEqual(result.attachments.map(file=>file.name),optional?['交付物.zip','verify.png']:['交付物.zip']);
    assert.match(result.text,/请先解压/);
    assert.equal(calls.some(url=>url.endsWith('/tasks/t/attachments')),optional);
    assert.ok(!calls.some(url=>/attachments\/(html|css)/.test(url)));
    t.mock.restoreAll();
  }
});
for (const [name,headers] of [['stale version',{'X-Artifact-Version':'v1'}],['corrupt bytes',{'X-Artifact-SHA256':'0'.repeat(64)}],['oversized response',{'content-length':String(257*1024*1024)}]])
  test('bundle rejects '+name,async t=>{t.mock.method(global,'fetch',async()=>response(headers));await assert.rejects(load(identity,'/tasks/t',bundle));});
