/* Example business UI: real host SDK, no browser data store or private service. */
'use strict';
const $ = id => document.getElementById(id), api = window.soduWorkApp;
let next = null, revision = 0, rows = [], busy = false;
const scope = () => $('target').value ? {appId:$('target').value} : {};
function result(r) { if (!r?.ok) throw Error(r?.reason || '宿主未返回成功回执'); return r; }
function status(text,error) { $('status').textContent=text; $('status').toggleAttribute('data-error',!!error); }
async function action(run) { if(busy)return;busy=true;try { await run(); } catch(e) { status(e.message,true); } finally { busy=false; } }
function render() {
  $('notes').replaceChildren(); $('count').textContent=rows.length+' 条'+(next?' · 还有更多':'');
  if(!rows.length){const empty=document.createElement('div');empty.className='empty';empty.textContent='从一个小想法开始。写下第一条便签。';$('notes').append(empty);}
  for(const row of rows){const article=document.createElement('article');article.className='note';const p=document.createElement('p');p.textContent=row.value.title || JSON.stringify(row.value);const bottom=document.createElement('div');bottom.className='note-bottom';const time=document.createElement('time');time.textContent=new Date(row.updatedAt).toLocaleString();const remove=document.createElement('button');remove.textContent='删除';remove.onclick=()=>action(async()=>{result(await api.data.batch({...scope(),collection:'notes',operations:[{id:row.id,expectedRevision:row.revision,delete:true}]}));await load();});bottom.append(time,remove);article.append(p,bottom);$('notes').append(article);}
  $('more').hidden=!next;
}
async function load(append=false) { const page=result(await api.data.list({...scope(),collection:'notes',limit:40,...(append&&next?{after:next}:{})}));rows=append?[...rows,...page.items]:page.items;next=page.next;render();status('已读取本机数据库 · '+new Date().toLocaleTimeString()); }
async function settings() {const r=result(await api.settings.get());revision=r.revision;$('nickname').value=r.values.nickname || '';$('appearance').value=r.values.appearance || 'warm';document.body.dataset.theme=$('appearance').value;return r;}
$('new').onsubmit=e=>{e.preventDefault();const value=$('text').value.trim();if(!value)return;action(async()=>{result(await api.data.batch({...scope(),collection:'notes',operations:[{id:'note_'+api.createRequestId(),expectedRevision:0,value:{title:value,status:'open'}}]}));$('text').value='';await load();});};
$('refresh').onclick=()=>action(()=>load());$('more').onclick=()=>action(()=>load(true));$('target').onchange=()=>action(()=>load());
$('settings').onclick=()=>action(async()=>{await settings();$('settings-status').textContent='';$('preferences').showModal();});
$('save-settings').onclick=e=>{e.preventDefault();action(async()=>{const r=result(await api.settings.update({values:{nickname:$('nickname').value,appearance:$('appearance').value},expectedRevision:revision}));revision=r.revision;document.body.dataset.theme=r.values.appearance;$('preferences').close();status('设置已保存到 SoduWork');});};
$('ai').onclick=()=>action(async()=>{result(await api.chat.insertText({text:'请通过即用的数据 MCP 读取'+($('target').value?'目标即用 '+$('target').value:'当前即用')+'的 notes 集合，整理灵感与待办；写回前读取 revision，保留原意，完成后告诉我真实修改结果。'}));result(await api.chat.expand());status('整理要求已放入宿主对话，请核对后发送');});
$('schedule').onclick=()=>action(async()=>{result(await api.automation.create({text:'每天早上9点，读取本即用 notes 集合，整理未完成待办并写回；保留原始便签，遵守 revision 冲突检查。',requestId:api.createRequestId()}));status('计划请求已交给 SoduWork，请查看真实创建结果');});
api.events.onRefresh(()=>action(()=>load()));
action(async()=>{await settings();const current=result(await api.context.get());const all=result(await api.data.apps());for(const app of all.apps){if('plugin:'+app.appId===current.appId||!app.collections.some(c=>c.key==='notes'))continue;const option=document.createElement('option');option.value=app.appId;option.textContent=app.name;$('target').append(option);}await load();});

let colleagues=[];
function showPeople(){
  const selected=colleagues.filter(p=>!$('share-org').value || p.orgId===$('share-org').value);
  $('share-person').replaceChildren();
  for(const p of selected){const option=document.createElement('option');option.value=p.id;option.textContent=p.name+(p.org?' · '+p.org:'')+(!p.canReceive?'（暂不可联系）':'');option.disabled=!p.canReceive;$('share-person').append(option);}
  const first=selected.find(p=>p.canReceive);if(first)$('share-person').value=first.id;
  $('share-open').disabled=!first;
}
$('mention').onclick=()=>action(async()=>{
  if(!api.directory?.list || !api.chat.mention)throw Error('请更新 SoduWork 后联系同事');
  const directory=result(await api.directory.list());colleagues=directory.members;
  $('share-org').replaceChildren(new Option('全部部门',''));
  for(const org of directory.orgUnits)$('share-org').append(new Option(org.name,org.id));
  showPeople();$('share-text').value=String(rows[0]?.value.title || '').slice(0,500);
  $('share-status').textContent=directory.truncated?'同事较多，当前显示部分目录':colleagues.length?'在右侧对话核对后发送通知':'暂无可联系的同事';$('share').showModal();
});
$('share-org').onchange=showPeople;
$('share-open').onclick=e=>{e.preventDefault();action(async()=>{
  const recipient=colleagues.find(p=>p.id===$('share-person').value && p.canReceive);if(!recipient)throw Error('请选择可联系的同事');
  const r=result(await api.chat.mention({recipientUserId:recipient.id,text:$('share-text').value,requestId:api.createRequestId()}));
  $('share').close();status(r.state==='review'?'已在右侧打开发送卡片，请核对后发送':'请在右侧选择同事');
});};
