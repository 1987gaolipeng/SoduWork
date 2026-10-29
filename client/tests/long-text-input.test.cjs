'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const read = name => fs.readFileSync(path.join(__dirname, '../components/panels', name), 'utf8');

function fixture(options = {}) {
  const events = new Map();
  const input = { value: options.prefix || '', selectionStart: (options.prefix || '').length, selectionEnd: (options.prefix || '').length,
    addEventListener(name, handler) { events.set(name, handler); },
    dispatchEvent(event) { events.get(event.type)?.(event); }, focus() {}, setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; } };
  const context = { File, Blob, URL, Uint8Array, Intl, Event, setTimeout, clearTimeout };
  context.window = context;
  for (const name of ['conversation-attachments.js', 'plugin-ui-host.js', 'compose-candidate-navigation.js',
    'chat-plugin-mention-model.js', 'chat-plugin-mention.js', 'panels-compose-skills.js', 'panels-compose-work-actions.js']) vm.runInNewContext(read(name), context);
  context.PluginUIHost.registerAction({ id: 'work.automation.create', command: '自动化', open() {} });
  let opened;
  context.NativeChat = { prepare() {}, clearDraft() {}, async openWorkAction(command, options) { opened = { command, options }; return true; } };
  const attachments = context.ConversationAttachments.create({ input, ...options });
  function paste(text, files = []) {
    let prevented = false;
    events.get('paste')({ clipboardData: { items: files.map(file => ({ kind: 'file', getAsFile: () => file })), getData() { return text; } },
      preventDefault() { prevented = true; } });
    // The real browser inserts text when the production handler allows default paste.
    if (!prevented) {
      input.value = input.value.slice(0, input.selectionStart) + text + input.value.slice(input.selectionEnd);
      input.dispatchEvent(new Event('input'));
    }
    return prevented;
  }
  return { context, input, attachments, paste, events, opened: () => opened };
}

for (const length of [1499, 1500, 1501, 12000]) {
  test('pasting ' + length + ' characters folds only above the threshold and keeps the entire instruction', () => {
    const f = fixture(), text = '用户原始指令\r\n'.padEnd(length - 4, '资料') + '尾部要求';
    f.paste(text);
    assert.equal(f.attachments.submissionText(f.input.value), text);
    assert.equal(f.input.value, length > 1500 ? '' : text);
    assert.equal(f.attachments.has(), length > 1500);
  });
}

test('long pasted slash and hash examples remain full ordinary content without selected chips', async () => {
  const f = fixture(), detail = '#audit-skill 每天9点检查报表。' + '输入内容'.repeat(1000) + '\n必须保留最终输出要求';
  f.paste('/自动化 ' + detail);
  const submission = f.context.ComposeSkills.submission(f.attachments.submissionText(f.input.value), []);
  assert.deepEqual(Array.from(submission.skills), []);
  const result = await f.context.ComposeWorkActions.route({ text: submission.text, hasAttachments: f.attachments.has(), attachments: f.attachments });
  assert.equal(result.handled, false);
  assert.equal(submission.text, '/自动化 ' + detail);
  assert.equal(f.opened(), undefined);
});

test('a slash prefix already in the input receives the long pasted instruction', async () => {
  const f = fixture({ prefix: '/自动化 ' }), detail = '每日上午9点汇总报表。' + '材料'.repeat(1000);
  f.paste(detail);
  const routed = await f.context.ComposeWorkActions.route({ text: f.attachments.submissionText(f.input.value), hasAttachments: f.attachments.has(), attachments: f.attachments });
  assert.equal(routed.handled, false);
  assert.equal(f.attachments.submissionText(f.input.value), '/自动化 ' + detail);
  assert.equal(f.opened(), undefined);
});

test('menu-selected action and skill keep the long instruction and plugin goal', async () => {
  const f = fixture(), detail = '每日上午9点汇总报表。' + '材料'.repeat(1000) + '\n交付CSV';
  f.paste(detail);
  const submission = f.context.ComposeSkills.submission(f.attachments.submissionText(f.input.value), ['audit-skill']);
  assert.deepEqual(Array.from(submission.skills), ['audit-skill']);
  const result = await f.context.ComposeWorkActions.route({ text: submission.text, attachments: f.attachments,
    pluginMention: { action: () => ({ id: 'work.automation.create', command: '自动化' }) } });
  assert.equal(result.accepted, true);
  assert.ok(f.opened().command.text.endsWith(detail));
  const plan = f.context.ChatPluginMention.prepareConversationInputs([{ key: 'goal', type: 'textarea', required: true }], submission.text, {}, {});
  assert.equal(plan.values.goal, submission.text);
});

test('clipboard files still enter the ordinary attachment channel', async () => {
  const f = fixture(), file = new File(['reference bytes'], 'reference.txt', { type: 'text/plain' });
  assert.equal(f.paste('', [file]), true);
  assert.equal(f.input.value, '');
  const refs = await f.attachments.refs({});
  assert.equal(refs.length, 1);
  assert.equal(refs[0].name, 'reference.txt');
  assert.equal(Buffer.from(refs[0].data).toString(), 'reference bytes');
});

