/* Isolated plugin library scenarios. All actions stay in this fixture's memory. */
(function () {
  const params = new URLSearchParams(location.search);
  const scenario = params.get('scenario') || 'mixed';
  const skin = SkinRegistry.getSkin(params.get('skin') || 'flat-azure');
  if (skin) { document.documentElement.dataset.skin = skin.material; document.documentElement.dataset.theme = skin.palette; }
  const categories = [{ key: 'office', name: '办公写作', enabled: true, sort: 0 },
    { key: 'research', name: '研究分析', enabled: true, sort: 1 }, { key: 'dev', name: '研发工具', enabled: true, sort: 2 }];
  fixtureItems.forEach((item, index) => {
    item.category = categories[index % 3].key;
    item.marketPolicy = { configured: true, category: item.category, installation: 'available' };
    item.listed = !item.personal;
  });
  fixtureItems[2].setupState = 'required';
  const available = { ...structuredClone(fixtureItems[1]), pluginId: 'available-only', installed: false, name: '企业知识检索', description: '检索团队知识并保留引用。' };
  const submissions = Array.from({ length: 8 }, (_, index) => ({
    pluginId: 'submission-' + index, name: ['周报整理', '项目风险检查', '采购材料研读', '合同信息整理', '知识归档', '会议纪要', '业务数据汇总', '第八份插件'][index],
    version: '1.0.' + index, trustState: index === 1 ? 'approved' : 'quarantined', enabled: index === 1,
    reviewDecision: index === 2 ? 'reject' : index === 1 ? 'approve' : '', reviewNote: index === 2 ? '请补充交付样例，再提交审核。' : '',
    sourceKind: 'personal', scope: 'organization', reviewMode: 'internal-light', catalogReady: index === 1,
  }));
  let calls = 0;
  SoduWorkAPI.pluginCatalog = async () => {
    calls++;
    if (scenario === 'error' && calls === 1) throw Error('隔离测试：目录请求暂时失败');
    if (scenario === 'refresh' && calls > 1) fixtureItems[1].description = '目录已同步：生成团队演示文稿。';
    return { items: scenario === 'empty' ? [] : scenario === 'offline' ? fixtureItems.filter(item => item.personal) : fixtureItems.concat(available),
      submissions: scenario === 'empty' ? [] : submissions, categories,
      remoteError: scenario === 'offline' ? 'Isolated offline fixture' : '' };
  };
  const label = document.getElementById('fixtureLabel');
  if (label) label.innerHTML = '<b>SoduWork</b><p>插件库改版验收<br>隔离演示数据<br>不修改真实插件</p>';
  // Record trial navigation and import dispatch through the real page's handlers.
  window.soduWorkAPI = { personalPlugins: { choosePackage: async () => {
    fixtureCalls.push(['pick-package']); return { canceled: true };
  } } };
})();
