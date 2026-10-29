'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {spawn}=require('node:child_process');
test('series Markdown helper serializes quotes, line breaks and shell characters without command-line JSON',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-text-')), calls=[];
  const server=http.createServer((req,res)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{
    const rpc=JSON.parse(raw);if(rpc.id===undefined){res.writeHead(202);return res.end()}
    if(rpc.method==='tools/call')calls.push(rpc.params);
    const result=rpc.method==='initialize'?{protocolVersion:rpc.params.protocolVersion,capabilities:{}}:rpc.method==='tools/list'?{tools:[{name:'put_settings',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:JSON.stringify({ok:true,applied:Object.keys(rpc.params.arguments.settings)})}]};
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}));
  })});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const proxy=await require('../main/pi-session/app-mcp-proxy.cjs').create({url:'http://127.0.0.1:'+server.address().port+'/mcp',token:'stored-fixture',revision:1,readCurrent:()=>({token:'stored-fixture',revision:1})});
  t.after(()=>{proxy.cleanup();server.closeAllConnections();server.close();fs.rmSync(root,{recursive:true,force:true})});
  const config=path.join(root,'lease.json');fs.writeFileSync(config,JSON.stringify({servers:{app:{appLease:true,type:'http',url:proxy.url,headers:{Authorization:'Bearer '+proxy.token}}}}));
  const text='# 测试 "双引号" 与 \'单引号\'\n\n`code` $HOME $(not-a-command) \\ 路径\n段落\t保留🙂';
  const invoke=input=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,[path.resolve(__dirname,'../../skills/mcp-tools/scripts/app-settings-text.mjs'),'--config',config,'--server','app','--space','team-fixture','--series','series-fixture','--style','水彩手绘','--ratio','3:4','--channel','xhs'],{windowsHide:true,stdio:['pipe','pipe','pipe']});let out='',err='';child.stdin.end(input);child.stdout.on('data',c=>out+=c);child.stderr.on('data',c=>err+=c);child.on('error',reject);child.on('close',code=>resolve({code,out,err}))});
  const result=await invoke(text);assert.equal(result.code,0,result.err);
  assert.equal(calls[0].arguments.settings.doc,text);assert.equal(calls[0].arguments.space_id,'team-fixture');assert.equal(calls[0].arguments.series_id,'series-fixture');
  assert.deepEqual(calls[0].arguments.settings.target_channels,['xhs']);assert.equal(calls[0].arguments.settings.visual_style,'水彩手绘');
  assert.doesNotMatch(result.out,/stored-fixture/);assert.equal((await invoke('')).code,0,'structured fields can be updated without replacing doc');assert.equal(calls[1].arguments.settings.doc,undefined);
});
