// Presentation counterpart of client/core/plugin-locales.js; parity covered by tests.
const tag = value => String(value || '').replace(/_/g, '-').toLowerCase();
  function layers(locales, locale) {
    const rows = Object.entries(locales || {}).map(([id, item]) => [tag(id), item]);
    const find = id => rows.find(([key]) => key === id)?.[1] || rows.find(([key]) => key.split('-')[0] === id.split('-')[0])?.[1];
    return [find('en'), find(tag(locale))].filter(Boolean);
  }
  function localizeFields(items, translations) {
    return (items || []).map(item => {
      const translated = translations?.[item.key];
      if (!translated) return item;
      const { options: labels, ...text } = translated;
      return { ...item, ...text, ...(labels && Array.isArray(item.options) ? { options: item.options.map(option => {
        const value = typeof option === 'object' ? option.value : option;
        const label = labels[String(value)];
        return label ? { ...(typeof option === 'object' ? option : { value }), label } : option;
      }) } : {}) };
    });
  }
  function present(base, locale) {
    if (!base || !base.locales) return base;
    let result = { ...base };
    for (const layer of layers(base.locales, locale)) {
      for (const key of ['name', 'description']) if (layer[key]) result[key] = layer[key];
      if (layer.ui && result.ui) result.ui = { ...result.ui, contributions: (result.ui.contributions || []).map(item => ({ ...item, ...layer.ui[item.id] })) };
      if (layer.inputs) result.inputs = localizeFields(result.inputs, layer.inputs);
      if (layer.setup && result.setup) {
        const { preferences, ...text } = layer.setup;
        result.setup = { ...result.setup, ...text, preferences: localizeFields(result.setup.preferences, preferences) };
      }
    }
    return result;
  }

export { present as presentPlugin };
export function catalogPlugin(plugin, locale, version = plugin?.latestVersion) {
  const manifest = version?.manifest;
  return manifest ? present({ ...plugin, name: manifest.name || plugin.name, description: manifest.description || plugin.description, locales: manifest.locales }, locale) : present(plugin, locale);
}
