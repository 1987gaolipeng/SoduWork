/* Presentation-only plugin translations. Executable contracts always use the base manifest. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SoduWorkPluginLocales = api;
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const tag = value => String(value || '').replace(/_/g, '-').toLowerCase();
  const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
  function copy(value, fields, path) {
    if (!object(value)) throw Error(path + ' must be an object');
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (!Object.hasOwn(fields, key)) throw Error(path + ': unsupported presentation field ' + key);
      const rule = fields[key];
      if (typeof rule === 'number') {
        if (typeof item !== 'string' || !item.trim() || item.length > rule) throw Error(path + '.' + key + ': invalid text');
        result[key] = item.trim();
      } else result[key] = rule(item, path + '.' + key);
    }
    return result;
  }
  function map(value, rule, path) {
    if (!object(value) || Object.keys(value).length > 100) throw Error(path + ': invalid translation map');
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (!key || key.length > 180 || forbidden.has(key)) throw Error(path + ': invalid translation key');
      result[key] = rule(item, path + '.' + key);
    }
    return result;
  }
  const options = (value, path) => map(value, (item, at) => {
    if (typeof item !== 'string' || !item.trim() || item.length > 180) throw Error(at + ': invalid option label');
    return item.trim();
  }, path);
  const field = (value, path) => copy(value, { label: 100, description: 300, placeholder: 180, group: 60, options }, path);
  const fields = (value, path) => map(value, field, path);
  const schema = { name: 120, description: 600,
    ui: (value, path) => map(value, (item, at) => copy(item, { title: 80, description: 240 }, at), path),
    inputs: fields,
    setup: (value, path) => copy(value, { title: 120, description: 500, preferences: fields }, path) };
  function normalize(value) {
    if (value == null) return null; // Legacy packages stay installable.
    if (!object(value) || !Object.keys(value).length || Object.keys(value).length > 30) throw Error('locales must contain 1–30 languages');
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      const id = tag(key);
      if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,3}$/.test(id) || Object.hasOwn(result, id)) throw Error('locales: invalid or duplicate language ' + key);
      result[id] = copy(item, schema, 'locales.' + id);
    }
    for (const language of ['zh', 'en']) {
      if (!Object.entries(result).some(([id, item]) => id.split('-')[0] === language && item.name && item.description)) {
        throw Error('locales requires Chinese and English name/description (zh/en)');
      }
    }
    return result;
  }
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
  return { normalize, present };
});
