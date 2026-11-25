'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const certificates = require('../helpers/device-peer-fixture.cjs').certificates;
const sharedHistory = require('../../main/conversation/shared-history.cjs');
const replica = require('../../main/conversation/replica-store.cjs');
const transferFactory = require('../../main/conversation/device-transfer.cjs');
const tlsPeer = require('../../main/device-peer/transport.cjs');
const accountScope = require('../../main/platform-connections/runtime.cjs').scope;
const SID = 'pipeline-native-chat';
function identity(device) {
  const now = Math.floor(Date.now() / 1000);
  return { hub: 'https://peer.invalid', clientId: device, session: Buffer.from(JSON.stringify({
    typ: 'device', cid: device, uid: 'peer-owner', iat: now, exp: now + 1800, jti: device,
  })).toString('base64url') + '.' + 'a'.repeat(64) };
}
function devices(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix)), closers = [];
  t.after(async () => {
    const results = await Promise.allSettled(closers.map(close => close()));
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, endpoint: (...args) => createEndpoint(root, closers, ...args) };
}
function createEndpoint(root, closers, name, source, expectedSources = [source ? 'peer-target' : 'peer-source']) {
  const profile = path.join(root, name), workspace = path.join(root, name + '-work');
  fs.mkdirSync(profile, { recursive: true }); fs.mkdirSync(workspace, { recursive: true });
  const app = { getPath: () => profile }, id = identity(name), archive = path.join(profile, 'pi-agent', 'sessions', SID + '.jsonl');
  const row = { id: SID, adapterId: 'pi', title: 'Pipeline history', path: archive, cwd: workspace,
    at: 1710000000000, createdAt: '2024-03-09T16:00:00Z', count: 2, status: 'idle',
    taskId: 'requirement-retained', taskIds: ['requirement-retained'], activeTaskId: 'requirement-retained',
    creator: { hub: id.hub, account: 'peer-owner' }, workOwner: accountScope(id) };
  const nativeRows = new Map(source ? [[SID, row]] : []);
  let live = source ? { sessionId: SID, ref: 'ref-source', adapterId: 'pi', cwd: workspace,
    inFlight: () => false, on: () => () => {}, snapshot: () => ({ status: 'idle', messages: [], tools: [] }),
    historyRow: () => ({ ...row, live: true }), async close() { live = null; return true; } } : null;
  const session = {
    findBySessionId: requested => requested === SID ? live : null,
    historyEntry: async (_app, requested) => nativeRows.has(requested) && fs.existsSync(nativeRows.get(requested).path)
      ? { ok: true, entry: nativeRows.get(requested) } : { ok: false, notFound: true },
    archivedConversation: async (_app, requested) => source && requested === SID ? row : null,
    history: async () => ({ ok: true, chats: source ? [row] : [] }), archivedHistory: async () => ({ ok: true, chats: [] }),
    availableRuntimes: async () => ({ ok: true, availableRuntimes: [{ id: 'pi' }] }),
  };
  const history = sharedHistory.create({ app, session, identityOf: () => id, workRoot: () => root,
    store: replica.createWorker(path.join(profile, 'conversation-replicas', 'history.sqlite')) });
  const certificate = certificates()[name], remembered = [];
  let transfer, accepted = 0;
  const peer = tlsPeer.create({ identityOf: () => ({ ...certificate, privateKey: crypto.createPrivateKey(certificate.privateKey) }),
    confirmPair: async () => true, trustedPeers: () => remembered, rememberPeer: (_identity, value) => remembered.push(value),
    handlers: Object.fromEntries(['offer', 'chunk', 'prepare', 'grant', 'abort'].map(operation => [
      'migration.' + operation, (args, remote) => transfer.receive({ peer: remote, operation, args }),
    ])) });
  const makeTransfer = () => transferFactory.create({ app, identityOf: () => id, history, session, peer,
    confirmReceive: async input => { accepted++; assert.ok(expectedSources.includes(input.sourceDeviceId)); return true; } });
  transfer = makeTransfer();
  closers.push(async () => {
    try { await peer.dispose(); }
    finally { try { transfer.close(); } finally { await history.close(); } }
  });
  return { app, row, id, archive, workspace, history, session, peer, get transfer() { return transfer; }, handle: () => live,
    restartTransfer() { transfer.close(); transfer = makeTransfer(); },
    setHandle: handle => { live = handle; }, nativeRows, accepts: () => accepted };
}

