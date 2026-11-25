'use strict';

// An ordinary Qwen read_file stores a full-frame JPEG of the image it saw.
// Zoomed views and the current workspace file cannot certify that preview.
const path = require('node:path');
const crypto = require('node:crypto');
const native = require('./kimi-history-images.cjs');
const archive = require('./device-artifact-archive.cjs');
const { portablePath } = require('./portable-workspace');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function matchesFrame(bytes, size) {
  if (bytes.length < 11 || bytes.readUInt16BE(0) !== 0xffd8 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) return false;
  for (let offset = 2; offset + 9 < bytes.length;) {
    const marker = bytes.readUInt16BE(offset), length = bytes.readUInt16BE(offset + 2);
    if (marker < 0xff00 || marker === 0xffda || length < 2 || offset + 2 + length > bytes.length) return false;
    if ([0xffc0, 0xffc1, 0xffc2].includes(marker)) {
      const height = bytes.readUInt16BE(offset + 5), width = bytes.readUInt16BE(offset + 7);
      return width * height > 0 && width * height <= 40000000 && size === width + 'x' + height;
    }
    offset += length + 2;
  }
  return false;
}

async function overviews(profile, cwd, meta, turn) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(meta.cliSid)) return [];
  const key = (process.platform === 'win32' ? cwd.toLowerCase() : cwd).replace(/[^A-Za-z0-9]/g, '-');
  const source = path.join(profile, 'runner/data/.qwen/projects', key, 'chats', meta.cliSid + '.jsonl');
  const { bytes } = await native.read(profile, source, 16 * 1024 * 1024);
  const calls = new Map(), results = [];
  const seen = new Set(), ids = new Set(turn.tools.filter(t => t.name === 'ReadFile' && t.state === 'done' && !t.isError).map(t => t.callId));
  let previous = null, users = 0, answerSeen = false;
  for (const line of bytes.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (!row.uuid || seen.has(row.uuid) || row.parentUuid !== previous || row.sessionId !== meta.cliSid || row.cwd !== cwd) return [];
    if (!previous && !(row.type === 'system' && row.provenance === 'system' && row.subtype === 'session_model')) return [];
    seen.add(row.uuid); previous = row.uuid;
    if (row.type === 'user' && row.provenance === 'real_user') users++;
    for (const part of row.message?.parts || []) {
      if (row.type === 'assistant' && row.provenance === 'assistant_output') {
        const call = part.functionCall;
        if (call && ids.has(call.id)) {
          if (calls.has(call.id)) return [];
          if (call.name !== 'read_file' || Object.keys(call.args || {}).join() !== 'file_path' ||
              typeof call.args.file_path !== 'string' || !path.isAbsolute(call.args.file_path)) continue;
          let relative;
          try { relative = portablePath(path.relative(cwd, call.args.file_path).split(path.sep).join('/')); } catch { continue; }
          if (!relative.split('/').some(p => p.startsWith('.')) && turn.paths.has(relative))
            calls.set(call.id, relative);
        }
        if (!part.thought && part.text === turn.reply && results.length) answerSeen = true;
      }
      const response = part.functionResponse, receipt = row.toolCallResult;
      if (row.type !== 'tool_result' || row.provenance !== 'tool_result' || !calls.has(response?.id)) continue;
      const relative = calls.get(response.id), media = response.parts?.[0]?.inlineData;
      if (results.some(r => r.call === response.id)) return [];
      const overview = /^Image overview: (\d+x\d+); oriented source: \d+x\d+\./.exec(response.response?.output || '');
      if (answerSeen || response.name !== 'read_file' ||
          receipt?.callId !== response.id || receipt.status !== 'success' || receipt.executionStatus !== 'success' ||
          response.parts?.length !== 1 || media?.mimeType !== 'image/jpeg' || media.displayName !== path.posix.basename(relative) ||
          !overview) continue;
      const encoded = media.data;
      if (typeof encoded !== 'string' || !encoded.length || encoded.length > 12 * 1024 * 1024 || encoded.length % 4) continue;
      const jpeg = Buffer.from(encoded, 'base64');
      if (jpeg.toString('base64') !== encoded || !matchesFrame(jpeg, overview[1])) continue;
      results.push({ relative, jpeg, call: response.id, at: Date.parse(row.timestamp) });
    }
  }
  return users === 1 && answerSeen ? results.filter(v => !results.some(other =>
    other.relative === v.relative && !other.jpeg.equals(v.jpeg))) : [];
}

function recorded(history, turn, relative, preview = false) {
  return history?.archive?.versions?.some(v => (v.turnId === turn.id || v.source?.userMessageIndex === turn.index) &&
    (preview ? v.metadata?.previewOf : v.relative) === relative);
}

