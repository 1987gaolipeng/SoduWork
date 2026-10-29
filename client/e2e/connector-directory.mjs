// Real local desktop smoke: owned disabled fixtures, no probes or business tools.
import {listPages, CdpPage} from './lib/cdp.mjs';
import fs from 'node:fs';
if (process.env.SODUWORK_CONNECTOR_LIVE !== '1') throw Error('Set SODUWORK_CONNECTOR_LIVE=1 for the logged-in local development client');
const page = await CdpPage.connect((await listPages(Number(process.env.SODUWORK_CDP_PORT || 63814))).find(p => /desk\.html/.test(p.url)));
let ids = [];
async function click(selector) {
  const point = await page.run(selector => {
    const node = document.querySelector(selector); node.scrollIntoView({block:'center'});
    const box = node.getBoundingClientRect();
    if (!node.contains(document.elementFromPoint(box.x+box.width/2,box.y+box.height/2))) throw Error('Target is covered: '+selector);
    return {x:box.x+box.width/2,y:box.y+box.height/2};
  }, selector);
  for (const type of ['mousePressed','mouseReleased']) await page.call('Input.dispatchMouseEvent', {type,...point,button:'left',clickCount:1});
}
try {
  const origin = await page.evaluate('new URL(SoduWorkAPI.hubBase()).origin');
  if (origin !== 'http://127.0.0.1:9080') throw Error('Local Hub required');
  page.takeRuntimeErrors(); // Discard pre-existing/restart logs before the measured interaction.
  const suffix = Date.now().toString(36);
  ids = await page.run(async suffix => {
    const names = ['ui-check-a-'+suffix,'ui-check-b-'+suffix];
    const file = new File([JSON.stringify({mcpServers:Object.fromEntries(names.map(name => [name,{url:'https://connector-check.invalid/mcp'}]))})], 'connector-check.mcp.json',{type:'application/json'});
    const result = await SoduWorkAPI.importMyMcp(file);
    return result.importedRows.map(row => row.id);
  }, suffix);
  await click('button[title="主页"]');
  await click('button[title="插件"]');
  await page.waitFor(()=>!!document.querySelector('[data-cap-tab="connections"]'));
  await click('[data-cap-tab="connections"]');
  await page.waitFor(id=>!!document.querySelector('[data-toggle-mcp="'+id+'"]'),ids[0]);
  await page.run(id=>{window.__connectorOriginalRow=document.querySelector('[data-toggle-mcp="'+id+'"]').closest('.cap-mcp-row');},ids[0]);
  for (const id of ids) await click('[data-toggle-mcp="'+id+'"]');
  await page.waitFor(()=>document.querySelector('.cap-connector-save')?.hidden===true);
  const read = () => page.run(async ids => {
    const result = await SoduWorkAPI.myMcpServers();
    return {rows:result.personal.filter(x=>ids.includes(x.id)).map(x=>({id:x.id,enabled:x.enabled})),
      sameRow:window.__connectorOriginalRow===document.querySelector('[data-toggle-mcp="'+ids[0]+'"]').closest('.cap-mcp-row'),
      focus:document.activeElement?.dataset.toggleMcp};
  },ids);
  const rapid = await read();
  if (rapid.rows.length!==2 || rapid.rows.some(x=>!x.enabled) || !rapid.sameRow) throw Error('Rapid selection lost or DOM replaced');
  for (let i=0;i<2;i++) await click('[data-toggle-mcp="'+ids[0]+'"]');
  await page.waitFor(()=>document.querySelector('.cap-connector-save')?.hidden===true);
  const doubleToggle = await read();
  if (doubleToggle.rows.some(x=>!x.enabled)) throw Error('Final toggle intent lost');
  const output = {at:new Date().toISOString(),rapid,doubleToggle,errors:page.takeRuntimeErrors()};
  fs.mkdirSync('../outputs/connector-foundation-20261016',{recursive:true});
  fs.writeFileSync('../outputs/connector-foundation-20261016/real-client-selection.json',JSON.stringify(output,null,2));
  console.log(JSON.stringify(output));
} finally {
  for (const id of ids) await page.run(id=>SoduWorkAPI.deleteMyMcpServer(id).then(()=>true),id);
  await click('button[title="主页"]');
  await click('button[title="插件"]');
  page.close();
}
