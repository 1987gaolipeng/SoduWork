'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const diagnostics = require('../main/requirement-diagnostics.cjs');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'requirement-diagnostics-test-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  return dir;
}
test('disabled diagnostics create no files; enabled records are correlated but exclude content and secrets', t => {
  const dir = fixture(t);
  const off = diagnostics.create({directory:dir, enabled:false});
  off.record('native.send', {taskId:'private-task'});
  assert.deepEqual(fs.readdirSync(dir), []);
  const log = diagnostics.create({directory:dir, enabled:true});
  const data = {taskId:'private-task', conversationId:'private-chat', title:'PRIVATE TITLE',
    text:'PRIVATE TEXT', secret:'PRIVATE SECRET', status:'doing', reason:'PRIVATE ERROR', fileCount:1};
  log.record('native.send', data); log.record('native.terminal', data);
  const text = fs.readFileSync(log.file, 'utf8'), rows = text.trim().split('\n').map(JSON.parse);
  assert.doesNotMatch(text, /PRIVATE|private-task|private-chat/);
  assert.equal(rows[0].taskId, rows[1].taskId);
  assert.equal(rows[0].status, 'doing'); assert.equal(rows[0].fileCount, 1);
});
test('bounded files and unwritable destinations never interrupt execution', t => {
  const dir = fixture(t), log = diagnostics.create({directory:dir, enabled:true, maxBytes:512});
  for(let i=0;i<100;i++) log.record('native.send', {taskId:'task',fileCount:i});
  assert.ok(fs.statSync(log.file).size <= 512);
  assert.match(fs.readFileSync(log.file,'utf8'), /diagnostics.limit/);
  const blocked = path.join(dir, 'not-a-directory'); fs.writeFileSync(blocked, 'file');
  assert.doesNotThrow(() => diagnostics.create({directory:blocked,enabled:true}).record('native.send', {}));
});
test('capture diagnostics distinguish empty and summary output without changing delivery results', async t => {
  const rows=[]; t.mock.method(diagnostics,'record',(event,data)=>rows.push({event,...data}));
  const capture=require('../main/pi-session/task-delivery.cjs').capture;
  assert.equal(await capture(null,'completed',{taskId:'task',turnId:'turn'}),null);
  assert.equal(rows[0].captureReason,'no-handle'); assert.equal(rows[0].turnId,'turn');
  const artifacts=require('../main/conversation/artifact-runtime');
  t.mock.method(artifacts,'snapshotAsync',async()=>({delivery:{presentation:'summary'}}));
  assert.equal(await capture({},'completed',{taskId:'task'}),null);
  assert.equal(rows[1].captureReason,'summary');
});
test('hostile values are discarded and unknown fields cannot become log content', t => {
  const log=diagnostics.create({directory:fixture(t),enabled:true});
  log.record('http.result',{status:'PRIVATE BODY',operation:'https://private-host',fileCount:'SECRET',
    httpStatus:403,errorKey:'PRIVATE PROVIDER ERROR',headers:{Authorization:'SECRET'}});
  const text=fs.readFileSync(log.file,'utf8');
  assert.doesNotMatch(text,/PRIVATE|SECRET|private-host|Authorization/);
  assert.equal(JSON.parse(text).httpStatus,403);
});
test('HTTP projection separates request policy, effective policy, review and delivery outcome', () => {
  const project = require('../core/requirement-diagnostics.js');
  const rows=[];
  project.http((event,data)=>rows.push({event,...data}), '/tasks/t/conversation-turn',
    {action:'prepare',submissionMode:'auto',conversationId:'c',turnId:'r'},
    {task:{id:'t',status:'doing',workRouting:{executionSubmissionMode:'manual',outputContract:{kind:'office-artifact'}}},
      turn:{state:'queued'}}, 200);
  assert.equal(rows[0].selectedMode,'auto'); assert.equal(rows[0].effectiveMode,'manual');
  project.http((event,data)=>rows.push({event,...data}), '/tasks/t/conversation-delivery', {},
    {ok:true,pendingSubmission:true,submissionMode:'manual',files:['private.md'],invalid:[{reason:'private'}]},200);
  assert.equal(rows[1].fileCount,1); assert.equal(rows[1].invalidCount,1);
  assert.equal(rows[1].pendingSubmission,true);
  project.http(()=>assert.fail('unrelated route'),'/models',{}, {secret:'private'},200);
});
