'use strict';

// Some legacy Kimi replies linked a screenshot whose only turn-bound copy was
// kept by ReadMediaFile. The private media key hashes MIME + NUL + original bytes.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const archive = require('./device-artifact-archive.cjs');
const { same, stamp } = require('./runtime-artifacts.cjs');
const { portablePath } = require('./portable-workspace');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

async function read(root, file, limit) {
  const stat = await fs.lstat(file, { bigint: true });
  if (!stat.isFile() || stat.nlink !== 1n || stat.size <= 0n || stat.size > BigInt(limit)) throw Error('Invalid native media receipt');
  const version = stamp(stat), bytes = await archive.readVersion(root, path.relative(root, file).split(path.sep).join('/'), version);
  if (!bytes) throw Error('Native media receipt changed');
  return { bytes, version };
}

function declaredImages(text) {
  const paths = new Set();
  if (typeof text !== 'string' || !text.includes('soduwork-media')) return paths;
  for (const match of text.matchAll(/^```soduwork-media[^\S\r\n]*\r?\n([^\n]{1,16384})\r?\n```[^\S\r\n]*$/gm)) {
    let block;
    try { block = JSON.parse(match[1]); } catch { continue; }
    if (!['image', 'gallery'].includes(block?.type) || !Array.isArray(block.items) || !block.items.length ||
        block.items.length > 100 || block.type === 'image' && block.items.length !== 1 ||
        Object.keys(block).some(key => !['type', 'items'].includes(key))) continue;
    try {
      const matching = block.items.map(item => {
        if (typeof item?.url !== 'string' || Object.keys(item).some(key => !['url', 'title'].includes(key)) ||
            /[?#]/.test(item.url)) throw Error('Invalid image declaration');
        return portablePath(item.url.replace(/^\.\//, ''));
      });
      for (const relative of matching) paths.add(relative);
    } catch { /* A declaration may contain remote media instead of a workspace path. */ }
  }
  return paths;
}
const declared = (text, relative) => declaredImages(text).has(relative);

// An old archive knows the producing segment but not always the user turn.
// Callers may bind it only when that segment contains a single user turn.
function legacyReceipt(history, sources, source, turnId, index, relative) {
  const file = history?.archive?.files?.find(f => f.relative === relative);
  if (!file || !/^[a-f0-9]{64}$/.test(file.sha256)) return;
  // Some old terminal captures used the conversation's root ID. If that
  // adapter was started again, the root ID alone cannot identify the writer.
  const repeatedRoot = sources[0]?.id === source.id && sources.some(other =>
    other.id !== source.id && other.adapterId === source.adapterId);
  const entry = history.items?.find(entry => entry.metadata?.relative === relative &&
    entry.source?.sessionId === source.id && entry.source.adapterId === source.adapterId &&
    (!repeatedRoot || entry.source.turnId === turnId) &&
    (!entry.source.turnId || entry.source.turnId === turnId) &&
    (entry.source.userMessageIndex === undefined || entry.source.userMessageIndex === index) &&
    same(entry.stamp, file.sourceStamp));
  if (entry) return { entry, file };
}

async function bindLegacyOriginal(profile, id, history, receipt, turnId, index, replaced, guard) {
  const prior = history.archive, { entry, file } = receipt;
  guard();
  const root = archive.location(profile, id, prior);
  if (!root || !await archive.restoredStamp(profile, root, file, entry.metadata.size).catch(() => null)) return;
  guard();
  // Reference the existing archived bytes without copying or trusting the workspace.
  const next = { ...prior };
  const versions = (prior.versions || []).filter(v => v !== replaced);
  const bound = { ...entry, archiveOnly: false, source: { ...entry.source, turnId, userMessageIndex: index, legacyFinal: true } };
  if (!require('./artifact-versions.cjs').record(next, { versions }, { root: history.root, items: [bound] })) return;
  return { ...history, archive: next };
}

function imageRead(tool, cwd) {
  if (tool.name !== 'ReadMediaFile' || tool.state !== 'done' || tool.isError ||
      typeof tool.result !== 'string' || tool.result.length > 8192) return;
  try {
    const blocks = JSON.parse(tool.result);
    if (!Array.isArray(blocks) || blocks.length !== 3 || blocks[0]?.type !== 'text' ||
        blocks[1]?.type !== 'image_url' || blocks[2]?.type !== 'text' || blocks[2].text !== '</image>') return;
    const file = /^<image path="([^"<>]+)">$/.exec(blocks[0].text)?.[1];
    const key = /^kimi-file:\/\/(f_[a-f0-9]{64})$/.exec(blocks[1].imageUrl?.url)?.[1];
    if (!file || !path.isAbsolute(file) || !key) return;
    const relative = portablePath(path.relative(cwd, file).split(path.sep).join('/'));
    if (relative.split('/').some(part => part.startsWith('.')) || !mime[path.extname(relative).toLowerCase()]) return;
    return { relative, key, blocks };
  } catch { /* Malformed tool output grants no access. */ }
}

function candidates(row, data, history) {
  const messages = data.snapshot?.messages || [], found = [];
  const singleUser = new Map();
  for (const tool of data.snapshot?.tools || []) {
    const image = imageRead(tool, row.cwd);
    if (!image || !Number.isSafeInteger(tool.after) || !messages[tool.after]) continue;
    let index = tool.after;
    while (index >= 0 && messages[index].role !== 'user') index--;
    const user = messages[index], source = data.coverage.sources.find(item => item.adapterId === 'kimi' &&
      user?.id?.startsWith(item.id + ':') && tool.id?.startsWith(item.id + ':' + item.id + ':'));
    if (!source || !/^\d+:[^:]{1,256}$/.test(tool.callId)) continue;
    const versions = history?.archive?.versions || [];
    const existing = versions.filter(v => v.source?.userMessageIndex === index || user.submissionId && v.turnId === user.submissionId);
    const turns = new Set(existing.map(v => v.turnId));
    if (turns.size > 1 || turns.size && user.submissionId && !turns.has(user.submissionId)) continue;
    const syntheticId = 'kimi-' + digest(user.id).slice(0, 32);
    const turnId = user.submissionId || existing[0]?.turnId || syntheticId;
    if (!singleUser.has(source.id)) singleUser.set(source.id, messages.filter(m =>
      m.role === 'user' && m.id?.startsWith(source.id + ':')).length === 1);
    const legacy = singleUser.get(source.id) && legacyReceipt(history, data.coverage.sources, source, turnId, index, image.relative);
    const version = existing.find(v => v.relative === image.relative);
    // A genuine completed-turn receipt always wins. Only a version produced by
    // this fallback can yield to a subsequently restored final archive.
    if (version && (!legacy || version.source?.legacyFinal || version.sha256 === legacy.file.sha256 ||
        !(version.source?.nativeMediaKey === image.key || version.turnId === syntheticId))) continue;
    for (let i = Math.max(tool.after, index + 1); i < messages.length && messages[i].role !== 'user'; i++) {
      if (!messages[i].id?.startsWith(source.id + ':') || messages[i].sourceAgent?.agentId !== 'kimi') continue;
      const reply = messages[i].blocks?.find(block => block.kind === 'text' && declared(block.text, image.relative));
      if (reply) { found.push({ ...image, source, call: tool.callId.split(':')[1], index, turnId, legacy, version, reply: reply.text }); break; }
    }
    if (found.length > 32) return [];
  }
  // Two different reads of the same turn/path cannot establish which revision
  // the author meant in a subsequent filename-only declaration.
  return found.filter(item => !found.some(other => other !== item && other.turnId === item.turnId &&
    other.relative === item.relative && other.key !== item.key));
}

async function nativeSession(profile, row, part, source) {
  const json = async (file, cap) => JSON.parse((await read(profile, file, cap)).bytes);
  const root = path.join(profile, 'runner', 'data'), ref = source.id;
  const metaPath = path.join(root, 'local-runs', ref, 'meta.json');
  if (!/^[a-f0-9-]{36}$/.test(ref) || !part?.started ||
      require('../agent-runtime/runner-adapter').runnerRefForDispatch(part.nativeDispatchId || '') !== ref) return;
  const first = await read(profile, metaPath, 2 * 1024 * 1024), meta = JSON.parse(first.bytes);
  if (meta.ref !== ref || meta.cli !== 'kimi' || meta.ws !== row.cwd || meta.eventDestination !== 'local' ||
      meta.state !== 'done' || String(meta.seq) !== source.revision ||
      part.nativeDispatchId !== 'chat:' + meta.taskId + ':kimi' || !/^session_[a-f0-9-]{36}$/.test(meta.cliSid)) return;
  const workspace = path.basename(row.cwd);
  if (!/^chat-[a-z0-9-]+$/.test(workspace)) return;
  const project = 'wd_' + workspace + '_' + digest(row.cwd.split(path.sep).join('/')).slice(0, 12);
  const directory = path.join(root, '.kimi-code', 'sessions', project, meta.cliSid);
  const state = await json(path.join(directory, 'state.json'), 128 * 1024);
  if (state.id !== meta.cliSid || state.cwd !== row.cwd) return;
  const wire = await read(profile, path.join(directory, 'agents', 'main', 'wire.jsonl'), 16 * 1024 * 1024);
  const events = wire.bytes.toString('utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line))
    .filter(event => event.agentId === 'main' && ['turn.ended', 'context.append_loop_event'].includes(event.type));
  return { events, directory, json, unchanged: async () => (await read(profile, metaPath, 2 * 1024 * 1024)).bytes.equals(first.bytes) };
}

async function nativeOriginal(profile, row, session, item) {
  if (!session) return;
  const { events, directory, json } = session;
  let call, matched = false, reply = false, completed = false;
  for (const event of events) {
    const body = event.event;
    if (event.type === 'turn.ended' && call && String(event.turnId) === String(call.turnId) && event.reason === 'completed')
      completed = matched && reply;
    if (event.type !== 'context.append_loop_event') continue;
    if (body.toolCallId === item.call) {
      if (body.type === 'tool.call') {
        if (call || body.name !== 'ReadMediaFile' || Object.keys(body.args || {}).join() !== 'path' ||
            path.resolve(row.cwd, body.args.path) !== path.resolve(row.cwd, item.relative) || !body.uuid) return;
        call = body;
      } else if (body.type === 'tool.result') {
        if (!call || matched || body.parentUuid !== call.uuid || body.result?.isError !== false ||
            JSON.stringify(body.result.output) !== JSON.stringify(item.blocks)) return;
        matched = true;
      }
    }
    if (matched && call.turnId === body.turnId && body.type === 'content.part' && body.part?.type === 'text' &&
        body.part.text === item.reply) reply = true;
  }
  if (!completed) return;
  const extension = path.extname(item.relative).toLowerCase(), mediaType = mime[extension];
  const file = item.key + (extension === '.jpeg' ? '.jpg' : extension);
  const info = await json(path.join(directory, 'media', 'meta', item.key + '.json'), 8192);
  if (info.version !== 1 || info.key !== file || info.mediaType !== mediaType || info.name !== path.posix.basename(item.relative)) return;
  const original = await read(profile, path.join(directory, 'media', file), 20 * 1024 * 1024);
  if ('f_' + crypto.createHash('sha256').update(mediaType).update('\0').update(original.bytes).digest('hex') !== item.key) return;
  if (!await session.unchanged()) return;
  return original;
}

async function ownsScratch(profile, row, parts, data) {
  const origin = parts[0], name = path.basename(row.cwd);
  if (origin?.sessionId !== row.id || data.coverage.sources[0]?.id !== row.id || !/^chat-[a-z0-9-]+$/.test(name)) return false;
  if (origin.adapterId !== 'pi') return require('../agent-runtime/runner-adapter')
    .runnerRefForDispatch('chat:' + name + ':' + origin.adapterId) === row.id;
  if (origin.ref !== name || !origin.path || data.coverage.sources[0].adapterId !== 'pi') return false;
  const base = path.join(profile, 'pi-agent');
  const file = await require('../app-readonly-history.cjs').plainArchivePath(base, origin.path);
  const header = require('./metadata-snapshot.cjs').read(base, file, { prefix: true, maxBytes: 8192, maxFileBytes: 128 * 1024 * 1024 });
  if (header.stat.nlink !== 1n) return false;
  const first = JSON.parse(header.bytes.toString('utf8').split('\n', 1)[0]);
  return first.type === 'session' && first.id === row.id && first.cwd === row.cwd;
}

// Bind only turn versions. A recovered image never claims the current workspace name.
async function recover(app, row, data, history, guard, createdOriginals = []) {
  if (!data?.coverage?.complete || !Array.isArray(data.coverage.sources) || data.imported || data.nativeConflict ||
      data.historyProtection || row.historyProtection || row.deliveryWorkspaceKey || row.deviceTransferId ||
      !path.isAbsolute(row.cwd || '') || !data.coverage.sources.some(s => s.adapterId === 'kimi')) return history;
  const missing = candidates(row, data, history);
  if (!missing.length) return history;
  const segments = require('./runtime-segments');
  const manifest = segments.read(app, row.id);
  if (!manifest || manifest.cwd !== row.cwd || manifest.deviceTransferId || manifest.deviceShared || manifest.deviceHistoryComplete) return history;
  const parts = [...manifest.segments, manifest.active], profile = app.getPath('userData');
  try { if (!await ownsScratch(profile, row, parts, data)) return history; } catch { return history; }
  guard();
  let result = history;
  const sessions = new Map();
  try {
    for (const item of missing) {
      const part = parts.find(part => part.adapterId === 'kimi' && part.sessionId === item.source.id);
      if (!part?.started || require('../agent-runtime/runner-adapter').runnerRefForDispatch(part.nativeDispatchId || '') !== item.source.id) continue;
      if (item.legacy) {
        const bound = await bindLegacyOriginal(profile, row.id, result, item.legacy, item.turnId, item.index, item.version, guard);
        if (segments.read(app, row.id) !== manifest) throw Error('历史图片的来源已变化');
        if (bound) { result = bound; continue; }
      }
      if (result?.archive?.versions?.some(version => version.turnId === item.turnId && version.relative === item.relative)) continue;
      let original;
      try {
        if (!sessions.has(item.source.id)) {
          sessions.set(item.source.id, nativeSession(profile, row, part, item.source));
        }
        original = await nativeOriginal(profile, row, await sessions.get(item.source.id), item);
      }
      catch { /* Optional native evidence may be absent, corrupt or from a newer format. */ }
      guard();
      if (!original || segments.read(app, row.id) !== manifest) continue;
      const relative = item.relative, name = path.posix.basename(relative);
      const entry = { metadata: { artifactId: require('./delivery-contract')._artifactId('image', relative), kind: 'image',
        name, title: name, relative, size: original.bytes.length, at: Math.round(Number(original.version[3]) / 1e6),
        preview: true, primary: false, processEvidence: true }, stamp: original.version,
        source: { sessionId: item.source.id, adapterId: 'kimi', turnId: item.turnId, userMessageIndex: item.index, nativeMediaKey: item.key } };
      const copy = await archive.preserve(profile, row.id, { version: 1, root: row.cwd, items: [entry], resources: [] },
        null, guard, { readWorkspace: false, originals: new Map([[entry, original.bytes]]) });
      if (!copy.archive?.versions?.length) continue;
      createdOriginals.push(copy.archive.generation);
      const prior = result?.archive;
      result = { ...(result || { version: 1, root: row.cwd, items: [], resources: [] }),
        archive: { ...(prior || { version: 1, generation: copy.archive.generation, files: [], omitted: 0 }),
          versions: [...(prior?.versions || []), ...copy.archive.versions] } };
      guard();
      if (segments.read(app, row.id) !== manifest) throw Error('历史图片的来源已变化');
    }
    return result;
  } catch (error) {
    await archive.retire(profile, row.id, history?.archive, result?.archive, false, createdOriginals);
    throw error;
  }
}

module.exports = { recover, ownsScratch, read, declaredImages, legacyReceipt, bindLegacyOriginal };
