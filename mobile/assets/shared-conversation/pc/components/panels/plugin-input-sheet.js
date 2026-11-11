/* Declarative enterprise-plugin work surface.
   Plugins declare safe fields; SoduWork owns rendering, validation and theming.
   No plugin HTML or JavaScript is executed in the employee client. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PluginInputSheet = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const TYPES = new Set(['text', 'textarea', 'boolean', 'number', 'select']);
  let active = null;

  function cut(value, limit) {
    return String(value == null ? '' : value).trim().slice(0, limit || 200);
  }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[char]));
  }

  function normalizeInputs(value) {
    const seen = new Set();
    return (Array.isArray(value) ? value : []).slice(0, 50).map((raw) => {
      const source = raw && typeof raw === 'object' ? raw : {};
      const key = cut(source.key, 64);
      let type = cut(source.type, 20).toLowerCase() || 'text';
      if (type === 'string') type = 'text';
      if (type === 'bool') type = 'boolean';
      if (type === 'enum') type = 'select';
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key) || seen.has(key) || !TYPES.has(type)) return null;
      seen.add(key);
      const item = {
        key, type, label: cut(source.label, 100) || key,
        required: Boolean(source.required), description: cut(source.description, 300),
        placeholder: cut(source.placeholder, 180),
      };
      if (Object.prototype.hasOwnProperty.call(source, 'default')) item.default = source.default;
      if (type === 'select') {
        item.options = (Array.isArray(source.options) ? source.options : []).slice(0, 50).map((option) => {
          const row = option && typeof option === 'object' ? option : { value: option, label: option };
          const optionValue = cut(row.value, 200);
          return optionValue ? { value: optionValue, label: cut(row.label, 100) || optionValue } : null;
        }).filter(Boolean);
        if (!item.options.length) return null;
      }
      return item;
    }).filter(Boolean);
  }

  function valueLines(plugin, values, seed) {
    const rows = [];
    const goal = cut(seed, 20000);
    if (goal) rows.push('工作目标：\n' + goal);
    normalizeInputs(plugin && plugin.inputs).forEach((field) => {
      let value = values && values[field.key];
      if (field.type === 'boolean') value = value ? '是' : '否';
      if (value == null || String(value).trim() === '') return;
      const body = String(value).trim();
      rows.push(field.label + '：' + (body.includes('\n') ? '\n' + body : body));
    });
    return rows;
  }

  function promptFrom(plugin, values, seed) {
    const name = cut(plugin && plugin.name, 120) || '企业插件';
    const rows = valueLines(plugin, values, seed);
    return ['请使用「' + name + '」完成这项工作。', rows.join('\n\n')]
      .filter(Boolean).join('\n\n').trim();
  }

  function fieldHtml(field) {
    const id = 'pis-' + field.key;
    const label = '<span>' + esc(field.label) + (field.required ? '<b>*</b>' : '') +
      (field.description ? "<small data-user-content>" + esc(field.description) + '</small>' : '') + '</span>';
    const placeholder = esc(field.placeholder || '请填写' + field.label);
    const defaultValue = field.default == null ? '' : field.default;
    if (field.type === 'textarea') {
      return '<label class="pis-field is-wide" for="' + id + '">' + label +
        '<textarea id="' + id + '" name="' + esc(field.key) + '" rows="4" placeholder="' + placeholder + '">' +
        esc(defaultValue) + '</textarea></label>';
    }
    if (field.type === 'boolean') {
      return '<label class="pis-toggle is-wide" for="' + id + "\"><span><b data-user-content>" + esc(field.label) + '</b>' +
        (field.description ? "<small data-user-content>" + esc(field.description) + '</small>' : '') + '</span>' +
        '<input id="' + id + '" name="' + esc(field.key) + '" type="checkbox"' +
        (defaultValue === true ? ' checked' : '') + '><i aria-hidden="true"></i></label>';
    }
    if (field.type === 'select') {
      return '<label class="pis-field" for="' + id + '">' + label + '<select id="' + id + '" name="' +
        esc(field.key) + '">' + field.options.map((option) => '<option value="' + esc(option.value) + '"' +
          (String(defaultValue) === option.value ? ' selected' : '') + '>' + esc(option.label) + '</option>').join('') +
        '</select></label>';
    }
    return '<label class="pis-field" for="' + id + '">' + label + '<input id="' + id + '" name="' +
      esc(field.key) + '" type="' + (field.type === 'number' ? 'number' : 'text') + '" value="' +
      esc(defaultValue) + '" placeholder="' + placeholder + '"></label>';
  }

  function workflowHtml(plugin) {
    const rows = (Array.isArray(plugin && plugin.workflow) ? plugin.workflow : []).slice(0, 6);
    if (!rows.length) return '';
    return '<div class="pis-route" aria-label="插件流程"><span>执行方法</span><ol>' + rows.map((item, index) =>
      '<li><i>' + (index + 1) + '</i><b>' + esc(item.name || item.key || '工作步骤') + '</b></li>').join('') +
      '</ol></div>';
  }

  function readValues(form, fields) {
    const data = new FormData(form);
    const values = {};
    fields.forEach((field) => {
      const control = form.elements[field.key];
      if (field.type === 'boolean') values[field.key] = Boolean(control && control.checked);
      else if (field.type === 'number') {
        const raw = String(data.get(field.key) || '').trim();
        values[field.key] = raw === '' ? '' : Number(raw);
      } else values[field.key] = String(data.get(field.key) || '').trim();
    });
    return values;
  }

  function readiness(fields, values) {
    const required = fields.filter((field) => field.required);
    const complete = required.filter((field) => field.type === 'boolean'
      ? values[field.key] === true : String(values[field.key] == null ? '' : values[field.key]).trim()).length;
    return { required: required.length, complete, ready: complete === required.length };
  }

  function open(options) {
    const o = options || {};
    const plugin = o.plugin || {};
    const fields = normalizeInputs(plugin.inputs);
    if (!fields.length || typeof document === 'undefined') return null;
    if (active && typeof active.close === 'function') active.close(true);
    const host = typeof o.host === 'function' ? o.host() : o.host;
    const anchor = typeof o.anchor === 'function' ? o.anchor() : o.anchor;
    const surface = window.PluginUIHost && PluginUIHost.mount({
      id: 'plugin-input:' + cut(plugin.pluginId, 100), host, anchor,
      className: 'pis-surface',
    });
    if (!surface) return null;
    const root = surface.content;
    const seed = cut(o.seed, 20000);
    const initialValues = o.initialValues && typeof o.initialValues === 'object' ? o.initialValues : {};
    const surfaceContext = cut(o.surfaceContext, 30) || 'conversation';
    const copy = {
      eyebrow: cut(o.eyebrow, 50) || 'PLUGIN WORK SURFACE',
      contextLabel: cut(o.contextLabel, 50) || '\u672c\u6b21\u4e0a\u4e0b\u6587',
      sectionTitle: cut(o.sectionTitle, 80) || '\u5de5\u4f5c\u8f93\u5165',
      sectionSubtitle: cut(o.sectionSubtitle, 120) || '\u628a\u5173\u952e\u6761\u4ef6\u4e00\u6b21\u8bf4\u6e05',
      inputHint: cut(o.inputHint, 120) || '\u51ed\u636e\u4e0d\u4f1a\u5728\u8fd9\u91cc\u6536\u96c6',
      footnote: cut(o.footnote, 160) || '\u5e26\u5165\u540e\u4ecd\u53ef\u5728\u53d1\u9001\u524d\u4fee\u6539',
      submitLabel: cut(o.submitLabel, 40) || '\u5e26\u5165\u5bf9\u8bdd',
      busyLabel: cut(o.busyLabel, 40) || '\u6b63\u5728\u5904\u7406\u2026',
      requiredMessage: cut(o.requiredMessage, 120) || '\u8bf7\u5148\u8865\u9f50\u5fc5\u586b\u5185\u5bb9\uff0c\u518d\u7ee7\u7eed\u3002',
    };
    surface.root.dataset.surfaceContext = surfaceContext;
    root.innerHTML = '<section class="pis-sheet"><header class="pis-head"><div class="pis-mark" aria-hidden="true">' +
      '<svg viewBox="0 0 24 24"><path d="M8 4h8M9 2v4M15 2v4M5 8h14v11H5zM8 12h3M8 15h6"/></svg></div>' +
      '<div><span data-i18n="eyebrow.plugin_work_surface">PLUGIN WORK SURFACE</span><h2' + (plugin.name ? ' data-user-content' : '') + '>' + esc(plugin.name || '企业插件') + "</h2><p" + (plugin.description ? ' data-user-content' : '') + '>' +
      esc(plugin.description || '按企业已发布的方法完成这项工作') + '</p></div>' +
      '<div class="pis-head-actions">' + (plugin.version ? '<em>v' + esc(plugin.version) + '</em>' : '') +
      '<button type="button" data-pis-close aria-label="关闭插件表单"><svg viewBox="0 0 24 24"><path d="m7 7 10 10M17 7 7 17"/></svg></button></div></header>' +
      workflowHtml(plugin) + '<form class="pis-form" novalidate>' +
      (seed ? '<div class="pis-seed"><span>本次上下文</span><p>' + esc(seed) + '</p></div>' : '') +
      '<div class="pis-section-head"><div><span>工作输入</span><b>把关键条件一次说清</b></div>' +
      '<small>凭据不会在这里收集</small></div><div class="pis-fields">' + fields.map(fieldHtml).join('') + '</div>' +
      '<div class="pis-error" role="alert" hidden></div><footer class="pis-foot"><p>带入后仍可在发送前修改</p>' +
      '<span class="pis-ready" aria-live="polite"></span><button type="button" class="pis-quiet" data-pis-close>取消</button>' +
      '<button type="submit" class="pis-primary">带入对话</button></footer></form></section>';
    const form = root.querySelector('.pis-form');
    const error = root.querySelector('.pis-error');
    const ready = root.querySelector('.pis-ready');
    const submit = form.querySelector('[type="submit"]');
    let submitting = false;
    const setCopy = (selector, value) => {
      const node = root.querySelector(selector);
      if (node) node.textContent = value;
    };
    setCopy('.pis-head>div:nth-child(2)>span', copy.eyebrow);
    setCopy('.pis-seed>span', copy.contextLabel);
    setCopy('.pis-section-head span', copy.sectionTitle);
    setCopy('.pis-section-head b', copy.sectionSubtitle);
    setCopy('.pis-section-head>small', copy.inputHint);
    setCopy('.pis-foot>p', copy.footnote);
    if (submit) submit.textContent = copy.submitLabel;
    fields.forEach((field) => {
      if (!Object.prototype.hasOwnProperty.call(initialValues, field.key)) return;
      const control = form.elements[field.key];
      if (!control) return;
      if (field.type === 'boolean') control.checked = Boolean(initialValues[field.key]);
      else control.value = initialValues[field.key] == null ? '' : String(initialValues[field.key]);
    });
    const update = () => {
      const values = readValues(form, fields);
      const state = readiness(fields, values);
      ready.textContent = state.required ? state.complete + '/' + state.required + ' 项必填' : '可以开始';
      ready.classList.toggle('is-ready', state.ready);
      error.hidden = true;
      try {
        if (typeof o.onChange === 'function') o.onChange(values, plugin);
      } catch (_error) {}
    };
    const close = (silent) => {
      if (active && active.surface === surface) active = null;
      surface.destroy();
      if (!silent && typeof o.onClose === 'function') o.onClose();
    };
    root.querySelectorAll('[data-pis-close]').forEach((button) => button.addEventListener('click', () => close()));
    form.addEventListener('input', update);
    form.addEventListener('change', update);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (submitting) return;
      const values = readValues(form, fields);
      const state = readiness(fields, values);
      if (!state.ready) {
        error.textContent = copy.requiredMessage;
        error.hidden = false;
        const missing = fields.find((field) => field.required && (field.type === 'boolean'
          ? values[field.key] !== true : !String(values[field.key] == null ? '' : values[field.key]).trim()));
        if (missing && form.elements[missing.key]) form.elements[missing.key].focus();
        return;
      }
      const prompt = promptFrom(plugin, values, seed);
      submitting = true;
      if (submit) { submit.disabled = true; submit.textContent = copy.busyLabel; }
      error.hidden = true;
      try {
        const result = typeof o.onApply === 'function'
          ? await o.onApply(prompt, values, plugin) : undefined;
        if (result === false) {
          submitting = false;
          if (submit) { submit.disabled = false; submit.textContent = copy.submitLabel; }
          return;
        }
        close(true);
      } catch (failure) {
        submitting = false;
        if (submit) { submit.disabled = false; submit.textContent = copy.submitLabel; }
        error.textContent = cut(failure && failure.message || failure, 240) || '\u6ca1\u6709\u5904\u7406\u6210\u529f\uff0c\u8bf7\u68c0\u67e5\u540e\u91cd\u8bd5\u3002';
        error.hidden = false;
      }
    });
    active = { pluginId: cut(plugin.pluginId, 100), surface, close };
    update();
    const first = form.querySelector('textarea,input:not([type=checkbox]),select');
    if (first) setTimeout(() => first.focus(), 0);
    return active;
  }

  function close(pluginId) {
    if (!active || (pluginId && active.pluginId !== String(pluginId))) return false;
    active.close(true); return true;
  }

  return { normalizeInputs, promptFrom, readiness, open, close };
});
