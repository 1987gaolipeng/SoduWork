'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const guard = require('../main/agent-runtime/protocol-guard');
const stream = require('../main/pi-session/event-stream');
const loop = ['I will read README now.', 'Let me read README.', 'Execute read README.', 'Let me read README.', 'Execute read README.'].join('\n');
const plan = ['I will read the config.', 'Let me read the schema.', 'I will read the config.', 'I will run tests afterward.', 'Let me inspect the result.'].join('\n');

test('normal reasoning can discuss an action twice and then emit native tools', () => {
  const acc = stream.create();
  acc.push({type:'message_start',message:{role:'assistant'}});
  for (const delta of plan.match(/.{1,11}|\n/g)) {
    const event = acc.push({type:'message_update',assistantMessageEvent:{type:'thinking_delta',contentIndex:0,delta}});
    assert.notEqual(event.kind,'protocol-leak');
  }
  acc.push({type:'message_update',assistantMessageEvent:{type:'thinking_end',contentIndex:0,content:plan}});
  acc.push({type:'message_update',assistantMessageEvent:{type:'toolcall_end',contentIndex:1,toolCall:{id:'read-config',name:'read',arguments:{path:'config.json'}}}});
  acc.push({type:'tool_execution_start',toolCallId:'read-config',toolName:'read',args:{path:'config.json'}});
  acc.push({type:'tool_execution_end',toolCallId:'read-config',toolName:'read',result:{content:[{type:'text',text:'{}'}]}});
  assert.equal(acc.state.protocolIssue,null);
  assert.equal(acc.state.tools.length,1);
  assert.equal(acc.state.tools[0].state,'done');
  assert.equal(acc.state.messages[0].blocks[0].text,plan);
});

test('quoted and fenced tool narration remains a valid answer, including streaming partial fences', () => {
  for(const marker of ['```','~~~']){
    const content='Example transcript:\n'+marker+'text\n'+loop+'\n'+marker;
    for(let i=1;i<=content.length;i++) assert.equal(guard.inspect(content.slice(0,i)).detected,false);
    assert.equal(guard.inspect(content,{final:true}).text,content);
  }
  const quoted=loop.split('\n').map(line=>'> '+line).join('\n');
  assert.equal(guard.inspect(quoted,{final:true}).detected,false);
  assert.equal(guard.inspect(plan,{final:true}).detected,false);
});

test('true repeated narration is still stopped, with a higher bar for deep thinking', () => {
  assert.equal(guard.inspect(loop,{final:true}).code,guard.DEGENERATE_OUTPUT_CODE);
  assert.equal(guard.inspect(loop,{channel:'thinking',final:true}).detected,false);
  const reasoning=Array(14).fill('Let me read the same file now.').join('\n');
  assert.equal(guard.inspect(reasoning,{channel:'thinking',final:true}).code,guard.DEGENERATE_OUTPUT_CODE);
  const acc=stream.create();
  const event=acc.push({type:'message_update',assistantMessageEvent:{type:'thinking_end',contentIndex:0,content:reasoning}});
  assert.equal(event.kind,'protocol-leak');
});

test('productive tool rounds never accumulate narration into a later false alarm', () => {
  const acc=stream.create();
  for(let i=0;i<8;i++){
    acc.push({type:'message_start',message:{role:'assistant'}});
    acc.push({type:'message_update',assistantMessageEvent:{type:'text_end',contentIndex:0,content:'I will read the next file.'}});
    acc.push({type:'message_end',message:{role:'assistant',stopReason:'toolUse'}});
    acc.push({type:'tool_execution_start',toolCallId:'read-'+i,toolName:'read'});
    acc.push({type:'tool_execution_end',toolCallId:'read-'+i,toolName:'read',result:{content:[{type:'text',text:'File '+i}]}});
  }
  assert.equal(acc.state.protocolIssue,null);assert.equal(acc.state.tools.length,8);
});

test('private protocol leaks remain protected in both output channels', () => {
  for(const channel of ['text','thinking']){
    assert.equal(guard.inspect('<invoke name="bash">',{channel,final:true}).code,guard.CODE);
    assert.equal(guard.inspect('both both both',{channel,final:true}).code,guard.CHANNEL_REPETITION_CODE);
  }
});


test('an unfinished streamed line is not mistaken for a repeated complete action', () => {
  const prefix = [
    'Read README for setup.',
    'Read README for setup.',
    'Run tests for verification.',
    'Inspect the export and read its checksum.',
    'Read README for setup',
  ].join('\n');
  const content = prefix + '; then compare it with the release notes.';
  assert.equal(guard.inspect(content, { final: true }).detected, false);
  assert.equal(guard.inspect(prefix, { final: false }).detected, false);
  const acc = stream.create();
  acc.push({ type: 'message_start', message: { role: 'assistant' } });
  for (const delta of content) {
    const event = acc.push({ type: 'message_update', assistantMessageEvent: {
      type: 'text_delta', contentIndex: 0, delta,
    } });
    assert.notEqual(event.kind, 'protocol-leak', 'a partial final sentence must remain recoverable');
  }
  const end = acc.push({ type: 'message_update', assistantMessageEvent: {
    type: 'text_end', contentIndex: 0, content,
  } });
  assert.notEqual(end.kind, 'protocol-leak');
  assert.equal(acc.state.protocolIssue, null);
  assert.equal(acc.state.messages[0].blocks[0].text, content);
  // Waiting for a complete line must not disable detection on newline/EOF.
  assert.equal(guard.inspect(prefix + '\n', { final: false }).code, guard.DEGENERATE_OUTPUT_CODE);
  assert.equal(guard.inspect(prefix, { final: true }).code, guard.DEGENERATE_OUTPUT_CODE);
});

test('Markdown quotes indented by one to three spaces remain literal examples while streaming', () => {
  for (const spaces of [1, 2, 3]) {
    const content = loop.split('\n').map(line => ' '.repeat(spaces) + '> ' + line).join('\n');
    assert.equal(guard.inspect(content, { final: true }).detected, false);
    const acc = stream.create();
    acc.push({ type: 'message_start', message: { role: 'assistant' } });
    for (const delta of content) {
      const event = acc.push({ type: 'message_update', assistantMessageEvent: {
        type: 'text_delta', contentIndex: 0, delta,
      } });
      assert.notEqual(event.kind, 'protocol-leak', 'indented quoted examples are not attempted tool calls');
    }
    const end = acc.push({ type: 'message_update', assistantMessageEvent: {
      type: 'text_end', contentIndex: 0, content,
    } });
    assert.notEqual(end.kind, 'protocol-leak');
    assert.equal(acc.state.protocolIssue, null);
    assert.equal(acc.state.messages[0].blocks[0].text, content);
  }
});
