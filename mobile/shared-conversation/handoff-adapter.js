(function (global) {
  'use strict';
  function mount(el, options) {
    const pop = el.querySelector('#nchatMorePop');
    if (!pop) return {render() {}, destroy() {}};
    const life = new AbortController(), buttons = [];
    let busy = false, epoch = 0;
    const ref = () => options.state().ref || '';
    let lastRef = ref();
    const current = (scope, ticket) => !life.signal.aborted && ref() === scope && epoch === ticket;
    function render() {
      if (lastRef !== ref()) {lastRef = ref(); epoch++;}
      const exists = Boolean(ref() && global.SoduWorkMobileSession.taskId(ref()));
      for (const button of buttons) {
        button.disabled = busy || !exists;
        button.title = exists ? '' : '先产生对话记录，再从此对话创建';
        button.setAttribute('aria-busy', String(busy));
      }
    }
    async function open(kind) {
      if (busy || life.signal.aborted) return;
      const scope = ref(), taskId = global.SoduWorkMobileSession.taskId(scope);
      if (!scope || !taskId) {options.say('先产生对话记录，再从此对话创建'); return;}
      const ticket = ++epoch;
      const instruction = String(el.querySelector('#nchatInput')?.value || '');
      busy = true; render(); pop.hidden = true;
      el.querySelector('#nchatMore')?.setAttribute?.('aria-expanded', 'false');
      try {
        const value = await global.soduWorkAPI.conversationSession.snapshot(scope);
        if (!current(scope, ticket)) return;
        if (value?.ok !== true || !value.snapshot) throw Error('暂时无法读取此对话，请稍后重试');
        const context = await global.ChatWorkIntent.create({_snap: value.snapshot})
          ._workConversationContext('', {includeFiles: false});
        if (!current(scope, ticket)) return;
        if (!context?.text?.trim()) throw Error('此对话还没有可带入的正文');
        const result = await global.SoduWorkMobileBridge.call('handoff', {
          kind, taskId, contextText: context.text, turnCount: context.turnCount, instruction,
        });
        if (!current(scope, ticket) || result?.cancelled === true) return;
        if (result?.ok !== true || !result.id) throw Error(result?.message || '创建结果尚未确认，请到对应列表核对');
        options.say(result.partial === true
          ? result.message || '需求已保存，部分材料尚未上传，请在需求中继续处理'
          : (kind === 'requirement' ? '需求已创建' : '自动化已创建'));
      } catch (error) {
        if (current(scope, ticket)) options.say(error.message || '暂时无法创建，请稍后重试');
      } finally {
        busy = false;
        if (!life.signal.aborted) render();
      }
    }
    for (const [kind, label, path] of [
      ['requirement', '从此对话新建需求', 'M5 3h10l4 4v14H5z M9 11h6 M9 15h6'],
      ['automation', '从此对话新建自动化', 'M13 2L4 14h7l-1 8 10-13h-7z'],
    ]) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'wc-more-row';
      button.dataset.mobileHandoff = kind;
      button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + path + '"></path></svg><span><b></b></span>';
      button.querySelector('b').textContent = label;
      button.addEventListener('click', event => {
        event.preventDefault(); event.stopPropagation(); void open(kind);
      }, {signal: life.signal});
      buttons.push(button); pop.append(button);
    }
    render();
    return {render, destroy() {epoch++; life.abort(); buttons.forEach(button => button.remove());}};
  }
  global.SoduWorkMobileHandoff = {mount};
})(window);
