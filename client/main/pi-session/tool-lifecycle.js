'use strict';

const installed = new WeakSet(), wrapped = new WeakSet();
const transport = require('./mcp-tool-transport');
const guard = require('./tool-guard');

function boundedArgs(name, args) {
  if (!/^ctx_execute(?:_file)?$/.test(name)) return args;
  return { ...args, timeout: guard.contextTimeoutMs(args?.timeout) };
}

function install(session) {
  if (!session?.agent || installed.has(session)) return;
  installed.add(session);
  const previous = session.agent.beforeToolCall;
  session.agent.beforeToolCall = async function (context, signal) {
    const decision = await previous?.call(this, context, signal);
    if (decision?.block || signal?.aborted) return decision;
    // This public hook sees the exact object already selected by agent-core.
    // Mutate its execute property, not the tool list: lazy MCP registration
    // and per-turn active-tool changes must get the same cancellation boundary.
    const tool = context.context?.tools?.find(item => item.name === context.toolCall.name);
    if (tool && !wrapped.has(tool)) {
      const execute = tool.execute;
      tool.execute = function (id, args, signal, ...rest) {
        return transport.run(signal, () => execute.call(this, id, boundedArgs(tool.name, args), signal, ...rest));
      };
      wrapped.add(tool);
    }
    return decision;
  };
}

module.exports = { install, boundedArgs };
