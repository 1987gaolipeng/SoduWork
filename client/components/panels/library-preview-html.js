/* Fit opaque HTML previews without giving the document access to the app. */
(function (global) {
  'use strict';
  let sequence = 0;

  // Runs inside the sandbox. Layout and explicit member navigation stay scoped
  // to this frame; the host rechecks the member against the archive manifest.
  function reportLayout(channel, fragment) {
    let queued = false, changed = false, forced = false, resizing = false, previous = '';
    let fragmentReady = false, fragmentApplied = false;
    function scrollToFragment(value) {
      let name = value.replace(/^#/, '');
      try { name = decodeURIComponent(name); } catch (_) {}
      if (!name) { scrollTo(0, 0); return; }
      const target = document.getElementById(name) || document.getElementsByName(name)[0];
      if (target) target.scrollIntoView();
      else if (name.toLowerCase() === 'top') scrollTo(0, 0);
    }
    function applyInitialFragment() {
      if (!fragment || !fragmentReady || fragmentApplied || document.readyState !== 'complete') return;
      fragmentApplied = true;
      requestAnimationFrame(() => scrollToFragment(fragment));
    }
    function schedule(contentChanged = false, forceReply = false) {
      changed ||= contentChanged;
      forced ||= forceReply;
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        const root = document.documentElement, body = document.body;
        if (!body || !innerWidth) return;
        let width = Math.max(innerWidth, root.scrollWidth, body.scrollWidth);
        // A page can hide overflow on an outer shell. Include its visible
        // layout containers, while leaving intentional scrolling areas alone.
        const containers = [body, ...body.children];
        for (const child of [...body.children]) containers.push(...child.children);
        for (const element of containers) {
          const rect = element.getBoundingClientRect();
          if (!rect.width || !rect.height || rect.right <= 0) continue;
          const style = getComputedStyle(element);
          if (style.visibility === 'hidden' || style.display === 'none') continue;
          width = Math.max(width, rect.right);
          if (['hidden', 'clip'].includes(style.overflowX)) width = Math.max(width, rect.left + element.scrollWidth);
        }
        const key = innerWidth + ':' + Math.ceil(width);
        if (key !== previous || changed || forced) {
          parent.postMessage({ type: 'soduwork-html-layout', channel, viewport: innerWidth, width: Math.ceil(width), changed }, '*');
          previous = key;
        }
        changed = false; forced = false;
      });
    }
    function start() {
      const resized = new ResizeObserver(() => schedule(!resizing));
      [document.documentElement, document.body, ...document.body.children].forEach(element => resized.observe(element));
      new MutationObserver(() => schedule(!resizing)).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
      document.addEventListener('load', () => schedule(!resizing), true);
      document.fonts?.ready.then(() => schedule(!resizing));
      schedule();
    }
    addEventListener('load', applyInitialFragment, { once: true });
    addEventListener('resize', () => {
      resizing = true;
      requestAnimationFrame(() => requestAnimationFrame(() => { resizing = false; }));
      schedule();
    });
    addEventListener('message', event => {
      if (event.source !== parent || event.data?.channel !== channel) return;
      if (event.data.type === 'soduwork-html-measure') schedule(false, true);
      if (event.data.type === 'soduwork-html-fragment') { fragmentReady = true; applyInitialFragment(); }
    });
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || !event.isTrusted || event.defaultPrevented) return;
      event.preventDefault(); parent.postMessage({ type: 'soduwork-html-escape', channel }, '*');
    });
    document.addEventListener('click', event => {
      const anchor = event.target.closest?.('a');
      if (!anchor) return;
      if (!anchor.hasAttribute('data-soduwork-preview-path')) {
        const href = anchor.getAttribute('href');
        // srcdoc inherits the host's base URL. Handle local fragments here so
        // the browser never tries to load the host page inside the preview.
        if (href?.startsWith('#')) { event.preventDefault(); scrollToFragment(href); }
        return;
      }
      event.preventDefault();
      if (!event.isTrusted || event.button !== 0) return;
      parent.postMessage({ type: 'soduwork-html-navigate', channel,
        path: anchor.dataset.soduworkPreviewPath, fragment: anchor.dataset.soduworkPreviewFragment || '' }, '*');
    }, true);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
  }

  function attach(frame, html, { onClose, onNavigate, fragment = '' } = {}) {
    const stage = document.createElement('div'); stage.className = 'library-preview-html-stage';
    stage.setAttribute('aria-busy', 'true'); stage.append(frame);
    const channel = 'library-html-' + (++sequence) + '-' + global.crypto.randomUUID();
    let disposed = false, viewport = 0, width = 0, height = 0, pending = 0;
    let fitSteps = 0, previousOverflow = 0, fitLimited = false, initialFragmentSent = false;
    function resetFit() { fitSteps = 0; previousOverflow = 0; fitLimited = false; }
    function apply(logicalWidth) {
      viewport = logicalWidth;
      const scale = Math.min(1, width / logicalWidth);
      frame.style.width = logicalWidth + 'px'; frame.style.height = Math.ceil(height / scale) + 'px';
      frame.style.transform = 'scale(' + scale + ')';
    }
    function measure() {
      if (disposed) return;
      const nextWidth = stage.clientWidth, nextHeight = stage.clientHeight;
      if (!nextWidth || !nextHeight) return;
      const reflow = nextWidth !== width;
      width = nextWidth; height = nextHeight;
      if (reflow) resetFit();
      apply(reflow || !viewport ? width : viewport);
      frame.contentWindow?.postMessage({ type: 'soduwork-html-measure', channel }, '*');
    }
    function schedule() {
      if (!pending) pending = requestAnimationFrame(() => { pending = 0; measure(); });
    }
    function receive(event) {
      const value = event.data;
      if (disposed || event.source !== frame.contentWindow || value?.channel !== channel) return;
      if (value.type === 'soduwork-html-escape') {
        if (document.activeElement === frame && frame.checkVisibility()) onClose?.();
        return;
      }
      if (value.type === 'soduwork-html-navigate') {
        if (frame.checkVisibility() && typeof value.path === 'string' && value.path.length <= 1024
            && typeof value.fragment === 'string' && value.fragment.length <= 2048) onNavigate?.(value.path, value.fragment);
        return;
      }
      if (value.type !== 'soduwork-html-layout') return;
      if (!Number.isFinite(value.width) || value.width <= 0 || value.width > 100000 || !Number.isFinite(value.viewport)) return;
      if (!stage.clientWidth || Math.abs(value.viewport - viewport) > 2) return;
      // Recheck changed content at the actual column width so a formerly fixed
      // page can shrink or return to its responsive layout without reloading.
      if (value.changed && (viewport > width + 2 || fitLimited)) {
        resetFit();
        if (viewport > width + 2) { apply(width); return; }
      }
      const overflow = value.width - value.viewport;
      if (!fitLimited && overflow > 2) {
        // Relative widths plus padding (or vw overflow) can grow with every
        // viewport expansion. Keep those documents readable with their native
        // scrolling instead of repeatedly shrinking them toward zero.
        if (fitSteps >= 3 || (fitSteps && Math.abs(overflow - previousOverflow) <= 2)) {
          fitLimited = true; apply(width);
        } else {
          fitSteps++; previousOverflow = overflow; apply(Math.max(width, value.width));
        }
      } else if (!fitLimited) apply(Math.max(width, value.width));
      frame.style.opacity = '1'; stage.removeAttribute('aria-busy');
      // Wait for the fitted viewport to be acknowledged before locating the
      // initial anchor. Scrolling while the frame still has its default height
      // can be undone by the first responsive resize.
      if (fragment && !initialFragmentSent && Math.abs(value.viewport - viewport) <= 2) {
        initialFragmentSent = true;
        frame.contentWindow?.postMessage({ type: 'soduwork-html-fragment', channel }, '*');
      }
    }
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const fragmentJson = JSON.stringify(String(fragment).slice(0, 2048)).replace(/</g, '\\u003c');
    const script = doc.createElement('script'); script.textContent = '(' + reportLayout.toString() + ')(' + JSON.stringify(channel) + ',' + fragmentJson + ');';
    doc.body.append(script);
    frame.style.opacity = '0'; frame.srcdoc = '<!doctype html>' + doc.documentElement.outerHTML;
    global.addEventListener('message', receive); frame.addEventListener('load', schedule);
    const observer = new ResizeObserver(schedule); observer.observe(stage);
    return { element: stage, dispose() {
      disposed = true; observer.disconnect(); cancelAnimationFrame(pending);
      global.removeEventListener('message', receive); frame.removeEventListener('load', schedule);
    } };
  }
  global.SoduWorkLibraryHtmlPreview = { attach };
})(window);
