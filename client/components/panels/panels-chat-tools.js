/*
 * Render tools by user-relevant intent: file writes show content, edits show per-change
 * diffs, commands show status, and reads/searches identify targets. Keep complete command
 * output in execution records. Resolve provider-specific argument aliases and fall back
 * when classification is uncertain rather than inventing details.
 */
(function (global) {
  'use strict';
  const domPatch = global.ChatDomPatch || (typeof require === 'function' ? require('./chat-dom-patch') : null);
  const { patchContent, patchList } = domPatch;
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  function uiOutput(value, fallback) {
    if (value) return '<span data-user-content>' + esc(value) + '</span>';
    return global.SoduWorkI18n?.html(fallback, fallback) || esc(fallback);
  }

  function pick(args, names) {
    for (const n of names) {
      const v = args && args[n];
      if (typeof v === 'string' && v) return v;
    }
    return '';
  }
  function baseName(p) {
    const s = String(p || '').split(/[\\/]/);
    return s[s.length - 1] || p || '';
  }
  function ext(p) {
    const n = baseName(p);
    const i = n.lastIndexOf('.');
    return i < 0 ? '' : n.slice(i + 1).toLowerCase();
  }
  function code(text, lang) {
    const src = String(text == null ? '' : text);
    try {
      if (global.hljs && lang && global.hljs.getLanguage(lang)) {
        return '<code class="hljs">' + global.hljs.highlight(src, { language: lang }).value + '</code>';
      }
    } catch (e) { /* Preserve readable content if syntax highlighting fails. */ }
    return '<code>' + esc(src) + '</code>';
  }
  const MAX_LINES = 80;          // Bound expanded card content; the runtime retains complete logs in temporary files.
  function clamp(text) {
    const lines = String(text || '').split('\n');
    if (lines.length <= MAX_LINES) return { text: String(text || ''), cut: 0 };
    return { text: lines.slice(0, MAX_LINES).join('\n'), cut: lines.length - MAX_LINES };
  }
  const SHORT_SUMMARY = 38;
  function compact(value, limit) {
    const max = Math.max(12, Number(limit) || SHORT_SUMMARY);
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > max ? text.slice(0, max - 1).trimEnd() + '\u2026' : text;
  }
  function commandSummary(value) {
    let command = String(value || '').replace(/[\r\n]+/g, ' ').trim();
    const chain = command.split(/\s*(?:&&|;)\s*/).filter(Boolean);
    while (chain.length > 1 && /^(?:cd|chdir|set-location)\b/i.test(chain[0])) chain.shift();
    command = chain.join(' && ').replace(/^cmd(?:\.exe)?\s+\/[cd]\s+/i, '').trim();
    const known = command.match(/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?[\w:.-]+(?:\s+--?[\w:.-]+)?/i) ||
      command.match(/\bgit\s+(?:status|diff|log|show|branch|checkout|switch|add|commit|push|pull|fetch|merge|rebase|clone)\b(?:\s+(?:"[^"]+"|'[^']+'|\S+)){0,2}/i) ||
      command.match(/\bpython(?:3)?(?:\.exe)?\s+-m\s+http\.server(?:\s+\d+)?/i) ||
      command.match(/\b(?:python(?:3)?(?:\.exe)?\s+-m\s+(?:pytest|unittest)|pytest)\b[^;&|]*/i);
    if (known) return compact(known[0], SHORT_SUMMARY);
    command = chain[0] || command;
    command = command.replace(/(["'])(?:[A-Za-z]:[\\/]|\/)[^"']+\1/g, (whole, quote) => {
      const path = whole.slice(1, -1);
      return quote + baseName(path) + quote;
    });
    return compact(command, SHORT_SUMMARY);
  }
  function toolKind(tool) {
    // ACP display titles vary by runtime and locale; its semantic kind wins.
    const declared = String(tool?.toolKind || '').toLowerCase();
    const kinds = { execute: 'command', command: 'command', terminal: 'command',
      read: 'read', write: 'write', edit: 'edit', delete: 'delete', remove: 'delete', search: 'search', list: 'list' };
    if (Object.hasOwn(kinds, declared)) return kinds[declared];
    const name = String((tool && tool.name) || '').toLowerCase();
    if (name.startsWith('mcp__')) {
      // Server names carry no tool semantics. Recognize only explicit native
      // operation names; delete_record/read_database remain generic MCP calls.
      const operation = name.split('__').slice(2).join('__');
      const native = { read_file: 'read', open_file: 'read', write_file: 'write', create_file: 'write',
        edit_file: 'edit', replace_in_file: 'edit', delete_file: 'delete', remove_file: 'delete', unlink: 'delete',
        bash: 'command', shell: 'command', exec_command: 'command', run_shell_command: 'command',
        command_execution: 'command', write_stdin: 'command' };
      return Object.hasOwn(native, operation) ? native[operation] : 'tool';
    }
    const args = (tool && tool.args && typeof tool.args === 'object') ? tool.args : {};
    if (/write_stdin|exec_command|run_shell_command|command_execution|terminal/.test(name)) return 'command';
    if (/(^|_)(delete|remove|unlink)(_|$)|删除文件/.test(name)) return 'delete';
    if (/(^|_)write|create_file|\u65b0\u5efa\u6587\u4ef6/.test(name)) return 'write';
    if (/(^|_)edit|replace|patch|\u4fee\u6539/.test(name)) return 'edit';
    if (/(^|_)read|cat|open_file/.test(name)) return 'read';
    if (/(^|_)(grep|search)/.test(name)) return 'search';
    if (/(^|_)(ls|list|glob|find)/.test(name)) return 'list';
    if (/bash|shell|command|exec|terminal|run/.test(name) && pick(args, ['command', 'cmd', 'script', 'argv', 'code'])) return 'command';
    return 'tool';
  }
  function icon(tool) {
    const paths = {
      command: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m7 9 3 3-3 3m6 0h4"/>',
      write: '<path d="M11 20.5H6A2.5 2.5 0 0 1 3.5 18V6A2.5 2.5 0 0 1 6 3.5h7.5l5 5V12M13 3.5V9h5.5M7.5 12.5h4M7.5 16h2.5M17.5 14v7m-3.5-3.5h7"/>',
      edit: '<path d="M9.5 20.5H6A2.5 2.5 0 0 1 3.5 18V6A2.5 2.5 0 0 1 6 3.5h7.5l5 5V10M13 3.5V9h5.5M7.5 12.5h3M7.5 16H9m3.5 5 3.5-1 5-5a1.8 1.8 0 0 0-2.5-2.5l-5 5-1 3.5Zm4.8-7.3 2.5 2.5"/>',
      read: '<path d="M12 5.5C9.5 4 6 3.5 3 4.5v14c3-1 6.5-.5 9 1 2.5-1.5 6-2 9-1v-14c-3-1-6.5-.5-9 1Zm0 0v14M6.5 8.5c.8 0 1.5.2 2.2.5m-2.2 3c.8 0 1.5.2 2.2.5m6.6-3.5c.7-.3 1.4-.5 2.2-.5m-2.2 4c.7-.3 1.4-.5 2.2-.5"/>',
      delete: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7m4-7v7"/>',
      list: '<path d="M3 8V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
      search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
      tool: '<rect x="4" y="4" width="6" height="6" rx="1.5"/><rect x="14" y="4" width="6" height="6" rx="1.5"/><rect x="4" y="14" width="6" height="6" rx="1.5"/><path d="M14 17h6m-3-3v6"/>',
    };
    const kind = toolKind(tool);
    return '<svg class="ntool-icon" data-tool-kind="' + kind + '" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + (paths[kind] || paths.tool) + '</svg>';
  }
  function isCommandTool(tool) {
    return toolKind(tool) === 'command';
  }
  function hasVisibleMessageContent(message) {
    if (!message) return false;
    if (message.role === 'user') return true;
    if (Array.isArray(message.attachments) && message.attachments.length) return true;
    if (String(message.text || '').trim()) return true;
    return (message.blocks || []).some((block) => {
      if (!block || !['text', 'thinking'].includes(String(block.kind || ''))) return false;
      return Boolean(String(block.text || '').trim());
    });
  }
  /*
   * A model emits each tool call in its own assistant message.  Those messages
   * contain only a hidden tool-call block, so grouping by `after` would split
   * one command run into a card per command.  Keep the original order and
   * anchor consecutive command calls to the first command until visible prose
   * (or another kind of tool) appears between them.
   */
  function groupConsecutiveCommands(input, messages) {
    const items = Array.isArray(input) ? input : [];
    const history = Array.isArray(messages) ? messages : [];
    /* The old implementation scanned the message slice for every tool. A
       long tool-heavy turn therefore became O(tools * messages) on every
       snapshot. Prefix counts make the same visibility check O(1). */
    const visiblePrefix = [0];
    history.forEach((message, index) => {
      visiblePrefix[index + 1] = visiblePrefix[index] + (hasVisibleMessageContent(message) ? 1 : 0);
    });
    const output = [];
    let previous = null;
    let anchor = null;
    items.forEach((item) => {
      const current = item || {};
      const after = Math.max(0, Number(current.after) || 0);
      const command = isCommandTool(current);
      const from = Math.min(history.length, previous ? previous.after + 1 : 0);
      const to = Math.min(history.length, after + 1);
      const hasVisibleBetween = visiblePrefix[to] - visiblePrefix[from] > 0;
      const source = JSON.stringify(current.sourceAgent || null);
      const canJoin = source === previous?.source && command && previous && previous.command && anchor != null &&
        after >= previous.after && !hasVisibleBetween;
      // Re-anchor without evaluating output accessors; command logs stay lazy.
      const mapped = canJoin && after !== anchor ? Object.defineProperties({}, {
        ...Object.getOwnPropertyDescriptors(current), after: { value: anchor, enumerable: true, writable: true, configurable: true },
      }) : current;
      output.push(mapped);
      if (command) {
        if (!canJoin) anchor = after;
        previous = { after, command: true, source };
      } else {
        previous = { after, command: false, source };
        anchor = null;
      }
    });
    return output;
  }
  function verificationTool(tool) {
    if (toolKind(tool) !== 'command') return false;
    const args = (tool && tool.args) || {};
    return /(?:^|\s)(?:test|check|lint|build|verify|pytest|unittest|health|curl)(?:\s|:|$)/i
      .test(pick(args, ['command', 'cmd', 'script', 'argv']));
  }
  function phaseNarrative(tool, previous) {
    const before = Array.isArray(previous) ? previous : [];
    const kind = toolKind(tool);
    const seen = new Set(before.map(toolKind));
    if (!before.length) {
      if (['read', 'search', 'list'].includes(kind)) {
        return '\u5148\u67e5\u770b\u5de5\u4f5c\u533a\u548c\u73b0\u6709\u5185\u5bb9\uff0c\u786e\u8ba4\u57fa\u7840\u60c5\u51b5\u3002';
      }
      if (kind === 'write' || kind === 'edit') {
        return '\u76ee\u6807\u548c\u8f93\u5165\u5df2\u786e\u8ba4\uff0c\u5f00\u59cb\u5f62\u6210\u53ef\u4ea4\u4ed8\u5185\u5bb9\u3002';
      }
      return '\u5df2\u5f00\u59cb\u6267\u884c\uff0c\u6b63\u5728\u51c6\u5907\u5de5\u4f5c\u73af\u5883\u5e76\u786e\u8ba4\u73b0\u72b6\u3002';
    }
    if ((kind === 'write' || kind === 'edit') && !seen.has('write') && !seen.has('edit')) {
      return '\u73b0\u6709\u5185\u5bb9\u5df2\u786e\u8ba4\uff0c\u6b63\u5728\u5236\u4f5c\u548c\u5b8c\u5584\u4ea4\u4ed8\u5185\u5bb9\u3002';
    }
    if (verificationTool(tool) && (seen.has('write') || seen.has('edit')) && !before.some(verificationTool)) {
      return '\u4e3b\u4f53\u5185\u5bb9\u5df2\u5f62\u6210\uff0c\u6b63\u5728\u8fd0\u884c\u68c0\u67e5\u5e76\u6838\u5bf9\u5b8c\u6210\u6807\u51c6\u3002';
    }
    return '';
  }
  function timeline(input, previous) {
    const rows = [];
    const seen = Array.isArray(previous) ? previous.slice() : [];
    let bucket = [];
    const flush = () => {
      if (!bucket.length) return;
      rows.push({ tools: bucket, key: String(bucket[0].id || rows.length) });
      bucket = [];
    };
    (input || []).forEach((tool) => {
      const note = phaseNarrative(tool, seen);
      if (note) { flush(); rows.push({ note, key: 'phase:' + String(tool.id || rows.length) }); }
      bucket.push(tool); seen.push(tool);
    });
    flush();
    return rows;
  }
  function conciseTool(tool) {
    const item = tool || {};
    const args = (item.args && typeof item.args === 'object') ? item.args : {};
    const kind = toolKind(item);
    const path = pick(args, ['path', 'file_path', 'filePath', 'filename', 'file', 'target']);
    if (kind === 'command') {
      return render(item).title;
    }
    const labels = {
      write: '\u5199\u5165', edit: '\u4fee\u6539', read: '\u8bfb\u53d6', delete: '删除', search: '\u641c\u7d22',
      list: '\u67e5\u770b', tool: '\u8c03\u7528',
    };
    const subject = path || pick(args, ['pattern', 'query', 'dir']) || item.name || '';
    return compact((labels[kind] || '\u6267\u884c') + (subject ? ' ' + baseName(subject) : ''), 44);
  }
  function accessCancelled(item) {
    return item?.state === 'cancelled' && item.cancelReason === 'access-change' && !item.isError;
  }
  function batchSummary(input) {
    const items = Array.isArray(input) ? input.filter(Boolean) : [];
    const running = items.filter(item => String(item.state || '').toLowerCase() === 'running');
    const errors = items.filter(item => !accessCancelled(item) && (item.isError || /^(?:error|failed|cancelled)$/i.test(String(item.state || ''))));
    const cancelled = items.filter(accessCancelled);
    const complete = Math.max(0, items.length - running.length);
    const current = running[running.length - 1] || items[items.length - 1] || null;
    const state = running.length ? 'running' : errors.length ? 'error' : cancelled.length === items.length && items.length ? 'cancelled' : 'done';
    const commandsOnly = items.length > 0 && items.every(item => isCommandTool(item) && render(item)?.commandOnly);
    return {
      total: items.length,
      complete,
      errors: errors.length,
      state,
      commandsOnly,
      title: running.length
        ? (commandsOnly ? '正在运行命令' : '正在执行操作')
        : errors.length
          ? (commandsOnly ? '命令执行有异常' : '执行有异常')
          : cancelled.length === items.length && items.length ? '权限已调整，未执行'
          : (commandsOnly ? '运行了命令' : '完成了操作'),
      detail: running.length ? conciseTool(current)
        : (errors.length ? errors.length + ' 项异常' : cancelled.length && cancelled.length < items.length ? '部分操作因权限调整未执行' : ''),
    };
  }
  function batchHtml(input, key, open, itemHtml) {
    const items = Array.isArray(input) ? input.filter(Boolean) : [];
    if (!items.length) return '';
    const summary = batchSummary(items);
    const id = String(key || (items[0] && items[0].id) || 'batch');
    if (summary.commandsOnly) {
      return '<div class="ntool-batch ' + summary.state +
        '" data-tool-node="batch:commands:' + esc(id) + '">' +
        '<div class="ntool-batch-head ntool-summary">' + icon(items[0]) +
          '<span class="ntool-batch-title">' + esc(summary.title) + '</span>' +
          (summary.total > 1 ? '<span class="ntool-batch-count">' + summary.total + ' 项</span>' : '') +
          (summary.errors ? '<span class="ntool-batch-detail">' + summary.errors + ' 项异常</span>' :
            /权限/.test(summary.detail) ? '<span class="ntool-batch-detail">' + esc(summary.detail) + '</span>' : '') +
        '</div></div>';
    }
    const rows = typeof itemHtml === 'function' ? items.map(itemHtml).join('') : '';
    return '<div class="ntool-batch ' + summary.state + (open ? ' open' : '') +
      '" data-tool-node="batch:' + esc(id) + '">' +
      '<button class="ntool-batch-head" type="button" data-tool-group="' + esc(id) +
        '" aria-expanded="' + (open ? 'true' : 'false') + '">' +
        icon(items[0]) +
        "<span class=\"ntool-batch-copy\"><b class=\"ntool-batch-title\">" + esc(summary.title) + '</b>' +
          (summary.detail ? '<span class="ntool-batch-detail">' + esc(summary.detail) + '</span>' : '') + '</span>' +
        (summary.total > 1 ? '<span class="ntool-batch-count">' + summary.total + ' 项</span>' : '') +
        '<svg class="ntool-batch-caret" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>' +
      '</button><div class="ntool-batch-body">' + rows + '</div></div>';
  }
  const MCP_SAY = Object.freeze({
    task_options: '查看执行机和流程',
    task_propose: '提议一张任务卡',
    task_create: '创建任务',
    task_list: '查看我的任务',
    task_get: '查看任务详情',
    task_update: '更新任务',
  });
  function unquote(value) {
    const text = String(value || '');
    return /^(["']).*\1$/.test(text) ? text.slice(1, -1) : text;
  }
  function jsonField(command, key) {
    const normalized = String(command || '').replace(/\\"/g, '"');
    const matched = normalized.match(new RegExp('"' + key + '"\\s*:\\s*"([^"\\n]{1,200})"'));
    return matched ? matched[1] : '';
  }
  /*
   * Pi represents MCP bridge calls as bash. Show their business meaning without exposing
   * temporary authorization files, bridge paths, or shell details.
   */
  function mcpView(t, result, done) {
    const args = (t.args && typeof t.args === 'object') ? t.args : {};
    const native = /^(?:mcp__soduwork[-_]plugin__)?plugin_mcp_(list|call)$/.exec(String(t.name || ''));
    if (native) return { title: '连接器', sub: native[1] === 'list'
      ? '查看 ' + (args.server || '连接器') + ' 的能力'
      : (args.server ? args.server + ' · ' : '') + (args.tool || '执行外部操作'),
      localizedSub: true, summaryOnly: true, body: '', tip: '' };
    const command = pick(args, ['command', 'cmd', 'script', 'argv']);
    const bridge = command.match(/mcp\.mjs["']?\s+([\s\S]+)/i);
    if (!bridge) return null;
    let tail = bridge[1].trim();
    tail = tail.replace(/^--config(?:=(?:"[^"]*"|'[^']*'|\S+)|\s+(?:"[^"]*"|'[^']*'|\S+))\s+/i, '');
    const call = tail.match(/^(servers|list|call)(?:\s+("[^"]*"|'[^']*'|\S+))?(?:\s+("[^"]*"|'[^']*'|\S+))?/i);
    if (!call) return null;
    const action = call[1].toLowerCase();
    const server = unquote(call[2]);
    const tool = unquote(call[3]);
    let title = server === 'soduwork-plugin' ? '连接器' : 'SoduWork';
    let sub = '查看已连接的工具';
    if (action === 'servers') sub = '查看可用连接';
    else if (action === 'list' && server === 'soduwork-plugin') sub = '读取本轮连接器工具';
    // Preserve historical protocol service IDs; update only first-party display branding, never commands, paths, or third-party names.
    else if (action === 'list') sub = '查看 ' + (/^soduwork$/i.test(server) ? 'SoduWork' : server || '连接') + ' 的工具';
    else if (action === 'call' && server === 'soduwork-plugin') {
      const connector = jsonField(command, 'server');
      const target = jsonField(command, 'tool');
      if (tool === 'plugin_mcp_list') sub = '查看 ' + (connector || '连接器') + ' 的能力';
      else if (tool === 'plugin_mcp_call') {
        sub = (connector ? connector + ' · ' : '') + (target || '执行外部操作');
      } else sub = '执行连接器操作';
    } else if (action === 'call') {
      sub = MCP_SAY[tool] || ('调用 ' + (tool || '工具'));
    }
    return {
      title, sub, tip: sub, localizedSub: true,
      get body() { const output = clamp(typeof result === 'function' ? result() : result);
        return '<pre class="ntool-pre">' + uiOutput(output.text, done ? '已完成' : '正在执行…') + '</pre>' +
          (output.cut ? '<div class="nd-skip">…… 还有 ' + output.cut + ' 行 ……</div>' : ''); },
    };
  }



  function diffHtml(oldText, newText, name) {
    const D = global.Diff;
    const H = global.Diff2Html;
    const file = name || 'file';
    if (D && D.createTwoFilesPatch && H && H.html) {
      const patch = D.createTwoFilesPatch(file, file,
        String(oldText || ''), String(newText || ''), '', '', { context: 3 });
      return H.html(patch, {
        drawFileList: false,
        outputFormat: 'line-by-line',
        matching: 'lines',
        renderNothingWhenEmpty: false,
      });
    }
    if (!D || !D.diffLines) return '<div class="nd-none">（这台机器上没装 diff 库，看不了改动）</div>';
    const rows = [];
    D.diffLines(String(oldText || ''), String(newText || '')).forEach((p) => {
      const lines = p.value.split(String.fromCharCode(10));
      if (lines.length && lines[lines.length - 1] === '') lines.pop();
      lines.forEach((ln) => {
        const cls = p.added ? ' add' : p.removed ? ' del' : '';
        const sign = p.added ? '+' : p.removed ? '-' : ' ';
        rows.push('<div class="nd-l' + cls + '"><i>' + sign + '</i><span>' + esc(ln) + '</span></div>');
      });
    });
    return '<div class="nd">' + rows.join('') + '</div>';
  }
  /* Classify a tool call into icon, title, sub, and body; return null when unrecognized. */
  function render(t) {
    if (t.phase === 'preparing') return {
      title: /write|edit|create/i.test(t.name) ? '正在生成文件' : /read/i.test(t.name) ? '准备读取' : '准备删除',
      sub: baseName(pick(t.args, ['path', 'filePath', 'file_path'])), summaryOnly: true, body: '', tip: '',
    };
    // Conversation command cards show status only, without expandable command/receipt details or hover payloads.
    // Avoid reading potentially large result/partial payloads here; execution records retain them intact.
    if (isCommandTool(t)) {
      const done = t.state !== 'running';
      const mcp = mcpView(t, '', done);
      if (mcp) return { ...mcp, summaryOnly: true, body: '', tip: '' };
      return {
        title: accessCancelled(t) ? '权限已调整，未执行' :
          (done ? (t.isError || /^(?:error|failed|cancelled)$/i.test(t.state) ? '命令执行异常' : '运行了命令') : '正在运行命令'),
        sub: '', commandOnly: true, summaryOnly: true, body: '', tip: '',
      };
    }
    if (accessCancelled(t)) return {
      title: '权限已调整，未执行', sub: conciseTool(t), tip: t.name || '',
      body: '<pre>' + esc('此操作在执行前因权限调整而取消，将按新权限继续当前任务。') + '</pre>',
    };
    if (t.name === 'generate_image') return {
      title: t.state === 'running' ? '正在生成图片' : t.isError ? '图片生成未完成' : '图片已生成',
      sub: String(t.args?.prompt || '').slice(0, 120), tip: String(t.args?.prompt || ''),
      get body() { return '<pre>' + uiOutput(t.result, '生成完成后，图片会显示在当前对话中。') + '</pre>'; },
    };
    const name = String(t.name || '').toLowerCase();
    const kind = toolKind(t);
    const args = (t.args && typeof t.args === 'object') ? t.args : {};
    const path = pick(args, ['path', 'file_path', 'filePath', 'filename', 'file', 'target']);
    // Read contents are already in the tool receipt; only process them on click.
    if (kind === 'read' && path) return {
      title: '读取', sub: baseName(path), tip: path, file: true, side: true, readSnapshot: true, body: '',
    };
    const done = t.state !== 'running';
    // Summary consumers must never touch large receipts or run syntax/diff formatting.
    const result = () => done ? String(t.result || '') : String(t.partial || '');
    const mcp = mcpView(t, result, done);
    if (mcp) return mcp;
    // File writes.
    if (kind === 'write' && path) {
      return {
        title: '写入', sub: baseName(path), tip: path, side: true, file: true,
        get body() { const c = clamp(pick(args, ['content', 'text', 'body', 'data']));
          return '<pre class="ntool-pre hljs">' + code(c.text, ext(path)) + '</pre>' +
            (c.cut ? '<div class="nd-skip">…… 还有 ' + c.cut + ' 行 ……</div>' : ''); },
      };
    }
    // File edits with per-change diffs.
    // Pi edit calls can contain path and multiple edits with oldText/newText pairs.
    // Render each edit separately; concatenating unrelated changes would fabricate a diff.
    const edits = Array.isArray(args.edits) ? args.edits : null;
    const oldT = pick(args, ['old_string', 'oldText', 'old_str', 'search', 'from']);
    const newT = pick(args, ['new_string', 'newText', 'new_str', 'replace', 'to']);
    if (kind === 'edit' && (path || edits || oldT || newT)) {
      const editCount = Number(t.detailSummary?.editCount) || edits?.length || 0;
      // Prefer main-process precomputed line counts; legacy records without counts show the number of changes.
      const added = Number(t.detailSummary?.added);
      const removed = Number(t.detailSummary?.removed);
      const hasStat = Number.isFinite(added) && Number.isFinite(removed);
      const label = baseName(path) || '文件';
      const stat = hasStat
        ? ' <span class="ntool-diffstat"><b class="add">+' + added + '</b><b class="del">-' + removed + '</b></span>'
        : (editCount > 1 ? '（' + editCount + ' 处）' : '');
      const statText = hasStat ? ' +' + added + ' -' + removed : (editCount > 1 ? '（' + editCount + ' 处）' : '');
      return { title: '修改', sub: label + statText, subHtml: esc(label) + stat, tip: path, side: true, file: Boolean(path),
        get body() { let body;
      if (edits && edits.length) {
        body = edits.map((e, i) => (edits.length > 1 ? '<div class="nd-hunk">第 ' + (i + 1) + ' 处</div>' : '') +
          diffHtml(pick(e, ['oldText', 'old_string', 'old_str', 'from']),
                   pick(e, ['newText', 'new_string', 'new_str', 'to']), baseName(path))).join('');
      } else if (oldT || newT) {
        body = diffHtml(oldT, newT, baseName(path));
      } else {
        body = '<pre class="ntool-pre">' + uiOutput(clamp(result()).text, done ? '已完成' : '正在执行…') + '</pre>';
      }
      return body; } };
    }
    // Summarize read/list/search targets without displaying complete payloads.
    if (kind === 'delete' && path) return {
      title: '删除', sub: baseName(path), tip: path, file: true,
      get body() { return '<pre class="ntool-pre">' + uiOutput(clamp(result()).text, done ? '已完成' : '正在执行…') + '</pre>'; },
    };
    if (/(^|_)(ls|list|glob|find|grep|search)/.test(name)) {
      const q = pick(args, ['pattern', 'query', 'path', 'dir']) || '';
      return {
        title: /grep|search/.test(name) ? '\u641c\u7d22' : '\u67e5\u770b', sub: compact(q), tip: q,
        get body() { const r = clamp(result());
          return '<pre class="ntool-pre">' + uiOutput(r.text, done ? '（没有结果）' : '正在找…') + '</pre>' +
            (r.cut ? '<div class="nd-skip">…… 还有 ' + r.cut + ' 行 ……</div>' : ''); },
      };
    }
    const label = compact(name.replace(/[_-]+/g, ' '), 34) || '\u5de5\u5177';
    return {
      title: '\u8c03\u7528', sub: label, tip: name,
      get body() { const raw = clamp(JSON.stringify(args, null, 2)), output = clamp(result());
        return (raw.text && raw.text !== '{}' ? '<pre class="ntool-pre cmd">' + esc(raw.text) + '</pre>' : '') +
          '<pre class="ntool-pre">' + uiOutput(output.text, done ? '（没有输出）' : '正在执行…') + '</pre>'; },
    };
  }
  function composerHasPayload(root, attachments) {
    const input = root && root.querySelector('#nchatInput');
    const text = String((input && input.value) || '').trim();
    const files = attachments && typeof attachments.names === 'function' ? attachments.names() : [];
    return Boolean(text || files.length || Number(root && root.dataset && root.dataset.annotationCount) || Number(root && root.dataset && root.dataset.skillCount));
  }
  function paintSendButton(root, busy, attachments, requestedState, stoppable, sendState) {
    if (!root || typeof root.querySelector !== 'function') return;
    const send = root.querySelector('#nchatSend');
    if (!send) return;
    const state = String(requestedState || root.dataset?.stopState ||
      root.querySelector('.nbox')?.dataset?.stopState || 'idle');
    // A requested stop remains visibly pending until its receipt arrives;
    // runtime snapshots can briefly report idle while the active turn is still
    // settling, so busy alone must not clear this state.
    const stopping = state === 'requested';
    const canStop = stoppable === undefined ? Boolean(busy) : Boolean(stoppable);
    // Once the runtime has accepted the turn, the same submission may still
    // be awaiting its final IPC receipt. The visible action must already be
    // stop in that window; only a not-yet-stoppable submission shows sending.
    const sending = String(sendState || root.dataset?.sendState || 'idle') === 'sending' && !canStop;
    // Timeout is an internal cancellation outcome. Keep the action surface in
    // the normal send/stop state instead of exposing a third retry action.
    const showStop = Boolean(canStop || stopping);
    const transient = Boolean(sending || stopping);
    const title = stopping ? '\u505c\u6b62\u4e2d\u2026' : sending ? '\u53d1\u9001\u4e2d\u2026' :
      showStop ? '\u505c\u6b62\u751f\u6210' : '\u53d1\u9001';
    send.classList.toggle('stop', showStop && !transient);
    send.classList.toggle('stop-pending', transient);
    send.disabled = transient;
    send.setAttribute('aria-busy', String(transient));
    send.title = title;
    send.setAttribute('aria-label', title);
    const html = transient
      ? '<span class="nsend-spinner" aria-hidden="true"></span>'
      : showStop
        ? '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="3"/></svg>'
        : '<svg viewBox="0 0 24 24"><path d="M12 19V6M6.5 11.5 12 6l5.5 5.5"/></svg>';
    if (send._sendMarkup !== html) { send.innerHTML = html; send._sendMarkup = html; }
  }
  function toggleGroup(target, openGroups) {
    const trigger = target && target.closest('[data-tool-group]');
    if (!trigger) return false;
    const key = trigger.getAttribute('data-tool-group');
    const box = trigger.closest('.ntool-batch');
    const open = box && box.classList.toggle('open');
    trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) openGroups.add(key); else openGroups.delete(key);
    return true;
  }
  function appendGoalProgress(parts, rows, state, limit) {
    const tracker = state || { index: 0 };
    const ceiling = Number.isFinite(Number(limit)) ? Number(limit) : Infinity;
    while (tracker.index < rows.length) {
      const row = rows[tracker.index];
      if (Number(row.progressIndex || 0) > ceiling) break;
      parts.push(row.html);
      tracker.index += 1;
    }
    return tracker.index;
  }
  function toolProgressBoundary(tool, rows) {
    const explicit = Number(tool && tool.goalProgressCount);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
    const startedAt = Number(tool && tool.startedAt);
    if (startedAt > 0) {
      let boundary = 0;
      rows.forEach((row) => {
        if (Number(row.at || 0) > 0 && Number(row.at) <= startedAt) {
          boundary = Math.max(boundary, Number(row.progressIndex || 0));
        }
      });
      if (boundary) return boundary;
    }
    const execute = rows.find((row) => row.phase === 'execute');
    return execute ? execute.progressIndex : (rows[0] ? rows[0].progressIndex : null);
  }
  function appendTimeline(parts, input, previous, anchor, narrated, itemHtml, openGroups,
      progressRows, progressState) {
    if (!input.length) return;
    const staged = narrated && Array.isArray(progressRows) && progressRows.length && progressState;
    if (!staged) {
      const rows = narrated ? timeline(input, previous) : [{ tools: input, key: anchor }];
      rows.forEach((row) => {
        if (row.note) {
          parts.push('<div class="nprocess" data-chat-node="process:' + esc(anchor + ':' + row.key) + '">' +
            "<span aria-hidden=\"true\"></span><p data-user-content>" + esc(row.note) + '</p></div>');
        }
        if (row.tools && row.tools.length) {
          const groupKey = anchor + ':' + row.key;
          const content = row.tools.length >= 2
            ? batchHtml(row.tools, groupKey, openGroups.has(groupKey), itemHtml)
            : row.tools.map(itemHtml).join('');
          parts.push('<div class="nmsg ai" data-chat-node="tools:' + esc(anchor + ':' + row.key) + '">' +
            content + '</div>');
        }
      });
      previous.push(...input);
      return;
    }
    let bucket = [];
    let boundary = null;
    let sequence = 0;
    const flush = () => {
      if (!bucket.length) return;
      sequence += 1;
      const groupKey = anchor + ':goal:' + String(boundary == null ? 'legacy' : boundary) +
        ':' + String(bucket[0].id || sequence);
      const content = bucket.length >= 2
        ? batchHtml(bucket, groupKey, openGroups.has(groupKey), itemHtml)
        : bucket.map(itemHtml).join('');
      parts.push('<div class="nmsg ai" data-chat-node="tools:' + esc(groupKey) + '">' +
        content + '</div>');
      bucket = [];
    };
    input.forEach((tool) => {
      const nextBoundary = toolProgressBoundary(tool, progressRows);
      if (bucket.length && nextBoundary !== boundary) flush();
      appendGoalProgress(parts, progressRows, progressState, nextBoundary);
      boundary = nextBoundary;
      bucket.push(tool);
    });
    flush();
    previous.push(...input);
  }
  function goalProgressRows(goalMode, harness, quality, goalReady) {
    if (!goalMode || !global.WorkIntent || typeof WorkIntent.phaseView !== 'function') return [];
    const progress = WorkIntent.phaseView({ phases: harness.phases, ready: goalReady });
    if (!progress || !progress.phase) return [];
    const copy = {
      understand: '\u6b63\u5728\u68b3\u7406\u76ee\u6807\u3001\u73b0\u72b6\u4e0e\u5b8c\u6210\u6807\u51c6\u3002',
      plan: '\u6b63\u5728\u5f62\u6210\u53ef\u6267\u884c\u8ba1\u5212\u5e76\u786e\u8ba4\u5fc5\u8981\u4f9d\u8d56\u3002',
      execute: '\u6b63\u5728\u6309\u8ba1\u5212\u63a8\u8fdb\uff0c\u5e76\u6301\u7eed\u8bb0\u5f55\u5173\u952e\u53d8\u5316\u3002',
      verify: '\u6b63\u5728\u6838\u5bf9\u7ed3\u679c\u3001\u8bc1\u636e\u548c\u5b8c\u6210\u6807\u51c6\u3002',
      deliver: goalReady ? '\u4ea4\u4ed8\u5df2\u6574\u7406\u5b8c\u6210\uff0c\u53ef\u7ee7\u7eed\u6838\u5bf9\u6216\u8ffd\u95ee\u3002'
        : '\u6b63\u5728\u6574\u7406\u6700\u7ec8\u7ed3\u679c\u548c\u53ef\u6253\u5f00\u7684\u6210\u679c\u3002',
    };
    const eventMeta = {
      'run.started': ['understand', '理解目标'],
      'plan.ready': ['plan', '形成方案'],
      'replan.requested': ['plan', '调整方案'],
      'action.started': ['execute', '开始实施'],
      'action.observed': ['execute', '本轮实施完成'],
      'verification.started': ['verify', '开始验收'],
      'verification.failed': ['verify', '发现缺口，继续修订'],
      'verification.passed': ['verify', '验收通过'],
      'run.paused': [harness.phase || 'execute', '已安全暂停'],
      'run.resumed': ['execute', '继续实施'],
      'run.blocked': ['deliver', '需要处理'],
      'run.completed': ['deliver', '交付完成'],
    };
    const phaseRows = Array.isArray(harness.phases) ? harness.phases : [];
    const phaseOrder = ['understand', 'plan', 'execute', 'verify', 'deliver'];
    const phaseIndex = new Map(phaseRows.map((row, index) => [row.key, index + 1]));
    const latestByPhase = new Map();
    (Array.isArray(harness.progress) ? harness.progress : []).forEach((item, index) => {
      const meta = eventMeta[String(item && item.type || '')];
      if (!meta) return;
      const type = String(item.type || '');
      const detail = String(item.summary || '')
        .replace(/<\/?soduwork-[^>]*>/gi, '').replace(/system_warning/gi, '')
        .replace(/\s+/g, ' ').trim();
      const state = type === 'run.blocked' ? 'blocked'
        : type === 'run.paused' ? 'paused'
          : /run\.completed|verification\.passed/.test(type) ? 'completed' : 'running';
      const row = {
        key: 'phase:' + meta[0],
        progressIndex: index + 1,
        at: Number(item.at || 0),
        phase: meta[0], label: meta[1],
        reason: (state === 'blocked' || state === 'paused') && detail
          ? detail.slice(0, 140) : copy[meta[0]],
        state,
      };
      /*
       * Retain the latest fact per phase under a stable phase:<key> DOM key; repeated
       * polling/actions update in place instead of appending progress narration.
       */
      latestByPhase.set(row.phase, row);
    });
    const history = [...latestByPhase.values()].sort((a, b) => {
      const ai = phaseOrder.indexOf(a.phase);
      const bi = phaseOrder.indexOf(b.phase);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    });
    if (!history.length) {
      const reason = String(harness.reason || quality.reason || copy[progress.phase.key] || '').trim();
      history.push({
        key: 'phase:' + progress.phase.key, progressIndex: 0, at: 0,
        phase: progress.phase.key, label: progress.phase.label, reason,
        state: progress.phase.state,
      });
    }
    return history.map((item, index) => {
      const number = phaseIndex.get(item.phase) || progress.current;
      const visualState = index < history.length - 1 && item.state === 'running'
        ? 'completed' : item.state;
      const html = '<div data-chat-node="goal-progress:' + esc(item.key) +
        '" class="nprocess ngoal-phase is-' + esc(visualState) +
        '"><span aria-hidden="true"></span><p><b>第 ' +
        number + ' / ' + progress.total + ' 步 · ' + esc(item.label) + '</b>' +
        (item.reason ? '<i>' + esc(item.reason.slice(0, 140)) + '</i>' : '') +
        '</p></div>';
      return { ...item, state: visualState, html };
    });
  }
  function goalPhaseHtml(goalMode, harness, quality, goalReady) {
    return goalProgressRows(goalMode, harness, quality, goalReady)
      .map((row) => row.html).join('');
  }
  function artifactKey(item) {
    return String(item && (item.artifactId || item.path) || '');
  }
  function artifactRequest(api, ref, file, action) {
    if (!api || !file) return null;
    if (file.taskId && file.attachmentId) {
      if (action === 'open') return global.ChatOutputLinks.openTaskFile(file,global.SoduWorkAPI,global.soduWorkAPI);
      return global.ChatOutputLinks.readPreview(file,api,ref,action);
    }
    if (file.artifactId && typeof api.artifactAction === 'function') {
      return api.artifactAction(ref, file.artifactId, action);
    }
    if (action === 'open' && file.path && typeof api.openOutput === 'function') {
      return api.openOutput(ref, file.path);
    }
    if (action === 'read' && file.path && typeof api.readOutput === 'function') {
      return api.readOutput(ref, file.path);
    }
    return null;
  }
  const OFFICE_EXTENSIONS = /^(?:doc|docx|xls|xlsx|ppt|pptx|odt|ods|odp|rtf|pages|numbers|key)$/;
  const ARCHIVE_EXTENSIONS = /^(?:zip|rar|7z|tar|gz|tgz|bz2|xz)$/;
  const ARCHIVE_MIME = /^application\/(?:zip|x-zip-compressed|x-rar-compressed|vnd\.rar|x-7z-compressed|x-tar|gzip|x-gzip|x-bzip2|x-xz)$/;
  const OFFICE_MIME = /^(?:application\/(?:msword|rtf|vnd\.ms-[\w.+-]+|vnd\.openxmlformats-officedocument\.[\w.+-]+|vnd\.oasis\.opendocument\.[\w.+-]+)|text\/rtf)$/;
  const TEXT_MIME = /^(?:text\/.+|application\/(?:json|xml|yaml|x-yaml|javascript|typescript|sql))$/;
  function previewKind(file) {
    const item = file || {};
    const declared = String(item.kind || '').trim().toLowerCase();
    const mime = String(item.contentType || item.mimeType || item.type || '').split(';', 1)[0].trim().toLowerCase();
    const suffix = ext(item.name || item.relative || item.path);
    // Office and other explicitly packaged outputs stay out of the workbench.
    // They are handed to the OS so Excel/PowerPoint/Word (or the user's
    // configured equivalent) can render the original bytes faithfully.
    if (OFFICE_EXTENSIONS.test(suffix) || OFFICE_MIME.test(mime) ||
        ARCHIVE_EXTENSIONS.test(suffix) || ARCHIVE_MIME.test(mime) ||
        ['presentation', 'spreadsheet', 'archive', 'binary'].includes(declared)) return 'external';
    const mapped = { website: 'web', pdf: 'pdf', image: 'image', video: 'video' }[declared];
    if (mapped) return mapped;
    if (declared === 'markdown' || /^(md|markdown)$/.test(suffix)) return 'markdown';
    if (declared === 'document' && !suffix && !mime) return 'external';
    if (/^html?$/.test(suffix) || mime === 'text/html' || mime === 'application/xhtml+xml') return 'web';
    if (declared === 'text' || TEXT_MIME.test(mime)) return 'text';
    if (suffix === 'pdf' || mime === 'application/pdf') return 'pdf';
    if (/^(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/.test(suffix) || mime.startsWith('image/')) return 'image';
    if (/^(mp4|m4v|webm|mov|ogv)$/.test(suffix) || mime.startsWith('video/')) return 'video';
    if (/^(txt|csv|json|ya?ml|xml|js|jsx|ts|tsx|css|scss|py|java|go|rs|sql|sh|ps1)$/.test(suffix)) return 'text';
    return 'external';
  }
  function fileUrl(value) {
    const valuePath = String(value || '').replace(/\\/g, '/');
    const url = valuePath.startsWith('//') ? 'file:' + valuePath
      : 'file:///' + valuePath.replace(/^\/+/, '');
    return encodeURI(url).replace(/#/g, '%23').replace(/\?/g, '%3F');
  }
  function normalizeAddress(raw) {
    let value = String(raw || '').trim();
    if (!value) return '';
    if (/^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:\/|$)/i.test(value)) value = 'http://' + value;
    else if (!/^[a-z][a-z\d+.-]*:/i.test(value)) value = 'https://' + value;
    if (!/^https?:\/\//i.test(value)) return '';
    try {
      const parsed = new URL(value);
      if (isTimestampLikeHost(parsed.hostname)) return '';
      // Preserve the renderer's address-bar text (including the absence of a
      // trailing slash) while still validating the hostname shape.
      return value;
    } catch (_) { return ''; }
  }
  function isTimestampLikeHost(host) {
    const value = String(host || '').trim().replace(/^\[|\]$/g, '');
    return /^(?:\d{4}[-/]\d{1,2}[-/]\d{1,2})(?:[tT _-]\d{1,2})(?::\d{1,2}(?::\d{1,2})?)?$/.test(value);
  }
  function currentTurnTools(snapshot) {
    const snap = snapshot || {};
    let turnAt = -1;
    (snap.messages || []).forEach((item, index) => {
      if (item && item.role === 'user') turnAt = index;
    });
    return (snap.tools || []).filter((item) => Number(item && item.after || 0) >= turnAt);
  }
  function latestTurnWebFile(files, changes, previewKind) {
    const candidates = (files || []).filter((item) => previewKind(item) === 'web' && item.primary !== false && !item.processEvidence)
      .sort((left, right) => Number(right.at || 0) - Number(left.at || 0));
    const normalized = (changes || []).map((item) =>
      String(item && item.path || '').replace(/\\/g, '/').replace(/^\.\//, ''));
    return candidates.find((file) => file.changedInTurn) || candidates.find((file) => {
      const target = String(file && file.path || '').replace(/\\/g, '/');
      const relative = String(file && (file.relative || file.name) || '')
        .replace(/\\/g, '/').replace(/^\.\//, '');
      return normalized.some((changed) => changed &&
        (changed === target || changed === relative || target.endsWith('/' + changed)));
    }) || null;
  }
  /*
   * Display write/edit details beside the collapsed conversation card. Mount on
   * document.body to avoid transformed panel ancestors.
   */
  let _sideDrawer = null, _sideMask = null, _sideEsc = null;
  function closeSide() {
    if (_sideMask) { _sideMask.remove(); _sideMask = null; }
    if (_sideDrawer) { _sideDrawer.remove(); _sideDrawer = null; }
    if (_sideEsc) { global.removeEventListener('keydown', _sideEsc, true); _sideEsc = null; }
  }
  function openSide(t) {
    const kind = (t && typeof t === 'object') ? render(t) : null;
    if (!kind || !kind.side || typeof document === 'undefined') return false;
    /*
     * Route all write/edit cards through the shared workbench. If no indexed output exists,
     * supply bounded tool text as a temporary change hint so tabs, CodeMirror, and Diff2Html
     * remain consistent.
     */
    const args = (t && typeof t === 'object' && t.args && typeof t.args === 'object') ? t.args : {};
    const sidePath = pick(args, ['path', 'file_path', 'filePath', 'filename', 'file', 'target']);
    if (!sidePath || !global.ChatWorkbench || typeof ChatWorkbench.openPath !== 'function') return false;
    const bounded = (value) => String(value == null ? '' : value).slice(0, 240000);
    if (kind.readSnapshot) {
      const text = String((t.state === 'running' ? t.partial : t.result) || '');
      return ChatWorkbench.openPath(sidePath, { readSnapshot: {
        id: String(t.id || sidePath), text: bounded(text), truncated: text.length > 240000,
        images: Array.isArray(t.readImages) ? t.readImages : [],
        imageCount: Number(t.readImageCount) || t.readImages?.length || 0,
        imagesTruncated: Boolean(t.readImagesTruncated),
      } });
    }
    const edits = Array.isArray(args.edits) ? args.edits : [];
    const oldText = pick(args, ['old_string', 'oldText', 'old_str', 'search', 'from']) ||
      edits.map((item) => pick(item, ['oldText', 'old_string', 'old_str', 'from'])).filter(Boolean).join('\n');
    const newText = pick(args, ['new_string', 'newText', 'new_str', 'replace', 'to']) ||
      edits.map((item) => pick(item, ['newText', 'new_string', 'new_str', 'to'])).filter(Boolean).join('\n') ||
      pick(args, ['content', 'text', 'body', 'data']);
    const change = (oldText || newText) ? {
      action: oldText ? 'modified' : 'created',
      before: { text: bounded(oldText) }, after: { text: bounded(newText) },
    } : null;
    return ChatWorkbench.openPath(sidePath, change ? { change, size: newText.length } : null);
  }
  function displayTools(snap) {
    const tools = snap?.tools || [], ids = new Set(tools.map(row => row.id));
    return tools.concat((snap?.toolPreparations || []).filter(row => !ids.has(row.id)));
  }
  global.ChatTools = { displayTools, render, icon, kind: toolKind, diffHtml, esc, patchList, patchContent, mcpView, commandSummary, timeline,
    isCommandTool, groupConsecutiveCommands, openSide, closeSide,
    phaseNarrative, batchSummary, batchHtml, composerHasPayload, paintSendButton, toggleGroup,
    appendTimeline, appendGoalProgress, goalProgressRows, goalPhaseHtml, artifactKey,
    artifactRequest, previewKind, fileUrl, normalizeAddress, currentTurnTools, latestTurnWebFile };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.ChatTools;
})(window);
