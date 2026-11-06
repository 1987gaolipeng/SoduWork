/* Display metadata never changes a Skill's invocation name or instructions. */
(function (global) {
  'use strict';
  const escape = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  function key(item, field) {
    const builtin = item?.builtIn === true || item?.sourceKey === 'builtin';
    return builtin && item.scope !== 'personal' && item.sourceKey !== 'company'
      ? 'builtin.skill.' + item.name + '.' + field : '';
  }
  function text(item, field = 'name') {
    const source = String(item?.[field] || '');
    return key(item, field) ? global.SoduWorkI18n?.t?.(key(item, field), source) || source : source;
  }
  function html(item, field = 'name') {
    const source = String(item?.[field] || '');
    return key(item, field) && global.SoduWorkI18n?.html
      ? global.SoduWorkI18n.html(key(item, field), source)
      : '<span data-user-content>' + escape(source) + '</span>';
  }
  function title(item) {
    const field = item?.description ? 'description' : 'name';
    const source = String(item?.[field] || '');
    return (key(item, field) ? ' data-i18n-title="' + escape(key(item, field)) +
      '" data-i18n-title-source="' + escape(source) + '"' : ' data-user-attributes="title"') +
      ' title="' + escape(text(item, field)) + '"';
  }
  global.SoduWorkBuiltinSkills = { key, text, html, title };
})(globalThis);
