/* Keyed DOM updates preserve tool expansion, media nodes and reading state. */
(function (global) {
  'use strict';
  /*
   * Preserve tool-card DOM nodes during streaming to retain hover, selection, and expansion
   * state. Patch tool status/content incrementally and key other messages by stable
   * identity.
   */
  function _syncTool(current, next) {
    if (current.className !== next.className) current.className = next.className;
    const head = current.querySelector('.ntool-head');
    const nextHead = next.querySelector('.ntool-head');
    if (head && nextHead && head.nodeName !== nextHead.nodeName) {
      // A generating summary becomes a real file action once execution starts.
      // Keep the keyed row, but update the control, action attributes and body.
      patchContent(current, next); return;
    }
    if (head && nextHead) {
      head.title = nextHead.title || '';
      const icon = head.querySelector('.ntool-icon'), nextIcon = nextHead.querySelector('.ntool-icon');
      if (icon && nextIcon && icon.dataset.toolKind !== nextIcon.dataset.toolKind) icon.replaceWith(nextIcon);
      ['.ntool-name', '.ntool-args'].forEach((selector) => {
        const left = head.querySelector(selector); const right = nextHead.querySelector(selector);
        if (left && right && left.textContent !== right.textContent) left.textContent = right.textContent;
      });
    }
    const body = current.querySelector('.ntool-body');
    const nextBody = next.querySelector('.ntool-body');
    if (body && nextBody && body.innerHTML !== nextBody.innerHTML) body.innerHTML = nextBody.innerHTML;
  }
  function _syncBatch(current, next) {
    if (current.className !== next.className) current.className = next.className;
    const head = current.querySelector('.ntool-batch-head');
    const nextHead = next.querySelector('.ntool-batch-head');
    if (head && nextHead) {
      head.setAttribute('aria-expanded', nextHead.getAttribute('aria-expanded') || 'false');
      if (head.innerHTML !== nextHead.innerHTML) head.innerHTML = nextHead.innerHTML;
    }
    const body = current.querySelector('.ntool-batch-body');
    const nextBody = next.querySelector('.ntool-batch-body');
    if (body && nextBody) _syncTools(body, nextBody);
  }
  function _syncTools(current, next) {
    const old = new Map([...current.children].map((node) => [node.dataset.toolNode || '', node]));
    [...next.children].forEach((wanted, index) => {
      const key = wanted.dataset.toolNode || '';
      const node = key && old.get(key) ? old.get(key) : wanted;
      if (node !== wanted) {
        if (node.classList.contains('ntool-batch') && wanted.classList.contains('ntool-batch')) {
          _syncBatch(node, wanted);
        } else _syncTool(node, wanted);
      }
      const at = current.children[index];
      if (at !== node) current.insertBefore(node, at || null);
      old.delete(key);
    });
    old.forEach((node) => node.remove());
  }
  function _messageChildKey(node, index) {
    if (node?.dataset?.workflowMessageKey) return 'workflow:' + node.dataset.workflowMessageKey;
    if (node && node.classList && node.classList.contains('nthink')) {
      const head = node.querySelector('.nthink-head[data-think]');
      return 'thinking:' + String(head && head.getAttribute('data-think') || index);
    }
    if (node && node.classList && node.classList.contains('ntext')) {
      const block = node.getAttribute('data-block');
      return 'text:' + (block != null && block !== '' ? block : index);
    }
    /*
     * Delivery/media decorations have stable business keys. Positional keys would rebuild
     * later blocks after insertion, losing intrinsic-height measurements and scroll position.
     */
    const decoKey = node && (node.getAttribute('data-delivery') || node.getAttribute('data-cloud-artifact-url') ||
      node.getAttribute('data-output-image') || node.getAttribute('data-output-video') ||
      node.getAttribute('data-install-plugin-draft') ||
      (node.dataset && node.dataset.chatNode && node.dataset.chatNode.startsWith('plugin-draft:') ? node.dataset.chatNode : ''));
    if (decoKey) return 'deco:' + decoKey;
    return 'other:' + index;
  }
  function _syncThinking(current, next) {
    const bodyBefore = current.querySelector('.nthink-body');
    /* A row skipped by content-visibility has no user-visible scroll state;
       reading its scroll metrics would force the entire row to lay out on
       every structural re-render of a long transcript. */
    const hidden = typeof current.checkVisibility === 'function' &&
      !current.checkVisibility({ contentVisibilityAuto: true });
    const follow = !bodyBefore || hidden ? false :
      bodyBefore.scrollHeight - bodyBefore.scrollTop - bodyBefore.clientHeight < 36;
    if (current.className !== next.className) current.className = next.className;
    const head = current.querySelector('.nthink-head');
    const nextHead = next.querySelector('.nthink-head');
    if (head && nextHead) {
      const label = head.querySelector('span');
      const nextLabel = nextHead.querySelector('span');
      if (label && nextLabel && label.textContent !== nextLabel.textContent) {
        label.textContent = nextLabel.textContent;
      }
      if (head.title !== (nextHead.title || '')) head.title = nextHead.title || '';
      const expanded = nextHead.getAttribute('aria-expanded') || 'false';
      if (head.getAttribute('aria-expanded') !== expanded) head.setAttribute('aria-expanded', expanded);
    }
    const body = current.querySelector('.nthink-body');
    const nextBody = next.querySelector('.nthink-body');
    if (body && nextBody && body.textContent !== nextBody.textContent) {
      body.textContent = nextBody.textContent;
      if (!hidden && follow && current.classList.contains('is-live')) body.scrollTop = body.scrollHeight;
    }
  }
  function _syncMessage(current, next, opts = {}) {
    // A projected message:N can name a different reply after history slides.
    // Only the same original reply may retain decorator-owned children.
    const sameOwner = current.dataset.messageOwner === next.dataset.messageOwner;
    /* Writing the same className still runs attribute-changed invalidation on
       every reused row; with content-visibility rows that cost scales with the
       transcript length, so only write when the class actually changed. */
    if (current.className !== next.className) current.className = next.className;
    if (next.hasAttribute('data-output-task')) current.dataset.outputTask = next.dataset.outputTask;
    for (const name of ['deliveryFinal', 'deliveryCurrent', 'messageOwner']) {
      if (next.dataset[name] !== undefined && current.dataset[name] !== next.dataset[name]) current.dataset[name] = next.dataset[name];
      else if (next.dataset[name] === undefined && current.dataset[name] !== undefined) {
        current.removeAttribute('data-' + name.replace(/[A-Z]/g, char => '-' + char.toLowerCase()));
      }
    }
    const old = new Map([...current.children].map((node, index) =>
      [_messageChildKey(node, index), node]));
    [...next.children].forEach((wanted, index) => {
      const key = _messageChildKey(wanted, index);
      let node = old.get(key);
      if (!node) {
        node = wanted;
      } else if (sameOwner && next.dataset.messageOwner !== undefined && key.startsWith('workflow:')) {
        // Workflow decisions belong to this exact native message, including
        // failed/waiting replies. Keep their live controls and keyboard focus.
      } else if (node.classList.contains('nthink') &&
          wanted.classList.contains('nthink')) {
        _syncThinking(node, wanted);
      } else if (node.classList.contains('ntext') &&
          wanted.classList.contains('ntext')) {
        patchContent(node, wanted);
      } else if (node.dataset.outputImage && node.dataset.outputImage === wanted.dataset.outputImage &&
          node.dataset.outputVersion === wanted.dataset.outputVersion && node.dataset.outputScope === wanted.dataset.outputScope) {
        // Keep decoded image pixels and in-flight thumbnail requests during streaming.
      } else if (node.dataset.outputVideo && node.dataset.outputVideo === wanted.dataset.outputVideo &&
          node.dataset.outputVersion === wanted.dataset.outputVersion && node.dataset.outputScope === wanted.dataset.outputScope) {
        // A text update must not restart an already playing video.
      } else if (node.outerHTML !== wanted.outerHTML) {
        node.replaceWith(wanted);
        node = wanted;
      }
      const at = current.children[index];
      if (at !== node) current.insertBefore(node, at || null);
      old.delete(key);
    });
    old.forEach((node, key) => {
      // During streaming the raw HTML carries no cards; decorator-owned
      // children are preserved in place and reconciled after the patch
      // (chat-decorate-carry) so their DOM identity — entry animations,
      // decoded pixels, install-error state — survives every structural
      // re-render. Removal happens only through the superseded rule there,
      // or naturally once the settled decorate output drops them.
      if (opts.preserveDeco && sameOwner && next.dataset.deliveryFinal !== 'false' && key.startsWith('deco:')) return;
      node.remove();
    });
  }
  // Streaming appends must retain earlier paragraphs/images and an open context
  // tooltip. Replacing innerHTML restarts CSS entry animations on every token.
  function patchContent(current, next) {
    if (global.ChatMedia?.same(current, next)) return;
    if (current?.dataset?.chatMedia || next?.dataset?.chatMedia) { current.replaceWith(next); return; }
    if (current.isEqualNode(next)) return;
    if (current.nodeType !== 1) { current.nodeValue = next.nodeValue; return; }
    for (const attr of Array.from(current.attributes)) {
      if (!next.hasAttribute(attr.name)) current.removeAttribute(attr.name);
    }
    for (const attr of Array.from(next.attributes)) {
      if (current.getAttribute(attr.name) !== attr.value) current.setAttribute(attr.name, attr.value);
    }
    const old = Array.from(current.childNodes), desired = Array.from(next.childNodes);
    desired.forEach((wanted, i) => {
      const node = old[i];
      if (!node) current.appendChild(wanted);
      else if (node.nodeType !== wanted.nodeType || node.nodeName !== wanted.nodeName) node.replaceWith(wanted);
      else patchContent(node, wanted);
    });
    old.slice(desired.length).forEach(node => node.remove());
  }
  /* Direct attribute lookup instead of scanning every keyed node. The common
     keys (message:N, tool ids) are selector-safe; this used to run per token
     batch, thinking block and running tool during streaming. */
  function findDataNode(root, attribute, value) {
    if (!root || !root.querySelectorAll) return null;
    if (typeof attribute === 'string' && /^[\w-]+$/.test(attribute)) {
      const wanted = String(value);
      if (!/["\\]/.test(wanted)) {
        const direct = root.querySelector('[' + attribute + '="' + wanted + '"]');
        if (direct) return direct;
        if (!wanted) return null;
      }
    }
    const nodes = root.querySelectorAll('[' + attribute + ']');
    for (const node of nodes) {
      if (node.getAttribute(attribute) === String(value)) return node;
    }
    return null;
  }
  // Accept markup assembled by the escaped chat renderers, never raw receipt text.
  function htmlFragment(html) {
    const template = document.createElement('template'); template.innerHTML = String(html || '');
    return template.content;
  }
  function patchHtml(current, html) {
    const next = current.cloneNode(false);
    next.appendChild(htmlFragment(html));
    patchContent(current, next);
  }
  function patchList(host, html, opts = {}) {
    if (!host || typeof document === 'undefined') return;
    const fragment = htmlFragment(html);
    const old = new Map([...host.children].map((node) => [node.dataset.chatNode || '', node]));
    [...fragment.children].forEach((wanted, index) => {
      const key = wanted.dataset.chatNode || '';
      let node = key && old.get(key) ? old.get(key) : wanted;
      if (node === wanted && key.startsWith('task-confirmation:') && global.TaskTraceApproval) {
        global.TaskTraceApproval.remember(node);
      }
      if (node !== wanted) {
        if (key === 'workflow-history' && node.dataset.workflowRef === wanted.dataset.workflowRef) {
          // The one active workflow owns this compact older-history entry.
          // Reconciliation after the patch handles its run/ref and visibility.
        }
        else if (key.startsWith('work-card:') && node.dataset.workCardSlot === wanted.dataset.workCardSlot) {
          // The card controller owns its form, receipt and focus inside this slot.
        }
        else if (key.startsWith('tools:')) _syncTools(node, wanted);
        else if (key.startsWith('message:')) _syncMessage(node, wanted, opts);
        else if (key.startsWith('task-confirmation:') && global.TaskTraceApproval) node = global.TaskTraceApproval.patch(node, wanted);
        else if (node.outerHTML !== wanted.outerHTML) { node.replaceWith(wanted); node = wanted; }
      }
      const at = host.children[index];
      if (at !== node) {
        // Moving a message past a metrics row must not blur a focused workflow
        // decision. Chromium's state-preserving move keeps the live subtree.
        if (typeof host.moveBefore === 'function' && host.isConnected && node.parentNode === host) host.moveBefore(node, at || null);
        else {
          const focused = host.ownerDocument?.activeElement;
          const restoreFocus = focused && node.contains?.(focused);
          host.insertBefore(node, at || null);
          if (restoreFocus && focused.isConnected && host.ownerDocument.activeElement !== focused) focused.focus({ preventScroll: true });
        }
      }
      old.delete(key);
    });
    old.forEach((node) => node.remove());
  }
  const api = { patchContent, patchHtml, patchList, findDataNode, _syncMessage };
  global.ChatDomPatch = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
