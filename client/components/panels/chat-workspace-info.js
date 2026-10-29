/* Shared conversation workbench summaries. */
(function (global) {
  'use strict';
  const tools = global.ChatTools || (typeof require === 'function' ? require('./panels-chat-tools') : null);
  if (!tools) return;
  const pick = (args, names) => {
    for (const name of names) {
      const value = args && args[name];
      if (typeof value === 'string' && value) return value;
    }
    return '';
  };
  const baseName = (value) => String(value || '').split(/[\\/]/).pop() || '';

  function toolMeta(tool) {
    const name = String((tool && tool.name) || '').toLowerCase();
    const args = (tool && tool.args && typeof tool.args === 'object') ? tool.args : {};
    const target = pick(args, ['path', 'file_path', 'filePath', 'filename', 'file', 'target']);
    const command = pick(args, ['command', 'cmd', 'script', 'argv']);
    if (/(^|_)write|create_file|新建文件/.test(name) && target) return { kind: 'write', target };
    if (/(^|_)edit|replace|patch|修改/.test(name) && target) return { kind: 'edit', target };
    if (/(^|_)read|cat|open_file/.test(name) && target) return { kind: 'read', target };
    if (/(^|_)(ls|list|glob|find|grep|search)/.test(name)) {
      return { kind: /grep|search/.test(name) ? 'search' : 'list',
        target: pick(args, ['pattern', 'query', 'path', 'dir']) };
    }
    if (/bash|shell|command|exec|terminal|run/.test(name) && command) return { kind: 'command', command };
    return { kind: 'tool', target: name || '工具' };
  }

  const SERVER_COMMAND = /(?:^|[;&|]\s*|\b(?:nohup|exec|npx)\s+)(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|preview)\b|(?:\.\/node_modules\/\.bin\/)?(?:vite(?=\s*(?:--[^\r\n]*|$|[;&|]))|next\s+(?:dev|start)\b|(?:nuxt|astro)\s+(?:dev|preview)\b|webpack-dev-server\b|http-server\b|live-server\b)|python(?:3)?(?:\.exe)?\s+(?:-m\s+(?:http\.server|flask\s+run|uvicorn|streamlit\s+run)\b|manage\.py\s+runserver\b)|(?:uvicorn|flask\s+run|streamlit\s+run|dotnet\s+run|cargo\s+run|go\s+run)\b)/i;
  const CUSTOM_SERVER_COMMAND = /(?:^|[;&|]\s*|\b(?:nohup|exec)\s+)(?:node|python(?:3)?)(?:\.exe)?\s+["']?(?:[^\s"';&|]*[\\/])?(?:server|app|main|index|dev|serve|start|web)(?:[._-][\w-]+)*\.(?:mjs|cjs|js|py)\b/i;
  const isServerCommand = (command) => SERVER_COMMAND.test(String(command || ''));

  const currentTurnTools = tools.currentTurnTools;
  const messageAt = value => Number(value) || Date.parse(value || '') || 0;
  function currentWorkJournal(snapshot) {
    const journal = snapshot?.fileChanges || snapshot?.execution?.fileChanges || null;
    const user = [...(snapshot?.messages || [])].reverse().find(row => row?.role === 'user');
    const turnAt = messageAt(user?.sentAt || user?.at || user?.timestamp);
    return journal && turnAt && Number(journal.capturedAt) < turnAt ? null : journal;
  }

  // The trusted index also serves links in old messages. It is deliberately
  // broader than “current work”, especially when two chats share a project.
  // Select current evidence without pruning those addressable historical files.
  function currentWorkSelection(snapshot, files, cwd) {
    const links = global.ChatOutputLinks || (typeof require === 'function' ? require('./chat-output-links') : null);
    if (!links) return { files: [], images: [] };
    const messages = snapshot?.messages || [];
    let first = -1;
    messages.forEach((row, index) => { if (row?.role === 'user') first = index; });
    if (first < 0) return { files: [], images: [] };
    const journal = currentWorkJournal(snapshot);
    const root = cwd || journal?.cwd || '';
    const current = new Set(), explicitImages = new Set();
    const add = target => {
      const file = links.workspaceFileTarget(target, files, root);
      if (file && !file.deleted) current.add(file);
    };
    for (const tool of currentTurnTools(snapshot)) {
      if (tool.state !== 'done' || tool.isError) continue;
      const meta = toolMeta(tool);
      if (meta.kind === 'write' || meta.kind === 'edit') add(meta.target);
    }
    // A journal is a directory diff, not an authorship receipt: another chat
    // can write to the same explicit project while this turn is running.
    // Shell-generated files enter through the answer's explicit delivery below.
    const taskIds = new Set(messages.slice(first).map(row => String(row.taskId || '')).filter(Boolean));
    for (const file of files || []) {
      if (taskIds.has(String(file.taskId || file.cloudTaskId || '')) && file.primary !== false) current.add(file);
    }
    // Prose basename matching must not bypass the workspace boundary. Trusted
    // remote task results remain available through their explicit task above.
    const proseFiles = (files || []).filter(file => links.workspaceFileTarget(
      file.relative || file.path || file.name, [file], root));
    for (const row of messages.slice(first + 1)) {
      if (row.role !== 'assistant') continue;
      const rowTask = String(row.taskId || '');
      const available = proseFiles.filter(file => {
        const task = String(file.taskId || file.cloudTaskId || '');
        return !task || (rowTask ? task === rowTask : taskIds.has(task));
      });
      const text = (row.blocks || []).filter(block => block.kind === 'text').map(block => block.text || '').join('\n');
      const declared = [...text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)];
      for (const match of declared) {
        const target = match[1].trim().replace(/^<|>$/g, '');
        let decoded = target;
        // Native image turns publish URI-encoded relative links. Preserve an
        // exact literal filename first; file URLs already decode in the matcher.
        if (!/^file:/i.test(target)) try { decoded = decodeURIComponent(target); } catch (_) { /* literal percent path */ }
        const candidates = [target];
        if (decoded !== target && !/^file:/i.test(decoded)) candidates.push(decoded);
        let file;
        for (const candidate of candidates) {
          file = links.workspaceFileTarget(candidate, available, root);
          // Match bare names literally: the general link helper decodes again,
          // which could turn an encoded separator into a basename fallback.
          if (!file && !/[\\/:]/.test(candidate)) {
            const matches = available.filter(row => baseName(row.relative || row.path || row.name) === candidate);
            if (matches.length === 1) file = matches[0];
          }
          if (file) break;
        }
        // An explicitly linked screenshot is previewable evidence, without
        // changing its authoritative primary/processEvidence delivery role.
        if (file && !file.deleted && links.isImage(file)) {
          explicitImages.add(file); current.add(file);
        } else if (file?.primary !== false && file && !file.processEvidence) current.add(file);
      }
      for (const hit of links.mentions(text, available)) {
        if (declared.some(match => hit.start >= match.index && hit.end <= match.index + match[0].length)) continue;
        // A mention matcher may find the basename inside a longer untrusted
        // path. That path must resolve exactly before it can claim an output.
        const prefix = text.slice(0, hit.start).match(/[^\s"'()[\]<>`，。；：、]*$/)?.[0] || '';
        if (/[\\/]$/.test(prefix) && links.workspaceFileTarget(prefix + hit.text, available, root) !== hit.file) continue;
        if (hit.file.primary !== false && !hit.file.processEvidence) current.add(hit.file);
      }
    }
    return { files: (files || []).filter(file => current.has(file) && !file.deleted &&
      (!file.processEvidence || explicitImages.has(file))), images: [...explicitImages] };
  }
  function currentWorkFiles(snapshot, files, cwd) {
    return currentWorkSelection(snapshot, files, cwd).files;
  }

  /* Use friendly wording that describes actual ongoing work. */
  /*
   * Translate dynamic tool/status fragments at construction time because whole-node DOM
   * translation cannot match concatenated text.
   */
  const tx = (value) => {
    const i18n = global.SoduWorkI18n;
    return i18n && typeof i18n.translateText === 'function' ? i18n.translateText(value) : value;
  };

  function status(snapshot, pending) {
    const snap = snapshot || {};
    const messages = snap.messages || [];
    let turnAt = -1;
    messages.forEach((item, index) => { if (item.role === 'user') turnAt = index; });
    const turnTools = currentTurnTools(snap);
    const running = [...turnTools].reverse().find((item) => item.state === 'running');
    if (running) {
      const meta = toolMeta(running);
      const name = baseName(meta.target);
      if (meta.kind === 'write') return tx('正在把内容稳稳写进 ' + (name || '文件') + '…');
      if (meta.kind === 'edit') return tx('正在细修 ' + (name || '文件') + '…');
      if (meta.kind === 'read') return tx('正在翻阅 ' + (name || '资料') + '，找准再动手…');
      if (meta.kind === 'search' || meta.kind === 'list') return tx('正在工作区里找线索…');
      if (meta.kind === 'command') {
        return isServerCommand(meta.command) ? tx('正在把服务启动起来…') : tx('正在让程序跑一遍，看看结果…');
      }
      const view = tools.render(running);
      return view ? tx((/^(?:正在|准备)/.test(view.title) ? '' : '正在') + view.title + (view.sub ? ' ' + view.sub : '') + '…')
        : tx('正在处理 ' + meta.target + '…');
    }
    const assistant = [...messages].reverse().find((item, index) =>
      item.role === 'assistant' && messages.length - 1 - index > turnAt);
    const blocks = (assistant && assistant.blocks) || [];
    if (blocks.some((item) => item.kind === 'text' && String(item.text || '').trim())) return tx('正在把结果讲清楚…');
    if (blocks.some((item) => item.kind === 'thinking')) return tx('先把事情想明白，再动手…');
    if (turnTools.some((item) => item.state !== 'running')) return tx('正在核对刚才的结果…');
    return pending ? tx('收到，正在接上工作区…') : tx('正在理解你的要求…');
  }

  function normalizeUrl(raw, options) {
    const opts = options || {};
    let value = String(raw || '').trim().replace(/[),.;]+$/, '');
    if (!value) return '';
    // Dev servers usually print a bare `localhost:5173` or `0.0.0.0:3000`.
    // Treat those as URLs before parsing so ANSI-cleaned output is usable.
    if (/^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::\]|\[::1\])(?::\d+)?(?:\/|$)/i.test(value) ||
        /^(?:(?:\d{1,3}\.){3}\d{1,3}|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?):\d{2,5}(?:\/|$)/i.test(value)) {
      value = 'http://' + value;
    } else if (/^:\d+(?:\/|$)/.test(value)) {
      value = 'http://localhost' + value;
    }
    try {
      const parsed = new URL(value);
      if (!/^https?:$/.test(parsed.protocol)) return '';

      // The bare-host matcher below must never turn those into a phantom

      // cannot have this date/hour shape, so reject it at the URL boundary.
      if (isTimestampLikeHost(parsed.hostname)) return '';
      const loopback = /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::\]|\[::1\])$/i.test(parsed.hostname);
      // A cloud runner's localhost is the runner, not the user's desktop. The
      // Hub exposes the runner host in the target snapshot, so rewrite only
      // loopback addresses and keep the reported port/path/query intact.
      const cloudHost = String(opts.cloudHost || '').trim();
      if (opts.cloud && loopback && !cloudHost) return '';
      if (opts.cloud && loopback && cloudHost && /^[a-z0-9][a-z0-9._-]{0,252}$/i.test(cloudHost)) {
        parsed.hostname = cloudHost;
      } else if (loopback) {
        parsed.hostname = '127.0.0.1';
      }
      return parsed.href;
    } catch (_) { return ''; }
  }
  /*
   * Strip CSI, OSC, and isolated ESC sequences before extracting URLs from CLI output. ANSI
   * codes are not whitespace and can otherwise corrupt navigation targets.
   */
  function stripAnsi(text) {
    return String(text || '')
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
      .replace(/\x1b[@-_]/g, '');
  }
  function isTimestampLikeHost(host) {
    const value = String(host || '').trim().replace(/^\[|\]$/g, '');


    return /^(?:\d{4}[-/]\d{1,2}[-/]\d{1,2})(?:[tT _-]\d{1,2})(?::\d{1,2}(?::\d{1,2})?)?$/.test(value);
  }
  function isServiceCandidate(value) {
    const text = String(value || '').trim();
    const authority = text.replace(/^[a-z][a-z\d+.-]*:\/\//i, '').split(/[/?#]/, 1)[0]
      .replace(/^\[([^\]]+)\](?::\d+)?$/, '$1')
      .replace(/:\d+$/, '');
    return !isTimestampLikeHost(authority);
  }
  function serviceCandidates(text) {
    const value = stripAnsi(text);
    const full = [...value.matchAll(/https?:\/\/[^\s"'<>]+/ig)].map(match => ({ value: match[0], at: match.index }));
    // Vite/Next/Python commonly omit the scheme for local listeners.
    // Do not read a source location (file:///.../main.py:35:5) as a host.
    const bare = [...value.matchAll(/(?:^|[\s(=])((?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::\]|\[::1\]|(?:\d{1,3}\.){3}\d{1,3}|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?):\d{2,5}(?:\/[^\s"'<>]*)?)(?![:\d])/ig)].map(match => ({ value: match[1], at: match.index }));
    const portOnly = [...value.matchAll(/\b(?:port|running\s+on|listening\s+on|local)\s*[: ]\s*(\d{2,5})\b/ig)]
      .map(match => ({ value: 'http://localhost:' + match[1] + '/', at: match.index }));
    return [...full, ...bare, ...portOnly].sort((a, b) => a.at - b.at).map(row => row.value)
      .filter(candidate => isServiceCandidate(candidate));
  }
  // A signal belongs to its own output line, never to an unrelated URL in the
  // command, fetched page, stack trace or another line of a build log.
  const SERVICE_LISTENER_SIGNAL = /^(?:\s*(?:\[[^\]\r\n]{0,80}\]|(?:INFO|DEBUG|LOG)\s*:|[➜>•*-])\s*)*\s*(?:(?:local|network)\s*:|(?:[\w.-]+\s+)?(?:server\s+)?(?:listening\b|running\s+(?:on|at)\b)|serving\s+https?\b|starting\s+(?:development\s+)?server\s+at\b|(?:server|app|application)\s+(?:started|ready|running|listening)\b|available\s+at\b)/i;
  const HTTP_CLIENT_COMMAND = /(?:^|[\s;&|"'\\/])(?:curl|wget|fetch|http(?:ie)?|invoke-webrequest|iwr)(?:\.exe)?(?:\s|["']|$)|\b(?:browser\.(?:mjs|cjs|js)|playwright|puppeteer)\b/i;
  function hasLoopbackCandidate(candidates) {
    return (candidates || []).some((candidate) => {
      let value = String(candidate || '').trim();
      if (!/^[a-z][a-z\d+.-]*:\/\//i.test(value)) value = 'http://' + value;
      try {
        const host = new URL(value).hostname;
        return /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::\]|\[::1\])$/i.test(host);
      } catch (_) { return false; }
    });
  }
  function services(input, options) {
    const opts = options || {};
    const rows = [];
    [...(input || [])].reverse().forEach((tool) => {
      const meta = toolMeta(tool);
      if (meta.kind !== 'command') return;
      const port = Number(tool.port);
      const structuredPort = Number.isInteger(port) && port > 0 && port < 65536
        ? String(tool.host || 'localhost') + ':' + String(port) : '';
      const explicitServiceUrls = [
        tool.serviceUrl, tool.previewUrl, tool.service?.url,
        ...(Array.isArray(tool.services) ? tool.services.map(item => item?.url || item?.previewUrl) : []),
      ].filter(Boolean);
      const commandOutput = stripAnsi([tool.partial, tool.result].filter(Boolean).join('\n'));
      const serverCommand = isServerCommand(meta.command);
      const candidates = [...explicitServiceUrls, structuredPort].filter(Boolean);
      // A page or README can contain verbatim startup instructions. Require a
      // launch command as well as output evidence; a bare URL argument is never
      // enough. Custom unrecognized launchers can provide structured metadata.
      const launchesServer = serverCommand || CUSTOM_SERVER_COMMAND.test(meta.command);
      if (launchesServer && (!HTTP_CLIENT_COMMAND.test(meta.command) || serverCommand)) {
        commandOutput.split(/\r?\n/).forEach(line => {
          const addresses = serviceCandidates(line);
          if (SERVICE_LISTENER_SIGNAL.test(line)) {
            // The advertised endpoint, not documentation links later on the line.
            if (addresses.length) candidates.push(addresses[0]);
          } else if (serverCommand) {
            candidates.push(...addresses.filter(address => hasLoopbackCandidate([address])));
          }
        });
      }
      if (!serverCommand && !candidates.length) return;
      const found = candidates.map(url => normalizeUrl(url, opts)).filter(Boolean);
      const urls = [...new Set(found)];
      const unreachable = Boolean(opts.cloud && candidates.length && !urls.length);
      const state = tool.state === 'error' ? '启动失败'
        : unreachable ? '等待云端地址'
        : tool.state === 'running' ? (urls.length ? '运行中' : '正在启动')
        : (urls.length ? '已启动' : '已结束');
      const title = /vite|next|nuxt|astro|webpack|http-server|live-server/i.test(meta.command)
        ? '网页预览' : '本地服务';
      (urls.length ? urls : ['']).forEach((url) => rows.push({
        id: tool.id, title, state, url, command: meta.command,
        cloud: Boolean(opts.cloud), cloudHost: String(opts.cloudHost || ''), unreachable,
      }));
    });
    const unique = new Map();
    rows.forEach((item) => {
      const key = item.url ? 'url:' + item.url : 'tool:' + item.id;
      if (!unique.has(key)) unique.set(key, item);
    });
    return [...unique.values()];
  }

  function changes(input) {
    return (input || []).map((tool) => ({ tool, meta: toolMeta(tool) }))
      .filter((item) => item.meta.kind === 'write' || item.meta.kind === 'edit')
      .map(({ tool, meta }) => ({
        id: tool.id, action: meta.kind === 'write' ? '新建' : '修改',
        name: baseName(meta.target) || '文件', path: meta.target || '',
        state: tool.state === 'running' ? '进行中' : tool.state === 'error' ? '失败' : '已完成',
      }));
  }

  // Self-contained SVGs also render in document headers without inherited SVG CSS.
  const icon = paths => '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + paths + '</svg>';
  const ICONS = {
    close: icon('<path d="m7 7 10 10M17 7 7 17"/>'),
    expand: icon('<path d="M9 4.5H4.5V9M15 4.5h4.5V9M9 19.5H4.5V15M15 19.5h4.5V15"/>'),
    restore: icon('<rect x="7.5" y="4.5" width="12" height="12" rx="2"/><path d="M4.5 8.5v9a2 2 0 0 0 2 2h9"/>'),
    globe: icon('<circle cx="12" cy="12" r="8.25"/><ellipse cx="12" cy="12" rx="3.5" ry="8.25"/><path d="M3.75 12h16.5"/>'),
    file: icon('<path d="M13.5 3.75H6.75a1.5 1.5 0 0 0-1.5 1.5v13.5a1.5 1.5 0 0 0 1.5 1.5h10.5a1.5 1.5 0 0 0 1.5-1.5V9zM13.5 3.75V9h5.25"/>'),
    image: icon('<rect x="3.75" y="3.75" width="16.5" height="16.5" rx="3"/><circle cx="8.5" cy="8.5" r="1.25"/><path d="m4 16 4-4 3.5 3.5 4.5-5 4 4.5"/>'),
    back: icon('<path d="m14 6.5-5.5 5.5 5.5 5.5"/>'),
    forward: icon('<path d="m10 6.5 5.5 5.5-5.5 5.5"/>'),
    reload: icon('<path d="M19.25 9A7.5 7.5 0 1 0 19.4 14M19.25 4.5V9h-4.5"/>'),
    external: icon('<path d="M13.75 4.75h5.5v5.5m0-5.5-9 9M9 5.75H6.75a2 2 0 0 0-2 2v9.5a2 2 0 0 0 2 2h9.5a2 2 0 0 0 2-2V15"/>'),
    copy: icon('<rect x="8.25" y="8.25" width="11" height="11" rx="2.25"/><path d="M15.75 8.25V7a2.25 2.25 0 0 0-2.25-2.25H7A2.25 2.25 0 0 0 4.75 7v6.5A2.25 2.25 0 0 0 7 15.75h1.25"/>'),
    quote: icon('<path d="M8 17.5 4.75 20V6.75a2 2 0 0 1 2-2h10.5a2 2 0 0 1 2 2v8.75a2 2 0 0 1-2 2Z"/><path d="M8.5 9h7M8.5 12.5H13"/>'),
    annotation: icon('<path d="M10 4.75H6.75a2 2 0 0 0-2 2v10.5a2 2 0 0 0 2 2h10.5a2 2 0 0 0 2-2V14"/><path d="m11 14 1-4 6-6 3 3-6 6-4 1Zm5.5-8.5 3 3"/>'),
    inspect: icon('<rect x="4.5" y="5.5" width="15" height="13" rx="2"/><path d="M8 9.5h8M8 14h5"/>'),
    annotate: icon('<path d="M8 17.5 4.75 20V6.75a2 2 0 0 1 2-2h10.5a2 2 0 0 1 2 2v8.75a2 2 0 0 1-2 2Z"/><path d="M8.5 9h7M8.5 12.5H13"/>'),
    upload: icon('<path d="M12 15V4.75m-4 4 4-4 4 4M4.75 14v3.25a2 2 0 0 0 2 2h10.5a2 2 0 0 0 2-2V14"/>'),
    check: icon('<path d="m5.5 12 4.25 4.25L18.5 7.5"/>'),
  };
  const feedbackTimers = new WeakMap();
  function buttonStatus(button, label, glyph) {
    if (feedbackTimers.has(button)) { clearTimeout(feedbackTimers.get(button)); feedbackTimers.delete(button); }
    button.title = label; button.setAttribute('aria-label', label);
    if (glyph) button.innerHTML = glyph;
  }
  function copied(button, label, glyph) {
    buttonStatus(button, '已复制', ICONS.check);
    feedbackTimers.set(button, setTimeout(() => {
      feedbackTimers.delete(button);
      if (button.isConnected) buttonStatus(button, label, glyph);
    }, 1200));
  }
  const esc = tools.esc;
  function documentToolbar(tab, libraryButton, copyingDisabled, location) {
    const key = esc(tools.artifactKey(tab.file));
    const address = location || tab.label;
    const button = (attr, title, glyph, label = '') => '<button type="button" ' + attr + ' title="' + title + '" aria-label="' + title + '">' + glyph + (label ? '<span>' + label + '</span>' : '') + '</button>';
    return '<div class="ncw-dochead"><div class="ncw-document-name">' + (tab.kind === 'image' ? ICONS.image : ICONS.file) +
      '<b data-wb-file-location data-user-content title="' + esc(address) + '">' + esc(address) + '</b></div>' +
      button('class="ncw-reference-action" data-wb-reference', '引用到对话', ICONS.quote, '引用到对话') +
      '<div class="ncw-document-actions">' + libraryButton +
      button('data-wb-copy-location', '复制文件位置', ICONS.copy) +
      (tab.kind === 'image' ? button('data-wb-image-copy="' + key + '"' + (copyingDisabled ? ' disabled' : ''), '复制图片', ICONS.image) : '') +
      button('data-wb-file-open="' + key + '"', '在原生应用打开', ICONS.external) + '</div></div>';
  }
  function displayAddress(value) {
    const raw = String(value || '');
    if (/^file:/i.test(raw)) {
      try {
        const url = new URL(raw);
        const local = decodeURIComponent(url.pathname).replace(/^\/([a-z]:\/)/i, '$1');
        return (url.hostname ? '//' + url.hostname : '') + local + url.search + url.hash;
      } catch (_) { return raw; }
    }
    // Only the path/query/fragment is presentation text; keep the authority and
    // every escaped ASCII byte intact (especially delimiters and literal %).
    const parts = raw.match(/^(https?:\/\/[^/?#]*)([\s\S]*)$/i);
    if (!parts) return raw;
    return parts[1] + parts[2].replace(/(?:%[89a-f][\da-f])+/gi, encoded => {
      try {
        const decoded = decodeURIComponent(encoded);
        // Invisible separators, controls and bidi markers remain visible as bytes.
        return /[\p{C}\p{Z}]/u.test(decoded) ? encoded : decoded;
      } catch (_) { return encoded; }
    });
  }
  function browserToolbar({ tab, state, location, address, libraryButton }) {
    const display = displayAddress(address);
    const blank = tab.kind === 'browser' && !tab.url && !state.url;
    const referenceDisabled = location ? '' : ' disabled';
    const inspectable = ['browser', 'service', 'web'].includes(tab.kind) && Boolean(state.url || tab.url);
    return '<div class="ncw-browser' + (state.loading ? ' is-loading' : '') + '">' +
      '<form class="ncw-browserbar" data-wb-address-form><span class="ncw-browser-nav"><button type="button" data-wb-nav="back" title="后退" aria-label="后退" ' +
        (state.canBack ? '' : 'disabled') + '>' + ICONS.back + '</button><button type="button" data-wb-nav="forward" title="前进" aria-label="前进" ' +
        (state.canForward ? '' : 'disabled') + '>' + ICONS.forward + '</button><button type="button" data-wb-nav="' +
        (state.loading ? 'stop' : 'reload') + '" title="' + (state.loading ? '停止' : '刷新') + '" aria-label="' + (state.loading ? '停止' : '刷新') + '">' + (state.loading ? ICONS.close : ICONS.reload) +
        '</button></span><button type="button" class="ncw-annotate-action" data-wb-inspect' + (inspectable ? '' : ' disabled') + ' aria-pressed="' + Boolean(state.inspectEnabled) + '" aria-label="标注网页元素" title="进入标注模式，点击网页元素添加批量修改标注">' + ICONS.annotation + '<span>批注</span></button><label class="ncw-address">' + ICONS.globe + '<input data-wb-address value="' + esc(display) + '" title="' + esc(display) + '" ' +
        'autocomplete="off" spellcheck="false" placeholder="输入网址" aria-label="输入网址"></label><span class="ncw-browser-actions"><button type="button" data-wb-nav="external" title="在系统浏览器打开" aria-label="在系统浏览器打开" ' +
        (/^https?:\/\//i.test(state.url || tab.url || '') ? '' : 'disabled') + '>' + ICONS.external + '</button>' + libraryButton + '<button type="button" data-wb-reference' + referenceDisabled + ' title="引用页面内容到对话" aria-label="引用页面内容到对话">' + ICONS.quote + '</button><button type="button" data-wb-copy-location' + referenceDisabled + ' title="复制页面地址" aria-label="复制页面地址">' + ICONS.copy + '</button></span></form>' +
      '<div class="ncw-progress"></div><div class="ncw-browser-error"' + (state.error ? '' : ' hidden') + '>' +
        esc(state.error || '') + '</div>' + (blank
        ? '<div class="ncw-browser-start">' + ICONS.globe + '<b>开始浏览</b><span>输入网址，或等待 SoduWork 启动程序后自动打开。</span></div>'
        : '<div class="ncw-native" data-wb-native><span>正在准备页面…</span></div>') + '</div>';
  }

  function mediaToolbar(tab) {
    const display = esc(displayAddress(tab.url));
    return '<div class="ncw-dochead"><label class="ncw-address"><input data-wb-address readonly value="' + display +
      '" title="' + display + '" aria-label="媒体地址"></label>' +
      '<button type="button" data-wb-media-retry title="重新加载" aria-label="重新加载">' + ICONS.reload + '</button>' +
      '<button type="button" data-wb-copy-location title="复制页面地址" aria-label="复制页面地址">' + ICONS.copy + '</button></div>';
  }

  const api = { toolMeta, status, services, serviceCandidates, changes, currentTurnTools, currentWorkFiles, currentWorkSelection, currentWorkJournal, baseName, normalizeUrl, stripAnsi, isServerCommand, ICONS, documentToolbar, browserToolbar, mediaToolbar, displayAddress, buttonStatus, copied };
  Object.assign(tools, { status, _toolMeta: toolMeta, _services: services, _serviceCandidates: serviceCandidates, _changes: changes, _currentTurnTools: currentTurnTools });
  global.ChatWorkspaceInfo = api;
  global.ChatWorkbenchIcons = ICONS;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
