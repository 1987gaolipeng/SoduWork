'use strict';
// Attribution is the existing portable manifest.author field. Editing it
// creates a version; it never mutates accepted resource bytes in place.
async function update({app,identityOf,pluginId,options}) {
  const personal=require('./personal-plugins'),source=require('./plugin-source-access');
  if (!options || (options.author != null && (typeof options.author!=='string' || !options.author.trim() || options.author.trim().length>120))) throw Error('请填写开发者（最多120字）');
  const installed=personal.get(app,pluginId);
  if (!installed.personal || installed.builtIn || installed.template!=='app' || !installed.localDraft) throw Error('只能修改本机即用的信息');
  if (options.expectedChecksum!==installed.checksum) throw Error('即用版本已变化，请重新打开设置');
  const store=require('./app-settings-store.cjs'),binding={pluginId,origin:require('../core/plugin-package-page.cjs').origin(pluginId)},owner=store.scope(binding);
  await source.check({app,identityOf,action:'edit',sourceIds:source.sourcesForIds(personal._read(app).plugins,[pluginId])});
  if (store.scope(binding)!==owner) throw Error('SoduWork 账号已变化');
  if (personal.get(app,pluginId).checksum!==installed.checksum) throw Error('即用版本已变化，请重新打开设置');
  const author=options.author == null ? installed.authorName : options.author.trim();
  const appCategory=options.appCategory == null ? installed.localDraft.appCategory : require('../core/plugin-app-contract.cjs').category(options.appCategory);
  if(author===installed.authorName && appCategory===installed.localDraft.appCategory)return{ok:true,plugin:installed};
  const saved=personal._read(app).plugins.find(p=>p.id===pluginId);
  const parts=v=>/^(\d+)\.(\d+)\.(\d+)/.exec(v).slice(1).map(BigInt);
  const highest=saved.versions.map(v=>parts(v.version)).sort((a,b)=>{for(let n=0;n<3;n++)if(a[n]!==b[n])return a[n]>b[n]?-1:1;return 0;})[0];
  const version=highest[0]+'.'+highest[1]+'.'+(highest[2]+1n);
  return personal.create(app,{...installed.localDraft,author,...(appCategory != null ? {appCategory} : {}),version});
}
module.exports={update};
