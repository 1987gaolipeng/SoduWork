/*
 * Centralize sizes for workspace, console, form, and utility window roles.
 */
const ROLES = {
  workspace: { w: 1240, h: 840, minW: 800, minH: 540, placement: 'center' },
  console:   { w: 1400, h: 900, minW: 820, minH: 560, placement: 'center' },
  form:      { w: 940,  h: 780, minW: 620, minH: 500, placement: 'relative' },
  utility:   { w: 980,  h: 740, minW: 620, minH: 480, placement: 'side' },
};

function role(name, overrides) { return Object.freeze({ ...ROLES[name], ...overrides }); }

module.exports = Object.freeze({
  workspace: role('workspace', { title: '工作区', w: 1460, h: 900, minW: 1040, minH: 680 }),
  aidesk:    role('workspace', { title: 'AI 团队', w: 1440, h: 900 }),
  settings:  role('utility',   { title: '设置', w: 760, h: 760, minW: 560 }),
  skin:      role('utility',   { title: '外观', w: 900, h: 760 }),
  notices:   role('utility',   { title: '通知', w: 560, h: 700, minW: 440 }),
  add:       role('form',      { title: '创建任务', w: 1180, h: 860, minW: 900 }),
  detail:    role('form',      { title: '需求详情', w: 1280, h: 860, minW: 900 }),
  multi:     role('console',   { title: '多路控制台', w: 1480, h: 920 }),
  console:   role('console',   { title: '控制台' }),
  history:   role('workspace', { title: '需求池', w: 1180, h: 820 }),
  schedules: role('utility',   { title: '自动化', w: 920, h: 760 }),
  skills:    role('utility',   { title: '插件', w: 1080, h: 800 }),
  models:    role('utility',   { title: '我的模型', w: 1180, h: 780 }),
  'model-editor': role('form', { title: '模型配置', w: 760, h: 700, minW: 620, minH: 560 }),
  agents:    role('utility',   { title: 'Agent 管理', w: 1180, h: 720 }),
  cloud:     role('utility',   { title: '云端环境', w: 1180, h: 760 }),
  codeacct:  role('utility',   { title: '代码账号', w: 1080, h: 680 }),
  usage:     role('utility',   { title: '我的用量', w: 1180, h: 780, minW: 760, minH: 560 }),
  approvals: role('workspace', { title: '待我确认', w: 1260, h: 820, minW: 900, minH: 600 }),
  briefs:    role('workspace', { title: '简报', w: 1280, h: 840, minW: 900, minH: 600 }),
  team:      role('workspace', { title: '团队', w: 1240, h: 840 }),
  inbox:     role('form',      { title: '收件箱', w: 900, h: 760 }),
  daily:     role('workspace', { title: '简报', w: 1280, h: 840, minW: 900, minH: 600 }),
});
