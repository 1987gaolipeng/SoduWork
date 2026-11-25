'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const store = require('./device-transfer-store.cjs');
const lineage = require('./device-transfer-lineage.cjs');
const files = require('./device-transfer-files.cjs');
const runtime = require('../agent-runtime/switchable-conversation');
const { accountId } = require('../device-auth-request');
const CHUNK = 96 * 1024;
const { unresolvedTools } = require('./tool-terminal-receipts.cjs');
const unsettledTools = snapshot => unresolvedTools(snapshot).length > 0;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const textId = value => typeof value === 'string' && value.length > 0 && value.length <= 180 && !/[\x00-\x1f]/.test(value);
const locked = r => r && (r.direction === 'out' || r.state !== 'active') && r.state !== 'aborted';
const view = r => ({ operationId:r.op, sessionId:r.sid, targetDeviceId:r.target, state:r.state, generation:r.gen });
const localScope = identity => JSON.stringify([new URL(identity.hub).origin,accountId(identity)]);

function create({ app, identityOf, session, history, peer, confirmReceive, verifySource, available }) {
  const previews = new Map(), running = new Set(), admissions = new Map();
  let db;
  const dbFile = path.join(app.getPath('userData'),'device-transfers','transfers.sqlite');
  function storage() { return db ||= store.open(app); }
  function blocked(id) {
    if (!id || (!db && !fs.existsSync(dbFile))) return false;
    return Boolean(locked(storage().fence(id)));
  }
  function admit(id) {
    if (!id) return () => {};
    if (blocked(id)) throw Error('会话正在迁移或已经交出执行权');
    admissions.set(id,(admissions.get(id) || 0)+1);
    return () => { const n = admissions.get(id)-1; if (n) admissions.set(id,n); else admissions.delete(id); };
  }
  async function current() {
    const identity = await identityOf(app);
    if (!identity?.clientId || !accountId(identity)) throw Error('请先登录设备所属账号');
    return { identity,scope:localScope(identity),device:identity.clientId };
  }
  async function check(ctx) {
    const c = await current();
    if (ctx.scope !== c.scope || ctx.device !== c.device) throw Error('账号或设备已切换');
  }
  async function grantIdentity(ctx, device) {
    const identity = await peer.grantIdentity(device === ctx.device ? undefined : device);
    await check(ctx);
    if (identity?.deviceId !== device || identity.accountId !== accountId(ctx.identity) || identity.role !== 'desktop')
      throw Error('设备签名身份已变化');
    return lineage.publicKey(identity.publicKey);
  }
  function grantFields(ctx,r,sourceKey,targetKey) {
    return {scope:r.scope,account:accountId(ctx.identity),sid:r.sid,gen:r.gen,op:r.op,
      source:r.source,target:r.target,sourceKey,targetKey,digest:r.digest};
  }
  function storedLineage(ctx,r) {
    const saved = storage().lineage(r.op);
    if (!saved) throw Error('缺少原设备交权链，无法安全续接迁移');
    lineage.validate(saved.ancestors,saved.grant,grantFields(ctx,r,saved.grant.sourceKey,saved.grant.targetKey));
    return saved;
  }
  function signedRecord(ctx,r) {
    const saved = storedLineage(ctx,r);
    return {...saved,link:lineage.signed(saved.grant,r.proof)};
  }
  async function exclusive(key, action) {
    if (running.has(key)) throw Error('正在处理同一会话的迁移');
    running.add(key);
    try { return await action(); } finally { running.delete(key); }
  }
  async function live(ctx, id) {
    const h = session.findBySessionId(id), row = await history.resolve(id);
    if (!h || h.sessionId !== id || !row || row.id !== id || row.cached || row.cloud || row.remoteProjection ||
        row.accountProjection || row.deleted || row.archived || h.passiveCloudView || h.localReplica || h.snapshot()?.cloudHandoff)
      throw Error('请先打开当前账号拥有的本地原会话');
    if (verifySource) await verifySource(h,ctx.identity,row);
    else require('./history-access').assertOwner(app,id,require('./history-access').actor(app,ctx.identity),row);
    await check(ctx);
    if (session.findBySessionId(id) !== h) throw Error('会话已经关闭');
    return { h,row };
  }
  function stable(h) {
    const snap = h.snapshot();
    if (runtime.busy(h) || runtime.goalSwitchBlocked(snap) || snap.runtimeSwitching || snap.runtimeUnavailable ||
        snap.execution?.running || snap.execution?.active || snap.pendingApproval || snap.stopPending || unsettledTools(snap) ||
        h.ui?.selectedSkills?.length || h.pluginDebug || snap.activePlugins?.length)
      throw Error('请等待工具结束并处理排队、审批或未决操作，再迁移会话');
  }
  async function preview(input) {
    const ctx = await current(), sid = input.sessionId, target = input.targetDeviceId;
    if (!textId(sid) || !textId(target) || target === ctx.device || blocked(sid)) throw Error('迁移目标或会话不可用');
    const { h,row } = await live(ctx,sid);
    const retained = await history.transferSources?.(sid, h.ref) || [];
    const scanned = await files.review(app, h.cwd, retained);
    await check(ctx);
    const op = crypto.randomUUID();
    for (const [key,p] of previews) if (p.expires < Date.now() || p.sid === sid) previews.delete(key);
    previews.set(op,{...ctx,identity:undefined,op,sid,target,handle:h,scanned,expires:Date.now()+300000});
    return { operationId:op,sessionId:sid,targetDeviceId:target,state:'preview',title:row.title || '',
      files:scanned.files.map(f=>({path:f.path,size:f.size,...(f.historyAlias ? {historyAlias:f.historyAlias} : {})})),excludedCount:scanned.excluded.length,
      totalBytes:scanned.total, workspaceNotice:scanned.notice || '' };
  }
  async function rpc(ctx,r,method,params) {
    await check(ctx);
    const reply = await peer.request({peerId:r.target,method:'migration.'+method,params:{operationId:r.op,...params}});
    await check(ctx);
    if (reply?.ok !== true) throw Error(reply?.reason || '目标设备未确认该操作');
    return reply;
  }
  function sourceRecord(ctx,input) {
    const r = storage().get(input.operationId);
    if (!r || r.scope !== ctx.scope || r.source !== ctx.device || r.direction !== 'out' ||
      (input.sessionId && r.sid !== input.sessionId) || (input.targetDeviceId && r.target !== input.targetDeviceId))
      throw Error('无法确认本机迁移记录');
    return r;
  }
  async function sendAbort(ctx, record) {
    await rpc(ctx,record,'abort',{});
    storage().confirmAbort(record.op);
  }
  async function dispatch(ctx,r) {
    if (['done','aborted'].includes(r.state)) return view(r);
    if (r.state === 'packing') throw Error('打包未完成。请取消本次迁移，重新打开原会话后预览');
    if (r.state === 'sending') {
      const proof = storedLineage(ctx,r);
      const accepted = await rpc(ctx,r,'offer',{sessionId:r.sid,target:r.target,gen:r.gen,bytes:r.bytes,digest:r.digest,meta:JSON.parse(r.meta),lineage:proof});
      let offset = accepted.offset;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > r.bytes || (offset !== r.bytes && offset % CHUNK))
        throw Error('目标返回的传输进度无效');
      while (offset < r.bytes) {
        const data = storage().part(r.op,offset,CHUNK);
        await rpc(ctx,r,'chunk',{offset,data:data.toString('base64')});
        offset += data.length;
      }
      const ready = await rpc(ctx,r,'prepare',{digest:r.digest});
      if (ready.digest !== r.digest || ready.state !== 'ready') throw Error('目标检查点未准备完成');
      const signature = await peer.signGrant(lineage.text(proof.grant));
      lineage.signed(proof.grant,signature);
      await check(ctx);
      storage().state(r.op,'sending','released',signature);
      r = storage().get(r.op);
    }
    const ack = await rpc(ctx,r,'grant',{signature:r.proof});
    if (ack.state !== 'active' || ack.digest !== r.digest) throw Error('交权结果待确认，请重连同一台设备');
    storage().transaction(()=>{storage().state(r.op,'released','done');storage().clear(r.op);});
    return view(storage().get(r.op));
  }
  async function start(input) {
    const ctx = await current(), p = previews.get(input.operationId);
    if (!p || p.expires < Date.now() || p.scope !== ctx.scope || p.device !== ctx.device ||
      input.sessionId !== p.sid || input.targetDeviceId !== p.target) throw Error('请重新预览本次设备迁移');
    return exclusive(p.sid,async()=>{
      const { h,row } = await live(ctx,p.sid);
      if (h !== p.handle) throw Error('会话已重新打开，请重新预览');
      stable(h);
      const peers = await peer.peers();
      if (!peers.some(x=>x.deviceId === p.target && x.role === 'desktop')) throw Error('请先与同账号目标电脑建立直连');
      for (const record of storage().pendingAborts(ctx.scope,p.sid,p.target)) await sendAbort(ctx,record);
      const bundle = await history.exportPortable(p.sid);
      if (unsettledTools(bundle.snapshot)) throw Error('历史中仍有结果未确认的工具，无法安全交接');
      const body = await files.pack(app,h.cwd,p.scanned,input.selectedPaths,bundle,await history.transferSources?.(p.sid,h.ref));
      if (body.length > files.MAX_PACKAGE) throw Error('迁移包超过容量限制');
      const { count: fileCount, bytes: totalBytes } = files.selectedFiles(p.scanned,input.selectedPaths);
      const currentHandle = (await live(ctx,p.sid)).h;
      if (currentHandle !== h) throw Error('会话已变化，请重新预览');
      const segments = require('./runtime-segments').read(app,p.sid);
      const aliases = [...new Set([p.sid,...(row.historyAliasIds || []),segments?.active?.sessionId,...(segments?.segments || []).map(s=>s.sessionId)].filter(Boolean))];
      if (aliases.some(id=>admissions.has(id) || blocked(id))) throw Error('会话仍在处理操作，请稍后重试');
      stable(h);
      const previous = storage().latest(ctx.scope,p.sid);
      const sourceKey = await grantIdentity(ctx,ctx.device), targetKey = await grantIdentity(ctx,p.target);
      const prior = previous && signedRecord(ctx,storage().get(previous.op));
      const ancestors = prior ? [...prior.ancestors,prior.link] : [];
      const draft = {op:p.op,scope:ctx.scope,sid:p.sid,source:ctx.device,target:p.target,gen:(previous?.gen || 0)+1,
        direction:'out',state:'packing',bytes:body.length,digest:files.hash(body),
        meta:{title:String(row.title || '').slice(0,200),adapterId:h.adapterId,fileCount,totalBytes}};
      const grant = lineage.draft(grantFields(ctx,draft,sourceKey,targetKey),ancestors);
      if (session.findBySessionId(p.sid) !== h || aliases.some(id=>admissions.has(id) || blocked(id)))
        throw Error('会话仍在处理操作，请稍后重试');
      stable(h);
      // Freeze every known native alias before disposing the idle execution segment.
      storage().transaction(()=>{
        storage().insert(draft);
        storage().rememberLineage(p.op,ancestors,grant);
        storage().aliases(p.op,aliases);
      });
      previews.delete(p.op);
      try {
        // Check the target runtime and obtain its user's acceptance before closing the original.
        await rpc(ctx,draft,'offer',{sessionId:p.sid,target:p.target,gen:draft.gen,bytes:body.length,
          digest:draft.digest,meta:draft.meta,lineage:{ancestors,grant}});
        stable(h);
        const closed = typeof h.closeForDeviceTransfer === 'function' ? await h.closeForDeviceTransfer()
          : h.adapterId === 'pi' ? await h.close() : false;
        if (closed !== true) throw Object.assign(Error('未能确认原执行底座已结束，迁移保持冻结'),
          {code:'DEVICE_TRANSFER_EXECUTION_UNCONFIRMED'});
        const finalHistory = await history.exportPortable(p.sid);
        if (finalHistory.sha256 !== bundle.sha256) throw Error('会话历史已变化，请在源电脑重新预览');
        const finalBody = await files.pack(app,h.cwd,p.scanned,input.selectedPaths,finalHistory,await history.transferSources?.(p.sid,h.ref));
        if (files.hash(finalBody) !== files.hash(body)) throw Error('迁移内容已变化，请重新预览');
        await check(ctx);
        const indexed = await history.resolve(p.sid);
        const saved = await history.store?.deviceHistory(p.sid);
        await check(ctx);
        storage().transaction(()=>{
          if (indexed && saved) storage().rememberHistory(p.op,store.historyStamp(indexed,saved,indexed.deviceTransferId || p.op));
          storage().stage(p.op,finalBody,files.hash(finalBody));
        });
      } catch (error) {
        if (error.code !== 'DEVICE_TRANSFER_EXECUTION_UNCONFIRMED') storage().state(p.op,'packing','aborted');
        await sendAbort(ctx,draft).catch(()=>{});
        throw error;
      }
      return dispatch(ctx,storage().get(p.op));
    });
  }
  async function status(input) {
    const ctx = await current();
    if (!input.operationId && textId(input.sessionId)) {
      const latest = storage().latest(ctx.scope,input.sessionId);
      if (!latest) return {state:'local',sessionId:input.sessionId};
      return view(storage().get(latest.op));
    }
    return view(sourceRecord(ctx,input));
  }
  async function resume(input) {
    const ctx = await current(), r = sourceRecord(ctx,input);
    return exclusive(r.sid,()=>dispatch(ctx,sourceRecord(ctx,input)));
  }
  async function cancel(input) {
    const ctx = await current(), row = sourceRecord(ctx,input);
    return exclusive(row.sid,async()=>{
      const r = sourceRecord(ctx,input);
      if (r.state === 'aborted') {
        await sendAbort(ctx,r);
        return view(r);
      }
      if (!['packing','sending'].includes(r.state)) throw Error('执行权已经交出，请重新连接原目标核对');
      storage().transaction(()=>{storage().state(r.op,r.state,'aborted');storage().clear(r.op);});
      await sendAbort(ctx,r).catch(()=>{});
      return view(storage().get(r.op));
    });
  }
  async function receive({peer:remote,operation,args}) {
    const ctx = await current(), op = args?.operationId;
    if (!UUID.test(op || '') || remote?.role !== 'desktop' || remote.accountId !== accountId(ctx.identity) ||
        !textId(remote.deviceId) || remote.deviceId === ctx.device || typeof remote.assertCurrent !== 'function') throw Error('设备迁移授权无效');
    const guard = async()=>{ await remote.assertCurrent(); await check(ctx); };
    await guard();
    return exclusive(op,async()=>{
      let r = storage().get(op);
      if (r && (r.scope !== ctx.scope || r.source !== remote.deviceId || r.target !== ctx.device || r.direction !== 'in'))
        throw Error('迁移记录不属于当前设备');
      if (operation === 'offer') {
        const m = args.meta;
        if (!textId(args.sessionId) || args.target !== ctx.device || !Number.isSafeInteger(args.gen) || args.gen < 1 ||
            !Number.isSafeInteger(args.bytes) || args.bytes < 1 || args.bytes > files.MAX_PACKAGE ||
            !/^[0-9a-f]{64}$/.test(args.digest) || !m || !Number.isSafeInteger(m.fileCount) ||
            m.fileCount < 0 || m.fileCount > 4000 || !Number.isSafeInteger(m.totalBytes) || m.totalBytes < 0 ||
            m.totalBytes > 96*1024*1024 || typeof m.title !== 'string' || m.title.length > 200 ||
            !/^[a-z0-9_-]{1,48}$/.test(m.adapterId || '')) throw Error('迁移请求内容不正确');
        const offered = args.lineage;
        const incoming = {op,scope:ctx.scope,sid:args.sessionId,source:remote.deviceId,target:ctx.device,gen:args.gen,digest:args.digest};
        const expected = grantFields(ctx,incoming,lineage.publicKey(remote.publicKey),await grantIdentity(ctx,ctx.device));
        if (!offered || Object.keys(offered).sort().join(',') !== 'ancestors,grant') throw Error('迁移缺少设备交权链');
        lineage.validate(offered.ancestors,offered.grant,expected);
        if (!r) {
          const previous = storage().latest(ctx.scope,args.sessionId);
          const existing = await history.store?.get(args.sessionId) || await history.resolve(args.sessionId);
          let predecessor = null;
          if (previous || existing) {
            // The immutable local release anchors every subsequent delegation,
            // including a return from a device that was never our direct target.
            if (!previous || previous.direction !== 'out' || !['done','released'].includes(previous.state) ||
                previous.gen >= args.gen || !existing || existing.deleted)
              throw Error('本机已有同标识会话或删除记录，请先核对历史');
            const anchor = signedRecord(ctx,storage().get(previous.op)).link;
            lineage.validate(offered.ancestors,offered.grant,expected,anchor);
            predecessor = storage().historyStamp(previous.op);
            const saved = await history.store?.deviceHistory(args.sessionId);
            if (!store.matchesHistory(predecessor,existing,saved))
              throw Error('本机历史在交接后已变化，不能覆盖');
          }
          if (available) await available(m,ctx.identity);
          else {
            const catalog = await session.availableRuntimes(app);
            if (!catalog?.ok || !catalog.availableRuntimes?.some(x=>(x.id || x.adapterId) === m.adapterId))
              throw Error('目标设备缺少所需的执行底座');
          }
          if (!await confirmReceive?.({sourceDeviceId:remote.deviceId,sessionId:args.sessionId,...m})) throw Error('目标用户未接受此次迁移');
          await guard();
          storage().transaction(()=>{
            if (previous?.state === 'released') {
              storage().state(previous.op,'released','done');
              storage().clear(previous.op);
            }
            storage().insert({op,scope:ctx.scope,sid:args.sessionId,source:remote.deviceId,target:ctx.device,gen:args.gen,
              direction:'in',state:'receiving',meta:m,digest:args.digest,bytes:args.bytes});
            storage().rememberLineage(op,offered.ancestors,offered.grant);
            if (predecessor) storage().rememberHistory(op,predecessor);
          });
          r = storage().get(op);
        }
        if (r.digest !== args.digest || r.sid !== args.sessionId || r.gen !== args.gen || r.bytes !== args.bytes ||
            JSON.stringify(JSON.parse(r.meta)) !== JSON.stringify(m) ||
            JSON.stringify(storage().lineage(op)) !== JSON.stringify(offered) || !['receiving','ready'].includes(r.state)) throw Error('迁移请求与已保存记录不一致');
        return {ok:true,offset:storage().offset(op)};
      }
      if (!r && operation === 'abort') return {ok:true};
      if (!r) throw Error('目标设备没有本次迁移记录');
      if (operation === 'chunk' && r.state === 'receiving') {
        if (!Number.isSafeInteger(args.offset) || args.offset < 0 || args.offset >= r.bytes || args.offset % CHUNK ||
            typeof args.data !== 'string' || args.data.length > Math.ceil(CHUNK/3)*4) throw Error('迁移分块无效');
        const bytes = Buffer.from(args.data,'base64');
        if (bytes.length !== Math.min(CHUNK,r.bytes-args.offset) || bytes.toString('base64') !== args.data) throw Error('迁移分块数据无效');
        storage().append(op,args.offset,bytes);
        return {ok:true};
      }
      if (operation === 'prepare' && ['receiving','ready'].includes(r.state) && args.digest === r.digest) {
        if (r.state === 'receiving') {
          const packet = files.parse(storage().assemble(op),r);
          const {sha256,...historyBody} = packet.history;
          if (files.hash(Buffer.from(JSON.stringify(historyBody))) !== sha256 ||
              historyBody.schema !== 'soduwork.device-history/v1' || historyBody.conversation.creator?.account !== accountId(ctx.identity) ||
              historyBody.conversation.creator.hub !== ctx.identity.hub ||
              !Array.isArray(historyBody.snapshot?.messages) || !Array.isArray(historyBody.snapshot?.tools) || unsettledTools(historyBody.snapshot) ||
              historyBody.snapshot.messages.some(m=>!m || !['user','assistant'].includes(m.role)))
            throw Error('会话历史身份或内容无法校验');
          await files.prepare(storage().root,op,packet.files);
          await guard();
          storage().state(op,'receiving','ready');
        }
        return {ok:true,state:'ready',digest:r.digest};
      }
      if (operation === 'grant' && ['ready','activating','active'].includes(r.state)) {
        const proof = storedLineage(ctx,r);
        lineage.validate(proof.ancestors,proof.grant,grantFields(ctx,r,lineage.publicKey(remote.publicKey),await grantIdentity(ctx,ctx.device)));
        if ((r.proof && r.proof !== args.signature) || typeof args.signature !== 'string' ||
            !await peer.verifyGrant(remote,lineage.text(proof.grant),args.signature)) throw Error('交权凭证无效');
        lineage.signed(proof.grant,args.signature);
        await guard();
        if (r.state !== 'active') {
          if (r.state === 'ready') storage().state(op,'ready','activating',args.signature);
          const packet = files.parse(storage().assemble(op),r);
          const cwd = await files.activate(storage().root,op,packet.files);
          await guard();
          await history.importPortable(packet.history,{identity:ctx.identity,cwd,transferId:op,predecessor:storage().historyStamp(op),files:packet.files.map(({path,size,sha256,artifact,attachmentKey})=>({path,size,sha256,artifact,attachmentKey})),assertCurrent:guard});
          await guard();
          storage().transaction(()=>{storage().state(op,'activating','active');storage().clear(op);});
        }
        return {ok:true,state:'active',digest:r.digest};
      }
      if (operation === 'abort' && ['receiving','ready','aborted'].includes(r.state)) {
        await files.discard(storage().root,op);
        if (r.state !== 'aborted') storage().transaction(()=>{storage().state(op,r.state,'aborted');storage().clear(op);});
        return {ok:true};
      }
      throw Error('设备迁移状态不允许此操作');
    });
  }
  return { preview,start,status,resume,cancel,receive,blocked,admit,close:()=>{db?.close();db=null;} };
}
module.exports = { create };
