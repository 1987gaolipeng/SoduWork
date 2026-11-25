/* A UI bookmark into the runtime transcript. Loading history never sends a turn. */
(function (global) {
  'use strict';
  function create(ctx) {
    let reader;
    function closeEarlier() { reader?.close(); reader?.remove(); reader = null; }
    global.addEventListener?.('soduwork-data-scope-changed', closeEarlier);
    // Older pages use the same authorized snapshot channel. Keep them out of
    // the active composer and its bounded stream of live updates.
    async function openEarlier(end) {
      closeEarlier();
      const ref = ctx._ref, epoch = ctx._viewEpoch, scope = ctx._draftScopeEpoch;
      const dialog = document.createElement('dialog');
      reader = dialog;
      const tr = value => global.SoduWorkI18n?.translateText?.(value) || value;
      dialog.className = 'nchat-history-page';
      dialog.setAttribute('aria-label', tr('历史记录'));
      dialog.append(global.ChatDomPatch.htmlFragment('<header><b></b><button type="button"></button></header><section></section>' +
        '<footer><button type="button"></button><span role="status"></span><button type="button"></button></footer>'));
      const [close, previous, next] = dialog.querySelectorAll('button');
      const body = dialog.querySelector('section'), status = dialog.querySelector('[role="status"]');
      dialog.querySelector('b').textContent = tr('历史记录');
      close.textContent = tr('关闭'); previous.textContent = tr('上一页'); next.textContent = tr('下一页');
      const current = () => reader === dialog && dialog.open && ctx._ref === ref &&
        ctx._viewEpoch === epoch && ctx._draftScopeEpoch === scope;
      const ends = [end]; let position = -1, start = end;
      async function load(page) {
        previous.disabled = next.disabled = true;
        status.textContent = tr('正在加载更早记录…');
        try {
          const reply = await ctx._api().snapshot(ref, { messageEnd: ends[page], messageLimit: 80, toolLimit: 160 });
          if (!current()) return;
          const snap = reply?.snapshot, history = snap?.history;
          if (!reply?.ok || history?.messageEnd !== ends[page] || !(history.messageStart < ends[page]))
            throw Error(reply?.reason || tr('更早的对话暂时加载失败，请稍后重试'));
          const fragment = document.createDocumentFragment();
          const add = (tag, content) => { const node = document.createElement(tag); node.textContent = content; fragment.append(node); };
          const summaries = global.ChatTurnSummary;
          const tools = global.ChatTools?.displayTools?.(snap) || snap.tools || [];
          const last = history.messageIndices.at(-1);
          const endsTurn = history.nextIsUser || snap.turnMetrics?.some(turn => turn.toMessage === last);
          const finals = ctx._finalReplyIndexes(snap.messages, tools, endsTurn);
          const turns = new Map(summaries.project(snap, finals).filter(turn => !turn.outcome ||
            snap.turnMetrics.some(metric => metric.outcome === turn.outcome && metric.toMessage === history.messageIndices[turn.to]))
            .map(turn => [turn.outcome ? turn.to : turn.finalIndex, turn]));
          const byMessage = new Map();
          for (const tool of tools) {
            if (!byMessage.has(tool.after)) byMessage.set(tool.after, []);
            byMessage.get(tool.after).push(tool);
          }
          for (const [index, message] of snap.messages.entries()) {
            add('strong', tr(message.role === 'user' ? '用户' : '助手'));
            const text = message.role === 'user' ? message.text : (message.blocks || []).filter(block => block.kind === 'text')
              .map(block => block.text).filter(Boolean).join('\n\n');
            if (text) add('p', text);
            for (const block of message.blocks || []) if (block.kind === 'thinking' && block.text) {
              const thought = document.createElement('details'), title = document.createElement('summary');
              title.textContent = tr('思考过程'); thought.append(title, document.createTextNode(block.text)); fragment.append(thought);
            }
            for (const item of message.attachments || []) if (item.name) add('small', item.name);
            for (const tool of byMessage.get(index) || []) {
              const presentation = global.ChatTools?.render?.(tool);
              const label = [tr(presentation?.title || tool.name), presentation?.sub].filter(Boolean).join(' · ');
              if (!presentation || presentation.summaryOnly) { add('small', label); continue; }
              const receipt = document.createElement('details'), title = document.createElement('summary');
              title.textContent = label; receipt.append(title); fragment.append(receipt);
              receipt.ontoggle = () => {
                if (!receipt.open || receipt.childElementCount > 1) return;
                const result = document.createElement('div');
                result.append(global.ChatDomPatch.htmlFragment(presentation.body));
                receipt.append(result);
              };
            }
            const turn = turns.get(index);
            if (turn?.outcome === 'stopped') add('small', summaries.stoppedText(turn.elapsedMs));
            else if (turn?.outcome === 'interrupted') add('small', tr('本轮已中断'));
            else if (turn) add('small', tr('用时') + ' ' + summaries.formatDuration(turn.elapsedMs));
          }
          body.replaceChildren(fragment); body.setAttribute('data-user-content', '');
          body.scrollTop = page >= position ? body.scrollHeight : 0;
          start = history.messageStart; position = page;
          status.textContent = (start + 1) + '–' + history.messageEnd + ' / ' + history.totalMessages;
        } catch (error) {
          if (current()) status.textContent = error.message;
        } finally {
          if (current()) { previous.disabled = start === 0; next.disabled = position <= 0; }
        }
      }
      previous.onclick = () => { ends[position + 1] = start; void load(position + 1); };
      next.onclick = () => { if (position > 0) void load(position - 1); };
      close.onclick = () => dialog.close();
      dialog.onclose = () => { dialog.remove(); if (reader === dialog) reader = null; };
      ctx._mount().append(dialog); dialog.showModal();
      await load(0);
    }
    const scrollOf = () => ctx._mount()?.querySelector('#nchatScroll');
    const messageNodes = scroll => [...(scroll?.querySelectorAll('[data-chat-node^="message:"]') || [])]
      .filter(node => /^message:\d+$/.test(node.dataset.chatNode || ''));
    const windowSize = () => Number(ctx._snap?.history?.messageLimit) ||
      Number(ctx._snap?.history?.loadedMessages) || Number(ctx._messageWindowSize) || 80;
    function capture() {
      const scroll = scrollOf();
      if (!scroll || !ctx._ref) return null;
      const start = Math.max(0, Number(ctx._snap?.history?.messageStart) || 0);
      const reading = { top: Math.max(0, Number(scroll.scrollTop) || 0),
        follow: scroll.__soduworkScrollFollow?.follow === true,
        messageLimit: Math.min(2000, Math.max(80, windowSize())), messageStart: start };
      const bounds = scroll.getBoundingClientRect();
      const node = messageNodes(scroll).find(item => {
        const box = item.getBoundingClientRect(); return box.bottom > bounds.top && box.top < bounds.bottom;
      });
      if (node) reading.anchor = { index: ctx._snap?.history?.messageIndices?.[Number(node.dataset.chatNode.slice(8))] ??
          start + Number(node.dataset.chatNode.slice(8)),
        offset: node.getBoundingClientRect().top - bounds.top };
      return reading;
    }
    async function restore(reading, isCurrent = () => true) {
      if (!reading || reading.follow !== false || !ctx._ref) return false;
      const scroll = scrollOf(), ref = ctx._ref, epoch = ctx._viewEpoch, scope = ctx._draftScopeEpoch;
      const interaction = scroll?.__soduworkScrollFollow?.interaction || 0;
      const current = () => isCurrent() && ref === ctx._ref && epoch === ctx._viewEpoch && scope === ctx._draftScopeEpoch &&
        scroll === scrollOf() && interaction === (scroll?.__soduworkScrollFollow?.interaction || 0);
      scroll?.__soduworkScrollFollow?.pause?.();
      const total = Number(ctx._snap?.history?.totalMessages) || ctx._snap?.messages?.length || 0;
      const start = Number.isSafeInteger(reading.messageStart) ? reading.messageStart : total;
      const limit = Math.min(2000, Math.max(80, Number(reading.messageLimit) || 80, total - start));
      if (limit > windowSize()) {
        for (let attempt = 0; attempt < 3; attempt++) {
          const before = ctx._snap;
          const reply = await ctx._api()?.snapshot(ref, { messageLimit: limit, toolLimit: limit * 2 });
          if (!current() || !reply?.ok || !reply.snapshot) return false;
          // The request expands subsequent runtime publications too. Prefer a
          // newer event covering this window; retry a stale initial refresh.
          if (ctx._snap === before) { ctx._snap = reply.snapshot; break; }
          if (windowSize() >= limit) break;
          if (attempt === 2) return false;
        }
        ctx._messageWindowSize = Math.max(limit, windowSize());
        ctx._render();
      }
      return new Promise(resolve => {
        let frames = 0, stable = 0;
        const paint = fn => global.requestAnimationFrame ? global.requestAnimationFrame(fn) : global.setTimeout(fn, 16);
        const apply = () => {
          if (!current() || !scroll) { resolve(false); return; }
          if (scroll.__soduworkScrollFollow?.pause) scroll.__soduworkScrollFollow.pause();
          else if (scroll.__soduworkScrollFollow) scroll.__soduworkScrollFollow.follow = false;
          const anchor = reading.anchor;
          const indices = ctx._snap?.history?.messageIndices;
          const localIndex = Array.isArray(indices) ? indices.indexOf(anchor?.index) :
            anchor?.index - (Number(ctx._snap?.history?.messageStart) || 0);
          const node = Number.isSafeInteger(localIndex) && messageNodes(scroll)
            .find(item => item.dataset.chatNode === 'message:' + localIndex);
          const top = node && Number.isFinite(anchor.offset)
            ? Math.max(0, scroll.scrollTop + node.getBoundingClientRect().top - scroll.getBoundingClientRect().top - anchor.offset)
            : Math.max(0, Number(reading.top) || 0);
          stable = Math.abs(scroll.scrollTop - top) < 1 ? stable + 1 : 0;
          scroll.scrollTop = top;
          // content-visibility materializes messages after they enter the
          // viewport, changing estimated heights. Recheck after paint, bounded
          // to this navigation and interrupted immediately by user scrolling.
          if (++frames < 20 && stable < 3) paint(apply);
          else resolve(true);
        };
        paint(apply);
      });
    }
    async function revealSearchMatch(query, isCurrent = () => true) {
      const words = String(query || '').toLocaleLowerCase().split(/\s+/u).filter(Boolean);
      if (!words.length || !isCurrent()) return false;
      const ref = ctx._ref, epoch = ctx._viewEpoch, scope = ctx._draftScopeEpoch;
      const current = () => isCurrent() && ref === ctx._ref && epoch === ctx._viewEpoch && scope === ctx._draftScopeEpoch;
      if (!await restore({ top: 0, follow: false, messageStart: 0, messageLimit: 2000 }, current) || !current()) return false;
      const title = String(ctx._snap?.title || '').toLocaleLowerCase();
      const index = (ctx._snap?.messages || []).findIndex(message => {
        const text = [title, message.text, ...(message.blocks || []).filter(block => block.kind === 'text').map(block => block.text)].join(' ').toLocaleLowerCase();
        return words.every(word => text.includes(word));
      });
      if (index < 0) return false;
      const absolute = ctx._snap?.history?.messageIndices?.[index] ?? (Number(ctx._snap?.history?.messageStart) || 0) + index;
      return restore({ follow: false, messageStart: absolute, anchor: { index: absolute, offset: 24 } }, current);
    }
    return { capture, restore, revealSearchMatch, openEarlier, closeEarlier };
  }
  global.ChatReadingPosition = { create };
})(window);
