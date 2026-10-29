import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const exec=promisify(execFile),cli=fileURLToPath(new URL('../scripts/browser.mjs',import.meta.url));

test('persistent dedicated browser retains login across close/reopen and supports tabs/upload without sharing temporary sessions',{timeout:90000},async()=>{
  const directory=mkdtempSync(join(tmpdir(),'soduwork-publish-test-'));
  const session='browser-fixture-'+process.pid;
  const env={...process.env,SODUWORK_PUBLISH_BROWSER_ROOT:directory,SODUWORK_PUBLISH_BROWSER_PORT:'0'};
  const run=(...args)=>exec(process.execPath,[cli,...args,'--persistent','--headless','--session',session],{env,timeout:20000,windowsHide:true});
  const server=createServer((req,res)=>{
    if(req.url==='/login')res.setHeader('Set-Cookie','fixture_login=yes; Path=/; Max-Age=3600; HttpOnly; SameSite=Lax');
    res.setHeader('Content-Type','text/html');
    res.end('<!doctype html><body><p>'+((req.headers.cookie||'').includes('fixture_login=yes')?'Signed in':'Signed out')+'</p><input type="file" id="upload"><button id="publish">Publish fixture</button><div id="receipt"></div><script>publish.onclick=()=>receipt.textContent="Published fixture (isolated site)"</script></body>');
  });
  await new Promise(resolveServer=>server.listen(0,'127.0.0.1',resolveServer));
  const origin='http://127.0.0.1:'+server.address().port;
  const portLease=createServer();await new Promise(done=>portLease.listen(0,'127.0.0.1',done));
  const fixedPort=portLease.address().port;await new Promise(done=>portLease.close(done));env.SODUWORK_PUBLISH_BROWSER_PORT=String(fixedPort);
  try{
    await run('text',origin+'/login');
    assert.match((await run('text',origin+'/publish')).stdout,/Signed in/);
    const initial=JSON.parse((await run('status')).stdout);assert.equal(initial.persistent,true);assert.equal(initial.running,true);assert.equal(initial.port,fixedPort);
    const target=JSON.parse((await run('open-tab',origin+'/publish')).stdout).targetId;
    const tabs=JSON.parse((await run('tabs','current')).stdout);assert(tabs.some(tab=>tab.id===target));
    const file=join(directory,'fixture.txt');writeFileSync(file,'Fixture upload');
    const actions=JSON.stringify([{upload:{sel:'#upload',files:[file]}},{eval:'document.querySelector("#upload").files[0].name'},{click:'#publish'},{text:true}]);
    const result=await run('do','current',actions,'--tab',target);assert.match(result.stdout,/fixture.txt/);assert.match(result.stdout,/Published fixture/);
    const same=JSON.parse((await run('status')).stdout);assert.equal(same.pid,initial.pid);assert.equal(same.port,initial.port);
    await run('close');assert.equal(JSON.parse((await run('status')).stdout).running,false);
    assert.match((await run('text',origin+'/publish')).stdout,/Signed in/,'cookie must survive browser restart');
    assert.equal(JSON.parse((await run('status')).stdout).port,fixedPort,'configured port survives browser restart');
    await assert.rejects(run('text','current','--tab','does-not-belong-to-session'),/不属于当前受管浏览器/);
  }finally{
    await run('close').catch(()=>{});server.closeAllConnections();await new Promise(done=>server.close(done));
    assert(resolve(directory).startsWith(resolve(tmpdir())+sep));
    // Delete only this test's explicitly named temporary directory, never a user profile.
    if(resolve(directory).startsWith(resolve(tmpdir()))&&directory.includes('soduwork-publish-test-'))rmSync(directory,{recursive:true,force:true});
  }
});

test('an occupied configured port is refused without touching its listener',{timeout:15000},async()=>{
  const server=createServer((req,res)=>res.end('unrelated process'));
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  try{
    await assert.rejects(exec(process.execPath,[cli,'tabs','current','--persistent','--headless','--session','port-conflict-fixture-'+process.pid],{
      env:{...process.env,SODUWORK_PUBLISH_BROWSER_PORT:String(server.address().port)},timeout:10000,windowsHide:true}),/端口已占用/);
    assert.equal(await (await fetch('http://127.0.0.1:'+server.address().port)).text(),'unrelated process');
  }finally{server.closeAllConnections();await new Promise(done=>server.close(done));}
});
