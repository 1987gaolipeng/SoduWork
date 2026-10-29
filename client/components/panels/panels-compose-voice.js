/* Browser speech input for the start composer. It is intentionally isolated from
   conversation orchestration because recognition is an optional device capability. */
(function (global) {
  'use strict';

  let active = null;

  function toggle(button, input, say) {
    const SpeechRecognition = global.SpeechRecognition || global.webkitSpeechRecognition;
    const announce = typeof say === 'function' ? say : () => {};
    if (!SpeechRecognition) {
      announce('\u8fd9\u53f0\u673a\u5668\u4e0a\u6ca1\u6709\u53ef\u7528\u7684\u8bed\u97f3\u8bc6\u522b');
      return;
    }
    if (active) {
      try { active.stop(); } catch (error) { /* already stopped */ }
      active = null;
      if (button) button.classList.remove('on');
      return;
    }
    try {
      const recognition = new SpeechRecognition();
      recognition.lang = 'zh-CN';
      recognition.interimResults = true;
      recognition.continuous = true;
      const base = String((input && input.value) || '');
      recognition.onresult = (event) => {
        let text = '';
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          text += event.results[index][0].transcript;
        }
        if (input) input.value = (base ? base + ' ' : '') + text;
      };
      recognition.onerror = (event) => {
        active = null;
        if (button) button.classList.remove('on');
        const reason = String((event && event.error) || '');
        announce(reason === 'not-allowed' ? '\u9ea6\u514b\u98ce\u6ca1\u6388\u6743'
          : reason === 'network' ? '\u8bed\u97f3\u8bc6\u522b\u9700\u8981\u7f51\u7edc\uff0c\u5f53\u524d\u65e0\u6cd5\u8fde\u63a5'
            : '\u8bed\u97f3\u8bc6\u522b\u6ca1\u6210\u529f\uff08' + reason + '\uff09');
      };
      recognition.onend = () => {
        active = null;
        if (button) button.classList.remove('on');
      };
      active = recognition;
      recognition.start();
      if (button) button.classList.add('on');
    } catch (error) {
      active = null;
      if (button) button.classList.remove('on');
      announce('\u8bed\u97f3\u8bc6\u522b\u6682\u65f6\u65e0\u6cd5\u542f\u52a8');
    }
  }

  global.ComposeVoice = { toggle };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.ComposeVoice;
})(window);
