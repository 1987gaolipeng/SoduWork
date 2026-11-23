'use strict';

const READONLY_TOOLS = ['read', 'list', 'glob', 'grep'];

// The SDK records its tool selection on the next prompt, while an access
// change is durable immediately. A rebuild or reopen in that interval must
// not restore the older read-only selection from the transcript.
function unrecordedUpgrade(manager) {
  const entries = manager && (manager.getBranch?.() || manager.getEntries?.()) || [];
  let mode, upgrade = -1, declaration = -1;
  entries.forEach((entry, index) => {
    if (entry.type === 'custom' && entry.customType === 'soduwork.access.policy') {
      if (mode === 'readonly' && ['standard', 'full'].includes(entry.data?.mode)) upgrade = index;
      mode = entry.data?.mode;
    }
    if (entry.type === 'message' && entry.message?.role === 'system' &&
        (entry.message.toolsAdded || entry.message.toolsRemoved)) declaration = index;
  });
  return mode !== 'readonly' && upgrade > declaration;
}

function restore(session, sdk, settings, cwd, policy, previousPolicy) {
  if (!policy || policy.mode === 'readonly' ||
      previousPolicy?.mode !== 'readonly' && !unrecordedUpgrade(session.sessionManager)) return;
  const coding = sdk.createCodingTools(cwd).map(tool => tool.name);
  const builtins = new Set([...READONLY_TOOLS, ...coding,
    ...sdk.createReadOnlyTools(cwd).map(tool => tool.name)]);
  const defaults = settings.getDefaultTools?.() ?? coding;
  // Use the SDK's public selection API so default registration rules remain
  // intact. Preserve new extension tools, remove the stale readonly selection,
  // and honor an explicitly empty configured default list.
  session.setActiveToolsByName([...new Set([
    ...session.getActiveToolNames().filter(name => !builtins.has(name)), ...defaults,
  ])]);
}

module.exports = { restore, unrecordedUpgrade };
