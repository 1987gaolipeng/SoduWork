'use strict';
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const env = require('../scripts/start-client.cjs').cleanEnvironment(process.env);
  const result = spawnSync(require('electron'), [__filename, ...process.argv.slice(2)], { env, stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow } = require('electron');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-read-aloud-'));
app.setPath('userData', profile);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 600,
    webPreferences: { nodeIntegration: false, contextIsolation: true, offscreen: true, backgroundThrottling: false } });
  win.webContents.on('console-message', event => { if (event.level === 'error') console.error(event.message); });
  try {
    await win.loadURL('about:blank');
    for (const file of ['theme/variables.css', 'components/panels/panels-chat.css']) {
      await win.webContents.insertCSS(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));
    }
    await win.webContents.insertCSS('body{margin:40px;background:var(--bg);color:var(--ink);font-family:Arial,sans-serif}.nmsg{max-width:750px}');
    const native = await win.webContents.executeJavaScript(`new Promise(resolve => {
      const synth = window.speechSynthesis;
      setTimeout(() => resolve({ supported: !!synth, voices: (synth?.getVoices() || []).map(v =>
        ({ name: v.name, lang: v.lang, local: v.localService })) }), 1600);
      synth?.getVoices();
    })`);
    let nativeRate = null;
    let nativeFlow = null;
    if (process.argv.includes('--native-smooth')) {
      await win.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname, '../components/panels/chat-read-aloud-core.js'), 'utf8'));
      nativeFlow = await win.webContents.executeJavaScript(`new Promise(resolve => {
        const voice = speechSynthesis.getVoices().find(v => v.localService && v.lang === 'zh-CN');
        if (!voice) { resolve({ skipped: 'No local Chinese voice' }); return; }
        const packets = []; let player, started = false;
        const timer = setTimeout(() => { player.stop(); resolve({ timeout: true }); }, 18000);
        function Tracked(text) {
          const u = new SpeechSynthesisUtterance(text), packet = { text, created: performance.now() };
          packets.push(packet);
          u.addEventListener('start', () => { packet.start = performance.now(); });
          u.addEventListener('boundary', () => { packet.firstBoundary ??= performance.now(); });
          u.addEventListener('end', () => { packet.end = performance.now(); });
          return u;
        }
        player = SoduWorkReadAloudCore.create({ synth: speechSynthesis, Utterance: Tracked,
          changed(value) {
            if (value.state === 'playing') started = true;
            if (value.state === 'idle' && started) {
              clearTimeout(timer);
              resolve({ count: packets.length, prequeued: packets.slice(1).every((p, i) => p.created < packets[i].end), packets });
            }
          } });
        player.start('第一段，正在验证连续朗读。\\n\\n第二段，检查衔接。\\n\\n第三段，测试结束。', voice, 1);
      })`, true);
      if (!nativeFlow.skipped && (nativeFlow.timeout || nativeFlow.count !== 3 || !nativeFlow.prequeued)) throw Error('Native prefetch validation failed');
    }
    if (process.argv.includes('--native-rate')) {
      await win.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname, '../components/panels/chat-read-aloud-core.js'), 'utf8'));
      nativeRate = await win.webContents.executeJavaScript(`new Promise(resolve => {
        const voice = speechSynthesis.getVoices().find(v => v.localService && v.lang === 'zh-CN');
        if (!voice) { resolve({ skipped: 'No local Chinese voice' }); return; }
        const packets = []; let started = false, adjusted = false, player;
        const Original = SpeechSynthesisUtterance;
        const timer = setTimeout(() => { player.stop(); resolve({ timeout: true }); }, 18000);
        function Tracked(text) {
          const utterance = new Original(text); const packet = { text }; packets.push(packet);
          utterance.addEventListener('start', () => { packet.rate = utterance.rate; });
          utterance.addEventListener('boundary', event => {
            if (!adjusted && event.charIndex >= 3) { adjusted = true; setTimeout(() => player.setRate(1.5), 0); }
          });
          return utterance;
        }
        player = SoduWorkReadAloudCore.create({ synth: speechSynthesis, Utterance: Tracked,
          changed(value) {
            if (value.state === 'playing') started = true;
            if (value.state === 'idle' && started) { clearTimeout(timer); resolve({ adjusted, packets }); }
          } });
        player.start('正在测试调整朗读速度后，是否可以从当前位置继续播放。下一段将保持新的速度。', voice, 1);
      })`, true);
      if (nativeRate.timeout || nativeRate.adjusted && nativeRate.packets[1]?.rate !== 1.5) throw Error('Native rate-change validation failed');
    }
    let nativePlayback = null;
    if (process.argv.includes('--native-speech')) nativePlayback = await win.webContents.executeJavaScript(`new Promise(resolve => {
      const voice = speechSynthesis.getVoices().find(v => v.localService && v.lang === 'zh-CN');
      if (!voice) { resolve({ skipped: 'No local Chinese voice' }); return; }
      const utterance = new SpeechSynthesisUtterance('正在测试本机朗读功能。现在暂停，然后继续播放。'); utterance.voice = voice; utterance.lang = voice.lang;
      let started = false, paused = false, resumed = false;
      const timer = setTimeout(() => { speechSynthesis.cancel(); resolve({ started, ended: false }); }, 10000);
      utterance.onstart = () => {
        started = true;
        speechSynthesis.pause();
        setTimeout(() => { paused = speechSynthesis.paused; speechSynthesis.resume();
          setTimeout(() => { resumed = !speechSynthesis.paused; }, 50);
        }, 300);
      };
      utterance.onend = () => { clearTimeout(timer); resolve({ started, ended: true, paused, resumed }); };
      utterance.onerror = event => { clearTimeout(timer); resolve({ started, error: event.error }); };
      window.__nativeUtterance = utterance; speechSynthesis.speak(utterance);
    })`, true);
    await win.webContents.executeJavaScript(`
      window.__locale = 'en-US';
      window.SoduWorkI18n = { getLocale: () => window.__locale };
      window.__spoken = [];
      window.__cancelled = 0;
      const synth = { getVoices: () => [{ lang: 'en-US', localService: true }], cancel() { window.__cancelled++; }, pause() {}, resume() {},
        speak(u) { window.__spoken.push(u); u.onstart(); } };
      Object.defineProperty(window, 'speechSynthesis', { value: synth });
      Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: function(text) { this.text = text; } });
      document.body.innerHTML = '<div class="nmsg ai"><p>Hello world. This reply can be read aloud.</p><div class="nmessage-footer" id="messages"></div></div>';
    `);
    for (const file of ['vendor/markdown/marked.umd.js', 'components/panels/chat-read-aloud-core.js', 'components/panels/chat-read-aloud.js']) {
      await win.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));
    }
    await win.webContents.executeJavaScript(`
      window.__assert = (value, message) => { if (!value) throw Error(message); };
      const escape = text => String(text).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
      window.__footer = () => '<span class="nmessage-time">12:30</span>' + SoduWorkReadAloud.button('Hello **world**.', 'chat', 1, escape) + '<button class="ntext-copy" data-copy-test aria-label="Copy"><svg viewBox="0 0 24 24"><path d="M8 8h12v12H8ZM4 16V4h12"/></svg></button>';
      document.querySelector('#messages').innerHTML = __footer();
      document.querySelector('[data-speech-play]').click();
      document.querySelector('#messages').innerHTML = __footer();
    `);
    await new Promise(resolve => setTimeout(resolve, 100));
    await win.webContents.executeJavaScript(`
      __assert(__spoken.length === 1 && __spoken[0].text === 'Hello world.', 'Readable body');
      __assert(document.querySelector('[data-speech-play]').getAttribute('aria-label') === 'Pause', 'Playing state');
      document.querySelector('[data-speech-play]').click();
      __assert(document.querySelector('[data-speech-play]').getAttribute('aria-label') === 'Resume', 'Paused state');
    `);
    await new Promise(resolve => setTimeout(resolve, 200));
    await win.webContents.executeJavaScript(`__assert(getComputedStyle(document.querySelector('.nmessage-footer')).opacity === '1', 'Active controls remain visible without hover')`);
    const screenshot = path.resolve(__dirname, '../../outputs/database-release-notes/read-aloud-preview.png');
    fs.mkdirSync(path.dirname(screenshot), { recursive: true });
    fs.writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript(`
      document.querySelector('[data-speech-stop]').click();
      __assert(document.querySelector('[data-speech-play]').getAttribute('aria-label') === 'Read aloud', 'Stopped state');
      const time = document.querySelector('.nmessage-time').getBoundingClientRect();
      const read = document.querySelector('[data-speech-play]').getBoundingClientRect();
      const copy = document.querySelector('[data-copy-test]').getBoundingClientRect();
      __assert(Math.abs(read.left-time.right-6)<0.5 && Math.abs(copy.left-read.right-6)<0.5, 'Equal time/read/copy spacing');
      speechSynthesis.getVoices = () => [{lang:'en-US',localService:false}];
      document.querySelector('[data-speech-play]').click();
    `);
    await new Promise(resolve => setTimeout(resolve, 100));
    await win.webContents.executeJavaScript(`
      __assert(document.querySelector('[role="status"]').textContent.includes('No local voice'), 'Remote voices excluded');
      __assert(__spoken.length === 1, 'No remote speech');
      dispatchEvent(new Event('soduwork-data-scope-changed'));
      __assert(document.querySelector('[data-speech-controls]').hidden, 'Account change stops speech');
      window.__locale = 'ja-JP'; dispatchEvent(new Event('soduwork-locale-change'));
      __assert(document.querySelector('[data-speech-play]').getAttribute('aria-label') === '読み上げ', 'Locale switch');
    `);
    await win.webContents.executeJavaScript(`
      speechSynthesis.getVoices = () => [{lang:'ja-JP',localService:true},{lang:'en-US',localService:true}];
      __assert(!document.querySelector('[data-speech-menu="language"]'), 'No manual language control');
      document.querySelector('[data-speech-play]').click();
    `);
    await new Promise(resolve => setTimeout(resolve, 100));
    await win.webContents.executeJavaScript(`
      __assert(__spoken.at(-1).lang === 'en-US', 'Reply content determines the voice, independently of interface language');
      __spoken.at(-1).onboundary({charIndex:6});
      document.querySelector('[data-speech-menu="rate"]').click();
      document.querySelector('[data-speech-rate="1.5"]').click();
    `);
    await new Promise(resolve => setTimeout(resolve, 100));
    await win.webContents.executeJavaScript(`
      __assert(__spoken.at(-1).rate === 1.5, 'Speed selection');
      __assert(__spoken.at(-1).text === 'world.', 'Speed changes continue from the current word');
      __assert(!document.querySelector('[data-speech-play]').textContent, 'Icon-only play control');
      __assert(!document.querySelector('select'), 'No native select controls');
      window.__beforeRemoval = __cancelled;
      document.querySelector('#messages').replaceChildren();
    `);
    await new Promise(resolve => setTimeout(resolve, 100));
    await win.webContents.executeJavaScript(`
      __assert(!document.querySelector('[data-read-aloud]'), 'Removed conversation has no active controls');
      __assert(__cancelled > __beforeRemoval, 'Removing the conversation cancels speech');
    `);
    console.log(JSON.stringify({ ok: true, native, nativePlayback, nativeRate, nativeFlow, note: 'UI playback uses an isolated speech adapter; native voice enumeration is real.' }));
  } finally { win.destroy(); }
}).then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); });
