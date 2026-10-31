'use strict';

const nodeAssert = require('assert');
let asserted = 0;
/* Count assertions dynamically to keep reported totals accurate. */
const assert = new Proxy(nodeAssert, {
  apply(target, thisArg, args) { target(...args); asserted += 1; },
  get(target, prop) {
    const value = target[prop];
    if (typeof value !== 'function') return value;
    return (...args) => { value(...args); asserted += 1; };
  },
});
const contract = require('./agent-contract');

const normal = contract.prompts({ readOnly: false });
assert.match(normal.at(-1), /最高优先级输出语言.*简体中文/);
assert.equal(normal.at(-1), contract.OUTPUT_LANGUAGE);
assert(Object.isFrozen(normal));
assert.equal(normal.length, 2);
assert.match(normal[0], /不要把每条消息默认当成任务/);
assert.match(normal[0], /咨询讨论.*直接回答/);
assert.match(normal[0], /先不要做.*不授权实施/);
assert.match(normal[0], /明确说“去做、执行、修改”/);
assert.match(normal[0], /最终答复必须以结果开头/);
assert.match(normal[0], /最多 3 个关键成果/);
assert.match(normal[0], /真实成果渲染成可打开的文件链接/);
assert.match(normal[0], /不逐条翻译命令/);
assert.match(normal[0], /重新读取用户的目标与验收标准/);
assert.match(normal[0], /自我声称完成不算证据/);
assert.match(normal[0], /不在最终答复里重复工作目录/);
assert.match(normal[0], /真实可访问地址/);
assert.match(normal[0], /工程类工作以代码仓库/);
assert.match(normal[0], /不要用“还需要我做什么”/);

/* Ordinary and read-only tool use must receive the preamble rule without goal mode. */
for (const readOnly of [false, true]) {
  const items = contract.prompts({ readOnly }, ['【插件上下文】必要时读取资料']);
  const behavior = items[0];
  assert.match(behavior, /本轮首次调用工具前.*简短.*目标.*下一步/,
    'tool preambles belong to the shared contract, not only the goal-mode prompt');
  assert.match(behavior, /面向用户的正文.*不能只放在思考/,
    'a hidden thinking block cannot satisfy the visible progress requirement');
  assert.match(behavior, /只要最终结果.*不要过程说明.*严格输出格式.*优先遵守/,
    'explicit user output constraints must still override the default preamble');
  assert.match(behavior, /不输出隐藏推理.*不在每次工具调用前重复/,
    'the preamble must not request hidden reasoning or repetitive tool narration');
  assert.equal(items.at(-1), contract.OUTPUT_LANGUAGE);
}

/* Verify that plugin, goal, and recovery additions precede the final language contract. */
const withAddition = contract.prompts({ readOnly: false, locale: 'ja-JP' }, ['【插件上下文】追加指引']);
assert.equal(withAddition.length, 3);
assert.equal(withAddition[1], '【插件上下文】追加指引');
assert.equal(withAddition[2], contract.outputLanguage('ja-JP'));

/*
 * Verify locale-specific contracts while instruction text remains unchanged; user-message
 * language takes precedence over locale fallback.
 */
const LOCALE_MARKERS = [
  ['en-US', /Highest-priority output language/],
  ['ja-JP', /最優先の出力言語/],
  ['ko-KR', /최우선 출력 언어/],
];
for (const [locale, marker] of LOCALE_MARKERS) {
  const items = contract.prompts({ readOnly: false, locale });
  assert.equal(items.at(-1), contract.outputLanguage(locale));
  assert.match(items.at(-1), marker);
  assert.match(items.at(-1), /Let me/);
  assert.doesNotMatch(items.at(-1), /简体中文/);
  assert.match(items[0], /不要把每条消息默认当成任务/);
}

/* Unknown or missing locales use the existing zh-CN contract. */
assert.equal(contract.outputLanguage('fr-FR'), contract.OUTPUT_LANGUAGE);
assert.equal(contract.outputLanguage(), contract.OUTPUT_LANGUAGE);
assert.equal(contract.outputLanguage(' ja-JP '), contract.outputLanguage('ja-JP'));
assert.equal(contract.outputLanguage('zh-CN'), contract.OUTPUT_LANGUAGE);

const goal = contract.prompts({ readOnly: false, goal: true });
assert.equal(goal.length, 3);
assert.match(goal[1], /\u5f00\u59cb\u52a8\u624b\u524d/);
assert.match(goal[1], /\u4e0d\u8f93\u51fa\u9690\u85cf\u63a8\u7406/);
assert.match(goal[1], /\u5de5\u5177\u8c03\u7528\u4e4b\u95f4/);
assert.equal(goal.at(-1), contract.OUTPUT_LANGUAGE);

const readonly = contract.prompts({ readOnly: true });
assert.equal(readonly.length, 3);
assert.match(readonly[1], /不得声称已经写入文件/);
assert.equal(readonly.at(-1), contract.OUTPUT_LANGUAGE);

console.log('conversation agent contract: ' + asserted + ' assertions passed');
