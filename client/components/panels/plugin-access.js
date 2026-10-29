/* Enterprise authoring entries always obtain a fresh server authorization. */
(function (global) {
  'use strict';
  let activeDetail = null;
  let revision = 0;
  async function assertEditable(draft) {
    if (!draft?.sourcePluginId) return;
    const permissions = await SoduWorkAPI.enterprisePluginPermissions(draft.sourcePluginId);
    if (permissions?.canEdit !== true) throw new Error('当前没有编辑改进权限，请联系管理员');
  }
  function actions(item, taskOnly) {
    if (item.personal) return '';
    const hidden = item.permissions?.canEdit === true ? '' : ' hidden';
    return '<button class="btn-mini" id="capEnterpriseEdit"' + hidden + '>编辑新版本</button>' +
      '<button class="btn-mini" id="capEnterpriseImprove"' + hidden + '>用 SoduWork 改进</button>';
  }
  function bind(layer, item, ctx, openMaker, refreshDetail) {
    if (item.personal) return;
    const current = { layer, item, refreshDetail, button: layer.querySelector('#capEnterpriseEdit') };
    activeDetail = current;
    ++revision;
    [['#capEnterpriseEdit', false], ['#capEnterpriseImprove', true]].forEach(([selector, improve]) => {
      const button = layer.querySelector(selector);
      if (!button) return;
      button.addEventListener('click', async function () {
        this.disabled = true;
        try {
          const result = await SoduWorkAPI.enterprisePluginDraft(item.pluginId);
          if (!layer.isConnected || layer.hidden || this.isConnected === false || activeDetail !== current) return;
          if (!result?.draft) throw new Error('没有读取到可编辑的插件版本');
          if (improve) {
            if (typeof ctx.createWithAgent !== 'function') throw new Error('插件开发助手暂不可用');
            ctx.createWithAgent(result.draft);
          } else {
            ctx.closeModal();
            openMaker(ctx, result.draft, []);
          }
        } catch (error) {
          ctx.say(ctx.errorText(error, '当前没有编辑改进权限，请联系管理员'));
        } finally { this.disabled = false; }
      });
    });
  }
  async function refresh(event) {
    const current = activeDetail;
    if (!current || !current.layer.isConnected || current.layer.hidden ||
        current.layer.querySelector('#capEnterpriseEdit') !== current.button ||
        (event.detail?.pluginId && event.detail.pluginId !== current.item.pluginId)) return;
    const request = ++revision;
    let permissions;
    try { permissions = await SoduWorkAPI.enterprisePluginPermissions(current.item.pluginId); }
    catch (_) { permissions = { canUse: false, canEdit: false }; }
    const isCurrent = () => request === revision && activeDetail === current && current.layer.isConnected &&
      !current.layer.hidden && current.layer.querySelector('#capEnterpriseEdit') === current.button;
    if (!isCurrent()) return;
    current.layer.querySelectorAll('#capPluginTry, #capEnterpriseInstall, #capPluginOpenUI').forEach(button => {
      // Grants cannot override missing connections or other original blockers.
      if (button.dataset.accessOriginalDisabled === undefined) button.dataset.accessOriginalDisabled = String(button.disabled);
      button.disabled = permissions.canUse !== true || button.dataset.accessOriginalDisabled === 'true';
    });
    current.layer.querySelectorAll('#capEnterpriseEdit, #capEnterpriseImprove').forEach(button => {
      button.hidden = permissions.canEdit !== true;
      button.disabled = permissions.canEdit !== true;
    });
    // A denied detail never rendered installation/use controls. Refresh its
    // authoritative catalog state instead of only toggling existing buttons.
    if (current.refreshDetail) {
      await current.refreshDetail(permissions, isCurrent);
    }
  }
  global.addEventListener('soduwork-plugin-policy', refresh);
  global.addEventListener('soduwork-data-scope-changed', function () { activeDetail = null; ++revision; });
  global.SoduWorkPluginAccess = { actions, bind, assertEditable };
})(window);
