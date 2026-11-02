'use strict';

// Production capture and durable receipts cross the real isolated Hub HTTP API.
// Model execution is covered separately by agent-runtime-process.cjs.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');

module.exports = async function deliveryRoundtrip(hub, call, report) {
  assert.match(hub, /^http:\/\/127\.0\.0\.1:\d+$/);
  const enrollment = await fetch(hub + '/api/v1/clients/enroll', {method:'POST',
    headers:{'Content-Type':'application/json', 'X-Device-Key':'isolated-requirements-fixture-key-never-production'},
    body:JSON.stringify({device:'e2e-recipient', name:'Isolated delivery fixture'})});
  assert.equal(enrollment.status, 200);
  const {session} = await enrollment.json();
  assert.ok(session);
  const identity = {hub, clientId:'e2e-recipient', session};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-delivery-http-'));
  const cwd = path.join(root, 'work'); fs.mkdirSync(cwd);
  let receipts;
  try {
    const created = await call('/api/v1/tasks/native-delivery-roundtrip', 'recipient', 'PUT', {
      title:'Deliver a complete website', description:'Deliver a usable HTML page and its stylesheet.',
      status:'todo', triageStage:'ready', kind:'requirement', acceptanceCriteria:['Page includes its styling'],
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const request = async (_identity, route, body) => {
      const response = await fetch(hub + '/api/v1' + route, {method:'POST',
        headers:{Authorization:'Device ' + session, 'Content-Type':'application/json'}, body:JSON.stringify(body)});
      const data = await response.json();
      if (!response.ok) throw Object.assign(Error(JSON.stringify(data)), {status:response.status});
      return data;
    };
    receipts = require('../main/pi-session/start-receipts.cjs').create({
      app:{getPath:()=>root}, identityOf:async()=>identity, request, intervalMs:0,
    });
    const since = Date.now(), conversationId = 'native-delivery-roundtrip-chat';
    const handle = {cwd, sessionId:conversationId, snapshot:()=>({status:'idle', execution:{startedAt:since},
      tools:[{name:'browser_screenshot', state:'done', args:{filename:'final-proof.png'}}]}),
      outputSnapshot:()=>require('../main/pi-session/outputs').scan(cwd, since, since)};
    const turn = await require('../main/pi-session/task-input').prepare(identity, 'native-delivery-roundtrip',
      conversationId, 'native-delivery-turn', 'Build the page',
      {executionChoice:'native', agentId:'local:pi', submissionMode:'auto'},
      {app:{getPath:()=>root}, handle, startReceipts:receipts, identityOf:async()=>identity});
    await turn.beforeTurn(); await turn.onStarted();
    fs.writeFileSync(path.join(cwd, 'index.html'), '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body>Final page</body></html>');
    fs.writeFileSync(path.join(cwd, 'style.css'), 'body{color:purple}');
    fs.writeFileSync(path.join(cwd, 'final-proof.png'), 'Optional verification screenshot');
    const settled = await turn.afterTurn('completed');
    assert.equal(settled.pending, false);
    const task = (await call('/api/v1/tasks/native-delivery-roundtrip', 'recipient')).body;
    assert.equal(task.workRouting.conversationTurn.state, 'completed');
    assert.equal(task.workRouting.conversationTurn.conversationId, conversationId);
    const files = (await call('/api/v1/tasks/native-delivery-roundtrip/attachments', 'recipient')).body;
    assert.deepEqual(files.filter(file=>file.role==='output').map(file=>file.filename).sort(), ['index.html','style.css']);
    assert.equal(files.some(file=>file.filename==='final-proof.png'), false);
    assert.equal(task.requirementStage, 'reviewing');
    const acceptance = await call('/api/v1/tasks/native-delivery-roundtrip/acceptance-context', 'recipient');
    assert.equal(acceptance.status, 200, JSON.stringify(acceptance.body));
    assert.equal(acceptance.body.deliveryBundle.fileCount, 2);
    assert.equal(fs.readdirSync(path.join(root, 'task-start-receipts')).filter(name=>name.endsWith('.json')).length, 0);
    report.checks.push('Native turn capture uploads HTML and CSS through authenticated Hub HTTP before completion; verification screenshots stay excluded, and the same task enters review with a two-file archive');
  } finally {
    receipts?.dispose(); fs.rmSync(root, {recursive:true, force:true});
  }
};
