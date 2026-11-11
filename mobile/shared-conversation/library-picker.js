(function (global) {
  'use strict';
  // The native picker owns location, folders and account checks. Only a selected
  // byte snapshot enters the existing attachment input, never a PC path or URL.
  global.SoduWorkMobileLibrary = {mount(el, options) {
    const input = el.querySelector('#nchatFile');
    if (!input) return {destroy() {}};
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = '资料库';
    button.setAttribute('aria-label', '从资料库添加材料');
    button.className = 'mobile-library-button';
    el.querySelector('.work-composer')?.before(button);
    let version = 0, destroyed = false;
    const identity = () => options.state().ref || options.state().draftId;
    button.onclick = async () => {
      if (button.disabled) return;
      const ticket = ++version, scope = identity();
      options.onOpen?.(); button.disabled = true;
      try {
        const value = await global.SoduWorkMobileBridge.call('libraryPick', {});
        if (destroyed || ticket !== version || scope !== identity() || value?.cancelled) return;
        const binary = atob(value.data), bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
        if (!bytes.length || bytes.length > 16 * 1024 * 1024) throw Error('会话资料须为非空且不超过16MB的文件');
        const transfer = new DataTransfer();
        transfer.items.add(new File([bytes], value.name, {type: value.contentType}));
        input.files = transfer.files; input.dispatchEvent(new Event('change', {bubbles: true}));
      } catch (error) { if (!destroyed) options.say(error.message); }
      finally { if (!destroyed) button.disabled = false; }
    };
    return {button, close() {version++;},
      destroy() {destroyed = true; version++; button.remove();}};
  }};
})(window);
