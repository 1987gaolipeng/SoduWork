/* Conversation context, work drafts and proposals; state is owned by NativeChat, never copied. */
(function (global) {
  'use strict';
  function create(ctx) {
  function _chatDraftBridge() {
    const bridge = (typeof global.composeDraftBridge === 'function') ? composeDraftBridge() : {};
    const inherited = typeof bridge.atts === 'function' ? bridge.atts : () => [];
    const clearInherited = typeof bridge.clearAtts === 'function' ? bridge.clearAtts : () => {};
    return Object.assign({}, bridge, {
      variant: 'chat',
      atts: () => [
        ...(inherited() || []),
        ...(ctx._messageAttachments ? ctx._messageAttachments.files() : []),
        ...ctx._taskAttachments,
      ],
      clearAtts: () => {
        clearInherited();
        if (ctx._messageAttachments) ctx._messageAttachments.clear();
        ctx._taskAttachments = [];
      },
      onCreated: (id, title, outcome) => {
        if (typeof bridge.onCreated === 'function') bridge.onCreated(id, title, outcome);
        if (outcome && outcome.handedOff) return;
        ctx._bindCollaborationTask(id, title);
      },
      onOpen: (id, title, outcome) => {
        if (outcome && outcome.handedOff) return;
        ctx._bindCollaborationTask(id, title);
        const input = document.getElementById('nchatInput');
        if (input) input.focus();
      },
    });
  }

  function _workModel() {
    if (ctx._snap && ctx._snap.modelSelection) return ctx._snap.modelSelection.name || ctx._snap.modelSelection.model?.id || '';
    return ctx._sessionOptions.modelName || (ctx._model && (ctx._model.name || ctx._model.id)) || '';
  }

  function _materialMatches(files, text) {
    const normalize = value => String(value || '').replace(/\\/g, '/').toLocaleLowerCase();
    const value = normalize(text), hits = [];
    const quoted = [...value.matchAll(/"[^"]*"|'[^']*'|`[^`]*`|“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|《[^》]*》/g)]
      .filter(match => /\.(?:md|txt|pdf|docx|html?|xlsx|pptx)$/i.test(match[0].slice(1, -1)))
      .map(match => ({ start: match.index + 1, end: match.index + match[0].length - 1 }));
    // Match complete references for manual attachments and historical outputs; filename substrings or mismatched paths are insufficient.
    for (const file of files) for (const target of new Set([file.path, file.relative, file.name || file.filename].filter(Boolean).map(normalize))) {
      for (let start = value.indexOf(target); start >= 0; start = value.indexOf(target, start + 1)) {
        const end = start + target.length, before = value.slice(0, start), after = value.slice(end);
        const begins = !before || /[\s"'`“‘(（\[【「『《，,、；;：:]$/.test(before) || /(?:把|将|根据|参考|参照|对照|附上)$/.test(before);
        const partialQuote = quoted.some(span => start >= span.start && end <= span.end && (start !== span.start || end !== span.end));
        if (begins && !/^[\w./\\-]/.test(after) && !partialQuote) hits.push({ file, start, end });
      }
    }
    // Prefer full reference spans when a long filename contains another candidate's shorter name; still disambiguate identical names.
    const complete = hits.filter(hit => !hits.some(other => other.start <= hit.start && other.end >= hit.end &&
      other.end - other.start > hit.end - hit.start));
    const remainder = value.split('');
    complete.forEach(hit => { for (let i = hit.start; i < hit.end; i++) remainder[i] = ' '; });
    return { files: [...new Set(complete.map(hit => hit.file))],
      unmatched: /\.(?:md|txt|pdf|docx|html?|xlsx|pptx)\b/i.test(remainder.join('')),
      ambiguous: complete.some(hit => complete.some(other => other.file !== hit.file && other.start === hit.start && other.end === hit.end)) };
  }

  function _workConversationContext(instruction, options) {
    const messages = (ctx._snap && ctx._snap.messages) || [];
    const allowed = new Set(['', 'normal', 'goal-final']);
    const rows = [], attachments = [], seenFiles = new Set();
    const clean = (value) => String(value || '')
      .replace(/<soduwork-internal-[^>]+>[\s\S]*?<\/soduwork-internal-[^>]+>/gi, '')
      .replace(/<soduwork-internal-[^>]+>[\s\S]*/gi, '')
      .trim();
    const addFiles = (items) => (items || []).forEach((file) => {
      const name = String(file && (file.name || file.filename) || '').trim();
      if (!name) return;
      const key = [name, Number(file.size || 0), String(file.previewRef || '')].join(':');
      if (seenFiles.has(key)) return;
      seenFiles.add(key);
      attachments.push({
        name, filename: name, type: String(file.type || file.mimeType || ''),
        size: Number(file.size || 0), previewRef: String(file.previewRef || ''),
        source: 'conversation',
      });
    });
    messages.forEach((message) => {
      const scope = String(message && message.scope || '');
      if (message && (message.hidden || message.audit) || !allowed.has(scope)) return;
      if (message.role === 'user') {
        const text = clean(message.text);
        if (text || message.attachments?.length) rows.push({ text: text ? '你：' + text : '', attachments: message.attachments });
        return;
      }
      if (message.role !== 'assistant') return;
      const text = clean((message.blocks || [])
        .filter(block => block && block.kind === 'text' && !block.hidden)
        .map(block => block.text || '').join('\n'));
      if (text) rows.push({ text: 'SoduWork：' + text, role: 'assistant' });
    });
    const recent = rows.slice(-10);
    // Limit message count, never silently cut a selected source document.
    recent.forEach(row => addFiles(row.attachments));
    const text = recent.map(row => row.text).filter(Boolean).join('\n\n');
    const result = { text, turnCount: recent.length, attachments };
    // Read original files only when explicitly referenced by the creator; ordinary discussion and lists must not attach historical outputs automatically.
    const request = String(instruction || '');
    const namedFile = /\.(?:md|txt|pdf|docx|html?|xlsx|pptx)\b/i.test(request);
    const fileReference = namedFile || /(?:这个|这份|上述|上面|刚才|该).{0,12}(?:文档|文件|附件)/i.test(request);
    const currentFiles = (options?.currentAttachments || []).filter(file => /\.(?:md|txt|pdf|docx|html?|xlsx|pptx)$/i.test(file.name || file.filename || ''));
    const currentMatch = namedFile ? _materialMatches(currentFiles, request) : null;
    if (currentMatch?.files.length && (currentMatch.unmatched || currentMatch.ambiguous)) {
      return Promise.reject(Object.assign(new Error('明确引用的文档未全部匹配，请核对文件名并手动补齐所需附件'), { code: 'WORK_MATERIAL_REQUIRED' }));
    }
    if (namedFile ? currentMatch.files.length : currentFiles.length) return result; // Prefer current manual attachments only when they fully satisfy the explicit reference.
    return options?.includeFiles && fileReference ? _referencedFiles(result, recent, request) : result;
  }

  async function _referencedFiles(result, recent, instruction) {
    const ref = ctx._ref, epoch = ctx._viewEpoch;
    const account = global.SoduWorkAPI?.taskStorageKey?.('ops'), api = ctx._api?.();
    const error = message => Object.assign(new Error(message), { code: 'WORK_MATERIAL_REQUIRED' });
    const guard = () => {
      if (ref !== ctx._ref || epoch !== ctx._viewEpoch || account !== global.SoduWorkAPI?.taskStorageKey?.('ops')) {
        throw error('会话或账号已切换，请在当前会话重新选择材料');
      }
    };
    if (!ref || !api?.outputs || !api?.artifactAction) throw error('暂时无法读取所指的文档，请重新打开原会话或手动添加附件');
    const index = await api.outputs(ref); guard();
    if (!index || index.ok === false) throw error('会话成果暂时无法读取，请重试或手动添加附件');
    const files = (Array.isArray(index.artifacts) ? index.artifacts : []).filter(file =>
      file.artifactId && !file.deleted && /\.(?:md|txt|pdf|docx|html?|xlsx|pptx)$/i.test(file.name || ''));
    const matches = text => _materialMatches(files, text);
    const explicit = matches(instruction);
    let chosen = explicit.files;
    const namedFile = /\.(?:md|txt|pdf|docx|html?|xlsx|pptx)\b/i.test(instruction);
    if (namedFile && (!chosen.length || explicit.unmatched)) throw error('没有找到全部明确指定的文档，请核对完整文件名或路径后重试，也可以手动添加附件');
    if (explicit.ambiguous) throw error('找到多份同名文档，请写明完整路径或手动添加所需附件');
    if (!chosen.length) {
      const defect = /缺陷|bug|故障/i.test(instruction);
      for (const row of recent.slice().reverse().filter(row => row.role === 'assistant')) {
        const reference = matches(row.text);
        if (reference.ambiguous) throw error('找到多份同名文档，请写明完整路径或手动添加所需附件');
        chosen = reference.files.filter(file => !defect || /缺陷|bug|故障|issue|defect/i.test(file.name));
        if (chosen.length) break;
      }
    }
    if (!chosen.length) throw error('没有找到本会话中明确引用的文档，请在原回复中确认文件名或手动添加附件');
    if (chosen.length > 1 && !/(?:这些|多份|所有|全部)/.test(instruction)) {
      throw error('找到多份相关文档，请写明文件名后再创建，或手动添加所需附件');
    }
    if (chosen.length > 20 || chosen.reduce((sum, file) => sum + Number(file.size || 0), 0) > 24 * 1024 * 1024) {
      throw error('引用材料较多，请手动选择本次需要的附件（最多 20 份、合计 24 MB）');
    }
    const prepared = [], analysis = [];
    let bytes = 0;
    for (const file of chosen) {
      guard();
      const reply = await api.artifactAction(ref, file.artifactId, 'share'); guard();
      if (!reply?.ok || typeof reply.data !== 'string') throw error('「' + file.name + '」未能带入：' + (reply?.reason || '原件读取失败，请重试'));
      if (file.at && reply.at !== file.at) throw error('「' + file.name + '」已更新，请重新引用最新文档');
      const data = Uint8Array.from(atob(reply.data), char => char.charCodeAt(0));
      bytes += data.byteLength;
      if (bytes > 24 * 1024 * 1024) throw error('引用材料合计超过 24 MB，请手动选择本次需要的附件');
      const ext = String(file.name).split('.').pop().toLowerCase();
      const type = ({ md: 'text/markdown', txt: 'text/plain', html: 'text/html', htm: 'text/html', pdf: 'application/pdf' })[ext] || 'application/octet-stream';
      const original = new File([data], file.name, { type, lastModified: Number(file.at) || 0 });
      prepared.push(original);
      const item = { name: file.name, filename: file.name, size: original.size, type, source: 'conversation-output', mode: 'metadata' };
      if (/^text\//.test(type)) {
        const text = await original.text(); guard();
        item.mode = 'text'; item.text = text.slice(0, 240000); item.truncated = text.length > 240000;
      }
      analysis.push(item);
    }
    // Queue original files for upload separately from parsed copies; a filename alone is not a saved attachment.
    return { ...result, files: prepared, attachments: analysis };
  }

  async function _openPluginDebug(options) {
    if (!global.PluginDebugCard) return false;
    if (!ctx._ref && !(await ctx._ensure())) return false;
    const files = ctx._messageAttachments ? await ctx._messageAttachments.refs(ctx._api()) : [];
    return Boolean(await PluginDebugCard.open({ ...options, ref: ctx._ref, attachments: files }));
  }

  async function _openWorkAction(command, options) {
    if (command && command.id === 'work.plugin.debug' && global.PluginDebugCard) {
      return _openPluginDebug({ text: command.text || '' });
    }
    if (!global.ChatWorkActions) return false;
    // Bind forms to a stable conversation before recording requirements; do not warm up or invoke the Agent.
    if (ctx._workCards) {
      options = await ctx._workCards.prepare(command, options || {});
      if (!options) return false;
    }
    return ChatWorkActions.open(command, options, {
      mount: ctx._mount, dismissProposal: _dismissProposal, bridge: _chatDraftBridge,
      model: _workModel, mention: ctx._pluginMention,
    });
  }

  function _pickProposal(snap) {
    const tools = (snap && snap.tools) || [];
    /* Proposal discovery runs for every streamed snapshot. The previous
       implementation parsed every completed tool result on every token,
       which made a long tool-heavy conversation progressively slower. Keep a
       small per-session fingerprint and only parse a result when that tool
       actually changed. */
    const ref = String(ctx._ref || '');
    if (ctx._proposalFingerprintRef !== ref) {
      ctx._proposalFingerprintRef = ref;
      ctx._proposalFingerprints = new Map();
    }
    const fingerprints = ctx._proposalFingerprints || (ctx._proposalFingerprints = new Map());
    for (let i = tools.length - 1; i >= 0; i--) {
      const t = tools[i];
      const id = String(t && t.id || i);
      const result = String(t && t.result || '');
      const fingerprint = [String(t && t.state || ''), Number(t && t.updatedAt || 0),
        result.length, result.slice(0, 64), result.slice(-64)].join('|');
      if (fingerprints.get(id) === fingerprint) continue;
      fingerprints.set(id, fingerprint);
      if (t.state !== 'done' || !t.result) continue;
      let o = null;
      try { o = JSON.parse(result.trim()); } catch (e) { continue; }
      if (o && o.proposal && o.proposal.title) return { key: t.id, p: o.proposal };
    }
    while (fingerprints.size > 512) fingerprints.delete(fingerprints.keys().next().value);
    return null;
  }

  function _maybeProposal(snap) {
    const got = _pickProposal(snap);
    if (!got || got.key === ctx._lastProposal || ctx._proposalMuted) return;
    ctx._lastProposal = got.key;
    ctx._pendingProposal = got;
    _renderProposal();
    setTimeout(() => {
      const s = document.getElementById('nchatScroll');
      if (s) s.scrollTop = s.scrollHeight;
    }, 40);
  }

  function _renderProposal() {
    const box = document.getElementById('nchatTaskSuggest');
    if (!box) return;
    const got = ctx._pendingProposal;
    if (!got || ctx._proposalMuted) {
      box.classList.remove('show'); box.innerHTML = ''; return;
    }
    const title = String((got.p && got.p.title) || '这次工作').trim();
    box.innerHTML =
      '<span class="nts-mark"><svg viewBox="0 0 24 24"><path d="M9 11l2.5 2.5L16 8"/>' +
        '<rect x="4" y="4" width="16" height="16" rx="4"/></svg></span>' +
      '<span class="nts-copy"><b>这件事值得持续跟踪</b>' +
        '<i>“' + ctx.esc(title) + '” · 可在输入框使用斜杠工作动作</i></span>' +
      '<span class="nts-command"><kbd>/需求</kbd></span>' +
      '<button class="nts-close" data-proposal-act="dismiss" title="本次对话不再提示" aria-label="本次对话不再提示">' +
        '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>';
    box.classList.add('show');
  }

  function _dismissProposal(mute) {
    if (mute) ctx._proposalMuted = true;
    ctx._pendingProposal = null;
    _renderProposal();
  }

  function _proposalAction(e) {
    const btn = e.target.closest('[data-proposal-act]');
    if (!btn || !ctx._pendingProposal) return;
    if (btn.dataset.proposalAct === 'dismiss') {
      _dismissProposal(true);
      const input = document.getElementById('nchatInput'); if (input) input.focus();
    }
  }
    return { _chatDraftBridge, _workModel, _workConversationContext, _openPluginDebug, _openWorkAction, _pickProposal, _maybeProposal, _renderProposal, _dismissProposal, _proposalAction };
  }
  global.ChatWorkIntent = { create };
})(window);
