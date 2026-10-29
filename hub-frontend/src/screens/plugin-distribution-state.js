import { translateText as tx, localeMap, getLocale } from '../i18n.js'
export const INSTALLATION_LABEL = localeMap(() => ({
  available: '员工可按需安装',
  installed_by_default: '范围内成员默认安装',
  not_available: '不开放个人安装',
}))

function sourceState(version) {
  const signature = ((version || {}).provenance || {}).signatureState
  if (['platform', 'verified'].includes(signature)) {
    return {
      state: 'done',
      title: tx("来源已核验"),
      detail: signature === 'platform' ? tx("SoduWork 平台版本") : tx("发布者签名有效"),
    }
  }
  if (signature === 'unknown-key') {
    return { state: 'waiting', title: tx("待核对发布身份"), detail: tx("公钥尚未登记为可信发布者") }
  }
  if (signature === 'revoked-key') {
    return { state: 'blocked', title: tx("发布身份已撤销"), detail: tx("请使用有效身份签名并提交新版本") }
  }
  return { state: 'waiting', title: tx("来源待人工确认"), detail: tx("未提供可验证的发布签名") }
}

function qualityState(version, evaluationData) {
  const summary = (evaluationData && evaluationData.gate) ||
    (((version || {}).capabilities || {}).qualitySummary || {})
  const count = Number(summary.caseCount || 0)
  const passed = Number(summary.passedCount || 0)
  const ready = Number(summary.readyCount || 0)
  if (!count) {
    return { state: 'waiting', title: tx("未声明发布评测"), detail: tx("启用时需要管理员明确确认风险") }
  }
  if (summary.ok || summary.verified || passed === count) {
    return { state: 'done', title: tx("发布评测已通过"), detail: tx("{0}/{1} 个代表性场景", [passed, count]) }
  }
  if (summary.readyForApproval) {
    return { state: 'done', title: tx("自动验证已完成"), detail: tx("{0}/{1} 个场景；发布确认时一并归档", [passed + ready, count]) }
  }
  return { state: 'waiting', title: tx("发布评测未完成"), detail: tx("{0}/{1} 个场景已通过", [passed, count]) }
}

function reviewState(version) {
  if (version.trustState === 'approved' && version.enabled) {
    return { state: 'done', title: tx("企业审核已通过"), detail: tx("当前不可变版本允许被调用") }
  }
  if (version.trustState === 'revoked') {
    return { state: 'blocked', title: tx("版本已撤销"), detail: tx("不能启动新的执行或安装") }
  }
  return { state: 'waiting', title: tx("等待企业审核"), detail: tx("版本仍在隔离区，不会对员工生效") }
}

function audienceText(version, audienceData) {
  if (version.visibility === 'users') {
    const count = audienceData && !audienceData.loading && !audienceData.error
      ? (audienceData.items || []).length : version.audienceCount || 0
    return tx("指定 {0} 位成员", [count])
  }
  if (version.visibility === 'org_units') {
    const count = audienceData && !audienceData.loading && !audienceData.error
      ? (audienceData.items || []).length : version.audienceCount || 0
    return tx("指定 {0} 个团队及其成员", [count])
  }
  return tx("全公司成员")
}

export function buildPluginDistributionState({ plugin, version, evaluationData, audienceData, lightweight = false }) {
  const policy = plugin.catalogPolicy || { installation: 'available' }
  const approved = plugin.enabled !== false && version.trustState === 'approved' && version.enabled
  const bindings = (plugin.bindings || []).filter((item) =>
    item.enabled && item.versionId === version.id)
  const catalogOpen = approved && policy.installation !== 'not_available'
  const taskOpen = approved && bindings.length > 0
  const source = sourceState(version)
  const quality = qualityState(version, evaluationData)
  const review = reviewState(version)
  const lightweightNext = review.state === 'blocked'
    ? tx("需要发布新版本并重新完成审核。")
    : review.state !== 'done'
      ? tx("下一步：管理员核对来源、用途、权限和使用范围后审核上架。")
      : !catalogOpen && !taskOpen
        ? tx("版本已审核，尚未开放员工使用或需求绑定。")
        : tx("企业审核已完成；员工目录与需求绑定按各自策略生效。")
  const strictNext = review.state === 'blocked'
    ? tx("需要发布新版本并重新完成审核。")
    : source.state !== 'done'
      ? tx("下一步：核对发布者身份与包来源。")
      : quality.state !== 'done'
        ? tx("下一步：完成代表性发布评测。")
        : review.state !== 'done'
          ? tx("下一步：管理员审查并启用这个不可变版本。")
          : !catalogOpen && !taskOpen
            ? tx("版本可信，但尚未开放员工安装，也没有需求绑定。")
            : tx("公共发布基础已就绪；两条使用通道按各自策略独立生效。")
  const signature = version.provenance?.signatureState
  const next = signature === 'revoked-key' ? tx("发布身份已撤销，请作者使用有效身份签名并提交新版本。")
    : signature === 'unknown-key' ? tx("下一步：在审核页核对发布者身份并登记可信公钥，再审核上架。")
      : lightweight ? lightweightNext : strictNext
  return {
    policy,
    approved,
    bindings,
    catalogOpen,
    taskOpen,
    source,
    quality,
    review,
    next,
    audience: audienceText(version, audienceData),
  }
}
