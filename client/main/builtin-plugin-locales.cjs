'use strict';

const packs = require('../core/locales/builtin-ui.js');

// Call only for shipped manifests. Imported packages retain their author's metadata.
function withLocales(body) {
  const locales = Object.fromEntries(Object.entries(packs).map(([locale, messages]) => {
    const text = value => messages[value] || value;
    const inputs = Object.fromEntries((body.inputs || []).map(input => [input.key, {
      ...Object.fromEntries(['label', 'description', 'placeholder', 'group'].filter(key => input[key])
        .map(key => [key, text(input[key])])),
      ...(input.options ? { options: Object.fromEntries(input.options.map(option =>
        typeof option === 'string' ? [option, text(option)] : [option.value, text(option.label || option.value)])) } : {}),
    }]));
    return [locale, { ...body.locales?.[locale], name: text(body.name), description: text(body.description), inputs }];
  }));
  return { ...body, locales };
}
module.exports = { withLocales };
