'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {pathToFileURL}=require('node:url');
const config=require('../main/pi-session/model-config');
const selection=require('../main/conversation/model-selection');

test('missing or generic attachment MIME does not hide a valid image; declared size is not trusted',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-image-mime-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const images=require('../main/pi-session/attachments');
  const png=path.join(root,'fixture.png');fs.writeFileSync(png,'fixture');
  for(const mimeType of ['', 'application/octet-stream', 'IMAGE/PNG; charset=binary']){
    const got=await images.images([{path:png,mimeType,size:0}]);
    assert.equal(got.length,1);assert.equal(got[0].mimeType,'image/png');
  }
  const jpeg=path.join(root,'fixture.jpg');fs.writeFileSync(jpeg,'fixture');
  assert.equal((await images.images([{path:jpeg,mimeType:'image/jpg'}]))[0].mimeType,'image/jpeg');
  const fd=fs.openSync(png,'w');fs.ftruncateSync(fd,images.IMAGE_BYTES+1);fs.closeSync(fd);
  assert.deepEqual(await images.images([{path:png,mimeType:'image/png',size:0}]),[]);
});

test('image preparation keeps every selected image within the conversation attachment limit', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-image-batch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const images = require('../main/pi-session/attachments');
  const files = Array.from({ length: 12 }, (_, index) => {
    const file = path.join(root, `fixture-${index}.png`);
    fs.writeFileSync(file, `fixture-${index}`);
    return { path: file, name: path.basename(file), mimeType: 'image/png' };
  });
  assert.equal((await images.images(files)).length, 12);
});

test('proxy input metadata requires an explicit native image route',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-modality-config-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const item of [
    {input:undefined,routing:undefined,expected:['text'],expectedRouting:'vision-fallback'},
    {input:['text'],routing:'vision-fallback',expected:['text'],expectedRouting:'vision-fallback'},
    {input:['text'],routing:'vision-fallback',adapter:true,expected:['text'],expectedRouting:'vision-fallback'},
    {input:['text','image'],routing:'native',expected:['text','image'],expectedRouting:'native'},
    // A legacy server used native-first, which is deliberately no longer
    // trusted because it advertised image support for text-only models.
    {input:['text','image'],routing:'native-first',expected:['text'],expectedRouting:'vision-fallback'},
  ]){
    const got=await config.fetchModel({hub:'http://fixture',clientId:'fixture',secret:'fixture'},'',1000,
      async()=>({ok:true,json:async()=>({ok:true,key:'fixture',model:'arbitrary-alias',input:item.input,imageRouting:item.routing,
        visionFallbackAvailable:item.adapter})}));
    assert.deepEqual(got.model.input,item.expected);
    assert.equal(got.model.imageRouting,item.expectedRouting);
    assert.equal(got.model.visionFallbackAvailable,item.adapter===true);
    assert.deepEqual(JSON.parse(fs.readFileSync(config.writeModels(root,got.model))).providers.soduwork.models[0].input,item.expected);
    assert.deepEqual(selection.piProvider(got.model).models[0].input,item.expected);
  }
});

