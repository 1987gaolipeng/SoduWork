'use strict';

const ENTRY_TYPE = 'soduwork.goal';
const MODE_ENTRY_TYPE = 'soduwork.goal.mode';
/*
 * Goal mode completes and verifies deliverables across many tool calls. Default step
 * limits bound runaway execution; permissions, irreversible actions, cancellation, and
 * total runtime remain the actual control boundaries.
 */
const DEFAULT_BUDGET_MINUTES = 240;
const MAX_BUDGET_MINUTES = 720;
const DEFAULT_MAX_STEPS = 1000;
const MAX_STEPS = 5000;
const SCHEMA_VERSION = 2;
const boundedInt = (value, min, max, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.round(parsed))) : fallback;
};
const text = (value, max) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
const multiline = (value, max) => String(value || '').replace(/\r\n?/g, '\n')
  .split('\n').map((line) => line.replace(/[ \t]+/g, ' ').trim())
  .filter(Boolean).join('\n').slice(0, max);

function normalize(raw) {
  const value = raw || {};
  const intent = value.intent === 'goal' || value.mode === 'goal' || value.active === true ? 'goal' : '';
  const goal = text(value.goal, 1200);
  const active = Boolean(intent && goal);
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    intent: active ? 'goal' : '',
    goal,
    acceptance: multiline(value.acceptance, 1600),
    budgetMinutes: active
      ? boundedInt(value.budgetMinutes, 5, MAX_BUDGET_MINUTES, DEFAULT_BUDGET_MINUTES) : 0,
    maxSteps: active ? boundedInt(value.maxSteps, 5, MAX_STEPS, DEFAULT_MAX_STEPS) : 0,
  });
}

function fromEntries(entries) {
  const rows = Array.isArray(entries) ? entries : [];
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const item = rows[index];
    if (item && item.type === 'custom' && item.customType === ENTRY_TYPE) {
      const stored = { ...(item.data || {}) };
      /*
       * Migrate only legacy v1 default duration and step values; preserve explicit values in v2
       * and later archives.
       */
      if (!stored.schemaVersion) {
        if (Number(stored.budgetMinutes) === 60) stored.budgetMinutes = DEFAULT_BUDGET_MINUTES;
        if (Number(stored.maxSteps) === 80) stored.maxSteps = DEFAULT_MAX_STEPS;
      }
      return normalize(stored);
    }
  }
  return normalize({});
}

/*
 * Keep historical goals and delivery evidence while persisting goal-mode visibility and
 * execution switches separately.
 */
function modeFromEntries(entries) {
  const rows = Array.isArray(entries) ? entries : [];
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const item = rows[index];
    if (item && item.type === 'custom' && item.customType === MODE_ENTRY_TYPE) {
      return Object.freeze({ visible: !item.data || item.data.visible !== false });
    }
  }
  return Object.freeze({ visible: true });
}

function same(a, b) {
  const left = normalize(a);
  const right = normalize(b);
  return left.intent === right.intent && left.goal === right.goal
    && left.acceptance === right.acceptance
    && left.budgetMinutes === right.budgetMinutes && left.maxSteps === right.maxSteps;
}

function prompts(raw) {
  const value = normalize(raw);
  if (value.intent !== 'goal') return [];
  const acceptance = value.acceptance || '产出可直接使用的结果，并完成必要的自检与证据记录。';
  const limits = '本轮异常兜底：最长 ' + value.budgetMinutes + ' 分钟、最多 ' +
    value.maxSteps + ' 个工具步骤。这不是交付配额；应按真实工作需要持续推进，' +
    '不得为了节省调用或接近兜底值而跳过验证，也不得把明显的半成品包装成交付。';
  return [limits + String.fromCharCode(10) +
    '【SoduWork 自主目标模式】\n' +
    '长期目标：' + value.goal + '\n' +
    '完成标准：' + acceptance + '\n\n' +
    '你要把它当成需要持续推进直至完成的目标，而不是一次问答。请自主理解、规划、执行、验证和整理交付物；' +
    '普通、可逆且低风险的细节自行作出合理判断，不要用中间询问把工作退回给用户，也不要只给建议后停止。' +
    '\n\n【Codex 式交付循环】\n' +
    '本目标由 SoduWork 驱动为三个连续阶段，全部沿用同一个工作目录和上下文：\n' +
    '1. 理解与规划：第一轮先读取现有工程、说明和关键文件，识别用户、使用场景、约束、目标与非目标；' +
    '形成可执行计划，逐项写清交付物、改动范围、依赖关系、启动方式、验证方法和完成证据。此阶段不要只复述需求，也不要急着宣布完成。\n' +
    '2. 实施与验证：SoduWork 会自动发出内部继续执行指令。按依赖顺序完成计划，持续运行构建、测试、启动和关键用户旅程；' +
    '遇到失败先定位根因、修复并重跑，不把调试责任交还用户。\n' +
    '3. 交付复核：SoduWork 最后依据真实文件和工具证据审计，发现可修复缺口会要求继续补齐，只有证据闭环后才形成最终答复。\n' +
    '规划不是成果本身；除非目标明确只需要规划，否则必须继续完成真实实现和可用结果。' +
    '\n\n【完整交付门槛】\n' +
    '先检查现有工程、目标用户和实际使用场景，再列出本目标真正适用的交付面。' +
    '当目标是完整工程、网站、系统、应用或完整功能时，默认必须覆盖所有适用层：用户体验与视觉、前端、后端/API、数据与配置、权限与安全、集成、测试、运行或部署说明；' +
    '除非目标明确排除了某一层，否则只完成后端、只画页面、只给代码片段或只写方案，都不得宣称完成。简单文档或单点任务则不要生造无关层。\n' +
    '实施时优先形成可运行的端到端纵向闭环，再补齐边界状态、错误处理、空状态、性能、可访问性和工程质量。' +
    '工程启动不是写一句启动命令：需要安装或核对依赖、准备必要配置、真实启动并用健康检查或关键用户路径确认它能工作；' +
    '若因当前授权无法常驻运行，也要完成可重复的启动验证并留下准确说明。' +
    '完成前必须做一次交付缺口审查：逐项核对适用交付面与完成标准，并尽可能执行构建、测试、启动和关键用户旅程验证；' +
    '有可见界面时必须实际检查最终呈现，不能仅凭代码存在判定完成。任何适用项仍缺失时继续工作，不要把半成品包装成最终成果。\n\n' +
    '第一轮只做理解、工程勘察和可执行规划；SoduWork 随后会自动要求你实施，再发起内部交付复核。不要提前写最终交付结论；' +
    '复核阶段会要求你依据真实证据补齐缺口，最终面向用户的交付答复留到复核完成后。\n\n' +
    '每完成一个阶段都检查距离目标和完成标准还差什么，并继续推进。' +
    '只有缺少必要凭据或授权、即将进行不可逆/高风险操作、或存在无法绕过的外部阻断时才暂停，' +
    '并明确说明阻断、已完成内容和最小所需动作。' +
    '完成时给出结果摘要、交付物位置、验证证据和仍需人工处理的事项。' +
    '当 SoduWork 已完成复核、用户取消目标模式，或后续消息被明确标记为普通续聊时，' +
    '本目标循环立即结束；之后只回答用户当下的问题，不得再次自动重跑本目标。'
  ];
}

module.exports = {
  ENTRY_TYPE, MODE_ENTRY_TYPE, SCHEMA_VERSION, DEFAULT_BUDGET_MINUTES, MAX_BUDGET_MINUTES,
  DEFAULT_MAX_STEPS, MAX_STEPS, normalize, fromEntries, modeFromEntries, same, prompts,
};