test('real TLS transfers production Pi history and selected files into a durable isolated device workspace', async t => {
  const { endpoint } = devices(t, 'soduwork-transfer-pipeline-');
  const source = endpoint('peer-source', true), target = endpoint('peer-target', false);
  fs.mkdirSync(path.dirname(source.archive), { recursive: true });
  const entries = [
    { type: 'session', id: SID, timestamp: '2024-03-09T16:00:00Z', cwd: source.workspace },
    { type: 'message', id: 'message-user', timestamp: '2024-03-09T16:00:01Z', message: { role: 'user', content: 'Preserve this original request.' } },
    { type: 'message', id: 'message-assistant', timestamp: '2024-03-09T16:00:02Z', message: { role: 'assistant', content: [
      { type: 'text', text: 'The original answer is retained.' },
      { type: 'toolCall', id: 'tool-read-chosen', name: 'read', arguments: { path: 'chosen.txt' } },
    ] } },
    { type: 'message', id: 'message-tool', timestamp: '2024-03-09T16:00:03Z', message: { role: 'toolResult',
      toolCallId: 'tool-read-chosen', toolName: 'read', isError: false,
      content: [{ type: 'text', text: 'Explicitly selected output.' }] } },
  ];
  fs.writeFileSync(source.archive, entries.map(row => JSON.stringify(row)).join('\n') + '\n');
  fs.writeFileSync(path.join(source.workspace, 'chosen.txt'), 'Explicitly selected output.');
  fs.writeFileSync(path.join(source.workspace, 'not-selected.txt'), 'This stays on the source.');
  fs.writeFileSync(path.join(source.workspace, '.env'), 'SYNTHETIC_VALUE=not-a-secret');
  await source.history.projectRows([source.row]);
  await source.history.backfill(SID);
  source.history.observe(source.handle(), source.id);
  const exported = await source.history.exportPortable(SID);
  assert.equal(exported.coverage.complete, true);
  assert.equal(exported.snapshot.tools.length, 1);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal((await source.history.exportPortable(SID)).sha256, exported.sha256, 'unchanged production native history exports deterministically');
  assert.deepEqual(exported.snapshot.messages.map(row => row.text), ['Preserve this original request.', 'The original answer is retained.']);
  await target.peer.listen({ host: '127.0.0.1', port: 0 });
  const offer = target.peer.createPairingOffer();
  await source.peer.connect({ endpoint: offer.endpoints[0], offer: offer.offer, expectedDeviceId: offer.deviceId });
  const preview = await source.transfer.preview({ sessionId: SID, targetDeviceId: 'peer-target' });
  assert.ok(preview.files.some(row => row.path === 'chosen.txt')); assert.equal(preview.files.some(row => row.path === '.env'), false);
  const completed = await source.transfer.start({ ...preview, selectedPaths: ['chosen.txt'] });
  assert.equal(completed.state, 'done'); assert.equal(target.accepts(), 1);
  assert.equal(source.handle(), null); assert.equal(source.transfer.blocked(SID), true); assert.equal(target.transfer.blocked(SID), false);
  assert.throws(() => source.transfer.admit(SID), /执行权/);
  const imported = await target.history.resolve(SID);
  assert.equal(imported.id, SID); assert.equal(imported.cached, false); assert.equal(imported.taskId, 'requirement-retained');
  assert.deepEqual(imported.taskIds, ['requirement-retained']);
  assert.ok(imported.cwd.startsWith(path.join(target.app.getPath('userData'), 'device-transfers', 'workspaces') + path.sep));
  assert.equal(fs.readFileSync(path.join(imported.cwd, 'chosen.txt'), 'utf8'), 'Explicitly selected output.');
  assert.equal(fs.existsSync(path.join(imported.cwd, 'not-selected.txt')), false);
  assert.equal(fs.existsSync(path.join(imported.cwd, '.env')), false);
  const prepared = await target.history.prepareContinuation(SID);
  assert.deepEqual(prepared.prefix.messages.map(row => row.text), exported.snapshot.messages.map(row => row.text));
  assert.deepEqual(prepared.prefix.tools, exported.snapshot.tools);
  assert.equal(prepared.historyRecovery.nativeArchiveMissing, true);
  const view = await source.history.open(SID);
  assert.equal(view.localReplica, true); assert.equal((await view.send('must stay read only')).accepted, false);
  assert.deepEqual(view.snapshot().messages.map(row => row.text), exported.snapshot.messages.map(row => row.text));
  assert.equal(fs.readFileSync(source.archive, 'utf8'), entries.map(row => JSON.stringify(row)).join('\n') + '\n');
  // Simulate a completed new native segment after the production continuation
  // preparation. No model is involved; the real segment index and archive reader
  // must retain the imported prefix when this device transfers ownership back.
  const childId = 'target-new-native-segment', childPath = path.join(target.app.getPath('userData'), 'pi-agent', 'sessions', childId + '.jsonl');
  fs.mkdirSync(path.dirname(childPath), { recursive: true });
  fs.writeFileSync(childPath, [
    { type: 'session', id: childId, timestamp: '2024-03-09T16:01:00Z', cwd: imported.cwd },
    { type: 'message', id: 'target-reply', timestamp: '2024-03-09T16:01:01Z', message: { role: 'assistant', content: 'A new reply on the receiving device.' } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  target.nativeRows.set(childId, { ...imported, id: childId, path: childPath, count: 1 });
  await require('../../main/conversation/runtime-segments').save(target.app, { version: 1, id: SID,
    owner: accountScope(target.id), hub: target.id.hub, cwd: imported.cwd, segments: [],
    active: { sessionId: childId, adapterId: 'pi', path: childPath }, prefix: prepared.prefix,
    deviceHistoryComplete: true, deviceTransferId: imported.deviceTransferId });
  const child = { sessionId: SID, ref: 'target-ref', adapterId: 'pi', cwd: imported.cwd,
    inFlight: () => false, on: () => () => {}, snapshot: () => ({ ...prepared.prefix, status: 'idle' }),
    historyRow: () => ({ ...imported, path: childPath, count: 3 }), async close() { target.setHandle(null); return true; } };
  target.setHandle(child);
  await target.history.projectRows([child.historyRow()]); await target.history.backfill(SID);
  target.history.observe(child, target.id);
  const continued = await target.history.exportPortable(SID);
  assert.equal(continued.snapshot.messages.length, 3);
  const returning = await target.transfer.preview({ sessionId: SID, targetDeviceId: 'peer-source' });
  const returned = await target.transfer.start({ ...returning, selectedPaths: ['chosen.txt'] });
  assert.equal(returned.state, 'done'); assert.equal(source.accepts(), 1);
  assert.equal(source.transfer.blocked(SID), false); assert.equal(target.transfer.blocked(SID), true);
  const back = await source.history.prepareContinuation(SID);
  assert.deepEqual(back.prefix.messages.map(row => row.text), continued.snapshot.messages.map(row => row.text));
  assert.deepEqual(back.prefix.tools, exported.snapshot.tools, 'returning history retains the original tool receipt exactly once');
  assert.notEqual(back.row.cwd, source.workspace);
  assert.equal((await source.history.exportPortable(SID)).snapshot.messages.length, 3,
    'the original native archive cannot overwrite the returned device history');
  // Reopen the actual SQLite history after losing the synthetic native segment.
  await target.history.close();
  fs.unlinkSync(childPath);
  const reopened = sharedHistory.create({ app: target.app, session: target.session, identityOf: () => target.id,
    store: replica.createWorker(path.join(target.app.getPath('userData'), 'conversation-replicas', 'history.sqlite')) });
  try {
    assert.deepEqual((await reopened.prepareContinuation(SID)).prefix.messages.map(row => row.text), continued.snapshot.messages.map(row => row.text));
    assert.equal((await reopened.resolve(SID)).activeTaskId, 'requirement-retained');
  } finally { await reopened.close(); }
});

async function connectDevices(source, target) {
  await target.peer.listen({host:'127.0.0.1',port:0});
  const offer = target.peer.createPairingOffer();
  await source.peer.connect({endpoint:offer.endpoints[0],offer:offer.offer,expectedDeviceId:offer.deviceId});
}
async function continueOnDevice(device, label) {
  const prepared = await device.history.prepareContinuation(SID), imported = prepared.row;
  const childId = label + '-native-segment', childPath = path.join(device.app.getPath('userData'),'pi-agent','sessions',childId+'.jsonl');
  fs.mkdirSync(path.dirname(childPath),{recursive:true});
  fs.writeFileSync(childPath,[
    {type:'session',id:childId,timestamp:'2024-03-09T16:10:00Z',cwd:imported.cwd},
    {type:'message',id:label+'-reply',timestamp:'2024-03-09T16:10:01Z',message:{role:'assistant',content:label+' completed reply'}},
  ].map(value=>JSON.stringify(value)).join('\n')+'\n');
  device.nativeRows.set(childId,{...imported,id:childId,path:childPath,count:1});
  await require('../../main/conversation/runtime-segments').save(device.app,{version:1,id:SID,
    owner:accountScope(device.id),hub:device.id.hub,cwd:imported.cwd,segments:[],
    active:{sessionId:childId,adapterId:'pi',path:childPath},prefix:prepared.prefix,
    deviceHistoryComplete:true,deviceTransferId:imported.deviceTransferId});
  const handle = {sessionId:SID,ref:label+'-ref',adapterId:'pi',cwd:imported.cwd,
    inFlight:()=>false,on:()=>()=>{},snapshot:()=>({...prepared.prefix,status:'idle'}),
    historyRow:()=>({...imported,path:childPath,count:prepared.prefix.messages.length+1}),
    async close() { device.setHandle(null); return true; }};
  device.setHandle(handle);
  await device.history.projectRows([handle.historyRow()]); await device.history.backfill(SID);
  device.history.observe(handle,device.id);
  return device.history.exportPortable(SID);
}

test('three real TLS desktops return A to B to C to A while B is offline, anchored to A durable lost-ack release',async t=>{
  const { endpoint } = devices(t, 'soduwork-transfer-cycle-');
  const A = endpoint('peer-source',true,['peer-third']);
  const B = endpoint('peer-target',false,['peer-source']);
  const C = endpoint('peer-third',false,['peer-target']);
  fs.mkdirSync(path.dirname(A.archive),{recursive:true});
  const native = [
    {type:'session',id:SID,timestamp:'2024-03-09T16:00:00Z',cwd:A.workspace},
    {type:'message',id:'initial-user',timestamp:'2024-03-09T16:00:01Z',message:{role:'user',content:'Keep one requirement across my devices.'}},
    {type:'message',id:'initial-assistant',timestamp:'2024-03-09T16:00:02Z',message:{role:'assistant',content:[
      {type:'text',text:'Initial completed work.'},{type:'toolCall',id:'already-finished-tool',name:'read',arguments:{path:'work.txt'}}]}},
    {type:'message',id:'initial-tool',timestamp:'2024-03-09T16:00:03Z',message:{role:'toolResult',
      toolCallId:'already-finished-tool',toolName:'read',isError:false,content:[{type:'text',text:'original tool receipt'}]}},
  ].map(value=>JSON.stringify(value)).join('\n')+'\n';
  fs.writeFileSync(A.archive,native); fs.writeFileSync(path.join(A.workspace,'work.txt'),'selected workspace data');
  await A.history.projectRows([A.row]); await A.history.backfill(SID); A.history.observe(A.handle(),A.id);
  const initialTools = (await A.history.exportPortable(SID)).snapshot.tools;
  assert.equal(initialTools.length,1);
  assert.match(JSON.stringify(initialTools),/original tool receipt/);
  await connectDevices(A,B);
  const first = await A.transfer.preview({sessionId:SID,targetDeviceId:B.id.clientId});
  const requestA = A.peer.request;
  A.peer.request = async input => { const result = await requestA(input); if (input.method === 'migration.grant') throw Error('synthetic lost acknowledgement'); return result; };
  await assert.rejects(A.transfer.start({...first,selectedPaths:['work.txt']}),/lost acknowledgement/);
  A.peer.request = requestA;
  assert.equal((await A.transfer.status(first)).state,'released');
  const chain = require('../../main/conversation/device-transfer-lineage.cjs');
  const releasedJournal = require('../../main/conversation/device-transfer-store.cjs').open(A.app);
  let originalSignature, replacementSignature;
  try {
    originalSignature = releasedJournal.get(first.operationId).proof;
    replacementSignature = crypto.sign('sha256',Buffer.from('soduwork-device-grant/v1\0'+chain.text(
      releasedJournal.lineage(first.operationId).grant)),certificates()['peer-source'].privateKey).toString('base64');
  } finally { releasedJournal.close(); }
  assert.notEqual(replacementSignature,originalSignature);
  await assert.rejects(A.peer.request({peerId:B.id.clientId,method:'migration.grant',
    params:{operationId:first.operationId,signature:replacementSignature}}),/交权凭证/);
  const acceptedJournal = require('../../main/conversation/device-transfer-store.cjs').open(B.app);
  try { assert.equal(acceptedJournal.get(first.operationId).proof,originalSignature); }
  finally { acceptedJournal.close(); }
  A.restartTransfer();
  assert.equal(A.transfer.blocked(SID),true);
  const secondHistory = await continueOnDevice(B,'second-device');
  assert.equal(secondHistory.snapshot.messages.length,3);
  assert.deepEqual(secondHistory.snapshot.tools,initialTools);
  await connectDevices(B,C);
  const second = await B.transfer.preview({sessionId:SID,targetDeviceId:C.id.clientId});
  assert.equal((await B.transfer.start({...second,selectedPaths:['work.txt']})).state,'done');
  const finalHistory = await continueOnDevice(C,'third-device');
  assert.equal(finalHistory.snapshot.messages.length,4);
  assert.deepEqual(finalHistory.snapshot.tools,initialTools);
  C.restartTransfer();
  await B.peer.stop();
  assert.equal(B.peer.peers().length,0);
  await connectDevices(C,A);
  const before = await A.history.exportPortable(SID), confirmations = A.accepts();
  const requestC = C.peer.request;
  // A validly signed alternate branch must not replace A's actual durable release.
  for (const forgery of ['changed-key','alternate-signed-release']) {
    C.peer.request = async input => {
      if (input.method !== 'migration.offer') return requestC(input);
      const value = structuredClone(input), proof = value.params.lineage;
      if (forgery === 'changed-key') proof.ancestors[0].targetKey = proof.grant.sourceKey;
      else {
        const {signature:oldSignature,previous:oldPrevious,...oldFields} = proof.ancestors[0];
        const alternate = chain.draft({...oldFields,
          target:C.id.clientId,targetKey:proof.grant.sourceKey,op:crypto.randomUUID()},[]);
        const signature = crypto.sign('sha256',Buffer.from('soduwork-device-grant/v1\0'+chain.text(alternate)),
          certificates()['peer-source'].privateKey).toString('base64');
        const link = chain.signed(alternate,signature);
        proof.ancestors = [link];
        proof.grant = {...proof.grant,gen:2,previous:chain.hash(link)};
        value.params.gen = 2;
      }
      return requestC(value);
    };
    const attempt = await C.transfer.preview({sessionId:SID,targetDeviceId:A.id.clientId});
    await assert.rejects(C.transfer.start({...attempt,selectedPaths:['work.txt']}),/交权链/);
    assert.ok(C.handle()); assert.equal(C.transfer.blocked(SID),false);
    assert.equal(A.accepts(),confirmations);
    assert.equal((await A.history.exportPortable(SID)).sha256,before.sha256);
    assert.equal(A.transfer.blocked(SID),true);
  }
  C.peer.request = requestC;
  const returning = await C.transfer.preview({sessionId:SID,targetDeviceId:A.id.clientId});
  assert.equal((await C.transfer.start({...returning,selectedPaths:['work.txt']})).state,'done');
  assert.equal(A.transfer.blocked(SID),false); assert.equal(B.transfer.blocked(SID),true); assert.equal(C.transfer.blocked(SID),true);
  assert.equal((await A.transfer.status(first)).state,'done');
  assert.equal(A.accepts(),confirmations+1);
  const restored = await A.history.prepareContinuation(SID);
  assert.equal(restored.row.taskId,'requirement-retained');
  assert.equal(restored.row.activeTaskId,'requirement-retained');
  assert.deepEqual(restored.prefix.messages.map(value=>value.text),finalHistory.snapshot.messages.map(value=>value.text));
  assert.deepEqual(restored.prefix.tools,initialTools);
  assert.equal(fs.readFileSync(path.join(restored.row.cwd,'work.txt'),'utf8'),'selected workspace data');
  assert.equal(fs.readFileSync(A.archive,'utf8'),native);
  const journal = require('../../main/conversation/device-transfer-store.cjs').open(A.app);
  try {
    const saved = journal.lineage(returning.operationId);
    assert.equal(saved.ancestors.length,2);
    assert.equal(saved.grant.gen,3);
    assert.equal(saved.grant.source,C.id.clientId);
    assert.equal(saved.grant.target,A.id.clientId);
  } finally { journal.close(); }
});


test('direct migration restores only selected archived output and rebuilds its grant on the receiver', async t => {
  const { root, endpoint } = devices(t, 'device-artifact-handoff-');
  const source = endpoint('peer-source', true), target = endpoint('peer-target', false);
  for (const field of ['taskId', 'taskIds', 'activeTaskId']) delete source.row[field];
  const attachment = require('../../main/pi-session/attachment-contract');
  const stage = path.join(root, 'temp', source.handle().ref, '.soduwork-inputs');
  fs.mkdirSync(stage, { recursive: true });
  const input = path.join(stage, 'chosen-input.txt'), outside = path.join(root, 'other-session.txt');
  fs.writeFileSync(input, 'stage');
  fs.writeFileSync(path.join(stage, 'unreferenced.txt'), 'other');
  fs.writeFileSync(outside, 'other');
  const prompt = attachment.augment('Create the fixtures.', [
    { name: 'chosen-input.txt', path: input, size: 5 }, { name: 'other-session.txt', path: outside, size: 5 } ]);
  fs.mkdirSync(path.dirname(source.archive), { recursive: true });
  fs.writeFileSync(source.archive, [
    { type: 'session', id: SID, cwd: source.workspace },
    { type: 'message', id: 'u', message: { role: 'user', content: prompt } },
    { type: 'message', id: 'a', message: { role: 'assistant', content: 'Complete.' } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  const outputs = ['chosen.md', 'not-chosen.md'].map(name => {
    const bytes = Buffer.from('Archived ' + name);
    fs.writeFileSync(path.join(source.workspace, name), bytes);
    return { action: 'created', path: name, after: { exists: true, path: name, size: bytes.length,
      hash: crypto.createHash('sha256').update(bytes).digest('hex') } };
  });
  await source.history.projectRows([source.row]);
  await source.history.backfill(SID, { journal: { cwd: fs.realpathSync(source.workspace), turnId: 'captured', files: outputs } });
  source.history.observe(source.handle(), source.id);
  assert.equal((await source.history.transferSources(SID)).length, 2);
  fs.rmSync(source.workspace, { recursive: true });
  await target.peer.listen({ host: '127.0.0.1', port: 0 });
  const offer = target.peer.createPairingOffer();
  await source.peer.connect({ endpoint: offer.endpoints[0], offer: offer.offer, expectedDeviceId: offer.deviceId });
  const preview = await source.transfer.preview({ sessionId: SID, targetDeviceId: 'peer-target' });
  const staged = preview.files.find(file => file.path.endsWith('/chosen-input.txt'))?.path;
  assert.ok(staged);
  assert.deepEqual(preview.files.map(file => file.path).sort(), [...outputs.map(file => file.path), staged].sort());
  assert.equal((await source.transfer.start({ ...preview, selectedPaths: ['chosen.md', staged] })).state, 'done');
  const row = await target.history.resolve(SID), saved = await target.history.store.deviceHistory(SID);
  assert.equal(fs.readFileSync(path.join(row.cwd, staged), 'utf8'), 'stage');
  const attached = saved.snapshot.messages[0].attachments;
  assert.equal(attachment.previewPath(attached[0].previewRef), path.join(row.cwd, staged));
  assert.equal(attached[1].availability, 'missing');
  assert.equal(saved.localArtifactHistory.transferId, row.deviceTransferId);
  assert.equal(fs.readFileSync(path.join(row.cwd, 'chosen.md'), 'utf8'), 'Archived chosen.md');
  assert.equal(fs.existsSync(path.join(row.cwd, 'not-chosen.md')), false);
  assert.equal(JSON.stringify(saved.localArtifactHistory).includes(source.workspace), false);
  fs.unlinkSync(path.join(row.cwd, 'chosen.md'));
  const restored = await target.history.open(SID, { historyPreview: true });
  const result = await restored.historyArtifacts.snapshotAsync();
  assert.deepEqual(result.items.map(file => file.relative), ['chosen.md']);
  const relative = path.relative(fs.realpathSync.native(target.app.getPath('userData')), fs.realpathSync.native(result.items[0].path));
  assert.equal(relative.split(path.sep)[0], 'conversation-artifacts');
  assert.equal(fs.readFileSync(result.items[0].path, 'utf8'), 'Archived chosen.md');
  const third = endpoint('peer-third', false, ['peer-target']);
  await continueOnDevice(target, 'artifact-receiver');
  await connectDevices(target, third);
  const next = await target.transfer.preview({ sessionId: SID, targetDeviceId: third.id.clientId });
  assert.equal((await target.transfer.start({ ...next, selectedPaths: ['chosen.md', staged] })).state, 'done');
  const final = await third.history.store.deviceHistory(SID);
  const thirdCwd = (await third.history.resolve(SID)).cwd;
  assert.equal(attachment.previewPath(final.snapshot.messages[0].attachments[0].previewRef), path.join(thirdCwd, staged));
  assert.equal(fs.readFileSync(path.join(thirdCwd, 'chosen.md'), 'utf8'), 'Archived chosen.md');
});

async function ordinarySource(endpoint) {
  const peer = endpoint('peer-source', true);
  for (const field of ['taskId', 'taskIds', 'activeTaskId']) delete peer.row[field];
  fs.mkdirSync(path.dirname(peer.archive), { recursive: true });
  fs.writeFileSync(peer.archive, [
    { type: 'session', id: SID, cwd: peer.workspace },
    { type: 'message', id: 'user', message: { role: 'user', content: 'Create a website.' } },
    { type: 'message', id: 'reply', message: { role: 'assistant', content: 'Complete.' } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  await peer.history.projectRows([peer.row]); await peer.history.backfill(SID);
  peer.history.observe(peer.handle(), peer.id);
  return peer;
}

async function recordOutputs(device, cwd, values) {
  const entries = Object.entries(values).map(([name, text]) => {
    const file = path.join(cwd, name);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
    return { action: 'created', path: name, after: { path: name, exists: true,
      size: Buffer.byteLength(text), hash: crypto.createHash('sha256').update(text).digest('hex') } };
  });
  await device.history.backfill(SID, { journal: { cwd, files: entries, turnId: crypto.randomUUID() } });
}

test('a text-only handoff preserves new receiver outputs for the next handoff after its workspace moves', async t => {
  const { endpoint } = devices(t, 'receiver-artifact-turn-');
  const A = await ordinarySource(endpoint), B = endpoint('peer-target', false);
  const C = endpoint('peer-third', false, ['peer-target']);
  await connectDevices(A, B);
  const first = await A.transfer.preview({sessionId: SID, targetDeviceId: B.id.clientId});
  assert.equal((await A.transfer.start({...first, selectedPaths: []})).state, 'done');
  const original = await B.history.store.deviceHistory(SID);
  assert.equal(original.localArtifactHistory, undefined);
  await continueOnDevice(B, 'new-owner');
  const row = await B.history.resolve(SID);
  fs.writeFileSync(path.join(row.cwd, 'outside-receipt.md'), 'never selected');
  await recordOutputs(B, row.cwd, { 'new-output.md': 'written on B', '.soduwork/evidence/new.png': 'image fixture' });
  const saved = await B.history.store.deviceHistory(SID);
  assert.equal(saved.localArtifactHistory?.transferId, row.deviceTransferId);
  fs.renameSync(row.cwd, row.cwd + '-moved');
  const onB = await B.history.open(SID, { historyPreview: true });
  assert.deepEqual((await onB.historyArtifacts.snapshotAsync()).items.map(file => file.relative).sort(),
    ['.soduwork/evidence/new.png', 'new-output.md']);
  await connectDevices(B, C);
  const next = await B.transfer.preview({sessionId: SID, targetDeviceId: C.id.clientId});
  const selected = ['conversation-evidence/new.png', 'new-output.md'];
  assert.deepEqual(next.files.map(file => file.path).sort(), selected);
  assert.equal((await B.transfer.start({...next, selectedPaths: selected})).state, 'done');
  const third = await C.history.resolve(SID);
  assert.equal(fs.readFileSync(path.join(third.cwd, selected[0]), 'utf8'), 'image fixture');
  assert.equal(fs.readFileSync(path.join(third.cwd, selected[1]), 'utf8'), 'written on B');
  assert.equal(fs.existsSync(path.join(third.cwd, 'outside-receipt.md')), false);
});

test('a changed website and its archived original can migrate together with a single selection per shared resource', async t => {
  const { endpoint } = devices(t, 'historical-tree-choice-');
  const A = await ordinarySource(endpoint), B = endpoint('peer-target', false);
  const original = '<link rel="stylesheet" href="assets/style.css">OLD';
  const edited = original.replace('OLD', 'NEW');
  await recordOutputs(A, A.workspace, { 'index.html': original, 'assets/style.css': 'html{}' });
  fs.writeFileSync(path.join(A.workspace, 'index.html'), edited);
  await connectDevices(A, B);
  const request = { sessionId: SID, targetDeviceId: B.id.clientId };
  fs.mkdirSync(path.join(A.workspace, 'Conversation-History'));
  fs.writeFileSync(path.join(A.workspace, 'Conversation-History', 'index.html'), 'unrelated');
  await assert.rejects(A.transfer.preview(request), /conversation-history/);
  fs.rmSync(path.join(A.workspace, 'Conversation-History'), { recursive: true });
  const first = await A.transfer.preview(request), files = first.files;
  assert.deepEqual(files.map(f => f.path).sort(), ['assets/style.css', 'conversation-history/index.html', 'index.html']);
  assert.equal(files.find(f => f.path === 'assets/style.css').historyAlias, 'conversation-history/assets/style.css');
  assert.equal((await A.transfer.start({...first, selectedPaths: files.map(f => f.path)})).state, 'done');
  const cwd = (await B.history.resolve(SID)).cwd;
  assert.equal(fs.readFileSync(path.join(cwd, 'index.html'), 'utf8'), edited);
  assert.equal(fs.readFileSync(path.join(cwd, 'conversation-history/index.html'), 'utf8'), original);
  for (const prefix of ['', 'conversation-history/']) assert.equal(fs.readFileSync(path.join(cwd, prefix + 'assets/style.css'), 'utf8'), 'html{}');
  fs.renameSync(cwd, cwd + '-moved');
  const view = await B.history.open(SID, { historyPreview: true });
  const artifact = (await view.historyArtifacts.snapshotAsync()).items.find(f => f.kind === 'website');
  assert.equal(artifact.relative, 'conversation-history/index.html');
  assert.equal(fs.readFileSync(artifact.path, 'utf8'), original);
  assert.equal(fs.readFileSync(path.join(path.dirname(artifact.path), 'assets/style.css'), 'utf8'), 'html{}');
});
