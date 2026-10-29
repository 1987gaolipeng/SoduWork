(function (global) {
  'use strict';

  // Keep locale metadata in one small, runtime-readable file. A new language
  // only needs a catalog bundle and one entry here; the UI and native windows
  // use the same fallback chain while the catalog is being completed.
  const locales = {
    'zh-CN': { label: '简体中文', fallback: null },
    'en-US': { label: 'English', fallback: 'zh-CN' },
    'ja-JP': { label: '日本語', fallback: 'en-US' },
    'ko-KR': { label: '한국어', fallback: 'en-US' },
  };
  const registry = Object.freeze({ defaultLocale: 'zh-CN', locales: Object.freeze(locales) });
  if (typeof module !== 'undefined' && module.exports) module.exports = registry;
  global.SoduWorkLocaleRegistry = registry;
})(globalThis);
