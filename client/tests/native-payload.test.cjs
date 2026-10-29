'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
const {writeNativePayload,renderNativePayload}=require('../scripts/native-payload.cjs');
const {stageSource}=require('../scripts/payload-sources.cjs');
const crypto=require('node:crypto');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function renderProgress(files, root) {
  const sizes=new Map(files.map(item=>[item.path,item.size])); sizes.set('.soduwork-payload.json',100);
  return renderNativePayload(sizes,new Map([...sizes.keys()].map(name=>[name,path.join(root,name)])));
}
const {getMakeNsisPath}=require('app-builder-lib/out/toolsets/windows');
test('payload progress comes only after successful writes and handles totals beyond 32-bit NSIS arithmetic', async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'soduwork-native-progress-source-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const files=Array.from({length:1000},(_,index)=>({path:'runtime/'+String(index).padStart(4,'0')+'.dll',size:5*1024*1024}));
  // Test arithmetic independently; the native extraction test stages real bytes.
  const source=renderProgress(files,root);
  const snapshots=[...source.matchAll(/!insertmacro soduWorkProgress (\d+) (\d+) (\d+)/g)].map(match=>match.slice(1).map(Number));
  assert.deepEqual(snapshots[0],[0,0,1001]);
  assert.deepEqual(snapshots.at(-1),[70,1001,1001]);
  assert.ok(snapshots.length<=71);
  assert.ok(snapshots.length>20);
  for(let index=1;index<snapshots.length;index++){
    assert.ok(snapshots[index][0]>snapshots[index-1][0]);
    assert.ok(snapshots[index][1]>snapshots[index-1][1]);
  }
  assert.match(source,/IfErrors soduWorkNativeDone\n!ifmacrodef soduWorkProgress\n!insertmacro soduWorkProgress/);
  assert.doesNotMatch(source,/IntOp[^\n]*(?:5242880|5242880000)/);
});

test('invalid or duplicated inventory sizes cannot generate an optimistic progress payload', async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'soduwork-native-progress-invalid-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  for(const files of [[{path:'a.dll',size:-1}],[{path:'a.dll',size:'1'}],[{path:'a.dll',size:1},{path:'a.dll',size:1}]]){
    await fs.writeFile(path.join(root,'.soduwork-payload.json'),JSON.stringify({files}));
    await assert.rejects(writeNativePayload(root,path.join(root,'build')),/Invalid payload size|Duplicate payload path/);
  }
});

test('small-file extraction reports advancing counts while the byte percentage is unchanged', async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'soduwork-native-small-progress-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const files=[{path:'big.dll',size:1024*1024*1024},...Array.from({length:1000},(_,i)=>({path:'tiny/'+i+'.js',size:1}))];
  const source=renderProgress(files,root);
  const events=[...source.matchAll(/!insertmacro soduWorkProgress (\d+) (\d+) (\d+)/g)].map(m=>m.slice(1).map(Number));
  assert.ok(events.length>=9 && events.length<20);
  assert.ok(events.some((event,i)=>i && event[0]===events[i-1][0] && event[1]>events[i-1][1]));
  assert.deepEqual(events.at(-1),[70,1002,1002]);
});

test('native installer preserves exact bytes through deep Unicode paths and literal dollar names', {skip:process.platform!=='win32'}, async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'soduwork-native-regression-'));
  t.after(async()=>{assert.equal(path.dirname(root),os.tmpdir());assert.ok(path.basename(root).startsWith('soduwork-native-regression-'));await fs.rm(root,{recursive:true,force:true});});
  const source=path.join(root,'source'),dest=path.join(root,'installed'),output=path.join(root,'build');
  const deep=Array(14).fill('中文资源abcdefghijklmnop').join('/')+'/requirements.txt';
  const names=[deep,'runtime $literal.txt','base_library.zip','runtime-config.json','skills/example/SKILL.md',
    ...Array.from({length:130},(_,i)=>'modules/'+i+'.json')];
  for(const name of names){await fs.mkdir(path.dirname(path.join(source,name)),{recursive:true});await fs.writeFile(path.join(source,name),Buffer.from('original:'+name));}
  await fs.writeFile(path.join(source,'.soduwork-payload.json'),JSON.stringify({files:names.map(path=>({path,size:Buffer.byteLength('original:'+path),sha256:sha('original:'+path)}))}));
  await writeNativePayload(source,output);
  const shards=await fs.readdir(path.join(output,'payload-sources'));
  assert.equal(shards.length,3,'large inventories span bounded compiler input directories');
  for(const shard of shards){
    const entries=await fs.readdir(path.join(output,'payload-sources',shard));
    assert.ok(entries.length<=64,'native compiler never scans an unbounded flat directory');
  }
  const compiler=await getMakeNsisPath(),exe=path.join(root,'probe.exe'),script=path.join(root,'probe.nsi');
  await fs.writeFile(script,`Unicode true\nRequestExecutionLevel user\nSilentInstall silent\nOutFile "${exe}"\n!include "${output}\\native-payload.nsh"\nSection\nClearErrors\n!insertmacro soduWorkExtractPayload "${dest}"\nIfErrors 0 +3\nSetErrorLevel 2\nQuit\nSetErrorLevel 0\nSectionEnd\n`);
  const compiled=spawnSync(compiler.path,['/V2','/INPUTCHARSET','UTF8',script],{encoding:'utf8',windowsHide:true,env:{...process.env,...compiler.env},timeout:30000});
  assert.equal(compiled.status,0,compiled.stdout+compiled.stderr);
  const installed=spawnSync(exe,[],{windowsHide:true,timeout:30000});assert.equal(installed.status,0,installed.error?.message);
  assert.ok(path.join(dest,deep).length>350);
  for(const name of names)assert.deepEqual(await fs.readFile(path.join(dest,name)),await fs.readFile(path.join(source,name)),name);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dest,'.soduwork-payload.json'))),JSON.parse(await fs.readFile(path.join(source,'.soduwork-payload.json'))));
});

