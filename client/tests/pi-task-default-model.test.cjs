'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { pathToFileURL } = require('node:url');
const config = require('../main/pi-session/model-config');

test('real Pi history distinguishes omitted model from default and task turns resolve their own model', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-pi-task-model-'));
  const cwd = path.join(root, 'work'), agentDir = path.join(root, 'agent');
  fs.mkdirSync(cwd); fs.mkdirSync(agentDir);
  const requests = [], selections = [], refreshed = [];
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', value => raw += value);
    req.on('end', () => {
      const body = JSON.parse(raw); requests.push(body.model);
      res.writeHead(200, {'Content-Type':'text/event-stream'});
      res.write('data: ' + JSON.stringify({id:'fixture',object:'chat.completion.chunk',model:body.model,
        choices:[{index:0,delta:{role:'assistant',content:'Finished.'},finish_reason:null}]}) + '\n\n');
      res.end('data: ' + JSON.stringify({id:'fixture',object:'chat.completion.chunk',
        choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12}}) + '\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const sdk = await import(pathToFileURL(path.join(__dirname, '../node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href);
  const sessions = require('../main/pi-session/session');
  const create = sdk.ModelRuntime.create, oldPrepare = config.prepare, oldFetch = config.fetchSelection;
  const oldKey = process.env.SODUWORK_PROXY_KEY; process.env.SODUWORK_PROXY_KEY = 'fixture';
  let modelPath, session;
  const model = name => ({id:name || 'pi-default',label:name || 'Pi default',contextWindow:32000,input:['text'],
    quotaProvider:name === 'saved-model' ? 'provider-saved' : 'provider-default',
    key:'fixture',baseUrl:'http://127.0.0.1:' + server.address().port + '/v1',proxyExpiresAt:Date.now()+60000});
  config.prepare = async (_, _identity, name) => {
    selections.push(name); const next = model(name); modelPath = config.writeModels(agentDir, next);
    return {ok:true,provider:'soduwork',agentDir,model:next};
  };
  config.fetchSelection = async (_, name, _timeout, _fetch, force) => {
    if (force) refreshed.push(name);
    return {ok:true,model:model(name)};
  };
  sdk.ModelRuntime.create = () => create.call(sdk.ModelRuntime, {modelsPath:modelPath,authPath:path.join(agentDir,'auth.json')});
  t.after(async () => {
    if (session) await session.close();
    config.prepare=oldPrepare; config.fetchSelection=oldFetch; sdk.ModelRuntime.create=create;
    if (oldKey===undefined) delete process.env.SODUWORK_PROXY_KEY; else process.env.SODUWORK_PROXY_KEY=oldKey;
    server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));
    fs.rmSync(root,{recursive:true,force:true});
  });
  const archive = sdk.SessionManager.create(cwd, path.join(root, 'sessions'));
  archive.appendCustomEntry('soduwork.model.selection', {name:'saved-model'});
  archive.appendMessage({role:'assistant',content:[{type:'text',text:'Earlier result.'}],api:'openai-completions',
    provider:'soduwork',model:'saved-model',usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,
      cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()});
  const options = {app:{isPackaged:false,getPath:()=>root},identity:{},cwd,ref:'pi-model-review',
    resumePath:archive.getSessionFile(),resumeCwd:cwd,noExtensions:true};
  let opened = await sessions.open(options);
  assert.equal(opened.ok,true,opened.reason); session=opened.session;
  assert.equal(session.snapshot().modelSelection.name,'saved-model');
  const task = session.submit('Use the Agent default for this task.', [], {taskId:'fixture-task',modelName:''});
  const ordinary = session.submit('Then continue the ordinary conversation.', []);
  assert.equal((await task.completion).ok,true);
  assert.equal((await ordinary.completion).ok,true);
  assert.deepEqual(requests,['pi-default','saved-model']);
  assert.deepEqual(refreshed,['pi-default','saved-model'], 'ticket refresh belongs to the executing turn, not the future composer choice');
  assert.equal(session.snapshot().modelSelection.name,'saved-model');
  assert.deepEqual(session.snapshot().usageReceipts.map(row => [row.model,row.provider]),
    [['saved-model','soduwork'],['pi-default','provider-default'],['saved-model','provider-saved']],
    'new SDK calls retain resolved providers while historical usage remains synthetic');
  await session.close(); session=null;
  for (const choice of [{modelName:''}, {}]) {
    opened=await sessions.open({...options,...choice});
    assert.equal(opened.ok,true,opened.reason); session=opened.session;
    assert.equal(session.snapshot().modelSelection.name,'');
    assert.equal(session.snapshot().modelSelection.activeModel.id,'pi-default');
    assert.deepEqual(session.snapshot().usageReceipts.map(row => row.provider),
      ['soduwork','provider-default','provider-saved'], 'archived provider attribution survives reopening');
    await session.close();session=null;
  }
  assert.deepEqual(selections,['saved-model','','']);
  const entries=sdk.SessionManager.open(archive.getSessionFile()).getEntries();
  assert.deepEqual(entries.filter(row => row.type === 'message' && row.message.role === 'assistant')
    .map(row => row.message.usageProvider), [undefined,'provider-default','provider-saved']);
  assert.equal(entries.filter(row=>row.customType==='soduwork.model.selection').at(-1).data.name,'');
});
