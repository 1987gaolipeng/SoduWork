'use strict';

const contextWindow = require('../conversation/context-window');
const modelSelection = require('../conversation/model-selection');

// Ordinary turns and workflow nodes use the same managed-model contract,
// including when a running node receives a renewed model ticket.
function create(model, adapterId, capabilityIds) {
  const cfg = { local_cli: String(adapterId || 'codex-harness') };
  if (adapterId === 'codex') cfg.codex_model = String(model && model.id || '');
  const requiredCapabilities = Array.from(new Set((Array.isArray(capabilityIds)
    ? capabilityIds : []).map(value => String(value || '').trim().toLowerCase()).filter(Boolean)));
  if (requiredCapabilities.length) cfg.requiredCapabilities = requiredCapabilities;
  if (model && model.baseUrl && model.key && model.id) {
    cfg.llm = {
      base: String(model.baseUrl), key: String(model.key), model: String(model.id),
      maxOutputTokens: modelSelection.outputLimit(model),
      ...(model.capabilityProfile ? { capabilityProfile: model.capabilityProfile } : {}),
      ...(model.configRevision ? { configRevision: model.configRevision } : {}),
      ...(model.runtimeRevision ? { runtimeRevision: model.runtimeRevision } : {}),
      ...(Array.isArray(model.input) ? { input: model.input.filter(value => value === 'text' || value === 'image') } : {}),
      ...(['native', 'vision-fallback'].includes(model.imageRouting) ? { imageRouting: model.imageRouting } : {}),
      ...(typeof model.visionFallbackAvailable === 'boolean' ? { visionFallbackAvailable: model.visionFallbackAvailable } : {}),
      ...contextWindow.resolveContextWindow(model),
    };
  }
  return cfg;
}

module.exports = { create };
