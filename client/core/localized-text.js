/*
 * Read optional locale maps beside administrator-authored base fields. Select the
 * UI-language translation or fall back to the original without machine translation. Share
 * this contract with backend validation and the administration LocalesEditor.
 */
(function (global) {
  'use strict';

  function currentLocale() {
    return (global.SoduWorkI18n && global.SoduWorkI18n.getLocale)
      ? String(global.SoduWorkI18n.getLocale() || '')
      : 'zh-CN';
  }

  /*
   * Prefer exact locale keys, then case-insensitive legacy matches. Return no override for
   * zh-CN, which uses the base field.
   */
  function pickLocale(map, locale) {
    if (!map || typeof map !== 'object' || !locale || locale === 'zh-CN') return '';
    const direct = map[locale];
    if (typeof direct === 'string' && direct.trim()) return direct.trim();
    const key = Object.keys(map).find(k => String(k).toLowerCase() === String(locale).toLowerCase());
    const hit = key ? map[key] : '';
    return typeof hit === 'string' && hit.trim() ? hit.trim() : '';
  }

  /* Read item.fieldLocales for the UI language, falling back to item.field. */
  function resolve(item, field, locale) {
    const ui = locale || currentLocale();
    return pickLocale(item[field + 'Locales'], ui) || String(item[field] || '');
  }

  global.SoduworkLocalizedText = { currentLocale, pickLocale, resolve };
})(window);
