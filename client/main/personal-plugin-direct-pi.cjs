'use strict';
const crypto = require('node:crypto');
const permissions = require('./personal-plugin-permissions.cjs');
const bootId = crypto.randomUUID();
const active = new Map();
function create({ app, session = require('./agent-runtime/process-session'), timeoutMs = 22000 }) {
  async function bounded(promise) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('Pi 尚未确认停止，队列继续暂停，请稍后重试')), timeoutMs);
    })]); } finally { clearTimeout(timer); }
  }
  async function stop(node) {
    const entry = active.get(node.ref);
    if (!entry) {
      if (!node.dispatched || node.directFinished) return;
      // A legacy/interrupted controller must never silently replay its tools.
      // Live process facades below retain their exact host cleanup authority.
      if (node.directBootId !== bootId && node.directProcessId !== process.pid) {
        try { process.kill(node.directProcessId, 0); }
        catch (error) { if (error.code === 'ESRCH') return; throw error; }
      }
      throw Error('上次 Pi 执行状态尚未确认，请先停止原客户端再核对成果');
    }
    entry.cancelled = true;
    const child = entry.child || await bounded(entry.opening);
    if (child?.executionStopped?.() === true) {
      await bounded(Promise.resolve().then(() => child.close())).catch(error => {
        if (child.executionStopped?.() !== true) throw error;
      });
      active.delete(node.ref); return;
    }
    if (child?.snapshot().runtimeUnavailable) {
      throw Error('Pi 执行资源尚未确认回收，请稍后重试停止');
    }
    if (entry.admission) await bounded(entry.admission);
    await bounded(Promise.resolve(child?.cancel()));
    if (entry.completion) await bounded(entry.completion);
    if (child?.inFlight()) throw Error('Pi 尚未确认停止，队列继续暂停，请稍后重试');
  }
  async function answer(node, request) {
    const entry = active.get(node.ref);
    if (!entry?.child || entry.cancelled) throw Error('这条权限请求已失效，请使用当前请求');
    const result = await entry.child.answerUi(request);
    if (!result?.ok) throw Error('这条权限请求已失效，请使用当前请求');
  }
  async function execute({ node, record, persist, dir, prompt, localFiles, accessPolicy,
    identity, modelId, skillDirs, requested, grants, ensureActive, checkOwner, output, redact, parentHandle, readAccessPolicy }) {
    if (node.directDispatchId !== node.dispatchId) {
      node.directFinished = false; delete node.directResult; node.directDispatchId = node.dispatchId;
    }
    if (node.directFinished) {
      if (active.has(node.ref)) throw Error('上次 Pi 节点仍在收尾，请先核对停止状态');
      if (!node.directResult?.ok) throw Error(node.directResult?.reason || '上次 Pi 节点未正常完成，请重试本步骤');
      return node.directResult.text || '';
    }
    if (node.dispatched) throw Error('上次 Pi 节点因客户端重启或连接中断，未确认完成；请核对成果后重试本步骤');
    const ref = 'workflow-pi:' + node.dispatchId;
    const entry = { cancelled: false, child: null, completion: null, opening: null, admission: null };
    active.set(ref, entry);
    node.ref = ref; node.directBootId = bootId; node.directProcessId = process.pid;
    node.directFinished = false; delete node.directResult; persist();
    let unsubscribe = () => {}, timer, failure = null, accessRelay = null;
    const projection = require('./conversation/pi-workflow-output.cjs').create(redact);
    let activityAt = 0, permissionWaiting = false, publication = Promise.resolve();
    const toolDetails = new Map();
    function stopAfterFailure(error) {
      failure ||= error;
      Promise.resolve().then(() => entry.child?.cancel()).catch(() => {});
    }
    function activity(waiting = permissionWaiting) {
      const now = Date.now();
      if (activityAt && !permissionWaiting) node.activeElapsedMs += now - activityAt;
      activityAt = now; permissionWaiting = waiting;
    }
    function emit(_event, supplied) {
      const snapshot = supplied || entry.child.snapshot();
      const pending = (snapshot.pendingPermissions || []).map(item =>
        permissions.project(item, { cwd: dir, redact })).filter(Boolean);
      if (activityAt) activity(pending.length > 0);
      if (JSON.stringify(node.pendingPermissions || []) !== JSON.stringify(pending)) {
        node.pendingPermissions = pending; persist();
      }
      publication = publication.then(async () => {
        const tools = [];
        for (const tool of snapshot.tools || []) {
          if (tool.state !== 'running' && tool.phase !== 'preparing' && entry.child.toolDetail) {
            const key = tool.id + ':' + tool.state + ':' + (tool.endedAt || tool.lastProgressAt || '');
            if (!toolDetails.has(key)) toolDetails.set(key, await entry.child.toolDetail(tool.id) || tool);
            tools.push(toolDetails.get(key));
          } else tools.push(tool);
        }
        await output.consume(ref, projection.project({ ...snapshot, tools }));
      });
      publication.catch(stopAfterFailure);
      return publication;
    }
    try {
      await checkOwner(); ensureActive();
      entry.opening = session.open({ app, identity, cwd: dir, ref, ephemeral: true,
        modelName: modelId, skillDirs, capabilityIds: requested, accessPolicy,
        readOnly: accessPolicy?.mode === 'readonly', noExtensions: true,
        resolvePlugins: async () => {
          await checkOwner(); ensureActive();
          return { items: [], grant: grants.grant, readRoots: grants.readRoots || [] };
        } }).then(result => {
          if (!result?.ok || !result.session) throw Error('Pi 节点初始化失败：' + redact(result?.reason || '请检查本机底座'));
          entry.child = result.session; return result.session;
        });
      const child = await entry.opening;
      await checkOwner(); ensureActive();
      if (entry.cancelled) throw Error('本次运行已停止');
      const actual = child.snapshot().accessControl;
      if (!actual?.supported || !actual.modes?.includes(accessPolicy.mode)) throw Error('当前 Pi 尚未支持所选协作权限模式');
      unsubscribe = child.on((event, snapshot) => {
        try { emit(event, snapshot); } catch (error) { stopAfterFailure(error); }
      });
      if (parentHandle && readAccessPolicy) {
        accessRelay = require('./personal-plugin-access-relay.cjs').create({
          handle: parentHandle, cwd: dir, readPolicy: readAccessPolicy, initialPolicy: accessPolicy,
          readChild: async () => child.snapshot(),
          apply: async (policy, revision) => {
            const result = await child.setAccessPolicy(policy, revision);
            return { ...result, accessPolicy: child.snapshot().accessPolicy };
          },
          checkOwner: async () => { await checkOwner(); ensureActive(); }, stop: () => child.cancel(),
          committed: (policy, revision) => {
            node.accessPolicy = policy; node.parentAccessRevision = revision; persist();
          },
        });
        await accessRelay.sync();
      }
      // Persist intent before submit; an interrupted attempt requires explicit
      // reconciliation/retry and can never become an automatic duplicate turn.
      node.dispatched = true; persist();
      if (node.timingDispatchId !== node.dispatchId) { node.timingDispatchId = node.dispatchId; node.activeElapsedMs = 0; }
      activityAt = Date.now();
      entry.admission = Promise.resolve(child.submit(prompt, localFiles.map(file => ({ ...file,
        name: file.filename, mimeType: file.contentType })), {
        submissionId: node.dispatchId, pluginIds: [record.pluginId], goalMode: false,
      })).then(submitted => {
        if (submitted.accepted) entry.completion = Promise.resolve(submitted.completion);
        return submitted;
      });
      const submitted = await entry.admission;
      if (!submitted.accepted) throw Error('Pi 节点未能接收本次执行');
      timer = setInterval(() => {
        activity();
        if (node.activeElapsedMs > node.config.timeoutSeconds * 1000) {
          stopAfterFailure(Error('当前 Pi 节点执行超时，已请求停止并保留过程'));
        }
      }, 250);
      const result = await entry.completion;
      node.directFinished = true;
      await accessRelay?.sync();
      await emit();
      const snapshot = child.snapshot();
      const text = (snapshot.messages || []).filter(message => message.role === 'assistant')
        .map(message => message.text || (message.blocks || []).filter(block => block.kind === 'text').map(block => block.text).join('\n'))
        .filter(Boolean).map(redact).join('\n\n');
      node.directResult = { ok: Boolean(result?.ok && !result.cancelled && !failure),
        text, reason: failure?.message || redact(result?.reason || 'Pi 节点未正常完成') };
      node.pendingPermissions = []; persist();
      ensureActive();
      if (!node.directResult.ok) throw Error(node.directResult.reason);
      return text;
    } catch (error) {
      if (node.directFinished && !node.directResult) {
        node.directResult = { ok: false, reason: redact(error.message || 'Pi 节点输出未确认保存') }; persist();
      }
      throw error;
    } finally {
      clearInterval(timer); unsubscribe();
      await accessRelay?.close();
      // Do not dispose an unconfirmed live turn; the stop action retains it.
      if (!entry.child?.inFlight() && !entry.child?.snapshot().runtimeUnavailable) {
        await entry.child?.close(); active.delete(ref);
      }
    }
  }
  return { execute, stop, answer, probe: () => session.probe(app) };
}
module.exports = { create };
