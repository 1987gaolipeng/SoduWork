'use strict';
const policies = require('./policy');
const { create: createBroker } = require('./broker');

// The public Pi agent hook runs before built-in, MCP and extension tools.
// This is an approval boundary, not an operating-system sandbox.
function install(session, value, cwd, changed, { readScope = () => undefined } = {}) {
  let policy = policies.normalize(value, cwd);
  if (!policy) return null;
  if (!session.agent || typeof session.agent.beforeToolCall !== 'function') throw new Error('This Pi runtime does not support access approvals');
  const previous = session.agent.beforeToolCall;
  let suspended = false;
  const executing = new Set(), waiters = new Set(), retired = new Set();
  const blockForChange = context => {
    retired.add(context.toolCall.id);
    return { block: true, terminate: true, reason: 'Access policy is being updated; this tool was not executed.' };
  };
  session.subscribe?.(event => {
    if (event.type !== 'tool_execution_end') return;
    // Only calls stopped by our own pre-execution hook are neutral. A tool
    // which actually ran and failed during the transition remains an error.
    if (retired.delete(event.toolCallId)) {
      event.state = 'cancelled';
      event.cancelReason = 'access-change';
      event.isError = false;
      // The SDK persists result.details after notifying these subscribers.
      // Keep its isError flag in model history so "not executed" is not read
      // as success; the trusted marker supplies the UI/history projection.
      event.result.details = { ...event.result.details,
        soduWorkAccessChange: { state: 'cancelled', cancelReason: 'access-change' } };
    }
    executing.delete(event.toolCallId);
    if (!executing.size) { for (const resolve of waiters) resolve(); waiters.clear(); }
  });
  const broker = createBroker({ policy, onChange: changed });
  const queries = require("./query-execution").create(cwd, policy, policies, readScope);
  session.agent.beforeToolCall = async (context, signal) => {
    if (suspended) return blockForChange(context);
    // Preserve existing hooks and their denials before showing a request.
    const existing = await previous.call(session.agent, context, signal);
    if (existing?.block) return existing;
    if (suspended) return blockForChange(context);
    const name = String(context.toolCall?.name || '');
    const args = structuredClone(context.args || {});
    let operation = policies.operation(policy, name, args, cwd, readScope());
    if (operation.commandTargets && !queries.admit(context, operation)) {
      operation = { ...operation, verdict: "ask", commandTargets: undefined };
    }
    const allowed = await broker.authorize(operation, signal);
    if (suspended) return blockForChange(context);
    if (!allowed) return { block: true, reason: 'Access denied by user or policy. Do not retry the same operation or bypass the restriction.' };
    // Resolve aliases and read fallbacks again after the human delay. Neither a
    // renamed junction nor a newly selected filename may reuse old consent.
    if (!policies.current(policy, operation, cwd, readScope())) {
      return { block: true, reason: 'The target changed while awaiting approval. Submit a new request.' };
    }
    if (JSON.stringify(args) !== JSON.stringify(context.args || {})) return { block: true, reason: 'Tool arguments changed after approval' };
    executing.add(context.toolCall.id);
    return existing;
  };
  return { get policy() { return policy; }, broker,
    upgradeToFull(value) {
      const next = policies.normalize(value, cwd);
      if (suspended || policy.mode !== 'standard' || next?.mode !== 'full' || next.revision !== policy.revision + 1) {
        throw Error('Invalid live access upgrade');
      }
      broker.upgradeToFull(next);
      policy = next;
    },
    suspend() { suspended = true; broker.cancel(); return executing.size ? new Promise(resolve => waiters.add(resolve)) : Promise.resolve(); },
    resume() { suspended = false; broker.beginTurn(); },
    snapshot() {
    const pendingPermissions = broker.pending();
    return { accessPolicy: policy,
      appliedAccessPolicy: { ...policy, enforcement: 'tool-approvals', sandbox: false },
      pendingPermissions, ...(pendingPermissions.length ? { status: 'waiting-user', pendingUi: pendingPermissions[0] } : {}) };
  } };
}
module.exports = { install };
