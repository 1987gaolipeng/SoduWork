// Keep the native App Server's provider identical to the ACP session provider.
// codex-acp passes CODEX_CONFIG at thread/start, but recent Codex versions also
// validate turn/start and resume against startup configuration. No config file
// or credential-bearing command-line argument is written by this adapter.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';

const AUTH_ENV = 'SODUWORK_CODEX_GATEWAY_AUTH';

function configuration(env) {
  try {
    const auth = JSON.parse(env.DEFAULT_AUTH_REQUEST || '{}');
    const gateway = auth._meta?.gateway;
    if (env.MODEL_PROVIDER !== 'custom-gateway' || auth.methodId !== 'gateway' || !gateway) throw Error();
    const url = new URL(gateway.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error();
    const authorization = gateway.headers?.Authorization;
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ') || /[\r\n]/.test(authorization)) throw Error();
    return { authorization, provider: {
      name: 'SoduWork', base_url: gateway.baseUrl, wire_api: 'responses',
      env_http_headers: { Authorization: AUTH_ENV },
      http_headers: { 'X-Client-Feature-ID': 'codex' },
    } };
  } catch {
    throw Error('Invalid SoduWork managed Codex gateway configuration');
  }
}

function toml(value) {
  if (value && typeof value === 'object') {
    return '{' + Object.entries(value).map(([key, item]) => JSON.stringify(key) + '=' + toml(item)).join(',') + '}';
  }
  return JSON.stringify(value);
}

function isAppServer(command, args) {
  const executable = path.basename(String(command)).toLowerCase();
  if (['codex', 'codex.exe', 'codex.cmd'].includes(executable)) return args[0] === 'app-server';
  return ['node', 'node.exe'].includes(executable) && path.basename(String(args[0])).toLowerCase() === 'codex.js' && args[1] === 'app-server';
}

const gateway = configuration(process.env);
const originalSpawn = childProcess.spawn;
childProcess.spawn = function (command, args, options) {
  if (!Array.isArray(args) || !isAppServer(command, args)) {
    return originalSpawn.call(this, command, args, options);
  }
  const env = { ...(options?.env || process.env), [AUTH_ENV]: gateway.authorization };
  // The preload belongs to the adapter only, never native tools or descendants.
  delete env.NODE_OPTIONS;
  delete env.DEFAULT_AUTH_REQUEST;
  delete env.CODEX_CONFIG;
  const startup = [...args, '-c', 'model_provider="custom-gateway"',
    '-c', 'model_providers.custom-gateway=' + toml(gateway.provider)];
  return originalSpawn.call(this, command, startup, { ...options, env });
};
syncBuiltinESMExports();
