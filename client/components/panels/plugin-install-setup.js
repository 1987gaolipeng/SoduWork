/* Version-bound plugin installation preferences and governed connection checks. */
(function (global) {
  'use strict';

  const TYPES = new Set([
    'text', 'textarea', 'boolean', 'number', 'select', 'multiselect', 'url',
  ]);
  const SECRET_VALUE = /(?:sk|pk|pat|ghp|glpat)-[A-Za-z0-9_-]{12,}|(?:api[_ -]?key|token|password|secret)\s*[:=]\s*\S{8,}/i;
  const ICON = {
    tune: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h10m4 0h2M4 17h2m4 0h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></svg>',
    link: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 14.5 14.5 9m-7.8 8.3-1 1a3.5 3.5 0 0 1-5-5l3.6-3.6a3.5 3.5 0 0 1 5 0m5.4 4.6a3.5 3.5 0 0 1 5 0l.1.1a3.5 3.5 0 0 1-.1 4.9l-3.6 3.6a3.5 3.5 0 0 1-5 0"/></svg>',
    shield: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5 19 6v5.5c0 4.5-2.8 7.5-7 9-4.2-1.5-7-4.5-7-9V6z"/><path d="m8.7 12 2.1 2.1 4.5-4.5"/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.2 4.2L19 7"/></svg>',
  };
  const VIRTUAL_MCP_SERVERS = new Set(['soduwork-media']);
  function isVirtualMcp(name) {
    return VIRTUAL_MCP_SERVERS.has(String(name || '').trim());
  }

  function h(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
    });
  }

  function setupOf(item) {
    const raw = item && item.setup || {};
    const preferences = Array.isArray(raw.preferences)
      ? raw.preferences.filter(function (field) {
          return field && field.key && TYPES.has(String(field.type || 'text'));
        }) : [];
    return {
      title: String(raw.title || ''),
      description: String(raw.description || ''),
      preferences: preferences,
    };
  }

  function requiredMcp(item) {
    return Array.from(new Set(
      ((item && item.dependencyReadiness || {}).requiredMcp || [])
        .map(String).map(function (name) { return name.trim(); }).filter(Boolean)
        .filter(function (name) { return !isVirtualMcp(name); })));
  }

  function needs(item) {
    return setupOf(item).preferences.length > 0 ||
      requiredMcp(item).length > 0 ||
      (item && item.setupState && item.setupState !== 'ready' &&
        item.setupState !== 'not_installed');
  }

  function firstValue(field, stored) {
    if (Object.prototype.hasOwnProperty.call(stored, field.key)) {
      return stored[field.key];
    }
    if (Object.prototype.hasOwnProperty.call(field, 'default')) {
      return field.default;
    }
    return field.type === 'boolean' ? false :
      field.type === 'multiselect' ? [] : '';
  }

  function attr(value, h) {
    return h(String(value == null ? '' : value));
  }

  function fieldHtml(field, value, h) {
    const key = attr(field.key, h);
    const required = field.required ? '<em>必填</em>' : '';
    const help = field.description
      ? "<small data-user-content>" + h(field.description) + '</small>' : '';
    const common = ' data-setup-key="' + key + '" aria-label="' +
      attr(field.label || field.key, h) + '"';
    let control = '';
    if (field.type === 'textarea') {
      control = '<textarea class="cap-setup-control" rows="3"' + common +
        ' maxlength="' + Number(field.maxLength || 8000) + '" placeholder="' +
        attr(field.placeholder || '请填写', h) + '">' + h(String(value || '')) +
        '</textarea>';
    } else if (field.type === 'select') {
      control = '<select class="cap-setup-control"' + common +
        '><option value="">请选择</option>' +
        (field.options || []).map(function (option) {
          return '<option value="' + attr(option.value, h) + '"' +
            (String(value) === String(option.value) ? ' selected' : '') + '>' +
            h(option.label || option.value) + '</option>';
        }).join('') + '</select>';
    } else if (field.type === 'multiselect') {
      const selected = new Set(Array.isArray(value) ? value.map(String) : []);
      control = '<div class="cap-setup-options" data-setup-key="' + key +
        '" role="group" aria-label="' + attr(field.label || field.key, h) + '">' +
        (field.options || []).map(function (option) {
          return '<label><input type="checkbox" value="' +
            attr(option.value, h) + '"' +
            (selected.has(String(option.value)) ? ' checked' : '') +
            '><span>' + h(option.label || option.value) + '</span></label>';
        }).join('') + '</div>';
    } else if (field.type === 'boolean') {
      control = '<label class="cap-setup-boolean"><input type="checkbox"' +
        common + (value === true ? ' checked' : '') + '><span><i></i>' +
        h(field.placeholder || '启用') + '</span></label>';
    } else {
      const inputType = field.type === 'number' ? 'number' :
        field.type === 'url' ? 'url' : 'text';
      control = '<input class="cap-setup-control" type="' + inputType + '"' +
        common + ' value="' + attr(value, h) + '" placeholder="' +
        attr(field.placeholder || '请填写', h) + '"' +
        (field.maxLength ? ' maxlength="' + Number(field.maxLength) + '"' : '') +
        (field.minimum != null ? ' min="' + Number(field.minimum) + '"' : '') +
        (field.maximum != null ? ' max="' + Number(field.maximum) + '"' : '') +
        '>';
    }
    return '<label class="cap-setup-field" data-field="' + key +
      '"><span><b>' + h(field.label || field.key) + '</b>' + required +
      '</span>' + control + help +
      '<i class="cap-setup-error" aria-live="polite"></i></label>';
  }

  function preferenceSections(setup, stored, h) {
    const groups = new Map();
    setup.preferences.forEach(function (field) {
      const group = String(field.group || '使用偏好');
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(field);
    });
    if (!groups.size) {
      return '<div class="cap-setup-empty">这个版本没有需要填写的长期偏好。</div>';
    }
    return Array.from(groups.entries()).map(function (entry) {
      return '<div class="cap-setup-group"><h4>' + h(entry[0]) +
        '</h4><div class="cap-setup-grid">' +
        entry[1].map(function (field) {
          return fieldHtml(field, firstValue(field, stored), h);
        }).join('') + '</div></div>';
    }).join('');
  }

  function connectionSection(item, h) {
    if (item.personal) {
      const description = global.SoduWorkPlatformConnections?.setupDescription(item);
      const names = (item.capabilities?.mcpServers || []).map(String)
        .map(function (name) { return name.trim(); }).filter(Boolean);
      const external = names.filter(function (name) { return !isVirtualMcp(name); });
      const builtIn = names.filter(isVirtualMcp);
      const builtInNote = builtIn.length
        ? 'SoduWork 内置能力已就绪：' + builtIn.join('、') + '。'
        : '';
      const externalNote = external.length
        ? '使用前请在连接管理中配置并测试：' + external.join('、')
        : '';
      if (builtInNote && !externalNote) {
        return '<div class="cap-setup-empty">' + h(builtInNote) + '</div>';
      }
      return '<div class="cap-setup-empty">' + h(description || (names.length
        ? [builtInNote, externalNote].filter(Boolean).join(' ')
        : '需要外部账号时，请通过插件指定的连接入口授权。')) + '</div>';
    }
    const names = requiredMcp(item);
    if (!names.length) {
      return '<div class="cap-setup-empty">这个插件不依赖外部连接器。</div>';
    }
    const readiness = item.dependencyReadiness || {};
    const missing = new Set((readiness.missingMcp || []).map(String));
    return '<div class="cap-setup-connections">' + names.map(function (name) {
      const absent = missing.has(name);
      return '<div class="' + (absent ? 'missing' : 'ready') +
        '" data-connection="' + attr(name, h) + '"><span><i></i><b>' +
        h(name) + '</b></span><em>' +
        (absent ? '等待管理员接入' : '已接入，尚未测试') + '</em></div>';
    }).join('') + '</div>';
  }

  function permissionSection(item, h) {
    const cap = item && item.capabilities || {};
    const permission = cap.permissionSummary || {};
    const rows = [
      '风险等级：' + ({ low: '低', medium: '中', high: '高' }[
        String(permission.riskLevel || '').toLowerCase()] || '按企业策略'),
      cap.network ? '可访问插件声明的网络服务' : '不要求网络访问',
      cap.hasScript ? '包含受控脚本，按 Runner 隔离策略执行' :
        '不执行自定义脚本',
      '账号与密钥单独配置，不写入插件偏好；安装不会自动完成平台授权',
    ];
    return '<div class="cap-setup-permissions">' + rows.map(function (row) {
      return '<span>' + ICON.check + '<em>' + h(row) + '</em></span>';
    }).join('') + '</div>';
  }

  function collect(layer, setup) {
    const config = {};
    const errors = [];
    layer.querySelectorAll('.cap-setup-error').forEach(function (node) {
      node.textContent = '';
    });
    setup.preferences.forEach(function (field) {
      const shell = layer.querySelector('[data-field="' +
        CSS.escape(String(field.key)) + '"]');
      let value;
      if (field.type === 'multiselect') {
        value = Array.from(shell.querySelectorAll('input:checked')).map(
          function (input) { return input.value; });
      } else {
        const input = shell.querySelector('[data-setup-key]');
        value = field.type === 'boolean' ? input.checked :
          field.type === 'number' && input.value !== '' ? Number(input.value) :
          input.value.trim();
      }
      const empty = value === '' || value == null ||
        (Array.isArray(value) && !value.length);
      let message = '';
      if (field.required && empty) message = '请填写这项设置';
      if (!message && field.type === 'number' && value !== '' &&
          !Number.isFinite(value)) message = '请输入有效数字';
      if (!message && field.type === 'number' && value !== '' &&
          field.minimum != null && value < Number(field.minimum)) {
        message = '不能小于 ' + field.minimum;
      }
      if (!message && field.type === 'number' && value !== '' &&
          field.maximum != null && value > Number(field.maximum)) {
        message = '不能大于 ' + field.maximum;
      }
      if (!message && ['text', 'textarea', 'url'].includes(field.type) && value &&
          String(value).length < Number(field.minLength || 0)) {
        message = '至少填写 ' + field.minLength + ' 个字符';
      }
      if (!message && ['text', 'textarea', 'url'].includes(field.type) && value &&
          String(value).length > Number(field.maxLength || 8000)) {
        message = '最多填写 ' + (field.maxLength || 8000) + ' 个字符';
      }
      if (!message && field.type === 'url' && value) {
        try {
          const parsed = new URL(value);
          if (!/^https?:$/.test(parsed.protocol) ||
              parsed.username || parsed.password) {
            message = '请填写不含账号密码的 http/https 地址';
          }
        } catch (_error) {
          message = '请填写完整的 http/https 地址';
        }
      }
      const allowed = new Set((field.options || []).map(function (option) {
        return String(option.value);
      }));
      if (!message && field.type === 'select' && value && !allowed.has(String(value))) {
        message = '请选择当前版本支持的选项';
      }
      if (!message && field.type === 'multiselect' &&
          value.some(function (item) { return !allowed.has(String(item)); })) {
        message = '选择中包含当前版本不支持的选项';
      }
      if (!message && ['text', 'textarea', 'url'].includes(field.type) &&
          SECRET_VALUE.test(String(value || ''))) {
        message = '这里不能保存 Token、密码或密钥，请使用企业连接';
      }
      if (message) {
        shell.classList.add('has-error');
        shell.querySelector('.cap-setup-error').textContent = message;
        errors.push(shell);
      } else {
        shell.classList.remove('has-error');
        if (!empty || field.type === 'boolean') config[field.key] = value;
      }
    });
    if (errors[0]) {
      const target = errors[0].querySelector('input,textarea,select');
      if (target) target.focus();
      throw new Error('请先完成标出的安装设置');
    }
    return config;
  }

  function probeView(layer, result, h) {
    const box = layer.querySelector('#capSetupProbe');
    box.hidden = false;
    box.className = 'cap-setup-probe ' + (result.ok ? 'ok' : 'bad');
    const rows = (result.connections || []).map(function (row) {
      const tools = (row.tools || []).slice(0, 4).map(function (tool) {
        return '<code>' + h(tool) + '</code>';
      }).join('');
      return "<div><span><i></i><b" + (row.name ? ' data-user-content' : '') + '>' + h(row.name || '连接') + '</b><em>' +
        (row.ok ? '已连通 · ' + Number(row.toolCount || 0) + ' 个工具' :
          h(row.error || '连接失败')) + '</em></span>' +
        (tools ? '<small>' + tools + '</small>' : '') + '</div>';
    }).join('');
    box.innerHTML = '<header>' + ICON[result.ok ? 'check' : 'link'] +
      '<span><b>' + h(result.message ||
        (result.ok ? '检查通过' : '检查未通过')) + '</b><small>' +
      (result.ok ? '保存时服务端仍会再次核验，避免使用过期结果。' :
        '请修正设置或让管理员完成企业连接后重试。') +
      '</small></span></header>' +
      (rows ? '<section>' + rows + '</section>' : '');
  }

  function modalBody(item, setup, stored, onInstall, h) {
    return '<div class=cap-setup-intro><span>' + ICON.tune +
      "</span><div><b" + (setup.title ? ' data-user-content' : '') + '>' +
      h(setup.title || '完成一次设置，之后直接使用') + "</b><p" + (setup.description ? ' data-user-content' : '') + '>' +
      h(setup.description ||
        '偏好保存在你的安装实例中；账号、密钥与登录授权由企业连接单独托管。') +
      '</p></div><em>' + (onInstall ? '安装前验证' : '按需连接') + '</em></div>' +
      '<section class=cap-setup-section><header><span>01</span><div>' +
        '<b>使用偏好</b><p>只填写非敏感、可长期复用的工作偏好</p>' +
        '</div></header>' + preferenceSections(setup, stored, h) + '</section>' +
      '<section class=cap-setup-section><header><span>02</span><div>' +
        '<b>连接与登录</b><p>' +
        (onInstall ? '安装前必须真实连通所需企业服务' :
          '可以先安装，首次使用相关能力前完成连接') +
        '</p></div></header>' + connectionSection(item, h) + '</section>' +
      '<section class=cap-setup-section><header><span>03</span><div>' +
        '<b>权限边界</b><p>插件声明能力，SoduWork 在每次运行时执行最小授权</p>' +
        '</div></header>' + permissionSection(item, h) + '</section>' +
      '<div class=cap-setup-probe id=capSetupProbe hidden></div>';
  }

  function conversationInstallBody(item, setup, stored, onInstall, h) {
    const sections = [];
    if (setup.preferences.length) {
      sections.push('<section class=cap-setup-section><header><span>01</span><div>' +
        '<b>\u4f7f\u7528\u504f\u597d</b><p>\u53ea\u8865\u5145\u957f\u671f\u53ef\u590d\u7528\u7684\u975e\u654f\u611f\u8bbe\u7f6e</p>' +
        '</div></header>' + preferenceSections(setup, stored, h) + '</section>');
    }
    if (requiredMcp(item).length) {
      sections.push('<section class=cap-setup-section><header><span>' +
        (setup.preferences.length ? '02' : '01') + '</span><div>' +
        '<b>\u8fde\u63a5\u4e0e\u767b\u5f55</b><p>' + (onInstall
          ? '\u5b89\u88c5\u524d\u786e\u8ba4\u6240\u9700\u4f01\u4e1a\u670d\u52a1\u5df2\u7ecf\u63a5\u5165'
          : '\u9700\u8981\u65f6\u518d\u8fde\u63a5\uff0c\u51ed\u636e\u7531\u8fde\u63a5\u4e2d\u5fc3\u6258\u7ba1') +
        '</p></div></header>' + connectionSection(item, h) + '</section>');
    }
    sections.push('<section class=cap-setup-section><header><span>' +
      (sections.length + 1).toString().padStart(2, '0') +
      '</span><div><b>\u6743\u9650\u8fb9\u754c</b><p>\u53ea\u6309\u8fd9\u9879\u63d2\u4ef6\u58f0\u660e\u7684\u6700\u5c0f\u6743\u9650\u8fd0\u884c</p>' +
      '</div></header>' + permissionSection(item, h) + '</section>');
    return sections.join('') + '<div class=cap-setup-probe id=capSetupProbe hidden></div>';
  }

  function bindInstallControls(item, ctx, layer, setup, options, saveLabel) {
    const cancel = layer.querySelector('#capSetupCancel');
    const test = layer.querySelector('#capSetupTest');
    const save = layer.querySelector('#capSetupSave');
    if (cancel) cancel.addEventListener('click', ctx.closeModal);
    const close = layer.querySelector('[data-cap-install-close]');
    if (close) close.addEventListener('click', ctx.closeModal);
    if (test) test.addEventListener('click', function () {
      return runProbe(item, ctx, layer, setup, h, test);
    });
    if (save) save.addEventListener('click', function () {
      return saveSetup(item, ctx, layer, setup, options, save, saveLabel);
    });
  }

  async function runProbe(item, ctx, layer, setup, h, button) {
    let config;
    try {
      config = collect(layer, setup);
    } catch (error) {
      ctx.say(error.message);
      return;
    }
    button.disabled = true;
    button.textContent = '正在检查…';
    const box = layer.querySelector('#capSetupProbe');
    box.hidden = false;
    box.className = 'cap-setup-probe loading';
    box.innerHTML = '<header>' + ICON.link +
      '<span><b>正在验证设置与连接</b>' +
      '<small>将实际连接服务并获取工具清单，不会执行工具。</small>' +
      '</span></header>';
    try {
      const result = await SoduWorkAPI.probeEnterprisePluginInstallation(
        item.pluginId, item.versionId, config);
      probeView(layer, result, h);
    } catch (error) {
      probeView(layer, {
        ok: false,
        message: ctx.errorText(error, '检查没有通过'),
        connections: [],
      }, h);
    } finally {
      button.disabled = false;
      button.textContent = '测一下';
    }
  }

  async function saveSetup(item, ctx, layer, setup, options, button, label) {
    let config;
    try {
      config = collect(layer, setup);
    } catch (error) {
      ctx.say(error.message);
      return;
    }
    const policy = item.marketPolicy || {};
    button.disabled = true;
    button.textContent = policy.authentication === 'on_install' &&
      requiredMcp(item).length ? '正在验证连接…' : '正在保存…';
    try {
      const result = item.personal
        ? await SoduWorkAPI.configurePersonalPlugin(item.pluginId, item.checksum, config)
        : await SoduWorkAPI.setEnterprisePluginInstalled(item.pluginId, true, item.versionId, config);
      if (item.personal && result.plugin) Object.assign(item, result.plugin);
      ctx.closeModal();
      if (typeof options.onSaved === 'function') await options.onSaved(result);
    } catch (error) {
      ctx.say(ctx.errorText(error, options.editing ? '设置没有保存成功' :
        options.upgrading ? '插件没有升级成功' : '插件没有安装成功'));
      button.disabled = false;
      button.textContent = label;
    }
  }

  function modalFoot(saveLabel, personal) {
    return '<button class="btn-mini" id="capSetupCancel">取消</button>' +
      '<span class="push"></span>' +
      (personal ? '' : '<button class="btn-mini" id="capSetupTest">测一下</button>') +
      '<button class="btn-mini primary" id="capSetupSave">' +
      saveLabel + '</button>';
  }

  function canTry(item) {
    const entrypoints = item && item.entrypoints || {};
    return entrypoints.conversation !== false &&
      (!item.marketPolicy || item.marketPolicy.installation !== 'not_available');
  }

  async function finish(item, ctx, options) {
    if (typeof options.reload === 'function') await options.reload();
    if (typeof options.onInstalled === 'function') {
      await options.onInstalled(item);
      return true;
    }
    const message = options.editing ? '插件设置已保存，下一次调用立即生效' :
      options.upgrading ? '插件已验证并升级，可以继续使用' :
      '插件已完成设置并安装，可以在对话中使用';
    ctx.say(message);
    if (!options.editing && !options.upgrading && canTry(item) &&
        typeof ctx.tryPlugin === 'function') ctx.tryPlugin(item);
    return true;
  }

  async function directInstall(item, ctx, button, options) {
    const label = button.textContent;
    button.disabled = true;
    button.textContent = options.upgrading ? '正在升级…' : '正在安装…';
    try {
      await SoduWorkAPI.setEnterprisePluginInstalled(
        item.pluginId, true, item.versionId);
      ctx.closeModal();
      return await finish(item, ctx, options);
    } catch (error) {
      ctx.say(ctx.errorText(error,
        options.upgrading ? '插件没有升级成功' : '插件没有安装成功'));
      button.disabled = false;
      button.textContent = label;
      return false;
    }
  }

  function open(item, ctx, options) {
    options = options || {};
    const setup = setupOf(item);
    const policy = item.marketPolicy || {};
    const onInstall = policy.authentication === 'on_install';
    const editing = Boolean(
      options.editing || item.installed && !item.updateAvailable);
    options.editing = editing;
    const saveLabel = editing ? '保存设置' :
      options.upgrading ? '验证并升级' :
      onInstall && requiredMcp(item).length ? '验证并安装' : '安装插件';
    const layer = ctx.openModal(
      editing ? '插件设置' : options.upgrading ? '升级插件' : '安装插件',
      String(item.name || '企业插件') + ' · v' + String(item.version || ''),
      modalBody(item, setup, item.setupConfig || {}, onInstall, h),
      modalFoot(saveLabel, item.personal));
    bindInstallControls(item, ctx, layer, setup, options, saveLabel);
    return layer;
  }

  function openInline(item, ctx, options) {
    options = options || {};
    const setup = setupOf(item);
    const policy = item.marketPolicy || {};
    const onInstall = policy.authentication === 'on_install';
    const surface = typeof ctx.openSurface === 'function'
      ? ctx.openSurface({ id: 'plugin-install:' + String(item.pluginId || '') })
      : null;
    if (!surface) return null;
    const layer = surface.content || surface.root || surface;
    const closeSurface = function () {
      if (surface && typeof surface.destroy === 'function') surface.destroy();
      if (typeof options.onClose === 'function') options.onClose();
    };
    const inlineCtx = Object.assign({}, ctx, { closeModal: closeSurface });
    const saveLabel = onInstall && requiredMcp(item).length
      ? '\u9a8c\u8bc1\u5e76\u5b89\u88c5' : '\u5b89\u88c5\u5e76\u4f7f\u7528';
    layer.innerHTML = '<section class="cap-install-inline" data-plugin-install-card>' +
      '<header class="cap-install-inline-head"><span class="cap-install-inline-mark">' +
      ICON.tune + '</span><div><span data-i18n="eyebrow.plugin_setup">PLUGIN SETUP</span><b>安装「' +
      h(item.name || '\u4f01\u4e1a\u63d2\u4ef6') + '\u300d</b><p>\u5b89\u88c5\u540e\u76f4\u63a5\u56de\u5230\u5f53\u524d\u5bf9\u8bdd\u4f7f\u7528\uff1b\u8bbe\u7f6e\u53ea\u5bf9\u4f60\u7684 SoduWork \u751f\u6548\u3002</p>' +
      '</div><em>v' + h(item.version || '\u2014') + '</em>' +
      '<button type="button" class="cap-install-inline-close" data-cap-install-close ' +
      'aria-label="\u5173\u95ed\u5b89\u88c5\u5361">\u00d7</button></header>' +
      '<div class="cap-install-inline-body">' +
      conversationInstallBody(item, setup, item.setupConfig || {}, onInstall, h) +
      '</div><footer class="cap-install-inline-foot">' + modalFoot(saveLabel, item.personal) +
      '</footer></section>';
    const flow = Object.assign({}, options, {
      onSaved: function () { return finish(item, inlineCtx, options); },
    });
    bindInstallControls(item, inlineCtx, layer, setup, flow, saveLabel);
    return surface;
  }

  function install(item, ctx, button, options) {
    options = options || {};
    if (!needs(item)) return directInstall(item, ctx, button, options);
    ctx.closeModal();
    open(item, ctx, Object.assign({}, options, {
      onSaved: function () { return finish(item, ctx, options); },
    }));
    return Promise.resolve(true);
  }

  function configure(item, ctx, options) {
    options = Object.assign({}, options || {}, { editing: true });
    ctx.closeModal();
    return open(item, ctx, Object.assign({}, options, {
      onSaved: function () { return finish(item, ctx, options); },
    }));
  }

  global.SoduWorkPluginInstallSetup = {
    configure: configure,
    install: install,
    open: open,
    openInline: openInline,
    needs: needs,
    preferences: { schema: setupOf, render: preferenceSections, collect: collect },
    __test: {
      setupOf: setupOf, requiredMcp: requiredMcp,
      firstValue: firstValue, collect: collect,
    },
  };
})(window);
