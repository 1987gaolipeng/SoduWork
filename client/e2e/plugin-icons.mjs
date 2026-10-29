// Real editor/catalog + real local plugin store in a temporary profile.
// HTTP is only a test bridge to the same main-process functions; no production writes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {CdpPage,listPages,delay} from './lib/cdp.mjs';
const require=createRequire(import.meta.url);
const personal=require('../main/personal-plugins');
const output=path.resolve(process.argv[2]||path.join(os.tmpdir(),'soduwork-plugin-icon-evidence'));
fs.mkdirSync(output,{recursive:true});
const root=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-plugin-icons-'));
const profile=path.join(root,'browser'), app={getPath:()=>path.join(root,'store')};
fs.mkdirSync(profile);
const draft={template:'method',key:'icon-demo',name:'工作简报助手',version:'1.0.0',
  description:'整理团队进展，生成清晰的工作简报。',instructions:'根据材料总结进展、风险与下一步。'};
const initial=personal.create(app,draft).plugin;
const checks=[];
const server=http.createServer(async(req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS'){res.end();return;}
  try{
    let input=''; for await(const c of req){input+=c;if(input.length>1024*1024)throw Error('size');}
    const body=JSON.parse(input||'null');let result;
    if(req.url==='/preflight')result=personal.preflight(body);
    else if(req.url==='/save')result=personal.create(app,body);
    else if(req.url==='/get')result={plugin:personal.get(app,body)};
    else if(req.url==='/catalog')result={items:[...personal.catalog(app,true),
      {...personal.get(app,initial.pluginId),pluginId:'published-icon-demo',personal:false,
        sourceKind:'enterprise',installed:true,organizationWide:true}],submissions:[],categories:[]};
    else throw Error('Unknown fixture endpoint');
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));
  }catch(e){res.statusCode=400;res.end(JSON.stringify({error:e.message}));}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const endpoint='http://127.0.0.1:'+server.address().port;
const child=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',[
  '--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',
  '--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--user-data-dir='+profile,
  '--window-size=1440,1000','about:blank'],{windowsHide:true,stdio:'ignore'});
