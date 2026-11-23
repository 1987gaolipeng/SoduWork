// Kimi 2.6.2 publishes step truncation and turn failures on its native event
// stream, but its ACP projection reports both as end_turn. Preserve that native
// outcome at the ACP boundary; tools and the model loop remain unchanged.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_HASHES = new Map([
  ['2.6.2', 'f07d4f0d28ba1dd3397cb070aa757f7b7610a51bb15164f1e158fad7809cb36a'],
]);

export function settleTurnOutcome(driver, event, isAuthError, RequestError, mapStopReason) {
  if (event.reason === 'failed') {
    if (isAuthError(event.error)) {
      driver.reject(RequestError.authRequired(undefined, event.error?.message));
      return;
    }
    if (event.error?.code !== 'provider.filtered') {
      // Provider messages can contain credentials, request bodies or internal
      // paths. The native journal retains the diagnosis; ACP gets safe wording.
      const message = event.error?.code === 'context.overflow'
        ? 'Kimi context length exceeded; existing progress was preserved.'
        : 'Kimi model turn failed; existing progress was preserved.';
      driver.reject(RequestError.internalError(undefined, message));
      return;
    }
  }
  const reason = event.reason === 'completed' && driver.soduworkFinishReason === 'max_tokens'
    ? 'max_tokens' : mapStopReason(event.reason, event.error);
  driver.resolve({ stopReason: reason });
}

function replaceOnce(source, old, replacement) {
  const start = source.indexOf(old);
  if (start < 0 || source.indexOf(old, start + old.length) !== -1) {
    throw new Error('Kimi ACP outcome interface is unsupported; update SoduWork before running this adapter.');
  }
  return source.slice(0, start) + replacement + source.slice(start + old.length);
}

export function transformSource(source, version) {
  const expected = SOURCE_HASHES.get(version);
  if (!expected || createHash('sha256').update(source).digest('hex') !== expected) {
    throw new Error('Kimi ACP outcome interface is unsupported (' + version
      + '); update SoduWork before running this adapter.');
  }
  // The observable native event is on the existing stream, but this SDK's
  // typed registration table omits it. Add only its validated projection.
  source = replaceOnce(source, '\tagentEvents = {', `\tagentEvents = {
\t\t"turn.step.completed": {
\t\t\tkind: "stream", name: "events", type: "turn.step.completed",
\t\t\tschema: object$1({type: literal("turn.step.completed"), turnId: number$1(), finishReason: string(), providerFinishReason: string().optional()})
\t\t},`);
  source = replaceOnce(source, '\t\t\t}), events.on("turn.ended", (event) => {',
    `\t\t\t}), events.on("turn.step.completed", (event) => {
\t\t\t\tthis.dispatchTurnEvent(event.turnId, () => {
\t\t\t\t\tconst driver = this.driverFor(event.turnId);
\t\t\t\t\tif (driver !== void 0) driver.soduworkFinishReason = event.providerFinishReason === "truncated"
\t\t\t\t\t\t? "max_tokens" : event.finishReason;
\t\t\t\t});
\t\t\t}), events.on("turn.ended", (event) => {`);
  source = replaceOnce(source,
    `\t\t\t\tif (event.reason === "failed" && isAuthError(error)) {
\t\t\t\t\tdriver.reject(RequestError$1.authRequired(void 0, error?.message));
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t\tdriver.resolve({ stopReason: turnEndReasonToStopReason(event.reason, error) });`,
    '\t\t\t\t__soduworkKimiSettle(driver, event, isAuthError, RequestError$1, turnEndReasonToStopReason);');
  const importLine = 'import { settleTurnOutcome as __soduworkKimiSettle } from '
    + JSON.stringify(import.meta.url) + ';\n';
  // The installed CLI has a hashbang which must remain its first source line.
  const firstLineEnd = source.startsWith('#!') ? source.indexOf('\n') + 1 : 0;
  return source.slice(0, firstLineEnd) + importLine + source.slice(firstLineEnd);
}

if (process.env.SODUWORK_KIMI_ACP_OUTCOME === '1') {
  delete process.env.SODUWORK_KIMI_ACP_OUTCOME;
  // This hook belongs to the ACP host, never a tool's child Node process.
  delete process.env.NODE_OPTIONS;
  registerHooks({
    load(url, context, nextLoad) {
      if (!url.startsWith('file:')) return nextLoad(url, context);
      const file = fileURLToPath(url);
      const dist = dirname(file);
      const root = dirname(dist);
      if (basename(file) !== 'main.mjs' || basename(dist) !== 'dist'
          || basename(root) !== 'kimi-code' || basename(dirname(root)) !== '@moonshot-ai') {
        return nextLoad(url, context);
      }
      const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      if (manifest.name !== '@moonshot-ai/kimi-code') {
        throw new Error('Kimi ACP package identity is invalid; repair the adapter.');
      }
      const loaded = nextLoad(url, context);
      if (loaded.format !== 'module' || loaded.source == null) {
        throw new Error('Kimi ACP module format is unsupported; update SoduWork.');
      }
      const source = typeof loaded.source === 'string' ? loaded.source : Buffer.from(loaded.source).toString('utf8');
      return { ...loaded, source: transformSource(source, manifest.version) };
    },
  });
}
