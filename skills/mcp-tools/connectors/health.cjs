'use strict';
// Probe reviewed identity endpoints only; do not select arbitrary tools, read business files, or send messages.
const { provider, settings, readOnly } = require('./validation.cjs');
const TOOLS = Object.freeze({
  asana: 'get_current_user', canva: 'get_user_profile', clickup: 'get_authorized_user',
  confluence: 'get_current_user', discord: 'get_current_user', dropbox: 'get_current_account',
  elevenlabs: 'get_user', figma: 'get_me', github: 'get_authenticated_user',
  intercom: 'get_current_admin', jira: 'get_myself', linear: 'get_viewer',
  mailchimp: 'get_account_root', runway: 'get_organization', salesforce: 'get_user_info',
  slack: 'auth_test', stripe: 'get_account', telegram: 'get_me', trello: 'get_member_me',
  yuque: 'get_current_user', zendesk: 'get_current_user', 'zoho-crm': 'get_current_user', zoom: 'get_me',
});
const CLOUD_PROBES = {
  'aws-ec2': ['describe_regions', {}], 'aliyun-ecs': ['describe_regions', {}],
  'tencent-cloud': ['describe_regions', {}], 'huawei-cloud': ['list_servers', { limit: 1 }],
  'volcengine-ecs': ['describe_instances', { max_results: 1 }], azure: ['list_locations', {}],
  'google-cloud': ['list_zones', { max_results: 1 }],
};
const GRAPH = new Set(['onedrive', 'outlook', 'sharepoint', 'microsoft-teams', 'excel-online']);
const status = (ok, connectionState, authenticationTested, message) => ({
  ok, connectionState, authenticationTested, message, checkedAt: new Date().toISOString(),
  verificationScope: authenticationTested ? 'identity' : 'configuration',
});
async function probe(spec, options = {}) {
  if (spec.command !== 'soduwork-connector' || !Array.isArray(spec.args) || spec.args.length !== 1)
    throw Error('连接器探测配置无效');
  try {
    const def = provider(spec.args[0]), values = settings(def, spec.env || {});
    const probe = CLOUD_PROBES[def.id];
    let tool = def.tools.find(item => item.name === (probe?.[0] || TOOLS[def.id]));
    if (def.id === 'google-drive') tool = { name: 'connection_identity', method: 'GET',
      path: '/drive/v3/about', fixedQuery: { fields: 'user(permissionId)' }, readOnly: true,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false } };
    if (GRAPH.has(def.id)) tool = { name: 'connection_identity', method: 'GET', path: '/me',
      fixedQuery: { '$select': 'id' }, readOnly: true,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false } };
    if (!tool) return status(true, 'configured', false, '配置与工具清单就绪；此平台尚无受审的身份探测接口');
    if (!readOnly(tool) || (tool.inputSchema.required || []).length) throw Error('连接器身份探测定义无效');
    const reply = await require('./runtime.cjs').execute(def, values, tool, probe?.[1] || {}, { timeoutMs: 15000, ...options });
    const body = JSON.parse(reply.content?.find(item => item.type === 'text')?.text || 'null');
    if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).length)
      throw Error('平台身份响应无效');
    if (def.id === 'google-drive' && !body.user?.permissionId || GRAPH.has(def.id) && !body.id)
      throw Error('平台身份响应缺少账号标识');
    // Validate responses in process without exposing them to UI, logs, or models; identity success does not verify every tool permission.
    return status(true, 'verified', true, probe ? '只读连接已验证；其他资源权限以实际操作为准' : '账号授权已验证；具体资源与写入权限以实际操作为准');
  } catch (error) {
    const denied = [401, 403].includes(error.status) || error.code === 'AUTH_REQUIRED';
    return status(false, denied ? 'needs_auth' : 'error', false,
      denied ? '授权已失效或权限不足，请重新连接平台账号' : '连接暂时无法验证，请检查配置、网络及执行机');
  }
}
module.exports = { probe };