test('real Pi session sends original PNG, retains it in history and reads images through its registered tool',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-modality-wire-'));
  const cwd=path.join(root,'work'),agentDir=path.join(root,'agent');
  fs.mkdirSync(cwd);fs.mkdirSync(agentDir);
  const captured=[];
  const server=http.createServer((req,res)=>{
    let raw='';req.on('data',chunk=>raw+=chunk);
    req.on('end',()=>{
      captured.push(JSON.parse(raw));
      res.writeHead(200,{'Content-Type':'text/event-stream'});
      if (captured.length === 3) {
        res.write('data: '+JSON.stringify({id:'read-fixture',object:'chat.completion.chunk',model:'fixture',
          choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'read-image',type:'function',
            function:{name:'read',arguments:JSON.stringify({path:'fixture.png'})}}]},finish_reason:null}]})+'\n\n');
        res.end('data: '+JSON.stringify({id:'read-fixture',object:'chat.completion.chunk',
          choices:[{index:0,delta:{},finish_reason:'tool_calls'}]})+'\n\ndata: [DONE]\n\n');
        return;
      }
      res.write('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',model:'fixture',
        choices:[{index:0,delta:{role:'assistant',content:'A red square.'},finish_reason:null}]})+'\n\n');
      res.end('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',
        choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:4,total_tokens:104}})+'\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const sdk=await import(pathToFileURL(path.join(__dirname,'../node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href);
  const sessions=require('../main/pi-session/session'),vision=require('../main/pi-session/vision');
  const model={id:'fixture',label:'Fixture',contextWindow:32000,input:['text','image'],imageRouting:'native',
    key:'fixture',baseUrl:'http://127.0.0.1:'+server.address().port+'/v1'};
  const modelPath=config.writeModels(agentDir,model),previous=config.prepare,selectionFetch=config.fetchSelection,
    create=sdk.ModelRuntime.create,analyze=vision.analyze;
  const env=process.env.SODUWORK_PROXY_KEY;process.env.SODUWORK_PROXY_KEY='fixture';
  config.prepare=async()=>({ok:true,provider:'soduwork',agentDir,model});
  config.fetchSelection=async(_identity,name)=>({ok:true,model:name==='text-only'
    ? {...model,id:'text-only',imageRouting:'vision-fallback',input:['text'],visionFallbackAvailable:false} : model});
  sdk.ModelRuntime.create=()=>create.call(sdk.ModelRuntime,{modelsPath:modelPath,authPath:path.join(agentDir,'auth.json')});
  vision.analyze=async()=>{throw Error('Native image was incorrectly sent to vision');};
  let session;
  t.after(async()=>{
    if(session)await session.close();
    config.prepare=previous;config.fetchSelection=selectionFetch;sdk.ModelRuntime.create=create;vision.analyze=analyze;
    if(env===undefined)delete process.env.SODUWORK_PROXY_KEY;else process.env.SODUWORK_PROXY_KEY=env;
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    fs.rmSync(root,{recursive:true,force:true});
  });
  const opened=await sessions.open({app:{isPackaged:false,getPath:()=>root},identity:{},cwd,ephemeral:true});
  assert.equal(opened.ok,true,opened.reason);session=opened.session;
  const png='iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAIAAABvFaqvAAAAKklEQVR4nGP8z0AdwEQlcxhGDSIMRsOIMBgNI8JgNIwIg9EwIgwGXxgBAHuqAS9ARg1/AAAAAElFTkSuQmCC';
  const imagePath=path.join(cwd,'fixture.png');fs.writeFileSync(imagePath,Buffer.from(png,'base64'));
  const got=await session.send('Describe the attached image.',[{path:imagePath,name:'fixture.png',mimeType:'image/png'}]);
  assert.equal(got.ok,true,got.reason);
  assert.ok(captured.length);
  assert.ok(JSON.stringify(captured[0].messages).includes('data:image/png;base64,'+png));
  const second=await session.send('What colour did you see?');
  assert.equal(second.ok,true,second.reason);
  assert.ok(JSON.stringify(captured.at(-1).messages).includes('data:image/png;base64,'+png),'follow-up context keeps original pixels');
  const third=await session.send('Read fixture.png and describe it again.');
  assert.equal(third.ok,true,third.reason);
  assert.equal(captured.length,4,'the registered read tool executes and sends its result back to the model');
  const afterRead=captured.at(-1).messages;
  const readResult=afterRead.findIndex(message=>message.role==='tool' && message.tool_call_id==='read-image');
  assert.ok(readResult>=0,'read result is present');
  assert.ok(JSON.stringify(afterRead.slice(readResult)).includes('data:image/png;base64,'),'read image pixels survive SDK conversion');
  assert.doesNotMatch(JSON.stringify(afterRead.slice(readResult)),/does not support images|omitted|Permission denied/);
  assert.match(JSON.stringify(session.snapshot()),/A red square/);
  assert.doesNotMatch(JSON.stringify(session.snapshot()),/data:image/,'UI snapshots are lightweight');
  assert.equal((await session.selectModel('text-only')).ok,true);
  const textFollowup=await session.submit('不考虑截图了，继续按文字沟通。').completion;
  assert.equal(textFollowup.ok,true,textFollowup.reason);
  assert.equal(captured.length,5,'an ordinary text follow-up reaches the selected text model once');
  assert.match(JSON.stringify(captured.at(-1).messages),/历史图片不可见.*本轮没有读取这些图片/,
    'omission is disclosed to the model; it must not claim to have seen historical images');
  assert.doesNotMatch(JSON.stringify(captured.at(-1).messages),/data:image|iVBORw0KGgo/,
    'text transport receives no historical user or tool image pixels');
  const visibleFollowup=session.snapshot().messages.findLast(message=>message.role==='user');
  assert.equal(visibleFollowup.text,'不考虑截图了，继续按文字沟通。','runtime limitations remain hidden metadata, not user-written text');
  const rejected=await session.send('Describe this image with the selected text-only model.',
    [{path:imagePath,name:'fixture.png',mimeType:'image/png'}]);
  assert.equal(rejected.ok,false);
  assert.match(rejected.reason,/原图已保留.*未自动更换模型/);
  assert.equal(captured.length,5,'new attachments still call neither the text model nor an adapter');
  assert.equal(fs.readFileSync(imagePath).toString('base64'),png,'original pixels remain available');
  assert.equal((await session.selectModel('fixture')).ok,true);
  assert.equal((await session.submit('Describe the original screenshot again with the native model.').completion).ok,true);
  assert.ok(JSON.stringify(captured.at(-1).messages).includes('data:image/png;base64,'+png),'switching back recovers original history pixels');
});
