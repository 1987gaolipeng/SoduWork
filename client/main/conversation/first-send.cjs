'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const attachments = require('../pi-session/attachments');

const idPattern = /^first-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const allowedOpen = ['adapterId', 'modelName', 'thinkingLevel', 'reasoningEffort', 'capabilities', 'cwd',
  'workspaceLabel', 'mode', 'accessMode', 'projectId', 'repoId', 'memoryIds', 'contextPrompts',
  'pluginEditId', 'intent', 'goal', 'acceptance', 'budgetMinutes', 'maxSteps', 'sessionTitle'];
const select = (object, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(object || {}, key)).map(key => [key, object[key]]));
const interrupted = '客户端在发送前已关闭，可恢复这条消息。';
const uncertain = '暂时无法确认执行底座是否收到消息，请先查看原会话。';
const attemptOf = row => row.attemptId || row.intentId;
const isProvenRefusal = value => value?.notSent === true || (value?.retrySafe === true &&
  ['plugin-validation', 'plugin-grant', 'skill-selection'].includes(value.failureKind));

// Only the ordinary new-chat entry uses this journal. The runtime still owns
// permission prompts, model resolution, plugin preparation and turn admission.
function create({ root, actor, assertCurrent, open, send, received, notify }) {
  const flights = new Map(), probes = new Map(), admitted = new Set();
  function paths(owner, id) {
    if (!/^[a-f0-9]{32}$/.test(owner) || !idPattern.test(id)) throw Error('首条消息标识无效');
    const directory = path.join(root, owner);
    return { directory, file: path.join(directory, id + '.json'), receipt: path.join(directory, 'receipts', id + '.json'),
      inputs: path.join(directory, id + '.inputs'), key: owner + '/' + id };
  }
  function read(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  function activeRow(files) {
    const row = read(files.file);
    if (row && read(files.receipt)?.deleted) {
      // Finish an interrupted cleanup before allowing the request to be seen or retried.
      retire(files, row, true);
      return null;
    }
    return row;
  }
  function records(owner) {
    const directory = path.join(root, owner);
    let names;
    try { names = fs.readdirSync(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const rows = [];
    for (const name of names) {
      if (!name.endsWith('.json') || !idPattern.test(name.slice(0, -5))) continue;
      const files = paths(owner, name.slice(0, -5)), row = activeRow(files);
      if (row) rows.push({ files, row });
    }
    return rows;
  }
  function write(file, row) {
    const temp = file + '.' + crypto.randomUUID() + '.tmp';
    try {
      const fd = fs.openSync(temp, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(row)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temp, file);
    } finally { fs.rmSync(temp, { force: true }); }
  }
  function publicRow(row) {
    const canAttachFailed = row.status === 'failed' && Boolean(row.refusedAt);
    const preparation = row.turn?.inputPreparation;
    // Before allocation there is no history to supply these choices. Return only
    // ordinary editor settings; a one-use grant or special launch must be reselected.
    const accessMode = row.options?.accessMode;
    const recoverAccess = accessMode === 'readonly' || accessMode === 'standard' && row.options.mode !== 'readonly' ||
      !accessMode && row.options?.mode === 'readonly';
    const starter = row.status === 'failed' && !row.sessionId && recoverAccess &&
      !row.options.pluginEditId && !row.options.contextPrompts?.length &&
      (!row.options.intent || row.options.intent === 'chat') && row.options.mode !== 'goal';
    return { attemptId: attemptOf(row), ...select(row, ['intentId', 'sessionId', 'title', 'text', 'at', 'status', 'reason', 'adapterId',
      'modelName', 'acceptedAt', 'attachmentNames', 'confirmed']), ...(preparation?.userText ?
        { text: preparation.userText } : {}), canAttachFailed,
      ...(starter ? { draftOptions: { ...select(row.options, ['adapterId', 'modelName', 'thinkingLevel', 'reasoningEffort',
        'capabilities', 'cwd', 'workspaceLabel', 'mode', 'accessMode', 'projectId', 'repoId', 'memoryIds']),
        sidebarProjectId: row.sidebarProjectId || '' } } : {}),
      canRestoreText: Boolean(canAttachFailed || starter) && Boolean(row.text?.trim()) && !row.attachmentNames?.length &&
        !row.turn?.plugins?.length && !row.turn?.skills?.length && !row.options?.pluginEditId && !row.needsSelection &&
        (!preparation || Object.keys(preparation).every(key => key === 'userText') && preparation.userText === row.text) };
  }
  function retire(files, row, deleted = false) {
    // Keep duplicate delivery idempotent after the source conversation was
    // deleted, without retaining its title, body, model, or attachments.
    const receipt = deleted ? { intentId: row.intentId, deleted: true }
      : select(row, ['intentId', 'hash', 'sessionId', 'status', 'at', 'acceptedAt', 'confirmed']);
    fs.mkdirSync(path.dirname(files.receipt), { recursive: true, mode: 0o700 });
    write(files.receipt, receipt);
    const flight = flights.get(files.key);
    if (deleted && flight) flight.deleted = true;
    fs.rmSync(files.inputs, { recursive: true, force: true });
    fs.rmSync(files.file, { force: true });
    probes.delete(files.key); admitted.delete(files.key);
  }
  function assertNotDeleted(files) {
    if (flights.get(files.key)?.deleted) throw Error('这条会话已经删除');
  }
  function bindingFile(key) {
    return path.join(root, 'connections', key + '.json');
  }
  function forgetSession({ owner, binding }, sessionId) {
    if (!sessionId) return;
    const scope = owner || (binding && read(bindingFile(binding)));
    if (!scope || !/^[a-f0-9]{32}$/.test(scope)) return;
    for (const { files, row } of records(scope)) {
      if (row.sessionId !== sessionId) continue;
      retire(files, row, true);
      notify();
    }
  }
  function update(files, row, values) {
    assertNotDeleted(files);
    const next = { ...row, ...values };
    if (next.confirmed) {
      // Keep the idempotency receipt after removing private inputs/draft text.
      delete next.options; delete next.turn; delete next.files; delete next.text;
      next.attachmentNames = [];
    }
    write(files.file, next);
    Object.assign(row, next);
    if (row.confirmed) {
      delete row.options; delete row.turn; delete row.files; delete row.text;
      admitted.delete(files.key); probes.delete(files.key);
      try { fs.rmSync(files.inputs, { recursive: true, force: true }); } catch { /* Already acknowledged. */ }
    }
    notify();
  }
  async function run(files, row, context, request, prepared) {
    try {
      let attachmentWarnings;
      if (request.attachments.length) {
        const staged = await attachments.stage(files.inputs, request.attachments, { stagingDir: files.inputs });
        if (!staged.files.length)
          throw Error(staged.warnings[0] || '附件尚未完整保存，请重新选择');
        attachmentWarnings = staged.warnings;
        update(files, row, { files: staged.files, attachmentNames: staged.files.map(file => file.name), ready: true });
      }
      prepared(attachmentWarnings);
      await assertCurrent(context);
      const freshOptions = { ...row.options, attachments: row.files, ...select(request.open, ['accessDraftId', 'accessConsentId']) };
      const opened = request.ref ? { ok: true, ref: request.ref, sessionId: row.sessionId }
        : await open(context, row.sessionId ? { chatId: row.sessionId } : freshOptions);
      if (!opened?.ok || !opened.ref || !opened.sessionId) throw Error(opened?.reason || '会话尚未打开');
      if (row.sessionId && row.sessionId !== opened.sessionId) throw Error('原会话标识已变化，请重新打开');
      await assertCurrent(context);
      // A crash after this write has ambiguous admission. Never replay it
      // automatically, including when a plugin performed a side effect.
      update(files, row, { sessionId: opened.sessionId, status: 'sending' });
      const attempt = attemptOf(row);
      let refusal;
      const settleRefusal = () => {
        if (!refusal) return;
        const latest = activeRow(files);
        if (!latest || latest.confirmed || attemptOf(latest) !== attempt || !['accepted','uncertain'].includes(latest.status)) return;
        update(files, latest, { status: 'failed', refusedAt: Date.now(), reason: String(refusal.reason || interrupted) });
      };
      const settled = outcome => {
        if (isProvenRefusal(outcome)) { refusal = outcome; settleRefusal(); return; }
        // Completion can follow admission immediately. Let the durable write
        // finish, then read the native receipt even if the sidebar is idle.
        const timer = setTimeout(() => {
          try {
            const latest = activeRow(files);
            if (!latest || latest.confirmed || attemptOf(latest) !== attempt) return;
            probes.delete(files.key); checkReceipt(files, latest, context, outcome);
          } catch { /* The next authorized list operation can reconcile it. */ }
        }, 750);
        timer.unref?.();
      };
      // A refused turn may be retried on a different native segment of the same
      // public conversation. Freeze that segment before admission for cold recovery.
      const rememberTarget = (nativeAdapter, sessionId, readModelName) => {
        assertNotDeleted(files);
        const adapterId = nativeAdapter || row.adapterId;
        const modelName = request?.ref ? readModelName?.() ?? row.modelName : row.modelName;
        const target = row.receiptTarget || row;
        if (target.sessionId === sessionId && target.adapterId === adapterId &&
            row.adapterId === adapterId && row.modelName === modelName) return;
        update(files, row, { receiptTarget: sessionId === row.sessionId ? undefined : { adapterId, sessionId },
          adapterId, modelName, options: { ...row.options, adapterId, modelName } });
      };
      const reply = await send(context, opened.ref, row.text, row.files, { ...row.turn,
        ...(request?.turn?.plugins ? { plugins: request.turn.plugins } : {}), submissionId: row.nativeSubmissionId || attempt },
        settled, row.sessionId, rememberTarget);
      if (reply?.ok) {
        admitted.add(files.key);
        update(files, row, { status: 'accepted', acceptedAt: Date.now(), reason: '', workflowRun: Boolean(reply.workflowRun) });
        settleRefusal();
        if (!refusal) checkReceipt(files, row, context);
        return { row: publicRow(row), workflowRun: Boolean(reply.workflowRun), ...(request?.ref ? { admission: reply } : {}) };
      }
      const refused = reply?.notSent === true || reply?.accepted === false;
      update(files, row, { status: refused ? 'failed' : 'uncertain', refusedAt: refused ? Date.now() : 0, reason: reply?.reason || uncertain });
    } catch (error) {
      update(files, row, { status: row.status === 'sending' ? 'uncertain' : 'failed', reason: String(error.message || error) });
    } finally { prepared(); }
    return { row: publicRow(row) };
  }
  function launch(files, row, context, request) {
    let prepared;
    const staged = new Promise(resolve => { prepared = resolve; });
    const promise = Promise.resolve().then(() => run(files, row, context, request, prepared)).finally(() => {
      const deleted = flights.get(files.key)?.deleted;
      flights.delete(files.key);
      if (deleted) fs.rmSync(files.inputs, { recursive: true, force: true });
    });
    flights.set(files.key, { finished: promise, staged });
    promise.catch(() => {}); // A renderer may close before waiting for the result.
    return staged;
  }
  async function start(event, raw, retry) {
    const context = await actor(event);
    const files = paths(context.owner, raw?.intentId), options = select(raw.open, allowedOpen);
    const items = raw.attachments || [], text = raw.text, turn = raw.turn || {};
    if (typeof text !== 'string' || !text.trim() || !Array.isArray(items))
      throw Error('首条消息内容或附件无效');
    const ids = (turn.plugins || []).map(item => String(item.pluginId || item));
    const savedTurn = { ...select(turn, ['skills', 'sentAt', 'projectId', 'inputPreparation']), plugins: ids.map(pluginId => ({ pluginId })) };
    const sidebarProjectId = String(raw.sidebarProjectId || '').trim().slice(0, 256);
    const digest = crypto.createHash('sha256').update(JSON.stringify([text, options, savedTurn, turn.plugins || [], sidebarProjectId]));
    const selectedItems = items.slice(0, attachments.MAX_FILES);
    for (const item of selectedItems) {
      digest.update(JSON.stringify([item?.name, item?.path, item?.size, item?.type, item?.attachmentId, item?.sourceRef]));
      if (item?.data) digest.update(attachments.bytesFromTransport(item.data) || Buffer.alloc(0));
    }
    const hash = digest.digest('hex');
    const active = activeRow(files), previous = active || read(files.receipt);
    if (previous?.deleted) return { ok: false, reason: '这条会话已经删除' };
    if (!retry && raw.retryAttempt) {
      if (!idPattern.test(raw.retryAttempt.next || '') || raw.retryAttempt.expected === raw.retryAttempt.next)
        throw Error('首发重试标识无效');
      retry = { expected: raw.retryAttempt.expected, attemptId: raw.retryAttempt.next, sessionId: '' };
    }
    if (retry && (!active || previous.status !== 'failed' || flights.has(files.key) ||
        previous.sessionId !== retry.sessionId || attemptOf(previous) !== retry.expected))
      return { ok: false, code: 'FIRST_SEND_RETRY_STALE', reason: '这条首发请求的状态已变化，请查看侧栏记录' };
    if (previous && !retry) {
      if (previous.hash !== hash) throw Error('首条消息标识已被其他内容占用');
      await flights.get(files.key)?.staged;
      await assertCurrent(context);
      const latest = activeRow(files) || read(files.receipt) || previous;
      if (latest.deleted) return { ok: false, reason: '这条会话已经删除' };
      return { ok: latest.ready !== false, row: publicRow(latest), ...(latest.ready === false ? { reason: latest.reason } : {}) };
    }
    const userText = typeof savedTurn.inputPreparation?.userText === 'string' && savedTurn.inputPreparation.userText.trim() || text;
    const row = { intentId: raw.intentId, sessionId: '', at: Date.now(), title: userText.trim().replace(/\s+/g, ' ').slice(0, 64),
      text, adapterId: String(options.adapterId || 'pi'), modelName: String(options.modelName || ''),
      attachmentNames: selectedItems.map(item => String(item?.name || item?.filename || '附件')), status: 'opening', reason: '',
      options, turn: savedTurn, files: [], ready: !items.length, hash, sidebarProjectId,
      needsSelection: (turn.plugins || []).some(plugin => plugin?.inputValues && Object.keys(plugin.inputValues).length) };
    if (retry) Object.assign(row, { attemptId: retry.attemptId, sessionId: previous.sessionId, hash: previous.hash,
      sidebarProjectId: previous.sidebarProjectId, at: previous.at,
      ...(retry.ref ? { options: previous.options, adapterId: previous.adapterId, modelName: previous.modelName } : {}) });
    fs.mkdirSync(files.directory, { recursive: true, mode: 0o700 });
    // Bind a trusted offline account and enrollment to the signed storage scope.
    // This permits cleanup after token expiry without opening another account's drafts.
    if (context.binding && read(bindingFile(context.binding)) !== context.owner) {
      fs.mkdirSync(path.dirname(bindingFile(context.binding)), { recursive: true, mode: 0o700 });
      write(bindingFile(context.binding), context.owner);
    }
    write(files.file, row);
    probes.delete(files.key); admitted.delete(files.key);
    const prepared = launch(files, row, context, { ...raw, attachments: items, ref: retry?.ref });
    const flight = flights.get(files.key);
    notify();
    const attachmentWarnings = await prepared;
    await assertCurrent(context);
    if (!row.ready) return { ok: false, row: publicRow(row), reason: row.reason };
    if (retry?.ref) {
      const result = await flight.finished; await assertCurrent(context);
      if (attachmentWarnings?.length && result.admission)
        return { ...result.admission, attachmentWarnings: [...attachmentWarnings, ...(result.admission.attachmentWarnings || [])] };
      return result.admission || { ok: false, reason: result.row.reason };
    }
    return { ok: true, row: publicRow(row), ...(attachmentWarnings?.length ? { attachmentWarnings } : {}) };
  }
  function recover(files, row, context) {
    if (!flights.has(files.key) && (row.status === 'opening' || row.status === 'sending')) {
      update(files, row, row.status === 'opening' ? { status: 'failed', reason: interrupted } :
        { status: 'uncertain', reason: uncertain });
    }
    if (row.status === 'accepted' && !row.confirmed && (!admitted.has(files.key) || Date.now() - row.acceptedAt >= 60000))
      update(files, row, { status: 'uncertain', reason: uncertain });
    checkReceipt(files, row, context);
  }
  function checkReceipt(files, row, context, outcome) {
    if (row.confirmed || !['uncertain','accepted'].includes(row.status) || !row.sessionId ||
        Date.now() - (probes.get(files.key) || 0) < 30000) return;
    probes.set(files.key, Date.now());
    Promise.resolve().then(async () => {
      const confirmed = await Promise.resolve().then(() => received(context, row)).catch(() => false);
      await assertCurrent(context);
      const latest = activeRow(files);
      if (!latest || latest.confirmed || attemptOf(latest) !== attemptOf(row) || !['accepted','uncertain'].includes(latest.status)) return;
      if (confirmed) {
        update(files, latest, { status: 'accepted', confirmed: true, acceptedAt: latest.acceptedAt || Date.now(), reason: '' });
      } else if (outcome && (outcome.ok === false || outcome.cancelled || outcome instanceof Error)) {
        update(files, latest, { status: 'uncertain', reason: String(outcome.reason || outcome.message || uncertain) });
      }
    }).catch(() => {});
  }
  async function list(event) {
    const context = await actor(event, true);
    if (!context) return { ok: true, rows: [] };
    const rows = [];
    for (const { files, row } of records(context.owner)) {
      if (row.confirmed && !row.sidebarProjectId && Date.now() - row.acceptedAt >= 60000) {
        retire(files, row); continue;
      }
      recover(files, row, context); rows.push(publicRow(row));
    }
    await assertCurrent(context);
    return { ok: true, rows: rows.filter(row => row.status !== 'accepted' || Date.now() - row.acceptedAt < 60000)
      .sort((a,b) => b.at - a.at) };
  }
  async function discard(event, id, expectedAttempt) {
    const context = await actor(event, true);
    if (!context) throw Error('请重新登录后丢弃发送记录');
    await assertCurrent(context);
    const files = paths(context.owner, id), row = activeRow(files);
    if (!row && read(files.receipt)?.deleted) return { ok: true };
    // Check the attempt after the last await. A concurrent edit can start a
    // different attempt on this same intent, including one already in dispatch.
    if (!row || row.status !== 'failed' || row.sessionId || row.confirmed ||
        attemptOf(row) !== expectedAttempt || flights.has(files.key))
      throw Error('发送状态已变化，请刷新后重试');
    retire(files, row, true);
    notify();
    return { ok: true };
  }
  async function associations(event) {
    const context = await actor(event, true);
    if (!context) return { ok: true, rows: [] };
    const rows = records(context.owner).filter(({ row }) => row.confirmed && row.sidebarProjectId)
      .map(({ row }) => select(row, ['intentId', 'sessionId', 'title', 'at', 'sidebarProjectId']));
    await assertCurrent(context);
    return { ok: true, rows };
  }
  async function ackAssociations(event, id, sessionId) {
    const context = await actor(event, true);
    if (!context) return { ok: false, reason: '请重新登录后恢复会话归属' };
    const files = paths(context.owner, id), row = read(files.file);
    if (!row?.sidebarProjectId) return { ok: true };
    if (row.status !== 'accepted' || row.sessionId !== sessionId || !row.confirmed)
      throw Error('原会话已变化，请重新读取归属');
    update(files, row, { sidebarProjectId: '' });
    return { ok: true };
  }
  async function act(event, id, action, expectedAttempt) {
    if (action !== 'wait' && action !== 'attach') throw Error('未知的首发操作');
    const context = await actor(event), files = paths(context.owner, id);
    const draft = activeRow(files), row = draft || read(files.receipt);
    if (!row) throw Error('找不到这条首发请求');
    if (row.deleted) throw Error('这条会话已经删除');
    if (draft) recover(files, row, context);
    const result = await (flights.get(files.key)?.finished || { row: publicRow(row), workflowRun: row.workflowRun });
    await assertCurrent(context);
    if (action === 'attach' && (!draft || (expectedAttempt || id) !== result.row.attemptId ||
        (result.row.status !== 'accepted' && !result.row.canAttachFailed) ||
        Date.now() - (row.refusedAt || result.row.acceptedAt || 0) >= 60000))
      throw Error('请从历史记录重新打开这条会话');
    return { ok: true, ...result };
  }
  return { start, list, act, discard, associations, ackAssociations, forgetSession };
}
module.exports = { create };
