/* Post-patch card reconciliation for streaming renders.
   During streaming the decorated HTML carries no cards (decorate returns the
   raw transcript untouched), so the cards of earlier final replies would be
   lost on every structural re-render. Instead of re-parsing the whole
   transcript to clone them back, _syncMessage now preserves decorator-owned
   children in place (patchList {preserveDeco:true}) and this module only
   reconciles the delta: re-attach a card whose message row was rebuilt, and
   drop plugin draft cards the current output index has superseded. Keeping
   the original node — instead of delete-then-recreate — is what keeps entry
   animations, decoded media pixels and install-error state stable. */
(function (global) {
  'use strict';
  const CARD_CLASSES = new Set(['ndelivery', 'noutput-library', 'noutput-image', 'noutput-video', 'nplugin-draft']);
  const messageKey = node => node.dataset.messageOwner != null
    ? 'owner:' + node.dataset.messageOwner : node.dataset.chatNode;
  const isCard = node => {
    if (!node.classList) return false;
    for (const name of CARD_CLASSES) if (node.classList.contains(name)) return true;
    return false;
  };
  // Mirrors the deco half of _messageChildKey in chat-dom-patch.js.
  function cardKeyOf(node) {
    const attr = name => (node.getAttribute ? node.getAttribute(name) : null);
    return attr('data-delivery') || attr('data-cloud-artifact-url') || attr('data-output-image') ||
      attr('data-output-video') || attr('data-install-plugin-draft') ||
      (node.dataset && node.dataset.chatNode && String(node.dataset.chatNode).startsWith('plugin-draft:')
        ? node.dataset.chatNode : '') || '';
  }
  function capture(list) {
    const captured = new Map();
    if (!list || !list.querySelectorAll) return captured;
    const historical = [...list.children].filter(node => isCard(node) && node.dataset?.pluginDraftHistorical === 'true');
    if (historical.length) captured.set('plugin-history:root', historical);
    list.querySelectorAll('[data-delivery-final="true"]').forEach(message => {
      const cards = [...message.children].filter(isCard);
      if (cards.length) captured.set(messageKey(message), cards);
    });
    return captured;
  }
  function reconcile(list, files, captured, snapshot) {
    if (!list || !list.querySelectorAll) return;
    // desk.html loads this module before placement; renderer has no require.
    const placement = global.ChatPluginDraftPlacement || (typeof require === 'function' ? require('./chat-plugin-draft-placement') : null);
    const superseded = global.ChatOutputLinks?._supersededDraftCard;
    // Same rule decorate's carry applies: a newer draft generation under the
    // same plugin identity retires the older card immediately, not at settle.
    if (superseded) list.querySelectorAll('.nplugin-draft').forEach(node => {
      const message = node.closest('.nmsg.ai');
      if (superseded(node, files) || (snapshot && message && placement?.matchesOwner(node, message, snapshot) === false)) node.remove();
    });
    if (!captured || !captured.size) return;
    const wanted = new Map([...list.querySelectorAll('[data-delivery-current="false"][data-delivery-final="true"]')]
      .map(node => [messageKey(node), node]));
    wanted.set('plugin-history:root', list);
    captured.forEach((cards, key) => {
      const message = wanted.get(key);
      if (!message) return;
      const present = new Set([...message.children].map(cardKeyOf).filter(Boolean));
      cards.forEach(card => {
        if (present.has(cardKeyOf(card))) return;
        if (superseded && superseded(card, files)) return;
        if (snapshot && card.classList.contains('nplugin-draft') && key !== 'plugin-history:root' &&
            placement?.matchesOwner(card, message, snapshot) === false) return;
        message.appendChild(key === 'plugin-history:root' ? card : card.cloneNode(true));
      });
    });
  }
  const api = { capture, reconcile, cardKeyOf };
  global.ChatDecorateCarry = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
