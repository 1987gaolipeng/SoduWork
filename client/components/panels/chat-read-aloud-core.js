(function (root) {
  'use strict';
  function plainText(source, lexer, tableLabel) {
    function walk(tokens) {
      return (tokens || []).map(token => {
        if (['code', 'html', 'image', 'def'].includes(token.type)) return '';
        if (token.type === 'table') {
          const rows = [token.header, ...token.rows];
          if (rows.length > 8 || token.header.length > 4) return tableLabel;
          return rows.map(row => row.map(cell => walk(cell.tokens)).join(', ')).join('\n');
        }
        if (token.type === 'list') return token.items.map(item => walk(item.tokens)).join('\n');
        if (token.tokens) return walk(token.tokens) + (['paragraph', 'heading', 'blockquote'].includes(token.type) ? '\n' : '');
        if (token.type === 'space' || token.type === 'br') return '\n';
        return token.text || '';
      }).join('');
    }
    return walk(lexer(String(source))).replace(/https?:\/\/\S+/g, '')
      .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, name) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[name])
      .replace(/[ \t]+/g, ' ').trim();
  }
  function language(text, preferred) {
    if (/[\uac00-\ud7af]/.test(text)) return 'ko-KR';
    if (/[\u3040-\u30ff]/.test(text)) return 'ja-JP';
    if (/[\u3400-\u9fff]/.test(text)) return 'zh-CN';
    return /[a-z]{2}/i.test(text) ? 'en-US' : preferred;
  }
  function chunks(text) {
    const result = [];
    for (const paragraph of text.split(/\n\s*\n/u)) {
      const chars = Array.from(paragraph.replace(/\s+/g, ' ').trim());
      while (chars.length) {
        let size = Math.min(180, chars.length);
        if (chars.length > size) {
          // Prefer natural phrase/word boundaries, retaining decimals and abbreviations.
          for (let i = size - 1; i >= 90; i--) {
            if (/\d/.test(chars[i - 1] || '') && /\d/.test(chars[i + 1] || '') && /[.,]/.test(chars[i])) continue;
            if (/[。！？；;,，\s]/u.test(chars[i]) || /[.!?]/.test(chars[i]) && /\s/.test(chars[i + 1] || '')) {
              size = i + 1; break;
            }
          }
        }
        const part = chars.splice(0, size).join('').trim();
        if (part) result.push(part);
      }
    }
    return result;
  }
  function create({ synth, Utterance, changed = () => {}, timer = setTimeout, clear = clearTimeout }) {
    let generation = 0, utterance, queue = [], index = 0, state = 'idle', voice, rate = 1, watchdog;
    let position = 0, boundaryKnown = false, deferred = false, pending = null;
    const emit = (next, error) => { state = next; changed({ state, error, index, total: queue.length }); };
    function stop() { generation++; clear(watchdog); utterance = null; pending = null; queue = []; position = 0; boundaryKnown = false; deferred = false; synth?.cancel(); emit('idle'); }
    function next(token) {
      if (token !== generation) return;
      if (index >= queue.length) { stop(); return; }
      const prepared = pending?.index === index ? pending.u : null;
      utterance = prepared || build(index, position, token); pending = null;
      const u = utterance;
      const fail = () => { if (token === generation && utterance === u) { stop(); emit('error', 'failed'); } };
      if (state !== 'playing') emit('loading');
      watchdog = timer(fail, 15000);
      if (!prepared) { try { synth.speak(u); } catch (_) { fail(); } }
    }
    function build(segment, base, token) {
      const u = new Utterance(queue[segment].slice(base));
      u.voice = voice; u.lang = voice.lang; u.rate = rate;
      const fail = () => { if (token === generation && utterance === u) { stop(); emit('error', 'failed'); } };
      u.onstart = () => { if (token === generation && utterance === u) { clear(watchdog); emit('playing'); } };
      u.onerror = () => {
        if (token !== generation) return;
        if (pending?.u === u) pending = null;
        else fail();
      };
      u.onboundary = event => {
        if (token !== generation || utterance !== u || !Number.isInteger(event.charIndex)) return;
        if (event.charIndex >= 0 && base + event.charIndex < queue[segment].length) {
          position = Math.max(position, base + event.charIndex); boundaryKnown = true;
          // Keep at most one upcoming segment in the native queue. Engines without
          // boundary events stay demand-driven so rate changes never replay text.
          if (!pending && segment + 1 < queue.length) {
            const ahead = { index: segment + 1, u: build(segment + 1, 0, token) };
            pending = ahead;
            try { synth.speak(ahead.u); } catch (_) { pending = null; }
          }
        }
      };
      u.onend = () => { if (token === generation && utterance === u) {
        clear(watchdog); index++; position = 0; boundaryKnown = false; next(token);
      } };
      return u;
    }
    return {
      stop,
      start(text, selected, speed) {
        stop();
        if (!synth || !Utterance || !selected?.localService) { emit('error', 'unavailable'); return; }
        voice = selected; rate = [0.75, 1, 1.25, 1.5].includes(speed) ? speed : 1;
        queue = chunks(text); index = 0; next(generation);
      },
      toggle() {
        if (state === 'playing') { synth.pause(); emit('paused'); }
        else if (state === 'paused') {
          if (deferred) { deferred = false; synth.resume(); next(generation); }
          else { synth.resume(); emit('playing'); }
        }
      },
      setRate(speed) {
        if (![0.75, 1, 1.25, 1.5].includes(speed) || speed === rate) return;
        rate = speed;
        if (deferred || !['playing', 'paused', 'loading'].includes(state) || !boundaryKnown) return;
        const paused = state === 'paused';
        // Native engines cannot reliably change the rate of an active utterance.
        // Resume at the latest reported word boundary, preserving the queue cursor.
        generation++; clear(watchdog); utterance = null; pending = null; synth.cancel();
        if (paused) { deferred = true; emit('paused'); }
        else next(generation);
      },
      state: () => state,
    };
  }
  const api = { plainText, language, chunks, create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SoduWorkReadAloudCore = api;
})(globalThis);
