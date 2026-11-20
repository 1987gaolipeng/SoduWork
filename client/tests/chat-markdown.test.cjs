'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
function setup() {
  let now = 1000, parseCount = 0, output = '';
  const timers = new Map(); let id = 0;
  const ctx = { _ref:'session-a', _liveTextKey:'1:0', esc:s => String(s).replaceAll('<','&lt;') };
  const sandbox = { Date:{now:() => now}, DOMPurify:{sanitize:html => html},
    setTimeout(fn,ms) { const key=++id; timers.set(key,{fn,at:now+ms}); return key; },
    clearTimeout(key) { timers.delete(key); } };
  sandbox.window = sandbox;
  const desktop = fs.readFileSync(path.join(__dirname, '../desk.html'), 'utf8');
  for (const [, file] of desktop.matchAll(/<script src="((?:vendor\/markdown\/marked\.umd|core\/markdown)\.js)"><\/script>/g)) {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), sandbox);
  }
  const parse = sandbox.marked.parse;
  sandbox.marked = {...sandbox.marked, parse:(...args) => { parseCount++; return parse(...args); }};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../components/panels/chat-markdown.js'),'utf8'), sandbox);
  let source = '';
  const markdown = sandbox.ChatMarkdown.create(ctx, () => { output=markdown._streamText(source); });
  return {ctx,markdown,timers,
    render(text) { source=text; output=markdown._streamText(source); return output; },
    advance(ms) { now+=ms; for (const [key,timer] of Array.from(timers)) if(timer.at<=now) { timers.delete(key); timer.fn(); } },
    get output() { return output; }, get parseCount() { return parseCount; } };
}
test('long streamed code retains its fence and all earlier output across 24k', () => {
  const view=setup(); const text='```js\n'+'const value = 1;\n'.repeat(2000);
  assert.match(view.render(text.slice(0,24000)), /<pre><code/);
  view.advance(400);
  const html=view.render(text);
  assert.match(html, /<pre><code/);
  assert.equal((html.match(/const value = 1;/g)||[]).length,2000);
});
test('newlines cannot bypass the parse budget and the last token flushes when input pauses', () => {
  const view=setup(); view.render('start');
  for(let i=0;i<100;i++) view.render('start\n'+('line\n'.repeat(i+1)));
  assert.equal(view.parseCount,1);
  assert.equal(view.timers.size,1);
  view.advance(400);
  assert.equal(view.parseCount,2);
  assert.equal((view.output.match(/line/g)||[]).length,100);
});
test('same block number in another session does not reuse throttled old content', () => {
  const view=setup(); view.render('previous session');
  view.ctx._ref='session-b';
  assert.match(view.render('new session'), /new session/);
  assert.doesNotMatch(view.output, /previous/);
});
test('closing a renderer cancels pending flush work', () => {
  const view=setup(); view.render('first'); view.render('first plus tail');
  assert.equal(view.timers.size,1); view.markdown.reset();
  assert.equal(view.timers.size,0); view.advance(400);
  assert.equal(view.parseCount,1);
});

test('numeric ranges retain literal tildes in completed, cached and streaming replies', () => {
  const view = setup();
  const source = '找 3~5 个用户，运行 7~14 天。';
  const expected = '<div class="nmd"><p>' + source + '</p>\n</div>';
  assert.equal(view.markdown.rich(source), expected);
  assert.equal(view.markdown.rich(source), expected);
  for (const prefix of ['找 3~5 个用户，运行 7', '找 3~5 个用户，运行 7~', source]) {
    view.advance(400);
    assert.equal(view.render(prefix), '<div class="nmd"><p>' + prefix + '</p>\n</div>');
  }
  view.markdown.reset();
  assert.equal(view.markdown.rich(source), expected);
});

test('literal tildes coexist with explicit strikethrough and other Markdown syntax', () => {
  const { markdown } = setup();
  for (const source of ['3~5\n7~14', '-3~-1 与 0.5~1.5', '~普通文字~', '说明 ~~~普通文字~~~']) {
    assert.equal(markdown.rich(source), '<div class="nmd"><p>' + source + '</p>\n</div>');
  }
  assert.match(markdown.rich('3~5 与 ~~旧建议~~，7~14 与 **新建议**'), /3~5 与 <del>旧建议<\/del>，7~14 与 <strong>新建议<\/strong>/);
  assert.match(markdown.rich(String.raw`3\~5 与 7\~14`), /3~5 与 7~14/);
  assert.match(markdown.rich('`3~5 与 7~14`'), /<code>3~5 与 7~14<\/code>/);
  assert.match(markdown.rich('~~~text\n3~5 与 7~14\n~~~'), /<pre><code class="language-text">3~5 与 7~14\n<\/code><\/pre>/);
  assert.match(markdown.rich('| 范围 |\n| --- |\n| 3~5 与 7~14 |'), /<table>[\s\S]*<td>3~5 与 7~14<\/td>/);
  assert.match(markdown.rich('[3~5](https://example.test/~user) 与 7~14'), /<a href="https:\/\/example.test\/~user">3~5<\/a> 与 7~14/);
});

const chineseBoldCases = [
  ['**注意：**这里需要先登录。', '<strong>注意：</strong>这里需要先登录。'],
  ['**步骤一：**打开设置。', '<strong>步骤一：</strong>打开设置。'],
  ['这是**重点（必读）**内容。', '这是<strong>重点（必读）</strong>内容。'],
  ['这是**“重点”**内容。', '这是<strong>“重点”</strong>内容。'],
];