test('shared native extraction supports repeated destinations, preserves caller registers and propagates failure', {skip:process.platform!=='win32'}, async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'soduwork-native-shared-'));
  t.after(async()=>{assert.equal(path.dirname(root),os.tmpdir());assert.ok(path.basename(root).startsWith('soduwork-native-shared-'));await fs.rm(root,{recursive:true,force:true});});
  const source=path.join(root,'source'),output=path.join(root,'build'),progress=path.join(root,'progress');
  const names=['before.txt','nested/config.json'];
  for(const name of names){await fs.mkdir(path.dirname(path.join(source,name)),{recursive:true});await fs.writeFile(path.join(source,name),'shared:'+name);}
  await fs.writeFile(path.join(source,'.soduwork-payload.json'),JSON.stringify({files:names.map(name=>({path:name,size:Buffer.byteLength('shared:'+name),sha256:sha('shared:'+name)}))}));
  await writeNativePayload(source,output);
  const include=await fs.readFile(path.join(output,'native-payload.nsh'),'utf8');
  assert.equal((include.match(/^Function soduWorkExtractPayload$/gm)||[]).length,1);
  assert.equal((include.match(/^File /gm)||[]).length,names.length+1,'payload instructions are embedded once');
  const installer=await fs.readFile(path.resolve(__dirname,'../build/installer.nsh'),'utf8');
  const progressMacro=installer.match(/!macro soduWorkProgress percent completed total[\s\S]*?!macroend/);
  assert.ok(progressMacro,'exercise the production progress macro, not a fixture replacement');
  const destinations=['first','second','blocked','after-failure'].map(name=>path.join(root,name));
  await fs.mkdir(destinations[2]);
  await fs.writeFile(path.join(destinations[2],'nested'),'keep-blocking-file');
  await fs.mkdir(progress);
  // A live caller may already own R8 (package-check uses it for argv). Check
  // every saved register and a stack sentinel before doing any test logging.
  function invocation(index,expectedError=false){
    const label='call'+index;
    const registers=[['$R8','root-owner-'+index],['$0','zero-owner-'+index],['$1','one-owner-'+index],['$2','two-owner-'+index]];
    return registers.map(([reg,value])=>'StrCpy '+reg+' "'+value+'"').join('\n')+`
Push "stack-owner-${index}"
ClearErrors
!insertmacro soduWorkExtractPayload "${destinations[index]}"
IfErrors ${expectedError?label+'StatusOk':'unexpectedError'} ${expectedError?'missingError':label+'StatusOk'}
${label}StatusOk:
`+registers.map(([reg,value])=>'StrCmp '+reg+' "'+value+'" +2\nGoto changedRegister').join('\n')+`
Pop $9
StrCmp $9 "stack-owner-${index}" +2
Goto changedStack
CopyFiles /SILENT "${progress}\\.soduwork-update-progress" "${progress}\\${label}.txt"
`;
  }
  const compiler=await getMakeNsisPath(),exe=path.join(root,'shared.exe'),script=path.join(root,'shared.nsi');
  await fs.writeFile(script,`Unicode true
RequestExecutionLevel user
SilentInstall silent
OutFile "${exe}"
!include "LogicLib.nsh"
Var soduWorkRoot
${progressMacro[0]}
!include "${output}\\native-payload.nsh"
Section
StrCpy $soduWorkRoot "${progress}"
${invocation(0)}
${invocation(1)}
${invocation(2,true)}
${invocation(3)}
SetErrorLevel 0
Goto finished
unexpectedError:
SetErrorLevel 21
Goto finished
missingError:
SetErrorLevel 22
Goto finished
changedRegister:
SetErrorLevel 23
Goto finished
changedStack:
SetErrorLevel 24
finished:
SectionEnd
`);
  const compiled=spawnSync(compiler.path,['/V2','/INPUTCHARSET','UTF8',script],{encoding:'utf8',windowsHide:true,env:{...process.env,...compiler.env},timeout:30000});
  assert.equal(compiled.status,0,compiled.stdout+compiled.stderr);
  const result=spawnSync(exe,[],{windowsHide:true,timeout:30000});
  assert.equal(result.status,0,result.error?.message||'21=unexpected error, 22=lost error, 23=register corruption, 24=stack corruption');
  for(const index of [0,1,3]){
    for(const name of [...names,'.soduwork-payload.json'])assert.deepEqual(await fs.readFile(path.join(destinations[index],name)),await fs.readFile(path.join(source,name)));
    assert.equal(await fs.readFile(path.join(progress,'call'+index+'.txt'),'utf8'),'70|3|3');
  }
  const stopped=(await fs.readFile(path.join(progress,'call2.txt'),'utf8')).split('|').map(Number);
  assert.ok(stopped[0]<70 && stopped[1]<stopped[2],'failed extraction must never publish completed progress');
  assert.equal(await fs.readFile(path.join(destinations[2],'nested'),'utf8'),'keep-blocking-file');
  assert.deepEqual(await fs.readFile(path.join(destinations[2],'before.txt')),await fs.readFile(path.join(source,'before.txt')));
});

