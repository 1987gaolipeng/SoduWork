const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
test('bundle fingerprints are read-only labels; actual approval attachments stay clickable',()=>{
 const window={SoduWorkAPI:{attachmentUrl:item=>'https://hub.example/attachments/'+item.id}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../components/panels/task-trace-view.js'),'utf8'),{window,SoduWorkAPI:window.SoduWorkAPI});
 const html=window.TaskTraceView.gateHtml({schemaVersion:'soduwork.gate/1.1',subject:{},criteria:[],requirements:[],evidence:[
  {id:'artifact:version:files',kind:'file',title:'Fixed bundle',url:''},
  {id:'8cd318b6-1614-4085-8c4d-81117c26eb92',attachmentId:'8cd318b6-1614-4085-8c4d-81117c26eb92',url:'/api/v1/attachments/8cd318b6-1614-4085-8c4d-81117c26eb92',kind:'file',title:'live-result.txt'}
 ]});
 assert.match(html,/<span>Fixed bundle<\/span>/);assert.doesNotMatch(html,/href="[^\"]*artifact:version/);
 assert.match(html,/<a href="https:\/\/hub.example\/attachments\/8cd318b6[^\"]*"[^>]*>live-result.txt<\/a>/);
 assert.match(html, /data-tfd-evidence-filename="live-result\.txt"/);
});

test('desktop file evidence uses native download and regular links still open externally', async () => {
  const calls = [];
  const window = {
    soduWorkAPI: {
      downloadAttachment: async ({ url, filename }) => {
        calls.push(['download', url, filename]);
        return { ok: true };
      },
      openExternal: async (url) => {
        calls.push(['external', url]);
        return { ok: true };
      },
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/panels/task-trace-view.js'), 'utf8'), { window });
  const file = 'https://hub.example/api/v1/attachments/8cd318b6-1614-4085-8c4d-81117c26eb92';
  const url = 'https://example.com/deliverable';
  await window.TaskTraceView.openEvidence({ href: file, dataset: { tfdEvidenceFilename: 'live-result.txt' } });
  await window.TaskTraceView.openEvidence({ href: url, dataset: {} });
  assert.deepEqual(calls, [['download', file, 'live-result.txt'], ['external', url]]);
});

test('legacy gate file evidence downloads by ID when its stored URL is missing, empty or null', async () => {
  const id = '8cd318b6-1614-4085-8c4d-81117c26eb92';
  const hub = 'https://hub.example';
  const calls = [];
  const window = {
    SoduWorkAPI: { attachmentUrl: item => hub + (item.url || '') },
    soduWorkAPI: { downloadAttachment: async payload => { calls.push({ ...payload }); return { ok: true }; } },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/panels/task-trace-view.js'), 'utf8'),
    { window, SoduWorkAPI: window.SoduWorkAPI });
  function render(file) {
    return window.TaskTraceView.gateHtml({ schemaVersion: 'soduwork.gate/1.1',
      criteria: [], requirements: [], subject: {}, evidence: [{ kind: 'file', title: 'legacy.txt', ...file }] });
  }
  for (const file of [{ attachmentId: id }, { attachmentId: id, url: '' }, { id, url: null }, { id }]) {
    const html = render(file);
    const anchor = html.match(/<a\b([^>]+)>legacy\.txt<\/a>/);
    assert.ok(anchor, 'legacy evidence is clickable');
    const attr = key => anchor[1].match(new RegExp(key + '="([^"]*)"'))?.[1];
    const href = attr('href');
    assert.equal(href, hub + '/api/v1/attachments/' + id);
    await window.TaskTraceView.openEvidence({ href, dataset: {
      tfdEvidenceFilename: attr('data-tfd-evidence-filename'), tfdAttachmentId: attr('data-tfd-attachment-id'),
    } });
    assert.deepEqual(calls.pop(), { attachmentId: id, filename: 'legacy.txt' });
  }
  assert.match(render({ id: 'artifact:version:files' }), /<span>legacy\.txt<\/span>/);
  const external = render({ url: 'https://example.com/result' });
  assert.match(external, /href="https:\/\/example\.com\/result"/);
  assert.doesNotMatch(external, /data-tfd-evidence-filename|data-tfd-attachment-id/);
});