for (const [source, body] of chineseBoldCases) {
  test('Chinese punctuation bold renders in completed and cached replies: ' + source, () => {
    const view = setup();
    const expected = '<div class="nmd"><p>' + body + '</p>\n</div>';
    assert.equal(view.markdown.rich(source), expected);
    const parses = view.parseCount;
    assert.equal(view.markdown.rich(source), expected);
    assert.equal(view.parseCount, parses, 'a cached reply keeps the corrected output');
    view.markdown.reset();
    assert.equal(view.markdown.rich(source), expected);
  });
}

test('streamed Chinese bold recovers when its closing delimiter and final text arrive', () => {
  for (const [source, body] of chineseBoldCases) {
    const view = setup();
    const closing = source.indexOf('**', source.indexOf('**') + 2);
    const incomplete = source.slice(0, closing + 1);
    assert.doesNotMatch(view.render(incomplete), /<strong>/);
    view.render(source.slice(0, closing + 2));
    view.render(source);
    assert.equal(view.timers.size, 1);
    view.advance(400);
    const expected = '<div class="nmd"><p>' + body + '</p>\n</div>';
    assert.equal(view.output, expected);
    assert.equal(view.render(source), expected);
    assert.equal(view.markdown.rich(source), expected);
  }
});

test('adjacent Chinese bold spans keep their own boundaries and literal numeric ranges', () => {
  const { markdown } = setup();
  const source = '**注意：**先登录，**步骤一：**打开设置。这是**重点（必读）**内容。\n\n' +
    '**结论**：这一行的加粗是正常的（对照）。\n\n预算 100~200 元，工期 3~5 天。\n温度 20~25°C，湿度 40~60%。';
  const expected = '<div class="nmd"><p><strong>注意：</strong>先登录，<strong>步骤一：</strong>打开设置。这是<strong>重点（必读）</strong>内容。</p>\n' +
    '<p><strong>结论</strong>：这一行的加粗是正常的（对照）。</p>\n' +
    '<p>预算 100~200 元，工期 3~5 天。\n温度 20~25°C，湿度 40~60%。</p>\n</div>';
  assert.equal(markdown.rich(source), expected);
});

test('Chinese quotation and colon spans preserve their original token text and raw bytes', () => {
  const marked = require('../core/markdown.js');
  const source = '这是**“重点”**内容，**注意：**先登录，然后**步骤一：**打开设置。';
  const tokens = [];
  marked.parse(source, { gfm: true, breaks: false, walkTokens(token) {
    if (token.type === 'paragraph') tokens.push(token);
  } });
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].raw, source);
  assert.equal(tokens[0].text, source);
  assert.equal(tokens[0].tokens.map(token => token.raw).join(''), source);
  assert.deepEqual(tokens[0].tokens.filter(token => token.type === 'strong').map(token => ({
    raw: token.raw,
    text: token.text,
    children: token.tokens.map(child => ({ raw: child.raw, text: child.text })),
  })), [
    { raw: '**“重点”**', text: '“重点”', children: [{ raw: '“重点”', text: '“重点”' }] },
    { raw: '**注意：**', text: '注意：', children: [{ raw: '注意：', text: '注意：' }] },
    { raw: '**步骤一：**', text: '步骤一：', children: [{ raw: '步骤一：', text: '步骤一：' }] },
  ]);
  assert.equal(setup().markdown.rich(source), '<div class="nmd"><p>这是<strong>“重点”</strong>内容，<strong>注意：</strong>先登录，然后<strong>步骤一：</strong>打开设置。</p>\n</div>');
});

test('Chinese bold labels follow native image alt text and link rendering', () => {
  const { markdown } = setup();
  assert.equal(markdown.rich('![**注意：**这里](https://example.test/image.png)'),
    '<div class="nmd"><p><img src="https://example.test/image.png" alt="注意：这里"></p>\n</div>');
  assert.equal(markdown.rich('[**注意：**这里](https://example.test)'),
    '<div class="nmd"><p><a href="https://example.test"><strong>注意：</strong>这里</a></p>\n</div>');
});

test('Chinese punctuation bold keeps emphasis nesting and partial triple delimiters', () => {
  const { markdown } = setup();
  assert.equal(markdown.rich('*外层**重点：**内容*'),
    '<div class="nmd"><p><em>外层<strong>重点：</strong>内容</em></p>\n</div>');
  assert.equal(markdown.rich('***注意：**这里*'),
    '<div class="nmd"><p><em><strong>注意：</strong>这里</em></p>\n</div>');
});

test('Chinese bold support preserves native code, escapes, links and emphasis parsing', () => {
  // Use an independent parser: the desktop dialect modifies its own marked instance.
  const baseline = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../vendor/markdown/marked.umd.js'), 'utf8'), baseline);
  const { markdown } = setup();
  const sources = [
    '`**注意：**这里` and `` **重点（必读）** ``',
    '```markdown\n**注意：**这里\n这是**重点（必读）**内容。\n```',
    '    **注意：**这里\n    这是**重点（必读）**内容。',
    String.raw`\*\*注意：\*\*这里，\*\*重点（必读）\*\*内容。`,
    '[说明](https://example.test/**path** "**注意：**这里")',
    '[**正常**](https://example.test) and ![**正常**](https://example.test/image.png)',
    '**English:**text and a**word!**b and **normal bold**',
    '*italic* and **bold** and ***both*** and __bold__ and _italic_',
    '*斜体：*中文 and ***注意：***这里 and **outer *inner* bold**',
    '***普通*** and *外层 **重点**内容*',
    '`***注意：**这里*` and `*外层**重点：**内容*`',
    String.raw`\*\*\*注意：\*\*这里\*`,
    '**unclosed and ** empty ** and ****',
  ];
  for (const source of sources) {
    assert.equal(markdown.rich(source), '<div class="nmd">' + baseline.marked.parse(source, { gfm: true, breaks: false }) + '</div>', source);
  }
});