test('folded text remains both an exact text file and the original submission', async () => {
  const f = fixture({ captureLongText: true }), text = '仅作为参考材料。'.repeat(250);
  assert.equal(f.paste(text), true);
  assert.equal(f.input.value, '');
  const refs = await f.attachments.refs({});
  assert.equal(Buffer.from(refs[0].data).toString(), text);
  assert.equal(f.attachments.submissionText(''), text);
});

test('cumulative typing, selection paste and appended text preserve original order', () => {
  const f = fixture({ prefix: '前缀' + '中'.repeat(1495) + '替换' });
  f.input.selectionStart = 1497; f.input.selectionEnd = 1499;
  f.paste('插入文本');
  const first = '前缀' + '中'.repeat(1495) + '插入文本';
  assert.equal(f.attachments.submissionText(''), first);
  f.input.value = '\n追加内容'; f.input.dispatchEvent(new Event('input'));
  assert.equal(f.attachments.submissionText(f.input.value), first + '\n追加内容');
  assert.equal(f.attachments.restoreText(), true);
  assert.equal(f.input.value, first + '\n追加内容');
  assert.equal(f.attachments.has(), false);
  f.input.value += '继续编辑'; f.input.dispatchEvent(new Event('input'));
  assert.equal(f.attachments.has(), false, 'explicit expansion must not immediately fold again');
  assert.ok(f.input.value.endsWith('继续编辑'));
});

test('IME composition is not interrupted and Unicode characters are counted once', () => {
  const f = fixture(); f.events.get('compositionstart')();
  f.input.value = '字'.repeat(1501); f.input.dispatchEvent(new Event('input'));
  assert.equal(f.attachments.has(), false);
  f.events.get('compositionend')();
  assert.equal(f.attachments.submissionText(f.input.value), '字'.repeat(1501));
  assert.equal(f.input.value, '');
  f.attachments.clear();
  f.input.value = '🙂'.repeat(1500); f.input.dispatchEvent(new Event('input'));
  assert.equal(f.attachments.has(), false);
  f.input.value += '🙂'; f.input.dispatchEvent(new Event('input'));
  assert.equal(f.attachments.submissionText(f.input.value), '🙂'.repeat(1501));
});

test('draft transfer preserves folded text identity, ordinary TXT never becomes an instruction', async () => {
  const f = fixture(), text = '  原始要求\r\n'.repeat(300);
  f.paste(text); await new Promise(resolve => setImmediate(resolve));
  const files = f.attachments.files();
  f.attachments.clear(); f.attachments.add(files, 'draft');
  assert.equal(f.attachments.submissionText(''), text);
  f.attachments.add([new File(['这是外部资料'], 'external.txt', { type: 'text/plain' })]);
  assert.equal(f.attachments.submissionText(''), text);
  assert.equal((await f.attachments.analysis()).length, 1, 'folded prompt must not be reparsed as external material');
});

test('a full attachment tray never drops typed text while attempting to fold', () => {
  const f = fixture();
  f.attachments.add(Array.from({ length: 20 }, (_, i) => new File(['x'], i + '.txt')));
  f.input.value = '需求'.repeat(800); f.input.dispatchEvent(new Event('input'));
  assert.equal(f.input.value, '需求'.repeat(800));
  assert.equal(f.attachments.submissionText(f.input.value), f.input.value);
});

test('successive long input consolidates exactly once without uploading an unsent requirement', async () => {
  const f = fixture(), uploads = [];
  f.context.LibraryTransfer = { trackFile(file) { uploads.push(file); } };
  const first = '第一段 '.repeat(400), second = '\n第二段 '.repeat(400);
  f.paste(first); f.paste(second);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.attachments.files().length, 1);
  assert.equal(f.attachments.submissionText(''), first + second);
  assert.equal(await f.attachments.files()[0].text(), first + second);
  assert.equal(uploads.length, 0);
  f.attachments.clear();
  assert.equal(f.attachments.submissionText('新需求'), '新需求');
  f.paste(first);
  assert.equal(f.attachments.submissionText(''), first, 'clear resets the previous request');
});

test('accepted work action consumes only its submitted text card and preserves ordinary files and new typing', () => {
  const f = fixture(), reference = new File(['reference'], 'keep.txt');
  f.attachments.add([reference]); f.paste('原文'.repeat(800));
  const submitted = f.attachments.files();
  f.input.value = '下一轮补充';
  assert.equal(f.attachments.consumeInputText(submitted), true);
  assert.equal(f.attachments.submissionText(f.input.value), '下一轮补充');
  assert.equal(f.attachments.files().length, 1);
  assert.equal(f.attachments.files()[0], reference);
});

test('a late work result never removes a new text card created during the wait', () => {
  const f = fixture(); f.paste('旧内容'.repeat(600));
  const submitted = f.attachments.files();
  f.attachments.clear(); f.paste('新内容'.repeat(600));
  assert.equal(f.attachments.consumeInputText(submitted), false);
  assert.equal(f.attachments.submissionText(''), '新内容'.repeat(600));
});

test('successful submission resets explicit expansion before the next long requirement', () => {
  const f = fixture(); f.paste('展开正文'.repeat(500)); f.attachments.restoreText();
  f.attachments.consumeInputText(f.attachments.files(), { resetExpanded: true });
  f.input.value = '';
  f.input.value = '下一轮'.repeat(600); f.input.dispatchEvent(new Event('input'));
  assert.equal(f.input.value, '');
  assert.equal(f.attachments.submissionText(''), '下一轮'.repeat(600));
});