function turns(data, history) {
  const messages = data.snapshot?.messages || [], tools = data.snapshot?.tools || [], found = [];
  for (const source of data.coverage.sources) {
    if (source.adapterId !== 'qwen' || !/^[a-f0-9-]{36}$/.test(source.id)) continue;
    const owns = row => row?.id?.startsWith(source.id + ':');
    const users = messages.filter(row => owns(row) && row.role === 'user');
    if (users.length !== 1) continue;
    const index = messages.indexOf(users[0]);
    const next = messages.findIndex((row, i) => i > index && row.role === 'user');
    const final = messages.slice(index + 1, next < 0 ? undefined : next).filter(row =>
      owns(row) && row.role === 'assistant' && row.sourceAgent?.agentId === 'qwen' && row.done !== false).at(-1);
    const reply = final?.blocks?.find(block => block.kind === 'text' && block.text?.includes('soduwork-media'))?.text;
    if (!reply) continue;
    const turnIds = new Set((history?.archive?.versions || []).filter(v => v.source?.userMessageIndex === index).map(v => v.turnId));
    if (turnIds.size > 1 || turnIds.size && users[0].submissionId && !turnIds.has(users[0].submissionId)) continue;
    const paths = native.declaredImages(reply);
    const turn = { index, reply, paths, source, id: users[0].submissionId || [...turnIds][0] || 'qwen-' + digest(users[0].id).slice(0, 32),
      tools: tools.filter(t => t.id?.startsWith(source.id + ':' + source.id + ':') && t.after >= index && (next < 0 || t.after < next)) };
    if (!turn.tools.some(t => t.name === 'ReadFile' && t.state === 'done' && !t.isError)) continue;
    if ([...paths].some(relative => !recorded(history, turn, relative) && (!recorded(history, turn, relative, true) ||
        native.legacyReceipt(history, data.coverage.sources, source, turn.id, index, relative)))) found.push(turn);
  }
  return found;
}

async function recover(app, row, data, history, guard, created) {
  if (!data?.coverage?.complete || data.nativeConflict || data.imported || row.deliveryWorkspaceKey ||
      row.deviceTransferId || data.historyProtection || row.historyProtection || !path.isAbsolute(row.cwd || '')) return history;
  const pending = turns(data, history);
  if (!pending.length || pending.length > 32) return history;
  const segments = require('./runtime-segments'), manifest = segments.read(app, row.id);
  if (!manifest || manifest.cwd !== row.cwd || manifest.deviceHistoryComplete || manifest.deviceTransferId || manifest.deviceShared) return history;
  const parts = [...manifest.segments, manifest.active], profile = app.getPath('userData');
  if (!await native.ownsScratch(profile, row, parts, data)) return history;
  let result = history;
  const allocated = [];
  try {
    for (const turn of pending) {
      const ref = turn.source.id, part = parts.find(p => p.sessionId === ref && p.adapterId === 'qwen');
      if (!part?.started || require('../agent-runtime/runner-adapter').runnerRefForDispatch(part.nativeDispatchId || '') !== ref) continue;
      let needsPreview = false;
      for (const relative of turn.paths) {
        if (recorded(result, turn, relative)) continue;
        const legacy = native.legacyReceipt(result, data.coverage.sources, turn.source, turn.id, turn.index, relative);
        if (legacy) {
          const bound = await native.bindLegacyOriginal(profile, row.id, result, legacy, turn.id, turn.index, undefined, guard);
          if (bound) { result = bound; continue; }
        }
        if (!recorded(result, turn, relative, true)) needsPreview = true;
      }
      if (!needsPreview) continue;
      const file = path.join(profile, 'runner/data/local-runs', ref, 'meta.json');
      let images;
      try {
        const original = await native.read(profile, file, 2 * 1024 * 1024), meta = JSON.parse(original.bytes);
        if (meta.ref !== ref || meta.cli !== 'qwen' || meta.ws !== row.cwd || meta.eventDestination !== 'local' ||
            meta.state !== 'done' || meta.round !== 1 || String(meta.seq) !== turn.source.revision ||
            part.nativeDispatchId !== 'chat:' + meta.taskId + ':qwen') continue;
        images = await overviews(profile, row.cwd, meta, turn);
        if (!(await native.read(profile, file, 2 * 1024 * 1024)).bytes.equals(original.bytes)) continue;
      } catch { continue; }
      for (const image of images) {
        if (recorded(result, turn, image.relative) || recorded(result, turn, image.relative, true) || !Number.isFinite(image.at)) continue;
        guard();
        if (segments.read(app, row.id) !== manifest) throw Error('历史图片的来源已变化');
        const sha = digest(image.jpeg), relative = '.soduwork/evidence/' + digest(image.relative) + '.jpg';
        const name = path.posix.parse(image.relative).name + '.jpg';
        // A native payload has no workspace inode. Its private content receipt
        // cannot match a filesystem stamp or grant access to the declared PNG.
        const entry = { stamp: ['qwen-overview', sha, String(image.jpeg.length), '0', '0'],
          source: { sessionId: ref, adapterId: 'qwen', turnId: turn.id, userMessageIndex: turn.index },
          metadata: { artifactId: require('./delivery-contract')._artifactId('image', relative), kind: 'image',
            name, title: name, relative, size: image.jpeg.length, at: image.at, previewOf: image.relative,
            preview: true, primary: false, processEvidence: true } };
        const copy = await archive.preserve(profile, row.id, { version: 1, root: row.cwd, items: [entry], resources: [] },
          null, guard, { readWorkspace: false, originals: new Map([[entry, image.jpeg]]) });
        if (!copy.archive?.versions?.length) continue;
        allocated.push(copy.archive.generation);
        const prior = result?.archive;
        result = { ...(result || { version: 1, root: row.cwd, items: [], resources: [] }),
          archive: { ...(prior || { version: 1, generation: copy.archive.generation, files: [], omitted: 0 }),
            versions: [...(prior?.versions || []), ...copy.archive.versions] } };
      }
    }
    guard();
    if (segments.read(app, row.id) !== manifest) throw Error('历史图片的来源已变化');
    created.push(...allocated);
    return result;
  } catch (error) {
    await archive.retire(profile, row.id, history?.archive, result?.archive, false, allocated);
    throw error;
  }
}

module.exports = { recover };
