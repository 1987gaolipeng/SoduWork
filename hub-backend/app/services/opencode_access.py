"""Pin the final native permission map through OpenCode's public config hook.

Agent-specific permissions override global permissions.  The final hook replaces
both, including agents discovered from the project.  Its per-process agent ID is
checked in ACP metadata before any prompt is submitted.  This is tool admission,
not a sandbox for arbitrary native plugins that a user has installed.
"""
from __future__ import annotations

import json
from pathlib import Path
import tempfile
import uuid


class Guard:
    def __init__(self, permission: dict, mode: str = "standard"):
        self.agent_id = "soduwork-access-" + uuid.uuid4().hex
        # Native plan is a planning workflow with its own confirmation prompts,
        # not an access level. The pinned permission map enforces read-only.
        self.profile = "build"
        self.temp = tempfile.TemporaryDirectory(prefix="soduwork-opencode-access-")
        self.path = Path(self.temp.name) / "policy.mjs"
        # No credentials or approval-channel token are written to the module.
        source = """const permission = %s;
const agentId = %s;
const profile = %s;
export default async () => {
  let finalConfig;
  const matches = value => JSON.stringify(value) === JSON.stringify(permission);
  return {
  config: async config => {
    config.permission = structuredClone(permission);
    config.agent ||= {};
    for (const agent of Object.values(config.agent)) {
      if (agent && typeof agent === 'object') agent.permission = structuredClone(permission);
    }
    config.agent[agentId] = { mode: 'primary', description: 'SoduWork session access policy',
      permission: structuredClone(permission) };
    config.agent[profile] = { ...config.agent[profile], disable: false, hidden: false,
      mode: 'primary', permission: structuredClone(permission) };
    config.default_agent = profile;
    finalConfig = config;
  },
  'tool.execute.before': async () => {
    if (!finalConfig || !matches(finalConfig.permission) ||
        Object.values(finalConfig.agent).some(agent => !matches(agent.permission))) {
      throw new Error('SoduWork access policy was changed after initialization. Operation blocked.');
    }
  },
  };
};
""" % (json.dumps(permission, ensure_ascii=False), json.dumps(self.agent_id), json.dumps(self.profile))
        self.path.write_text(source, encoding="utf-8")

    def environment(self, env: dict) -> dict:
        result = dict(env)
        config = json.loads(result.get("OPENCODE_CONFIG_CONTENT") or "{}")
        config["plugin"] = [*(config.get("plugin") or []), self.path.as_uri()]
        result["OPENCODE_CONFIG_CONTENT"] = json.dumps(config, ensure_ascii=False)
        # This option skips all external hooks. It must not silently skip ours.
        result.pop("OPENCODE_PURE", None)
        return result

    def close(self):
        self.temp.cleanup()
