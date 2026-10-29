/* Shared, side-effect-free helpers for the client plugin authoring surface. */
(function (global) {
  'use strict';

  function html(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
    });
  }

  function errorText(error, fallback = '插件检查没有完成') {
    // Electron prefixes a rejected IPC call with transport details; retain the
    // actionable validation reason without exposing that implementation wrapper.
    return String(error?.message || error || fallback)
      .replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '').trim().slice(0, 240) || fallback;
  }

  function values(value) {
    return [...new Set(String(value || '').split(/[,，\n]/).map(x => x.trim()).filter(Boolean))];
  }

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function versionParts(value) {
    const match = String(value || '').match(/^(\d+)\.(\d+)\.(\d+)/);
    return match ? match.slice(1).map(Number) : [0, 0, 0];
  }

  function compareVersions(left, right) {
    const a = versionParts(left), b = versionParts(right);
    for (let index = 0; index < 3; index += 1) {
      if (a[index] !== b[index]) return a[index] - b[index];
    }
    return 0;
  }

  function nextVersion(value, versions) {
    const parts = versionParts(value);
    const used = new Set((versions || []).map(item => String(item.version || item)));
    let candidate;
    do {
      parts[2] += 1;
      candidate = parts.join('.');
    } while (used.has(candidate));
    return candidate;
  }

  function resourceMarkup(resources) {
    if (!Array.isArray(resources) || !resources.length) return '';
    const labels = { template: '模板', example: '示例', asset: '素材', script: '脚本', reference: '参考', ui: '页面文件' };
    const size = bytes => bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.ceil(bytes / 1024)) + ' KB';
    return '<details class="cap-resource-pack" open><summary><span class="cap-resource-emblem" aria-hidden="true">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3ZM4 7.5l8 4.5 8-4.5M12 12v9M8 5.2l8 4.5v4"/></svg></span>' +
      '<span><b>随包资源</b><small>随版本保存 · 试用可读取 · 上传时一并携带</small></span>' +
      '<span class="cap-resource-count">' + resources.length + ' 个文件</span></summary>' +
      '<div class="cap-resource-list">' + resources.map(item => '<div class="cap-resource-row">' +
        '<span class="cap-resource-kind">' + html(labels[item.kind] || '资源') + '</span>' +
        '<span class="cap-resource-name" title="' + html(item.path) + '">' + html(item.path) + '</span>' +
        '<span class="cap-resource-size">' + size(Number(item.size) || 0) + '</span></div>').join('') + '</div>' +
      '<p>模板请复制后使用。安装不会执行脚本；页面文件暂不自动挂载为交互界面。</p></details>';
  }
  const MAX_PACKAGE_BYTES = 10 * 1024 * 1024;
  async function preflightArchive(api, file) {
    if (api && typeof api.preflightPluginArchive === 'function') {
      try { return await api.preflightPluginArchive(file); }
      catch (_) { /* Enterprise adapters still use the Hub preflight below. */ }
    }
    return api.preflightPlugin(file);
  }
  async function choosePackage(api, callbacks) {
    const bridge = global.soduWorkAPI && global.soduWorkAPI.personalPlugins;
    if (bridge && typeof bridge.choosePackage === 'function') {
      try {
        const picked = await bridge.choosePackage();
        if (!picked || picked.canceled) return;
        if (picked.kind === 'draft') await callbacks.local(picked.body, await api.preflightPluginDraft(picked.body));
        else {
          const bytes = Uint8Array.from(atob(picked.content), c => c.charCodeAt(0));
          const file = new File([bytes], picked.name, { type: 'application/zip' });
          await callbacks.archive(file, await preflightArchive(api, file));
        }
        return;
      } catch (error) {
        // A renderer reload may precede the main-process restart during a source
        // upgrade. Keep the existing self-contained package import usable.
        if (!/No handler registered.*personal-plugin-choose-package/.test(String(error && error.message))) {
          callbacks.error(error); return;
        }
      }
    }
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.json,.zip,.soduwork-plugin,application/json,application/zip';
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      try {
        if (file.size > MAX_PACKAGE_BYTES) throw new Error('插件文件超过10MB，请精简资源后重试');
        if (/\.json$/i.test(file.name || '')) {
          const body = JSON.parse(await file.text());
          await callbacks.local(body, await api.preflightPluginDraft(body));
        } else await callbacks.archive(file, await preflightArchive(api, file));
      } catch (error) { callbacks.error(error); }
    });
    input.click();
  }
  async function openConversationDraft(ref, target, button, ctx) {
    if (button && button.disabled) return;
    const label = button && button.textContent;
    const errorEl = button?.closest?.('.nplugin-draft')?.querySelector('.nplugin-draft-error');
    if (errorEl) errorEl.hidden = true;
    if (button) { button.disabled = true; button.textContent = '正在检查…'; }
    try {
      const api = global.soduWorkAPI && (global.soduWorkAPI.conversationSession || global.soduWorkAPI.piSession);
      if (!api || typeof api.pluginDraft !== 'function') throw Error('请更新并重启 SoduWork 后安装会话插件');
      const result = await api.pluginDraft(ref, target);
      if (!result || !result.ok) throw Error(result && result.reason || '草稿读取失败');
      const preview = await global.SoduWorkAPI.preflightPluginDraft(result.body);
      global.SoduWorkCapabilityPlugins.openLocalImport(result.body, preview, ctx);
    } catch (error) {
      const message = errorText(error);
      if (errorEl) { errorEl.textContent = message; errorEl.hidden = false; }
      ctx.say(message);
    }
    finally { if (button) { button.disabled = false; button.textContent = label; } }
  }
  global.SoduWorkPluginMakerUtils = { html, errorText, values, clone, compareVersions, nextVersion, resourceMarkup, choosePackage, openConversationDraft };
})(window);
