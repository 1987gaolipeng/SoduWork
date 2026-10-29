'use strict';
// Reviewed integration of the real SoduWork mcp-studio authoring session.
// Only packaged definitions and fixed read APIs are executable; config cannot choose code, actions or token endpoints.
const { input, settings, plain } = require('./validation.cjs');
const { fetchBounded, redactData, MAX_BYTES } = require('./special-transport.cjs');
const signing = require('./cloud-signing.cjs');
const { bearer } = require('./cloud-auth.cjs');
const KINDS = new Set(['aws-ec2', 'aliyun-ecs', 'tencent-cloud', 'huawei-cloud', 'volcengine-ecs', 'azure', 'google-cloud']);
const ACTIONS = { describe_regions: 'DescribeRegions', describe_instances: 'DescribeInstances', describe_images: 'DescribeImages',
  describe_instance_types: 'DescribeInstanceTypes' };
const TOOLS = {
  'aws-ec2': ['describe_regions', 'describe_instances', 'describe_images'],
  'aliyun-ecs': ['describe_regions', 'describe_instances', 'describe_images'],
  'tencent-cloud': ['describe_regions', 'describe_instances', 'describe_images'],
  'volcengine-ecs': ['describe_instances', 'describe_images', 'describe_instance_types'],
  'huawei-cloud': ['get_api_versions', 'list_servers', 'get_server'],
  azure: ['list_locations', 'list_virtual_machines', 'get_virtual_machine'],
  'google-cloud': ['list_zones', 'list_instances', 'get_instance'],
};
function prepare(def, values, tool, supplied = {}) {
  const kind = def.runtimeKind;
  if (!KINDS.has(kind) || def.id !== kind || !TOOLS[kind].includes(tool.name) || tool.readOnly !== true)
    throw Error('云连接器只支持固定只读工具');
  if (!plain(supplied)) throw Error('参数必须为对象');
  const args = { ...Object.fromEntries(Object.entries(tool.inputSchema.properties || {})
    .filter(([, rule]) => Object.hasOwn(rule, 'default')).map(([key, rule]) => [key, rule.default])), ...supplied };
  input(args, tool.inputSchema);
  return { kind, values: settings(def, values), args };
}
const queryString = query => Object.keys(query).sort().map(key => signing.pct(key) + '=' + signing.pct(query[key])).join('&');
const urlWith = (base, path, query = {}) => new URL(base + path + (Object.keys(query).length ? '?' + queryString(query) : ''));
function nextAzure(next, expectedPath) {
  let url;
  try { url = new URL(next); } catch { throw Error('Azure 翻页地址无效'); }
  if (url.origin !== 'https://management.azure.com' || url.username || url.password || url.hash
    || url.pathname.toLowerCase() !== expectedPath.toLowerCase() || !url.searchParams.get('api-version'))
    throw Error('Azure 翻页地址必须属于当前订阅的虚拟机列表');
  return url;
}
function request(kind, values, tool, args, options = {}) {
  const name = tool.name, now = options.now ?? Date.now();
  let url, headers = {}, body, method = 'GET';
  if (kind === 'aws-ec2') {
    const host = 'ec2.' + values.AWS_REGION + (values.AWS_REGION.startsWith('cn-') ? '.amazonaws.com.cn' : '.amazonaws.com');
    const query = { Action: ACTIONS[name], Version: '2016-11-15' };
    if (args.max_results) query.MaxResults = args.max_results;
    if (args.next_token) query.NextToken = args.next_token;
    if (name === 'describe_images') query['Owner.1'] = 'self';
    headers = signing.sigV4Headers({ accessKey: values.AWS_ACCESS_KEY_ID, secretKey: values.AWS_SECRET_ACCESS_KEY,
      sessionToken: values.AWS_SESSION_TOKEN, region: values.AWS_REGION, service: 'ec2', method, host, path: '/', query, now }).headers;
    url = urlWith('https://' + host, '/', query);
  } else if (kind === 'aliyun-ecs') {
    const host = 'ecs.' + values.ALIYUN_REGION + '.aliyuncs.com', query = { RegionId: values.ALIYUN_REGION };
    if (args.page_number) query.PageNumber = args.page_number;
    if (args.page_size) query.PageSize = args.page_size;
    if (name === 'describe_images') query.ImageOwnerAlias = 'self';
    headers = signing.aliyunHeaders({ accessKeyId: values.ALIYUN_ACCESS_KEY_ID, accessKeySecret: values.ALIYUN_ACCESS_KEY_SECRET,
      securityToken: values.ALIYUN_SECURITY_TOKEN, host, action: ACTIONS[name], version: '2014-05-26', query, now, nonce: options.nonce }).headers;
    url = urlWith('https://' + host, '/', query);
  } else if (kind === 'tencent-cloud') {
    const host = 'cvm.tencentcloudapi.com', payload = {};
    if (name !== 'describe_regions') Object.assign(payload, { Limit: args.limit, Offset: args.offset });
    body = JSON.stringify(payload); method = 'POST';
    headers = signing.tc3Headers({ secretId: values.TENCENT_SECRET_ID, secretKey: values.TENCENT_SECRET_KEY,
      token: values.TENCENT_TOKEN, service: 'cvm', host, body, timestamp: Math.floor(now / 1000) }).headers;
    Object.assign(headers, { 'x-tc-action': ACTIONS[name], 'x-tc-version': '2017-03-12', 'x-tc-region': values.TENCENT_REGION });
    url = new URL('https://' + host + '/');
  } else if (kind === 'volcengine-ecs') {
    const host = 'ecs.' + values.VOLC_REGION + '.volcengineapi.com';
    const query = { Action: ACTIONS[name], Version: '2020-04-01', MaxResults: args.max_results };
    if (args.next_token) query.NextToken = args.next_token;
    headers = signing.volcHeaders({ accessKey: values.VOLC_ACCESS_KEY, secretKey: values.VOLC_SECRET_KEY,
      sessionToken: values.VOLC_SESSION_TOKEN, service: 'ecs', region: values.VOLC_REGION, method, host, path: '/', query, now }).headers;
    url = urlWith('https://' + host, '/', query);
  } else if (kind === 'huawei-cloud') {
    const host = 'ecs.' + values.HUAWEI_REGION + '.myhuaweicloud.com', project = values.HUAWEI_PROJECT_ID;
    let path = '/', query = {};
    if (name === 'list_servers') { path = '/v1/' + project + '/cloudservers/detail'; query.limit = args.limit; if (args.marker) query.marker = args.marker; }
    if (name === 'get_server') path = '/v1/' + project + '/cloudservers/' + encodeURIComponent(args.server_id);
    headers = signing.huaweiHeaders({ accessKey: values.HUAWEI_ACCESS_KEY, secretKey: values.HUAWEI_SECRET_KEY,
      securityToken: values.HUAWEI_SECURITY_TOKEN, method, host, path, query, now }).headers;
    url = urlWith('https://' + host, path, query);
  } else if (kind === 'azure') {
    const prefix = '/subscriptions/' + values.AZURE_SUBSCRIPTION_ID;
    const listPath = prefix + '/providers/Microsoft.Compute/virtualMachines';
    if (name === 'list_locations') url = urlWith('https://management.azure.com', prefix + '/locations', { 'api-version': '2022-12-01' });
    else if (name === 'list_virtual_machines') url = args.next_link ? nextAzure(args.next_link, listPath)
      : urlWith('https://management.azure.com', listPath, { 'api-version': '2024-07-01' });
    else {
      if ([args.resource_group, args.vm_name].some(value => ['.', '..'].includes(value))) throw Error('资源路径无效');
      url = urlWith('https://management.azure.com', prefix + '/resourceGroups/' + encodeURIComponent(args.resource_group)
        + '/providers/Microsoft.Compute/virtualMachines/' + encodeURIComponent(args.vm_name), { 'api-version': '2024-07-01' });
    }
  } else if (kind === 'google-cloud') {
    const prefix = '/compute/v1/projects/' + values.GCP_PROJECT, query = {};
    if (args.max_results) query.maxResults = args.max_results;
    if (args.page_token) query.pageToken = args.page_token;
    const path = name === 'list_zones' ? prefix + '/zones' : name === 'list_instances' ? prefix + '/aggregated/instances'
      : prefix + '/zones/' + encodeURIComponent(args.zone) + '/instances/' + encodeURIComponent(args.instance_name);
    if (name === 'list_instances') query.returnPartialSuccess = 'true';
    url = urlWith('https://compute.googleapis.com', path, query);
  } else throw Error('云连接器类型无效');
  return { url, method, headers, ...(body === undefined ? {} : { body }) };
}
function platformError(kind, data) {
  let error;
  if (kind === 'tencent-cloud') error = data.Response?.Error;
  else if (kind === 'volcengine-ecs') error = data.ResponseMetadata?.Error;
  else if (kind === 'aliyun-ecs') error = data.Code || data.Message ? data : null;
  else error = data.error || (data.error_code ? data : null);
  if (!error) return;
  const code = String(error.Code || error.code || error.error_code || '');
  // Vendor diagnostics can echo credentials. Only safe fixed wording crosses this boundary.
  throw Object.assign(Error('云平台拒绝了请求，请检查凭据、只读权限和地域'), {
    code: /auth|accessdenied|forbidden|unauthorized|invalid.*key|token|signature/i.test(code) ? 'AUTH_REQUIRED' : 'BUSINESS_DENIED',
  });
}
function parse(kind, tool, args, bytes) {
  const text = bytes.toString('utf8');
  if (kind === 'aws-ec2') {
    if (/<!DOCTYPE|<!ENTITY/i.test(text) || !text.includes('<' + ACTIONS[tool.name] + 'Response') || /<Errors?\b/.test(text))
      throw Error('AWS 返回错误或无效的查询响应');
    const raw = text.match(/<nextToken>([^<]*)<\/nextToken>/)?.[1];
    const next = raw?.replace(/&(amp|lt|gt|quot|apos);/g, (_, entity) => ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"}[entity]));
    // Retain the complete bounded official XML: regex extraction of nested <item> loses instances.
    return { data: { format: 'xml', xml: text }, pagination: next ? { next_token: next } : null };
  }
  let data;
  try { data = JSON.parse(text); } catch { throw Error('云平台响应不是 JSON'); }
  if (!plain(data)) throw Error('云平台响应格式无效');
  platformError(kind, data);
  let pagination = null, valid = false;
  if (kind === 'aliyun-ecs') {
    valid = tool.name === 'describe_regions' ? Array.isArray(data.Regions?.Region) : tool.name === 'describe_instances'
      ? Array.isArray(data.Instances?.Instance) : Array.isArray(data.Images?.Image);
    if (tool.name !== 'describe_regions') {
      const has_more = args.page_number * args.page_size < Number(data.TotalCount || 0);
      pagination = { has_more, ...(has_more ? { page_number: args.page_number + 1, page_size: args.page_size } : {}) };
    }
  } else if (kind === 'tencent-cloud') {
    data = data.Response;
    valid = plain(data) && Array.isArray(data[tool.name === 'describe_regions' ? 'RegionSet' : tool.name === 'describe_instances' ? 'InstanceSet' : 'ImageSet']);
    if (tool.name !== 'describe_regions') {
      const has_more = args.offset + args.limit < Number(data?.TotalCount || 0);
      pagination = { has_more, ...(has_more ? { offset: args.offset + args.limit, limit: args.limit } : {}) };
    }
  } else if (kind === 'volcengine-ecs') {
    data = data.Result;
    valid = plain(data) && Array.isArray(data[tool.name === 'describe_instances' ? 'Instances' : tool.name === 'describe_images' ? 'Images' : 'InstanceTypes']);
    if (data?.NextToken) pagination = { next_token: data.NextToken };
  } else if (kind === 'huawei-cloud') {
    valid = tool.name === 'get_api_versions' ? Array.isArray(data.versions) : tool.name === 'list_servers' ? Array.isArray(data.servers) : !!data.server?.id;
    if (tool.name === 'list_servers' && data.servers?.length === args.limit) pagination = { marker: data.servers.at(-1).id };
  } else if (kind === 'azure') {
    valid = tool.name === 'get_virtual_machine' ? !!data.id : Array.isArray(data.value);
    if (data.nextLink) {
      const expected = '/subscriptions/' + args._subscription + '/providers/Microsoft.Compute/virtualMachines';
      nextAzure(data.nextLink, expected); pagination = { next_link: data.nextLink };
    }
  } else {
    valid = tool.name === 'get_instance' ? !!data.name && !!data.id : typeof data.kind === 'string'
      && (data.kind === (tool.name === 'list_zones' ? 'compute#zoneList' : 'compute#instanceAggregatedList'));
    if (data.nextPageToken) pagination = { page_token: data.nextPageToken };
  }
  if (!valid) throw Error('云平台响应缺少预期字段，未验证连接成功');
  return { data, pagination };
}
async function execute(def, suppliedValues, tool, suppliedArgs, options = {}) {
  const { kind, values, args } = prepare(def, suppliedValues, tool, suppliedArgs);
  const req = request(kind, values, tool, args, options);
  if (kind === 'azure' || kind === 'google-cloud') req.headers.Authorization = 'Bearer ' + await bearer(kind, values, options);
  const response = await fetchBounded(req, { timeoutMs: 20000, ...options });
  const result = parse(kind, tool, { ...args, _subscription: values.AZURE_SUBSCRIPTION_ID }, response.bytes);
  const text = JSON.stringify(redactData(result, def, values, req.headers));
  if (Buffer.byteLength(text) > MAX_BYTES) throw Error('云平台结果超过 2 MB，请缩小范围');
  return { content: [{ type: 'text', text }], isError: false };
}
module.exports = { KINDS, prepare, request, parse, execute };
