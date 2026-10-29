/* Public task inputs and private installation preferences in the plugin authoring form. */
(function (global) {
  'use strict';
  const { html: h, clone } = global.SoduWorkPluginMakerUtils;

  function editorInput(raw, index) {
    raw = raw && typeof raw === 'object' ? raw : {};
    const aliases = { string: 'text', bool: 'boolean', enum: 'select' };
    let type = aliases[String(raw.type || 'text').toLowerCase()] || String(raw.type || 'text').toLowerCase();
    if (type === 'text' && raw.multiline) type = 'textarea';
    if (!['text', 'textarea', 'boolean', 'number', 'select'].includes(type)) type = 'text';
    return {
      key: String(raw.key || ('input_' + (index + 1))),
      label: String(raw.label || raw.key || ('参数 ' + (index + 1))),
      type, required: Boolean(raw.required),
      description: String(raw.description || ''), placeholder: String(raw.placeholder || ''),
      options: Array.isArray(raw.options) ? raw.options.map(option => {
        option = option && typeof option === 'object' ? option : { value: option, label: option };
        return { value: String(option.value || ''), label: String(option.label || option.value || '') };
      }) : [],
      defaultValue: Object.prototype.hasOwnProperty.call(raw, 'default') ? String(raw.default) : '',
    };
  }
  function optionsText(input) {
    return (input.options || []).map(option => option.value +
      (option.label && option.label !== option.value ? ' | ' + option.label : '')).join('\n');
  }
  function parseOptions(value) {
    const source = String(value || '').includes('\n')
      ? String(value || '').split(/\n/) : String(value || '').split(/[,，]/);
    return source.map(row => {
      const parts = row.split('|').map(x => x.trim());
      return { value: parts[0] || '', label: parts[1] || parts[0] || '' };
    }).filter(option => option.value);
  }
  function serializeInput(input) {
    const result = {
      key: input.key.trim(), label: input.label.trim(), type: input.type,
      required: Boolean(input.required), description: input.description.trim(),
      placeholder: input.placeholder.trim(),
    };
    if (input.type === 'select') result.options = clone(input.options);
    if (input.defaultValue !== '') {
      if (input.type === 'boolean') result.default = input.defaultValue === 'true';
      else if (input.type === 'number') result.default = Number(input.defaultValue);
      else result.default = input.defaultValue;
    }
    return result;
  }
  function editorSetup(raw, index) {
    raw = raw && typeof raw === 'object' ? raw : {};
    const aliases = { string: 'text', bool: 'boolean', enum: 'select' };
    let type = aliases[String(raw.type || 'text').toLowerCase()] || String(raw.type || 'text').toLowerCase();
    if (!['text', 'textarea', 'boolean', 'number', 'select', 'multiselect', 'url'].includes(type)) type = 'text';
    const rawDefault = Object.prototype.hasOwnProperty.call(raw, 'default') ? raw.default : '';
    return {
      key: String(raw.key || ('setup_' + (index + 1))),
      label: String(raw.label || raw.key || ('设置 ' + (index + 1))), type,
      required: Boolean(raw.required), description: String(raw.description || ''),
      placeholder: String(raw.placeholder || ''), group: String(raw.group || '使用偏好'),
      options: Array.isArray(raw.options) ? raw.options.map(option => {
        option = option && typeof option === 'object' ? option : { value: option, label: option };
        return { value: String(option.value == null ? '' : option.value), label: String(option.label || option.value || '') };
      }).filter(option => option.value) : [],
      defaultValue: Array.isArray(rawDefault) ? rawDefault.map(String).join('\n') : String(rawDefault == null ? '' : rawDefault),
      minLength: raw.minLength == null ? '' : String(raw.minLength), maxLength: raw.maxLength == null ? '' : String(raw.maxLength),
      minimum: raw.minimum == null ? '' : String(raw.minimum), maximum: raw.maximum == null ? '' : String(raw.maximum),
    };
  }
  function serializeSetup(input) {
    const result = {
      key: input.key.trim(), label: input.label.trim(), type: input.type,
      required: Boolean(input.required), description: input.description.trim(),
      placeholder: input.placeholder.trim(), group: input.group.trim() || '使用偏好',
    };
    if (input.type === 'select' || input.type === 'multiselect') result.options = clone(input.options);
    if (['text', 'textarea', 'url'].includes(input.type)) {
      if (input.minLength !== '') result.minLength = Number(input.minLength);
      if (input.maxLength !== '') result.maxLength = Number(input.maxLength);
    }
    if (input.type === 'number') {
      if (input.minimum !== '') result.minimum = Number(input.minimum);
      if (input.maximum !== '') result.maximum = Number(input.maximum);
    }
    if (input.defaultValue !== '') {
      if (input.type === 'boolean') result.default = input.defaultValue === 'true';
      else if (input.type === 'number') result.default = Number(input.defaultValue);
      else if (input.type === 'multiselect') result.default = parseOptions(input.defaultValue).map(option => option.value);
      else result.default = input.defaultValue;
    }
    return result;
  }
  function create({ layer, inputs, setup, onChange, option }) {
    let publicInputs = (Array.isArray(inputs) ? inputs : []).map(editorInput);
    const setupDraft = setup && typeof setup === 'object' ? setup : {};
    let setupFields = (Array.isArray(setupDraft.preferences) ? setupDraft.preferences : []).map(editorSetup);
    const inputRowsEl = layer.querySelector('#capInputRows');
    const setupRowsEl = layer.querySelector('#capSetupRows');
    const resetPreview = onChange;

    function inputDefaultControl(item) {
      if (item.type === 'boolean') {
        return '<select data-input-field="defaultValue" aria-label="默认值">' +
          option('', '不设默认', item.defaultValue) + option('true', '默认开启', item.defaultValue) +
          option('false', '默认关闭', item.defaultValue) + '</select>';
      }
      return '<input data-input-field="defaultValue" type="' + (item.type === 'number' ? 'number' : 'text') +
        '" value="' + h(item.defaultValue) + '" placeholder="默认值（可空）" aria-label="默认值">';
    }

    function renderInputs() {
      if (!publicInputs.length) {
        inputRowsEl.innerHTML = '<div class="cap-input-empty"><b>没有公开参数</b>' +
          '<span>直接使用对话内容作为输入；需要结构化启动时再添加。</span></div>';
        return;
      }
      inputRowsEl.innerHTML = publicInputs.map(function (item, index) {
        return '<article class="cap-public-input" data-input-index="' + index + '">' +
          '<div class="cap-public-input-main">' +
            '<input data-input-field="label" value="' + h(item.label) + '" maxlength="100" placeholder="显示名称" aria-label="显示名称">' +
            '<input data-input-field="key" value="' + h(item.key) + '" maxlength="64" placeholder="参数标识" aria-label="参数标识">' +
            '<select data-input-field="type" aria-label="参数类型">' +
              option('text', '单行文本', item.type) + option('textarea', '多行文本', item.type) +
              option('boolean', '开关', item.type) + option('number', '数字', item.type) +
              option('select', '选项', item.type) + '</select>' +
            '<label class="cap-input-required"><input type="checkbox" data-input-field="required"' +
              (item.required ? ' checked' : '') + '>必填</label>' +
            '<button type="button" data-input-remove="' + index + '" aria-label="删除参数">×</button>' +
          '</div><div class="cap-public-input-meta">' +
            '<input data-input-field="description" value="' + h(item.description) + '" maxlength="300" placeholder="给使用者的说明">' +
            '<input data-input-field="placeholder" value="' + h(item.placeholder) + '" maxlength="180" placeholder="输入提示">' +
            (item.type === 'select'
              ? '<textarea data-input-field="options" placeholder="每行一个选项；可写 value | 显示名">' + h(optionsText(item)) + '</textarea>'
              : '') +
            inputDefaultControl(item) +
          '</div></article>';
      }).join('');
    }


    function setupDefaultControl(item) {
      if (item.type === 'boolean') return '<select data-setup-field="defaultValue" aria-label="默认值">' +
        option('', '不设默认', item.defaultValue) + option('true', '默认开启', item.defaultValue) +
        option('false', '默认关闭', item.defaultValue) + '</select>';
      if (item.type === 'select') return '<select data-setup-field="defaultValue" aria-label="默认值"><option value="">不设默认</option>' +
        (item.options || []).map(function (row) { return option(row.value, row.label, item.defaultValue); }).join('') + '</select>';
      return '<input data-setup-field="defaultValue" type="' + (item.type === 'number' ? 'number' : item.type === 'url' ? 'url' : 'text') +
        '" value="' + h(item.defaultValue) + '" placeholder="默认值（可空）" aria-label="默认值">';
    }

    function setupRangeControls(item) {
      if (['text', 'textarea', 'url'].includes(item.type)) return '<input data-setup-field="minLength" type="number" min="0" max="8000" value="' + h(item.minLength) + '" placeholder="最小长度" aria-label="最小长度">' +
        '<input data-setup-field="maxLength" type="number" min="1" max="8000" value="' + h(item.maxLength) + '" placeholder="最大长度" aria-label="最大长度">';
      if (item.type === 'number') return '<input data-setup-field="minimum" type="number" value="' + h(item.minimum) + '" placeholder="最小值（可空）" aria-label="最小值">' +
        '<input data-setup-field="maximum" type="number" value="' + h(item.maximum) + '" placeholder="最大值（可空）" aria-label="最大值">';
      return '<span class="cap-setup-range-placeholder">无需范围</span><span></span>';
    }

    function renderSetup() {
      if (!setupFields.length) {
        setupRowsEl.innerHTML = '<div class="cap-input-empty"><b>没有安装设置</b>' +
          '<span>不需要每位同事单独配置时保持为空；账号和密钥请使用企业连接。</span></div>';
        return;
      }
      setupRowsEl.innerHTML = setupFields.map(function (item, index) {
        const options = item.type === 'select' || item.type === 'multiselect'
          ? '<textarea data-setup-field="options" placeholder="每行一个选项；可写 value | 显示名" aria-label="选项">' + h(optionsText(item)) + '</textarea>' : '';
        const defaultValue = item.type === 'multiselect'
          ? '<textarea data-setup-field="defaultValue" placeholder="默认选项，每行一个" aria-label="默认值">' + h(item.defaultValue) + '</textarea>'
          : setupDefaultControl(item);
        return '<article class="cap-public-input cap-setup-authoring" data-setup-index="' + index + '">' +
          '<div class="cap-public-input-main cap-setup-main">' +
            '<input data-setup-field="label" value="' + h(item.label) + '" maxlength="100" placeholder="显示名称" aria-label="显示名称">' +
            '<input data-setup-field="key" value="' + h(item.key) + '" maxlength="64" placeholder="参数标识" aria-label="参数标识">' +
            '<select data-setup-field="type" aria-label="设置类型">' +
              option('text', '单行文本', item.type) + option('textarea', '多行文本', item.type) +
              option('boolean', '开关', item.type) + option('number', '数字', item.type) +
              option('select', '单选', item.type) + option('multiselect', '多选', item.type) +
              option('url', '网址', item.type) + '</select>' +
            '<label class="cap-input-required"><input type="checkbox" data-setup-field="required"' +
              (item.required ? ' checked' : '') + '>必填</label>' +
            '<button type="button" data-setup-remove="' + index + '" aria-label="删除安装设置">×</button>' +
          '</div><div class="cap-public-input-meta cap-setup-meta">' +
            '<input data-setup-field="description" value="' + h(item.description) + '" maxlength="300" placeholder="给使用者的说明" aria-label="说明">' +
            '<input data-setup-field="placeholder" value="' + h(item.placeholder) + '" maxlength="180" placeholder="输入提示" aria-label="输入提示">' +
            '<input data-setup-field="group" value="' + h(item.group) + '" maxlength="60" placeholder="分组，例如：显示偏好" aria-label="分组">' +
          '</div><div class="cap-setup-advanced-row">' + options + setupRangeControls(item) + defaultValue + '</div>' +
        '</article>';
      }).join('');
    }

    function updateSetupField(event) {
      const row = event.target.closest('[data-setup-index]');
      const field = event.target.dataset.setupField;
      if (!row || !field) return;
      const item = setupFields[Number(row.dataset.setupIndex)];
      if (!item) return;
      if (field === 'required') item.required = event.target.checked;
      else if (field === 'options') item.options = parseOptions(event.target.value);
      else item[field] = event.target.value;
      resetPreview();
      if (field === 'type') {
        if (item.type !== 'select' && item.type !== 'multiselect') item.options = [];
        renderSetup();
      }
    }

    function updatePublicInput(event) {
      const row = event.target.closest('[data-input-index]');
      const field = event.target.dataset.inputField;
      if (!row || !field) return;
      const item = publicInputs[Number(row.dataset.inputIndex)];
      if (!item) return;
      if (field === 'required') item.required = event.target.checked;
      else if (field === 'options') item.options = parseOptions(event.target.value);
      else item[field] = event.target.value;
      resetPreview();
      if (field === 'type') renderInputs();
    }

    layer.querySelector('#capInputAdd').addEventListener('click', function () {
      let number = publicInputs.length + 1;
      const used = new Set(publicInputs.map(item => item.key));
      let key = publicInputs.length ? 'input_' + number : 'goal';
      while (used.has(key)) { number += 1; key = 'input_' + number; }
      publicInputs.push(editorInput({
        key, label: publicInputs.length ? '参数 ' + number : '目标',
        type: publicInputs.length ? 'text' : 'textarea',
        required: true, placeholder: publicInputs.length ? '' : '请说明要完成什么',
      }, publicInputs.length));
      resetPreview(); renderInputs();
    });
    inputRowsEl.addEventListener('click', function (event) {
      const remove = event.target.closest('[data-input-remove]');
      if (!remove) return;
      publicInputs.splice(Number(remove.dataset.inputRemove), 1);
      resetPreview(); renderInputs();
    });
    inputRowsEl.addEventListener('input', updatePublicInput);
    inputRowsEl.addEventListener('change', updatePublicInput);
    layer.querySelector('#capSetupTitle').addEventListener('input', resetPreview);
    layer.querySelector('#capSetupDescription').addEventListener('input', resetPreview);
    layer.querySelector('#capSetupAdd').addEventListener('click', function () {
      let number = setupFields.length + 1;
      const used = new Set(setupFields.map(item => item.key));
      let key = setupFields.length ? 'setup_' + number : 'workspace';
      while (used.has(key)) { number += 1; key = 'setup_' + number; }
      setupFields.push(editorSetup({ key, label: setupFields.length ? '设置 ' + number : '工作区', type: 'text', required: false }, setupFields.length));
      resetPreview(); renderSetup();
    });
    setupRowsEl.addEventListener('click', function (event) {
      const remove = event.target.closest('[data-setup-remove]');
      if (!remove) return;
      setupFields.splice(Number(remove.dataset.setupRemove), 1);
      resetPreview(); renderSetup();
    });
    setupRowsEl.addEventListener('input', updateSetupField);
    setupRowsEl.addEventListener('change', updateSetupField);

    return {
      render() { renderInputs(); renderSetup(); },
      inputs() { return publicInputs.map(serializeInput); },
      setup() {
        return {
          title: layer.querySelector('#capSetupTitle').value.trim(),
          description: layer.querySelector('#capSetupDescription').value.trim(),
          preferences: setupFields.map(serializeSetup),
        };
      },
    };
  }

  global.SoduWorkPluginMakerFields = { create };
})(window);
