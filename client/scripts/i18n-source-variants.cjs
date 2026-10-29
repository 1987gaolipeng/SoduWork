'use strict';

// Reviewed finite UI domains. These are NOT exclusions: audit-i18n verifies
// every concrete variant against the loaded catalog on every run.
const weekdays = ['一', '二', '三', '四', '五', '六', '日'];
const toolTitles = ['写入', '修改', '读取', '搜索', '查看', '调用', '插件', 'SoduWork',
  '正在生成图片', '图片生成未完成', '图片已生成', '正在运行命令', '运行了命令', '命令执行异常'];
module.exports = [
  {
    file: 'client/components/panels/work-intent.js', source: '周{value}',
    reason: 'The weekday options map the seven literal Chinese weekday names.',
    variants: weekdays.map(day => '周' + day),
  },
  {
    file: 'client/components/panels/panels-schedules.js', source: '每{value} {value}:{value}',
    reason: 'SCH_WD is a seven-entry weekday table; hour and minute stay numeric.',
    variants: weekdays.map(day => '每周' + day + ' {hour}:{minute}'),
  },
  {
    file: 'client/components/panels/work-intent.js', source: '正在按{value}执行与自检',
    reason: 'counted is either the criteria count or the fixed goal label.',
    variants: ['正在按{count} 项完成标准执行与自检', '正在按目标执行与自检'],
  },
  {
    file: 'client/components/panels/work-intent.js', source: '{value}已完成；后续可正常对话',
    reason: 'counted is either the criteria count or the fixed goal label.',
    variants: ['{count} 项完成标准已完成；后续可正常对话', '目标已完成；后续可正常对话'],
  },
  {
    file: 'client/components/panels/work-intent.js', source: '{value}已写入工作记忆',
    reason: 'counted is either the criteria count or the fixed goal label.',
    variants: ['{count} 项完成标准已写入工作记忆', '目标已写入工作记忆'],
  },
  {
    file: 'client/components/panels/chat-workspace-info.js', source: '正在{value}…',
    reason: 'ChatTools.render returns these finite tool-title labels; no business field is recursively translated.',
    variants: toolTitles.map(title => '正在' + title + '…'),
  },
  {
    file: 'client/components/panels/chat-workspace-info.js', source: '正在{value} {value}…',
    reason: 'ChatTools.render title labels are finite; subjects remain original file names, commands, or user inputs.',
    variants: toolTitles.map(title => '正在' + title + ' {subject}…'),
  },
];
