(function (global) {
  'use strict';
  const unavailable = '来源电脑未在线或尚未加载接力版本，请打开并登录同一账号';
  function notice(access = {}, acceptance) {
    if (acceptance?.binding) return {title: '本轮验收报告',
      text: '为保留本轮验收记录，此会话不能追加消息。请点击顶部“返回需求验收”查看结果或重新发起验收。'};
    const phase = access.relay?.phase;
    const titles = {prepared: '等待电脑接收', claimed: '正在确认发送', accepted: '正在同步回复',
      uncertain: '发送结果待确认', rejected: '消息未发送', closed: '发送请求已关闭'};
    if (access.personal && titles[phase]) return {title: titles[phase], text: access.reason || '请核对原请求的发送状态。'};
    if (access.personal && access.reason === unavailable) return {title: '电脑暂不可连接',
      text: '请打开电脑上的 SoduWork 并登录同一账号。连接恢复后可继续发送，已有消息仍可查看。'};
    return {title: access.personal ? '暂时无法发送' : '当前设备仅可查看',
      text: access.reason || '已有消息仍可查看，未发送的内容会保留。'};
  }
  global.SoduWorkMobileAccess = {notice};
  // Install before NativeChat captures the controller methods. Reject a known
  // read-only state before desktop send bookkeeping clears or fails a draft.
  const create = global.ChatSessionController.create;
  global.ChatSessionController.create = function (ctx) {
    const controller = create.call(this, ctx);
    for (const name of ['_send', '_sendCore']) {
      const send = controller[name];
      controller[name] = function (...args) {
        const access = ctx._snap?.mobileAccess;
        if (ctx._ref && access?.canSend === false) {
          global.petSay?.(notice(access, ctx._snap?.mobileAcceptance).text);
          return Promise.resolve(false);
        }
        return send.apply(this, args);
      };
    }
    return controller;
  };
})(window);
