const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
test('bundle fingerprints are read-only labels; actual approval attachments stay clickable',()=>{
 const window={SoduWorkAPI:{attachmentUrl:item=>'https://hub.example/attachments/'+item.id}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../components/panels/task-trace-view.js'),'utf8'),{window,SoduWorkAPI:window.SoduWorkAPI});
 const html=window.TaskTraceView.gateHtml({schemaVersion:'soduwork.gate/1.1',subject:{},criteria:[],requirements:[],evidence:[
  {id:'artifact:version:files',kind:'file',title:'Fixed bundle',url:''},
  {id:'8cd318b6-1614-4085-8c4d-81117c26eb92',attachmentId:'8cd318b6-1614-4085-8c4d-81117c26eb92',kind:'file',title:'live-result.txt'}
 ]});
 assert.match(html,/<span>Fixed bundle<\/span>/);assert.doesNotMatch(html,/href="[^\"]*artifact:version/);
 assert.match(html,/<a href="https:\/\/hub.example\/attachments\/8cd318b6[^\"]*"[^>]*>live-result.txt<\/a>/);
});
