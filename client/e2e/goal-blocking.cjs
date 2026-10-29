'use strict';
// Real Electron UI, production goal loop/verifier, real files and local HTTP.
// The worker/reviewer are controlled fixtures, not a production model or user session.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const loop=require('../main/conversation/goal-loop'),policy=require('../main/agent-runtime/execution-policy');
const verifier=require('../main/conversation/goal-verifier'),review=require('../main/conversation/goal-review');
const quality=require('../main/conversation/goal-quality'),delivery=require('../main/conversation/delivery-contract');
const out=process.argv[2];if(!out||!path.isAbsolute(out))throw Error('Absolute evidence directory required');
fs.mkdirSync(out,{recursive:true});const root=fs.mkdtempSync(path.join(out,'workspace-'));
app.setPath('userData',fs.mkdtempSync(path.join(out,'profile-')));
const report={ok:false,checks:[],mode:'isolated Electron + real files/HTTP + controlled worker/reviewer'};
let win,printer,server,baseUrl,state=policy.createExecutionPolicy({goal:'Deliver report'}),tools=[];
const write=(name,text)=>{fs.mkdirSync(path.dirname(path.join(root,name)),{recursive:true});fs.writeFileSync(path.join(root,name),text);};
write('index.html','<!doctype html><h1>Report</h1><script>fetch("/api/v1")</script>');
write('check.cjs','const = broken;');write('report.pdf','not a PDF');
write('.soduwork/delivery.json',JSON.stringify({schemaVersion:1,runtime:{networkPolicy:'online',externalDependencies:['/api/v1']},deliverables:[
 {path:'index.html',kind:'website',title:'网站'},{path:'report.pdf',kind:'pdf',title:'报告'}
]}));
function checkCode(){
 try{execFileSync(process.execPath,['--check',path.join(root,'check.cjs')],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},windowsHide:true,stdio:'pipe'});tools.push({name:'bash',args:{command:'node --check check.cjs'},state:'done'});}
 catch(error){tools.push({name:'bash',args:{command:'node --check check.cjs'},state:'error',result:String(error.stderr)});}
}
function audit(){
 const files=['index.html','report.pdf'].map(relative=>({relative,path:path.join(root,relative),size:fs.statSync(path.join(root,relative)).size}));
 const evidence=quality.collectEvidence(tools,{files});
 const deterministic=verifier.verify({cwd:root,evidence,outputSnapshot:{files,delivery:delivery.classify(root,files)}});
 const verdict=review.outcome(JSON.stringify({verdict:'pass',summary:'接口、检查和文件签名通过',gaps:[]}),{deterministic});
 const decision=policy.decidePolicyReview(state,verdict);state=decision.state;
 if(decision.action==='deliver'||decision.action==='block')state=policy.finalizeExecutionPolicy(state,decision.review);
 return decision;
}
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 try{
  server=http.createServer((req,res)=>{
   const assets={'/':path.join(__dirname,'fixtures/goal-blocking.html'),'/goal.js':path.join(__dirname,'../components/panels/work-intent.js'),
    '/goal.css':path.join(__dirname,'../components/panels/work-intent.css'),'/theme.css':path.join(__dirname,'../theme/variables.css'),'/site':path.join(root,'index.html')};
   if(req.url==='/state'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(loop.view(state.ledger)));return;}
   if(req.url==='/continue'&&req.method==='POST'){
    state=policy.resumeExecutionPolicy(state);const decision=audit();
    // A failed rerun remains blocked for this explicit recovery attempt.
    if(decision.action!=='deliver')state=policy.finalizeExecutionPolicy(state,decision.review);
    res.end('ok');return;
   }
   if(req.url==='/api/v1'){res.setHeader('Content-Type','application/json');res.end('{"ok":true}');return;}
   if(req.url==='/report.pdf'){res.setHeader('Content-Type','application/pdf');res.end(fs.readFileSync(path.join(root,'report.pdf')));return;}
   if(assets[req.url]){res.setHeader('Content-Type',req.url.endsWith('.js')?'text/javascript':req.url.endsWith('.css')?'text/css':'text/html; charset=utf-8');res.end(fs.readFileSync(assets[req.url]));return;}
   res.statusCode=404;res.end();
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));baseUrl='http://127.0.0.1:'+server.address().port;
  const health=await fetch(baseUrl+'/api/v1');assert.equal(health.status,200);
  tools.push({name:'bash',args:{command:'curl -f '+baseUrl+'/api/v1'},state:'done',result:await health.text()});
  checkCode();state=policy.beginPolicyVerification(state);
  for(let i=0;i<3;i++)audit();
  assert.equal(state.ledger.state,'blocked');assert.equal(state.ledger.phase,'verify');
  assert.match(state.ledger.focus.action,/node --check check.cjs/);
  report.checks.push('真实脚本失败及无效 PDF 导致验收阻断，重复失败停止重试');
  win=new BrowserWindow({width:1100,height:850,show:false,webPreferences:{offscreen:true,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
  const js=s=>win.webContents.executeJavaScript(s,true);
  await win.loadURL(baseUrl);await delay(180);
  await js('document.querySelector("#testIntentToggle").click()');
  assert.equal(await js('document.querySelector("#testIntentStage").textContent'),'第 4 / 5 步 · 验证结果');
  assert.equal(await js('document.querySelectorAll("#testIntentSteps .is-completed").length'),3);
  assert.equal(await js('document.querySelector("#testIntentResume").hidden'),false);
  fs.writeFileSync(path.join(out,'blocked.png'),(await win.webContents.capturePage()).toPNG());
  report.checks.push('界面显示第 4 步受阻，第 5 步未开始，并提供继续入口');
  await js('document.querySelector("#testIntentResume").click()');await delay(180);
  assert.equal(await js('current.state'),'blocked');
  report.checks.push('点击继续不会清除失败或直接变成完成');
  write('check.cjs','console.log("valid");');checkCode();
  printer=new BrowserWindow({show:false,webPreferences:{sandbox:true}});
  await printer.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<h1>Verified report</h1><p>Runtime API and script validation passed.</p>'));
  const generated=await printer.webContents.printToPDF({pageSize:'A4'});
  write('report.pdf',generated);
  function headers(){const file=path.join(root,'report.pdf'),fd=fs.openSync(file,'r'),buffer=Buffer.alloc(12);try{fs.readSync(fd,buffer,0,12,0);}finally{fs.closeSync(fd)}return {direct:fs.readFileSync(file).subarray(0,12).toString('hex'),read:buffer.toString('hex'),probe:verifier.artifactProbe({path:file,relative:'report.pdf'})};}
  report.generated={head:generated.subarray(0,12).toString('hex'),immediate:headers()};
  // Allow the endpoint protection to settle before checking the final artifact.
  await delay(500);
  report.afterAudit=headers();
  if(!report.afterAudit.probe.protected){
    // Portable regression fixture for machines without this enterprise protection.
    const protectedHeader=Buffer.alloc(256);Buffer.from('e0a891e7d8f205ac','hex').copy(protectedHeader);
    protectedHeader.write('Esafenet',88,'ascii');write('report.pdf',protectedHeader);
    report.protectionSource='controlled protected-header fixture';
  }else report.protectionSource='observed endpoint rewrite of a freshly generated PDF';
  await js('document.querySelector("#testIntentResume").click()');await delay(180);
  assert.equal(await js('current.state'),'blocked');
  assert.match(await js('current.reason'),/文档保护/);
  report.protectedOutcome=loop.view(state.ledger);
  fs.writeFileSync(path.join(out,'protected.png'),(await win.webContents.capturePage()).toPNG());
  report.checks.push('文档保护被准确说明为外部阻断，不反复生成文件、不跳过验收');

  // Separate healthy website case; do NOT waive or remove the PDF requirement
  // from the original blocked goal to make that goal appear completed.
  write('.soduwork/delivery.json',JSON.stringify({schemaVersion:1,runtime:{networkPolicy:'online',externalDependencies:['/api/v1']},
    deliverables:[{path:'index.html',kind:'website',title:'独立网站验收用例'}]}));
  state=policy.beginPolicyVerification(policy.createExecutionPolicy({goal:'独立网站验收用例'}));
  audit();
  await js('document.querySelector("h1").textContent="独立用例 · 正常网站交付";paint()');await delay(180);
  assert.equal(await js('current.state'),'completed');
  assert.equal(await js('document.querySelectorAll("#testIntentSteps .is-completed").length'),5);
  assert.equal(await js('document.querySelector("#testIntentResume").hidden'),true);
  const website=await fetch(baseUrl+'/site');assert.equal(website.status,200);assert.match(await website.text(),/<h1>Report/);
  assert.equal(await js('document.querySelector("#output").hidden'),false);
  fs.writeFileSync(path.join(out,'completed.png'),(await win.webContents.capturePage()).toPNG());
  report.checks.push('独立的正常网站目标通过验收，五步完成且成果入口可访问');
  await js('document.querySelector("#testIntentRail").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
  assert.equal(await js('document.querySelector("#testIntentPanel").hidden'),true);
  await js('document.querySelector("#composer").focus();document.execCommand("insertText",false,"继续讨论")');
  assert.ok(await js('document.querySelector("#composer").textContent.includes("继续讨论")'));
  assert.deepEqual(await js('errors'),[]);
  report.checks.push('弹层可关闭、普通对话仍能输入，无页面脚本错误');
  report.ok=true;
 }catch(error){report.error=String(error.stack||error);}
 finally{
  if(server)server.close();if(printer)printer.destroy();if(win)win.destroy();
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));app.exit(report.ok?0:1);
 }
});
