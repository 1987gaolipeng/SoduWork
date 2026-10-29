'use strict';
const artwork = require('../../core/plugin-icon');

// Presentation only: never carry executable context, grants or selected IDs
// through this projection of a plugin accepted for one particular message.
function publicBadges(value) {
  const seen = new Set(), badges = [];
  const text = (value, limit) => String(value == null ? '' : value).trim().slice(0, limit);
  for (const item of Array.isArray(value) ? value : []) {
    const pluginId = text(item?.pluginId, 160);
    if (!pluginId || seen.has(pluginId)) continue;
    seen.add(pluginId);
    const icon = artwork.source(item);
    badges.push({ pluginId, name: text(item.name, 120), version: text(item.version, 40),
      scopeLabel: text(item.scopeLabel, 120), ...(icon ? { icon } : {}) });
    if (badges.length === 3) break;
  }
  return badges;
}

module.exports = { publicBadges };
