const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
test('plugin presentation is loaded before both authoring and catalog in both clients',()=>{
  for(const file of ['index.html','desk.html']){
    const html=read(file);
    assert.ok(html.indexOf('plugin-presentation.js')<html.indexOf('panels-plugin-maker.js'));
    assert.ok(html.indexOf('plugin-presentation.js')<html.indexOf('panels-capability-plugins.js'));
    assert.match(html,/plugin-presentation\.css/);
  }
});
test('plugin surfaces do not declare a font smaller than 12px',()=>{
  for(const file of ['panels-capabilities.css','panels-capability-plugins.css','panels-plugin-maker.css','plugin-install-setup.css','plugin-presentation.css']){
    const source=read('components/panels/'+file);
    for(const match of source.matchAll(/font(?:-size)?\s*:\s*[^;{}]*?(\d+(?:\.\d+)?)px/g))
      assert.ok(Number(match[1])>=12,file+': '+match[0]);
  }
});
test('searching plugin skills filters presentation without clearing selection',()=>{
  const source=read('components/panels/panels-plugin-maker-skills.js');
  assert.match(source,/allRows\.filter/);
  assert.match(source,/selected\.forEach/);
  assert.doesNotMatch(source,/selected\.clear\(/);
  assert.match(source,/options\.search\.addEventListener\('input', render\)/);
});
test('detail management relocates existing buttons and does not call backend APIs',()=>{
  const source=read('components/panels/plugin-presentation.js');
  assert.match(source,/appendChild\(button\)/);
  assert.match(source,/AbortController/);
  assert.match(source,/aria-selected/);
  assert.match(source,/event\.key === 'Escape'/);
  assert.doesNotMatch(source,/SoduWorkAPI|fetch\(/);
});
const vm=require('node:vm');
function presentation(){
  const context={window:{}};
  vm.runInNewContext(read('components/panels/plugin-presentation.js'),context);
  return context.window.SoduWorkPluginPresentation;
}
test('应用类插件不进入插件库列表和计数，只由应用菜单承载',()=>{
  const api=presentation();
  const app={pluginId:'app-one',personal:true,installed:true,name:'自建应用',
    ui:{contributions:[{id:'main',slot:'workspace.navigation',source:{type:'external',url:'https://example.invalid/'}}]}};
  const appEnterprise={pluginId:'ent-app',installed:true,name:'企业应用',
    ui:{contributions:[{slot:'workspace.navigation',source:{type:'external',url:'https://example.invalid/ent'}}]}};
  const plain={pluginId:'plain-one',installed:true,name:'普通插件',capabilities:{skills:[]}};
  const model=api.libraryModel({items:[app,appEnterprise,plain]},{source:'all',category:'',status:'',query:''},()=>true,()=>'ready');
  assert.deepEqual(model.items.map(item=>item.pluginId),['plain-one']);
  assert.equal(model.counts.all,1,'应用类插件不占用插件库计数');
  assert.equal(api.isWorkspaceApp(app)&&api.isWorkspaceApp(appEnterprise),true);
  assert.equal(api.isWorkspaceApp(plain),false);
});