let page;
try{
  let port;
  for(let i=0;i<80;i++){try{port=Number(fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0]);if(port)break;}catch{}await delay(100);}
  assert.ok(port);page=await CdpPage.connect((await listPages(port))[0]);
  await page.call('Page.enable');
  await page.call('Page.addScriptToEvaluateOnNewDocument',{source:'window.iconTestFetch=window.fetch.bind(window);'});
  await page.call('Page.navigate',{url:new URL('../tests/plugin-presentation.html',import.meta.url).href});
  await page.waitFor(()=>document.querySelectorAll('.cap-plugin-card').length===7,null,10000);
  await page.call('Page.bringToFront');
  await page.call('Emulation.setFocusEmulationEnabled',{enabled:true});
  await page.run(async endpoint=>{
    const call=async(op,body)=>{const r=await iconTestFetch(endpoint+'/'+op,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body??null)});const x=await r.json();if(!r.ok)throw Error(x.error);return x;};
    Object.assign(SoduWorkAPI,{
      pluginCatalog:()=>call('catalog'),personalPlugin:id=>call('get',id),
      preflightPluginDraft:b=>call('preflight',b),createPluginDraft:b=>call('save',b)
    });
    await SoduWorkCapabilityPlugins.load();
    document.querySelector('[data-cap-tab="plugins"]').click();
  },endpoint);
  async function click(selector){
    const point=await page.run(s=>{const e=document.querySelector(s);if(!e)throw Error('Missing '+s);e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();if(!r.width)throw Error('Hidden '+s);return{x:r.x+r.width/2,y:r.y+r.height/2};},selector);
    for(const type of ['mousePressed','mouseReleased'])await page.call('Input.dispatchMouseEvent',{type,...point,button:'left',clickCount:1});
    await delay(80);
  }
  async function shot(name){const s=await page.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(output,name+'.png'),Buffer.from(s.data,'base64'));}
  async function edit(){await click('.cap-plugin-open[data-plugin="'+initial.pluginId+'"]');await click('#capPersonalEdit');await page.waitFor(()=>!!document.querySelector('#capPluginIconUpload'));}
  async function upload(file){
    const doc=await page.call('DOM.getDocument');
    const {nodeId}=await page.call('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'#capPluginIconFile'});
    await page.call('DOM.setFileInputFiles',{nodeId,files:[file]});
    await page.waitFor(()=>!document.querySelector('#capMakerDo').disabled);
  }
  async function save(){await click('#capMakerDo');await page.waitFor(()=>document.querySelector('#capMakerDo').textContent==='保存新版本');await click('#capMakerDo');await page.waitFor(()=>document.querySelector('#capModalLayer').hidden);}
  await edit();
  const fallback=await page.run(()=>document.querySelector('#capPluginIconPreview svg').outerHTML);
  assert.ok(await page.run(()=>document.querySelector('#capPluginIconReset').hidden));
  checks.push('default icon unchanged and reset hidden when unset');
  const pictures=await page.run(()=>{
    const c=document.createElement('canvas');c.width=240;c.height=120;
    const g=c.getContext('2d');g.fillStyle='#134a46';g.fillRect(0,0,240,120);
    g.fillStyle='#fcdb9b';g.beginPath();g.arc(120,60,42,0,Math.PI*2);g.fill();
    g.fillStyle='#134a46';g.fillRect(96,40,48,8);g.fillRect(96,57,48,8);g.fillRect(96,74,28,8);
    return ['image/png','image/jpeg','image/webp'].map(type=>({type,data:c.toDataURL(type).split(',')[1]}));
  });
  let uploaded;
  for(const [i,pic] of pictures.entries()){
    const file=path.join(root,'logo.'+['png','jpg','webp'][i]);fs.writeFileSync(file,Buffer.from(pic.data,'base64'));
    await upload(file);
    await page.waitFor(()=>{const e=document.querySelector('#capPluginIconPreview img');return e&&e.complete&&e.naturalWidth===128;});
    uploaded=await page.run(()=>document.querySelector('#capPluginIconPreview img').src);
    assert.match(uploaded,/^data:image\/png;base64,/);
    checks.push(pic.type+' upload normalized to self-contained 128px PNG');
  }
  await shot('01-upload');
  const bad=path.join(root,'invalid.png');fs.writeFileSync(bad,'not an image');
  await upload(bad);await page.waitFor(()=>document.querySelector('#capPluginIconStatus').textContent.includes('无法读取'));
  assert.equal(await page.run(()=>document.querySelector('#capPluginIconPreview img').src),uploaded);
  checks.push('invalid image rejected without replacing current selection');
  const svg=path.join(root,'unsafe.svg');fs.writeFileSync(svg,'<svg xmlns="http://www.w3.org/2000/svg" onload="window.pwned=true"/>');
  await upload(svg);assert.match(await page.run(()=>document.querySelector('#capPluginIconStatus').textContent),/请选择 PNG/);
  assert.equal(await page.run(()=>!!window.pwned),false);
  checks.push('active image format rejected');
  const large=path.join(root,'large.png');fs.writeFileSync(large,Buffer.alloc(2*1024*1024+1));
  await upload(large);assert.match(await page.run(()=>document.querySelector('#capPluginIconStatus').textContent),/2 MB/);
  checks.push('oversized upload rejected');
  await save();
  assert.equal(personal.get(app,initial.pluginId).icon,uploaded);
  await page.waitFor(id=>!!document.querySelector('.cap-plugin-open[data-plugin="'+id+'"] .cap-plugin-custom-icon'),initial.pluginId);
  checks.push('real local preflight and versioned save persisted icon');
  await shot('02-saved-catalog');
  await click('[data-cap-tab="market"]');
  assert.equal(await page.run(()=>document.querySelector('[data-cap-market-open="published-icon-demo"]').closest('.cap-market-row').querySelector('img').src),uploaded);
  checks.push('market presentation preserves custom icon using enterprise catalog fixture');
  await click('[data-cap-tab="plugins"]');
  await edit();assert.equal(await page.run(()=>document.querySelector('#capPluginIconPreview img').src),uploaded);
  checks.push('reopening editor reads saved icon');
  const skins=await page.run(()=>SkinRegistry.getSkins().map(s=>({id:s.id,theme:s.palette,skin:s.material})));
  for(const skin of skins){
    await page.run(s=>{document.documentElement.dataset.theme=s.theme;document.documentElement.dataset.skin=s.skin;},skin);
    for(const width of [1000,1440]){
      await page.call('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});
      const audit=await page.run(()=>{
        const box=document.querySelector('.cap-maker-icon-field');
        const r=box.getBoundingClientRect();
        const fonts=[...box.querySelectorAll('b,em,span,button')].filter(e=>e.getClientRects().length&&!e.closest('[hidden]'))
          .map(e=>parseFloat(getComputedStyle(e).fontSize));
        return{fits:r.left>=0&&r.right<=innerWidth&&box.scrollWidth<=box.clientWidth+1,small:fonts.some(x=>x<12),
          loaded:document.querySelector('#capPluginIconPreview img').naturalWidth===128};
      });
      assert.deepEqual(audit,{fits:true,small:false,loaded:true},skin.id+' '+width);
    }
  }
  checks.push('8 themes at 1000px and 1440px: no overflow, readable type, loaded icon');
  await page.run(()=>{document.querySelector('#capPluginIconUpload').focus();});
  assert.equal(await page.run(()=>document.activeElement.id),'capPluginIconUpload');
  await page.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab'});
  await page.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab'});
  assert.equal(await page.run(()=>document.activeElement.id),'capPluginIconReset');
  checks.push('upload and reset controls keyboard reachable');
  await shot('02-saved-editor');
  await click('#capPluginIconReset');
  assert.equal(await page.run(()=>document.querySelector('#capPluginIconPreview svg').outerHTML),fallback);
  assert.equal(await page.run(()=>!!document.querySelector('#capPluginIconPreview img')),false);
  await click('#capMakerCancel');
  assert.equal(personal.get(app,initial.pluginId).icon,uploaded);
  checks.push('cancelled reset does not alter saved plugin');
  await edit();await click('#capPluginIconReset');await save();
  assert.equal(personal.get(app,initial.pluginId).icon,undefined);
  await page.waitFor(id=>!document.querySelector('.cap-plugin-open[data-plugin="'+id+'"] img'),initial.pluginId);
  checks.push('saved reset restores original default in card and installed shelf');
  await edit();assert.equal(await page.run(()=>document.querySelector('#capPluginIconPreview svg').outerHTML),fallback);
  assert.ok(await page.run(()=>document.querySelector('#capPluginIconReset').hidden));
  await shot('03-restored-default');
  checks.push('reopened default stays unchanged');
  assert.deepEqual(await page.run(()=>fixtureErrors),[]);
  assert.deepEqual(page.takeRuntimeErrors(),[]);
  fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({ok:true,checks,root,scope:'isolated browser + actual local store; no live client changes'},null,2));
  console.log(JSON.stringify({ok:true,checks:checks.length,output}));
}catch(error){if(page){try{await shotFailure();}catch{}console.error(await page.run(()=>({errors:fixtureErrors,text:document.body.innerText.slice(-1600)})));}throw error;
}finally{
  if(page){try{await page.call('Browser.close');}catch{}page.close();}
  if(child.exitCode===null)child.kill();
  await new Promise(r=>server.close(r));
}
async function shotFailure(){const s=await page.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(output,'failure.png'),Buffer.from(s.data,'base64'));}