test('changed input cannot be silently staged into the installer after inventory', async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'soduwork-payload-snapshot-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const source=path.join(root,'config.json'),destination=path.join(root,'source.bin');
  const original=Buffer.from('{"version":1}');
  await fs.writeFile(source,original);
  await stageSource(source,destination,{size:original.length,sha256:sha(original)});
  assert.deepEqual(await fs.readFile(destination),original);
  await fs.writeFile(source,'{"version":2}');
  await assert.rejects(stageSource(source,destination,{size:original.length,sha256:sha(original)}),/changed after inventory/);
  await assert.rejects(fs.stat(destination),{code:'ENOENT'});
});
test('package check accepts a new TEMP child and refuses existing or outside destinations', {skip:process.platform!=='win32'}, async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'soduwork-native-boundary-'));
  const target=path.join(os.tmpdir(),'soduwork-package-check-'+require('node:crypto').randomUUID());
  t.after(async()=>{for(const dir of [root,target]){assert.equal(path.dirname(dir),os.tmpdir());assert.ok(/^soduwork-(native-boundary|package-check)-/.test(path.basename(dir)));await fs.rm(dir,{recursive:true,force:true});}});
  const compiler=await getMakeNsisPath();
  async function compile(name,text){const script=path.join(root,name+'.nsi'),exe=path.join(root,name+'.exe');await fs.writeFile(script,'Unicode true\nRequestExecutionLevel user\nSilentInstall silent\nOutFile "'+exe+'"\n'+text);const r=spawnSync(compiler.path,['/V2','/INPUTCHARSET','UTF8',script],{encoding:'utf8',windowsHide:true,env:{...process.env,...compiler.env},timeout:30000});assert.equal(r.status,0,r.stdout+r.stderr);return exe;}
  // A minimal verifier process isolates directory admission from the full-payload
  // tests, which separately run the delivered Electron verifier and Runner.
  const checker=await compile('checker','Section\nSetErrorLevel 0\nSectionEnd\n');
  const hook=path.resolve(__dirname,'../build/package-check.nsh');
  const setup=await compile('boundary',`!include "LogicLib.nsh"\n!include "FileFunc.nsh"\n!define APP_EXECUTABLE_FILENAME "SoduWork.exe"\n!macro soduWorkExtractPayload ROOT\nSetOutPath "\u0024{ROOT}"\nFile /oname=SoduWork.exe "${checker}"\n!macroend\n!include "${hook}"\nFunction .onInit\n!insertmacro preInit\nFunctionEnd\nSection\nSetErrorLevel 9\nSectionEnd\n`);
  const run=dest=>spawnSync(setup,['/S','/SODUWORK-PACKAGE-CHECK='+dest],{windowsHide:true,timeout:30000}).status;
  assert.equal(run(path.join(root,'soduwork-package-check-outside')),87);
  const token=path.basename(target).slice('soduwork-package-check-'.length);
  assert.equal(run('C:/Program Files/soduwork-package-check-invalid'),87);
  assert.equal(run('not-a-uuid'),87);
  assert.equal(run('z'.repeat(36)),87);
  assert.equal(spawnSync(setup, ['/S'], {windowsHide:true,timeout:30000}).status,9);
  assert.equal(run(token),0);
  const original=await fs.readFile(path.join(target,'SoduWork.exe'));
  assert.equal(run(token),183);assert.deepEqual(await fs.readFile(path.join(target,'SoduWork.exe')),original);
});
