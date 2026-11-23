// Host-only compatibility for Qwen Code 0.27.4: preserve the native model
// outcome through ACP after Qwen's own bounded output recovery has settled.
// No model text, credentials, tool arguments, or user files are inspected.
// Native source anchors: Copyright 2025 Google LLC and Qwen, Apache-2.0.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outcomes = new WeakMap();

export function captureOutcome(capture) {
  const state = { reason: undefined };
  const methods = ['beginResponse', 'restartAttempt', 'observeFinishReason'];
  if (methods.some(method => typeof capture?.[method] !== 'function')) {
    throw new Error('Qwen Code native outcome interface is unavailable; update SoduWork.');
  }
  for (const method of methods) {
    const original = capture?.[method];
    capture[method] = function (...args) {
      const result = Reflect.apply(original, this, args);
      if (method !== 'observeFinishReason') state.reason = undefined;
      else if (typeof args[0] === 'string' && args[0]) state.reason = args[0];
      return result;
    };
  }
  outcomes.set(capture, state);
  return capture;
}

export function promptOutcome(result, capture, signal) {
  const state = outcomes.get(capture);
  if (!state) throw new Error('Qwen Code native outcome capture is unavailable; update SoduWork.');
  // Cancellation, native session budgets, and genuine errors keep their own
  // meanings. Only an actual final model MAX_TOKENS replaces claimed success.
  if (signal?.aborted || result?.stopReason !== 'end_turn' || state.reason !== 'MAX_TOKENS') return result;
  return { ...result, stopReason: 'max_tokens', _meta: {
    ...result._meta, soduwork: { ...result._meta?.soduwork, outputLimit: true },
  } };
}

const VERSION = '0.27.4';
const ACP_FILE = 'acpAgent-DYVOMNZP.js';
const CORE_FILE = 'chunk-WG5L7ABP.js';
// Full installed source hashes also guard the producers of the callbacks and
// finish reasons. A rebuilt or upgraded runtime requires a fresh review.
const HASHES = new Map([
  [ACP_FILE, '76c9d14ebda816d2bcba07bda06b11138825d54966f85fe251c7fb0134538ae0'],
  [CORE_FILE, 'bdd6fa8e709456fc5b4a795419df94986bad04e4f2f7458a7803071685dd7714'],
]);
// The callback implementation is validation-only; its telemetry behavior is
// preserved unchanged, including when sensitive span capture is disabled.
const VALIDATION_HASHES = new Map([
  ...HASHES,
  ['chunk-KXSZYB5L.js', '404f98c252adaeaa011254e049c8ff92eb76b14c3ce77abffd32a659dae39b64'],
]);
const CAPTURE = 'recordingService:turnRecording?.recordingService??this.config.getChatRecordingService(),agentOutput:new AgentOutputMessageCapture(this.config)';
const PROMPT = 'const result=await this.#executePrompt(params,pendingSend,responseCapture,invocationContext,modelPrompt,!channelPromptTurn&&goalTurn===void 0,goalTurn,channelPromptTurn);';
const RECOVERY = 'rollbackRecoveryAttempt();debugLogger26.warn(`Recovery attempt ${recoveryCount} failed: ${recoveryError}`);yield{type:"chunk",value:{candidates:[{content:{role:"model",parts:[]},finishReason:FinishReason.STOP}]}};break';

function unsupported() {
  return new Error('Qwen Code ACP outcome interface is unsupported; update SoduWork before running this runtime.');
}

function replaceOnce(source, before, after) {
  const index = source.indexOf(before);
  if (index < 0 || source.indexOf(before, index + before.length) !== -1) throw unsupported();
  return source.slice(0, index) + after + source.slice(index + before.length);
}

export function transformSource(source, filename, version) {
  if (version !== VERSION || !HASHES.has(filename)
      || createHash('sha256').update(source).digest('hex') !== HASHES.get(filename)) throw unsupported();
  if (filename === CORE_FILE) {
    // The upstream recovery catch manufactures STOP after a failed request.
    // Keep its rollback, then let ACP report the original model/transport error.
    return replaceOnce(source, RECOVERY, 'rollbackRecoveryAttempt();throw recoveryError');
  }
  let fixed = replaceOnce(source, CAPTURE, CAPTURE.replace(
    'new AgentOutputMessageCapture(this.config)', '__soduworkCaptureOutcome(new AgentOutputMessageCapture(this.config))'));
  fixed = replaceOnce(fixed, PROMPT, PROMPT.replace('const result=await ', 'const result=__soduworkPromptOutcome(await ')
    .replace('channelPromptTurn);', 'channelPromptTurn),responseCapture.agentOutput,pendingSend.signal);'));
  return 'import { captureOutcome as __soduworkCaptureOutcome, promptOutcome as __soduworkPromptOutcome } from '
    + JSON.stringify(import.meta.url) + ';\n' + fixed;
}

if (process.env.SODUWORK_QWEN_ACP_OUTCOME === '1') {
  delete process.env.SODUWORK_QWEN_ACP_OUTCOME;
  delete process.env.NODE_OPTIONS;
  const validated = new Set();
  registerHooks({
    load(url, context, nextLoad) {
      if (!url.startsWith('file:')) return nextLoad(url, context);
      const file = fileURLToPath(url);
      const directory = dirname(file);
      const root = basename(directory) === 'chunks' ? dirname(directory) : directory;
      if (basename(root) !== 'qwen-code' || basename(dirname(root)) !== '@qwen-code') return nextLoad(url, context);
      if (!validated.has(root)) {
        try {
          const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
          if (manifest.name !== '@qwen-code/qwen-code' || manifest.version !== VERSION) throw unsupported();
          // Validate all three modules before allowing the package entrypoint.
          // This also fails closed if an upgrade renames a generated chunk.
          for (const [name, digest] of VALIDATION_HASHES) {
            const source = readFileSync(join(root, 'chunks', name));
            if (createHash('sha256').update(source).digest('hex') !== digest) throw unsupported();
          }
        } catch {
          throw unsupported();
        }
        validated.add(root);
      }
      const loaded = nextLoad(url, context);
      if (basename(directory) !== 'chunks' || !HASHES.has(basename(file))) return loaded;
      if (loaded.format !== 'module' || loaded.source == null) throw unsupported();
      const source = typeof loaded.source === 'string' ? loaded.source : Buffer.from(loaded.source).toString('utf8');
      return { ...loaded, source: transformSource(source, basename(file), VERSION) };
    },
  });
}
