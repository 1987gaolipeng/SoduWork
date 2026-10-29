/* Legacy renderer adapter. Only UI copy is localized; editable and business
   content must remain unchanged, including when it equals a known UI label. */
(function (global) {
  'use strict';
  const ATTRS = ['placeholder', 'title', 'aria-label', 'aria-description', 'aria-valuetext', 'alt', 'data-tooltip'];
  const CONTENT = '[data-user-content],[data-message-content],[translate="no"],[contenteditable]:not([contenteditable="false"]),.nmd,.nline,.nuser-text,.nuser-full,.nuser-long>summary>span,.nuser-criteria ul,.nthink-body,.nmessage-plugin,.d2h-wrapper,.nd-l,.ntool-result,.dks-message,.chat-message,.user-message,.assistant-message,.tt-ctitle,.tt-csub,.ib-title,.task-title,.task-name,.project-name,.chat-title,.nchat-title,.ws-chat-title';
  function createAdapter({ document: doc, translate, locale, onMissing, localizeKeyed }) {
    const texts = new WeakMap(), attributes = new WeakMap();
    let observer;
    function protectedElement(el, attribute) {
      if (!el || !el.closest) return true;
      if (el.closest(CONTENT)) return true;
      if (el.closest('.xterm')) return true;
      if (el.closest('[data-soduwork-user-initial],[data-soduwork-user-name]')) return true;
      if (el.closest('.sch-i-title,.sch-i-note,.sch-i-meta b')) return true;
      if (el.closest('.soduwork-account-name,.soduwork-account-id,.cap-plugin-title>b,.cap-plugin-detail-head>div>b,.cap-plugin-preview>div>b')) return true;
      if (el.closest('.cp-mrow[data-m]:not([data-m=""]) .cp-mtxt b')) return true;
      return !!el.closest(attribute ? 'script,style,code,pre' : 'script,style,code,pre,input,textarea');
    }
    function project(current, previous, write, target) {
      // A renderer can reuse a node for either Chinese or English data. The
      // last value written by us identifies our own mutations without guessing
      // from the alphabet, and prevents restoring obsolete status messages.
      const source = previous && current === previous.rendered ? previous.source : current;
      const rendered = locale() === 'zh-CN' ? source : translate(source);
      if (rendered !== current) write(rendered);
      if (locale() !== 'zh-CN' && /[\u3400-\u9fff]/.test(rendered) && onMissing) onMissing(source, target);
      return { source, rendered };
    }
    function text(node) {
      if (protectedElement(node.parentElement, false) || node.parentElement.closest('[data-i18n]')) return;
      texts.set(node, project(node.nodeValue, texts.get(node), value => { node.nodeValue = value; }, node));
    }
    function attrs(el) {
      if (protectedElement(el, true)) return;
      const saved = attributes.get(el) || Object.create(null);
      for (const name of ATTRS) {
        if ((el.getAttribute('data-user-attributes') || '').split(/\s+/).includes(name)) continue;
        if (!el.hasAttribute(name)) { delete saved[name]; continue; }
        saved[name] = project(el.getAttribute(name), saved[name], value => el.setAttribute(name, value), el);
      }
      attributes.set(el, saved);
    }
    function visit(root) {
      if (!root) return;
      if (root.nodeType === 3) { text(root); return; }
      localizeKeyed?.(root);
      if (root.nodeType === 1) attrs(root);
      const walker = doc.createTreeWalker(root, 4 /* SHOW_TEXT */);
      while (walker.nextNode()) text(walker.currentNode);
      root.querySelectorAll?.('*').forEach(attrs);
    }
    const options = { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: [...ATTRS, 'data-i18n', 'data-i18n-source', 'data-i18n-params'] };
    function start() {
      if (observer || !doc.body) return;
      observer = new global.MutationObserver(records => {
        observer.disconnect();
        const roots = new Set();
        for (const record of records) {
          if (record.type === 'attributes') { localizeKeyed?.(record.target); attrs(record.target); }
          else if (record.type === 'characterData') text(record.target);
          else for (const node of record.addedNodes) roots.add(node);
        }
        for (const root of roots) if (root.isConnected) visit(root);
        observer.observe(doc.body, options);
      });
      visit(doc.body);
      observer.observe(doc.body, options);
    }
    function apply(root = doc.body) {
      observer?.disconnect();
      visit(root);
      if (observer && doc.body) observer.observe(doc.body, options);
    }
    return { apply, start, stop() { observer?.disconnect(); observer = null; } };
  }
  global.SoduWorkLocaleDOM = Object.freeze({ createAdapter });
})(globalThis);
