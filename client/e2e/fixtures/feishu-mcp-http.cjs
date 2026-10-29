const path = require('node:path');
const root = process.env.SODUWORK_E2E_MCP_ROOT;
if (!root || !path.isAbsolute(root)) throw Error('Explicit installed MCP fixture path required');
const { oapiHttpInstance, commonHttpInstance } = require(path.join(root, 'dist/utils/http-instance.js'));
for (const instance of [oapiHttpInstance, commonHttpInstance]) instance.defaults.adapter = async config => {
  const url = new URL(config.url, config.baseURL);
  if (url.hostname !== 'open.feishu.cn' || !url.pathname.endsWith('/docx/v1/documents/doc-fixture/raw_content')) {
    throw Error('Unrecognized external call blocked by isolated test');
  }
  const bearer = config.headers.Authorization || config.headers.authorization;
  if (!['Bearer fixture-personal-access', 'Bearer fixture-rotated-access'].includes(bearer)) {
    throw Error('Tool did not use personal access token');
  }
  const rotated = bearer.includes('rotated');
  return { status: 200, statusText: 'OK', config, headers: {},
    data: { code: 0, data: { content: rotated ? 'Isolated document after token refresh' : 'Isolated personal document' } } };
};
