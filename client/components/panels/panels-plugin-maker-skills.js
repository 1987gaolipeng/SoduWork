/* Skill dependency picker used by the client-first plugin maker. */
(function (global) {
  'use strict';

  function h(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
    });
  }

  function create(options) {
    const root = options.root;
    const count = options.count;
    const selected = options.selected;
    let catalog = [];

    function render() {
      const known = new Map(catalog.map(item => [item.name, item]));
      selected.forEach(name => {
        if (!known.has(name)) known.set(name, {
          name, description: '当前目录中不可见；保留引用，发布预检会再次校验',
          unavailable: true,
        });
      });
      const allRows = [...known.values()];
      const query = String(options.search && options.search.value || '').trim().toLocaleLowerCase();
      const rows = allRows.filter(item => (!options.selectedOnly || !options.selectedOnly.checked || selected.has(item.name)) &&
        (!query || [item.name, item.description, global.SoduWorkBuiltinSkills?.text(item),
          global.SoduWorkBuiltinSkills?.text(item, 'description')].join(' ').toLocaleLowerCase().includes(query)));
      if (count) count.textContent = selected.size
        ? '已选 ' + selected.size + ' 项' : '未选择 · 插件自身方法会自动加载';
      if (!rows.length) {
        root.innerHTML = '<span class="cap-skill-empty">' + (allRows.length ? '没有符合筛选条件的 Skill，已选内容仍然保留。' :
          '当前没有企业开放的 Skill；插件自身方法仍会自动生成并加载。') + '</span>';
        return;
      }
      root.innerHTML = rows.map(item => {
        const checked = selected.has(item.name);
        return '<label' + (global.SoduWorkBuiltinSkills?.title(item) || ' title="' + h(item.description || '团队工作方法') + '"') + ' class="' + (item.unavailable ? 'is-unavailable' : '') + '">' +
          '<input type="checkbox" data-plugin-skill value="' + h(item.name) + '"' +
          (checked ? ' checked' : '') + '><span><b>' + (global.SoduWorkBuiltinSkills?.html(item) || h(item.name)) + '</b><em>' +
          (global.SoduWorkBuiltinSkills?.html(item, 'description') || h(item.description || '团队工作方法')) + '</em></span>' +
          (item.unavailable ? '<small>待校验</small>' : '') + '</label>';
      }).join('');
    }

    async function load() {
      try {
        const api = global.SoduWorkAPI;
        const result = options.deps.loadSkills ? await options.deps.loadSkills()
          : (api && typeof api.mySkills === 'function' ? await api.mySkills() : { skills: [] });
        catalog = (Array.isArray(result && result.skills) ? result.skills : [])
          .map(item => typeof item === 'string' ? { name: item, description: '' } : item)
          .filter(item => item && item.name && item.name !== options.pluginKey);
      } catch (_error) {
        catalog = [];
      }
      render();
    }

    root.addEventListener('change', function (event) {
      const field = event.target.closest('[data-plugin-skill]');
      if (!field) return;
      if (field.checked) selected.add(field.value); else selected.delete(field.value);
      if (typeof options.onChange === 'function') options.onChange(field.value, field.checked);
      render();
      const next = Array.from(root.querySelectorAll('[data-plugin-skill]')).find(input => input.value === field.value);
      if (next) next.focus({ preventScroll: true });
      else if (options.selectedOnly) options.selectedOnly.focus({ preventScroll: true });
    });
    if (options.search) options.search.addEventListener('input', render);
    if (options.selectedOnly) options.selectedOnly.addEventListener('change', render);
    return { render, load };
  }

  global.SoduWorkPluginMakerSkills = { create };
})(window);
