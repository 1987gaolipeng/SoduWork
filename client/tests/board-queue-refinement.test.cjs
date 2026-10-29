const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');
const vm = require('node:vm');
const { createTurnQueue } = require('../main/pi-session/turn-queue');
const read = file => fs.readFileSync(path.join(__dirname, '../components/panels', file), 'utf8');
const chat = read('panels-chat.js');
function preview(server, local) {
  const fn = fs.factoryMethods('chat-send-queue.js', 'ChatSendQueue')._queueRows.toString();
  const result = vm.runInNewContext('var ctx = globalThis;\n' + fn + '\n_queueRows()', {
    _snap: { execution: { queue: server } }, _localQueue: local,
  });
  return JSON.parse(JSON.stringify(result));
}
test('queue preview never collapses a task and a message with identical wording', () => {
  const result = preview([{id:'task-turn',text:'same',taskId:'task-a'}], [{id:'local-message',text:'same'}]);
  assert.deepEqual(result.map(r=>r.id), ['task-turn','local-message']);
});
test('queue preview uses submission identity and still recognizes legacy echoes', () => {
  assert.equal(preview([{id:'one',text:'same',submissionId:'s1'}], [{id:'two',text:'same',submissionId:'s2'}]).length,2);
  assert.equal(preview([{id:'one',text:'same',submissionId:'s1'}], [{id:'two',text:'same',submissionId:'s1'}]).length,1);
  assert.equal(preview([{id:'one',text:'same'}], [{id:'two',text:'same'}]).length,1);
  assert.equal(preview([{id:'one',text:'same',taskId:'a'}], [{id:'two',text:'same',taskId:'b'}]).length,2);
});
test('mixed task and chat queue preserves materials through edit, reorder and serial completion', async () => {
  const q = createTurnQueue(), sent = [];
  const task = q.add({text:'Task description and acceptance criteria', attachments:[{name:'brief.pdf'},{name:'screen.png'}],
    options:{taskId:'fixture', taskTitle:'Task', submissionId:'task-submit', afterTurn:async status=>sent.push('receipt:'+status)}});
  const followUp = q.add({text:'message',attachments:[{name:'notes.txt'}],options:{submissionId:'chat-submit'}});
  assert.equal(q.moveBefore(followUp.id, task.id),true);
  assert.equal(q.edit(task.id,'Task description, acceptance criteria and additional context'),true);
  assert.deepEqual(q.view().map(r=>r.taskId),['','fixture']);
  assert.deepEqual(q.view()[1].attachments,['brief.pdf','screen.png']);
  assert.deepEqual(q.view()[0].attachments,['notes.txt']);
  while(q.size() && !q.blocked()) {
    const item=q.take(); await q.run(item,async()=>{sent.push(item.id);return {ok:true};});
  }
  assert.deepEqual(sent,[followUp.id,task.id,'receipt:completed']);
  assert.equal(q.state().tasks[0].status,'completed');
  assert.equal(q.size(),0);
});
test('scoped board geometry does not constrain Gantt, and queue keeps existing controls', () => {
  const requirement=read('../requirements/requirements-board.css'), queue=read('panels-chat.css');
  assert.match(requirement,/\.rq-kanban\{[^}]*display:(?:grid|flex)/);
  assert.match(requirement,/@container requirements/);
  assert.match(requirement,/\.rq-lane-cards\{[^}]*flex-direction:column/);
  assert.match(requirement,/\.rq-lane-cards\{[^}]*overflow-y:auto/);
  assert.doesNotMatch(requirement,/\.rq-swimlanes\{/);
  assert.match(requirement,/\.history-board\.requirements-board \.hb-body\{display:block/);
  assert.doesNotMatch(requirement,/\.hb-body\{[^}]*grid-template-columns/);
  assert.match(queue,/button\[data-queue-action="add"\][^{]*\{[^}]*border-radius:999px/);
  assert.match(queue,/\.nqueue-stack.is-empty \.nqueue-toolbar\{justify-content:center/);
  assert.match(chat,/data-queue-kind=/);
  assert.match(chat,/nqueue-kind-icon/);
  assert.match(chat,/data-queue-grip=/);
  assert.match(chat,/data-queue-action="' \+ \(row.taskId \? 'detail' : 'edit'\)/);
});
