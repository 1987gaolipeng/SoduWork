/* A UI bookmark into the runtime transcript. Loading history never sends a turn. */
(function (global) {
  'use strict';
  function create(ctx) {
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
    return { capture, restore };
  }
  global.ChatReadingPosition = { create };
})(window);
