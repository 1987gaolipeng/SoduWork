'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const extensions=require('../core/plugin-extensions.cjs');
test('unknown versioned extension metadata remains portable through installation, author editing and re-export',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-extension-'));t.after(()=>fs.rmSync(root,{force:true,recursive:true}));
 const app={getPath:()=>root},personal=require('../main/personal-plugins'),metadata={ 'studio.example':{schemaVersion:99,unknown:{labels:['future',null,false],number:0}}};
 const body={template:'method',key:'extension-example',name:'Example',version:'0.1.0',author:'Studio',description:'Extension fixture',instructions:'Read the actual input.',extensions:metadata};
 const plugin=personal.create(app,body).plugin;assert.deepEqual(plugin.extensions,metadata);
 const edited=personal.create(app,{...plugin.localDraft,author:'即用实验室',version:'0.1.1'}).plugin;
 const file=path.join(root,'portable.soduwork-plugin');await personal.exportToFile(app,{showSaveDialog:async()=>({filePath:file})},edited.pluginId);
 const imported=require('../main/plugin-package-reader.cjs').readPersonalArchive(fs.readFileSync(file));assert.deepEqual(imported.extensions,metadata);assert.equal(imported.author,'即用实验室');
 assert.equal(Object.hasOwn(personal.preflight({...body,extensions:undefined}).manifest,'extensions'),false,'old packages do not acquire checksum-changing defaults');
});
test('extension metadata rejects executable/nonfinite/prototype/oversized values without discarding unknown valid fields',()=>{
 for(const raw of [{bad:()=>{}},{bad:[]},{bad:{n:Infinity}},{bad:{n:9007199254740992}},{bad:{text:'x'.repeat(17000)}},JSON.parse('{"bad":{"__proto__":{}}}')])assert.throws(()=>extensions.normalize(raw));
 const raw={future:{schemaVersion:23,custom:[1,true,null]}};const copy=extensions.normalize(raw);copy.future.custom.push('changed');assert.equal(raw.future.custom.length,3);
});
