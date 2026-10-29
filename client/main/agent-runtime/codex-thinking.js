'use strict';
const nativeCatalog = require('./native-model-catalog');

// Match the new-conversation picker without inventing support for unknown models.
function profile(modelName, preferred) {
  const model = nativeCatalog.list('codex').models?.find(row => row.id === modelName);
  const levels = [...nativeCatalog.REASONING_EFFORTS].filter(level => model?.reasoningLevels?.includes(level));
  const defaultLevel = levels.includes('medium') ? 'medium'
    : levels.includes(model?.defaultReasoning) ? model.defaultReasoning : levels[0] || '';
  const level = levels.includes(preferred) ? preferred : defaultLevel;
  return { supported: levels.length > 0, enabled: levels.length > 0, level, levels, defaultLevel };
}
module.exports = { profile };
