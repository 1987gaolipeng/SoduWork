'use strict';

const { RuntimeContractError } = require('./contract');
const { AgentRuntimeRegistry } = require('./registry');

/* Cordis is an assembly kernel, not SoduWork's public runtime contract. Keeping the
   plugin behind this file prevents Cordis preview APIs from leaking into the UI,
   Runner transport, adapters or persisted event schema. */
function createCordisRuntimePlugin(registry) {
  if (!(registry instanceof AgentRuntimeRegistry)) {
    throw new RuntimeContractError('INVALID_RUNTIME_REGISTRY',
      'Cordis runtime plugin needs an AgentRuntimeRegistry');
  }
  return {
    name: 'soduwork-agent-runtime',
    provide: ['soduWorkAgentRuntime'],
    apply(ctx) {
      const previous = ctx.soduWorkAgentRuntime;
      if (previous && previous !== registry) {
        throw new RuntimeContractError('RUNTIME_SERVICE_CONFLICT',
          'Cordis context already has a different SoduWork runtime service');
      }
      ctx.soduWorkAgentRuntime = registry;
      return () => {
        if (ctx.soduWorkAgentRuntime !== registry) return;
        if (previous === undefined) delete ctx.soduWorkAgentRuntime;
        else ctx.soduWorkAgentRuntime = previous;
      };
    },
  };
}

async function startCordisHost(options) {
  const opts = options || {};
  const registry = opts.registry || new AgentRuntimeRegistry();
  const loadCordis = opts.loadCordis || (() => import('cordis'));
  let cordis;
  try {
    cordis = await loadCordis();
  } catch (error) {
    throw new RuntimeContractError('CORDIS_UNAVAILABLE',
      'Cordis runtime is not installed or could not be loaded', {
        cause: String((error && error.message) || error),
      });
  }
  if (!cordis || typeof cordis.Context !== 'function') {
    throw new RuntimeContractError('CORDIS_INVALID', 'Cordis module does not export Context');
  }
  const context = new cordis.Context();
  const fiber = context.plugin(createCordisRuntimePlugin(registry));
  await fiber;
  let disposed = false;
  return {
    context,
    registry,
    async dispose() {
      if (disposed) return false;
      disposed = true;
      await registry.dispose();
      await fiber.dispose();
      return true;
    },
  };
}

module.exports = { createCordisRuntimePlugin, startCordisHost };
