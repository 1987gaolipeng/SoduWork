'use strict';
const contract = require('../core/jiyong-contract.cjs');
const store = require('./app-settings-store.cjs');
function declaration(installed) { return installed.jiyong || installed.localDraft?.jiyong; }
async function data({item},request,deps) {
  const capability = ['data.batch','data.assetPut'].includes(request.method) ? 'data.write' : 'data.read';
  const {bound,installed,assertCurrent} = await require('./work-preview-app-connection.cjs').authorize(item,deps,capability);
  const schema = declaration(installed);
  if (!schema) throw Error('即用没有声明宿主数据结构');
  return require('./jiyong-data-access.cjs').request(deps,bound,installed,request.method,request.params,assertCurrent);
}
function parameters(bound,installed,action,input) {
  const raw = declaration(installed);
  if (!raw) return store[action](bound,input);
  const schema = contract.normalize(raw), options = store.normalize(input);
  const fields = new Map(schema.parameters.map(p => [p.key,p]));
  const selected = [...Object.keys(options.values || {}),...(options.remove || []),...(options.keys || []),...(options.secretKeys || [])];
  if (selected.some(k => !fields.has(k))) throw Error('即用参数未声明');
  if (action === 'update') {
    for (const [k,v] of Object.entries(options.values || {})) contract.value(fields.get(k),v);
    options.secretKeys = [...new Set([...options.secretKeys,...schema.parameters.filter(p => p.secret).map(p => p.key)])];
    // normalize expects remove/secretKeys even for no-op updates.
    store.update(bound,options);
  }
  const row = store.read(bound);
  const defaults = Object.fromEntries(schema.parameters.filter(p => Object.hasOwn(p,'default')).map(p => [p.key,p.default]));
  const secrets = [...new Set([...(row.secretKeys || []),...schema.parameters.filter(p => p.secret).map(p => p.key)])];
  return store.publicRecord({...row,values:{...defaults,...row.values},secretKeys:secrets},options);
}
module.exports = {data,parameters,declaration};
