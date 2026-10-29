'use strict';
// Read-only payload benchmark. Writes only the requested output directory.
// Run: node client/scripts/benchmark-payload-verifier.cjs PAYLOAD_ROOT OUTPUT_DIR
// Timings are local repeated reads (warm-cache evidence), never a remote-device SLA.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { verify } = require('../build/verify-payload.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function measure(root, scenario, concurrency) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, '.soduwork-payload.json'), 'utf8'));
  const originalLstat = fs.promises.lstat, diagnostics = {}, attempts = new Map();
  const locked = new Set(manifest.files.slice(0, 600).map(item => path.resolve(root, item.path)));
  if (scenario === 'read-latency-2ms' || scenario === '600-locks') {
    fs.promises.lstat = async function(file, ...args) {
      if (scenario === 'read-latency-2ms') await delay(2);
      if (scenario === '600-locks' && locked.has(file)) {
        const attempt = (attempts.get(file) || 0) + 1; attempts.set(file, attempt);
        if (attempt < 3) throw Object.assign(Error('Injected temporary sharing failure'), { code: 'EBUSY' });
      }
      return originalLstat.call(fs.promises, file, ...args);
    };
  }
  const started = performance.now();
  try {
    const verifier = scenario === 'published-54' ? require(path.join(root, '.soduwork-verify.cjs')).verify : verify;
    const count = await verifier(root, [], { concurrency, diagnostics });
    return { scenario, concurrency: scenario === 'published-54' ? 1 : concurrency,
      fileCount: count, bytes: manifest.files.reduce((sum, item) => sum + item.size, 0),
      elapsedMs: Math.round(performance.now() - started), diagnostics,
      injectedLockFiles: attempts.size, maxRssKiB: process.resourceUsage().maxRSS };
  } finally { fs.promises.lstat = originalLstat; }
}

async function child(root, scenario, concurrency) {
  const proc = spawn(process.execPath, [__filename, '--case', root, scenario, String(concurrency)], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  proc.stdout.on('data', chunk => { stdout += chunk; });
  proc.stderr.on('data', chunk => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    proc.once('error', reject);
    proc.once('exit', code => {
      if (code !== 0) return reject(Error(`Benchmark case failed (${scenario}/${concurrency}): ${stderr}`));
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
    });
  });
}

async function main(root, output) {
  if (!root || !output) throw Error('Expected payload root and output directory');
  root = path.resolve(root); output = path.resolve(output);
  if (output === root || output.startsWith(root + path.sep)) throw Error('Benchmark output must be outside the payload');
  await fs.promises.mkdir(output, { recursive: true });
  const report = { schema: 1, time: new Date().toISOString(), node: process.version,
    platform: process.platform, release: os.release(), cpu: os.cpus()[0]?.model, root,
    scope: 'Local strict verification; repeated reads without clearing caches. Injected latency/locks are simulations.',
    timingMeaning: 'readMs sums per-file metadata/read/hash/close duration; retryDelayMs sums scheduled retry delays. Both overlap; elapsedMs is actual wall time.',
    results: [] };
  const save = () => fs.promises.writeFile(path.join(output, 'verifier-benchmark.json'), JSON.stringify(report, null, 2));
  const add = async (scenario, concurrency, round) => {
    const result = await child(root, scenario, concurrency); result.round = round;
    report.results.push(result); await save();
    console.log(JSON.stringify({ scenario, concurrency, round, elapsedMs: result.elapsedMs, retryCount: result.diagnostics.retryCount }));
  };
  await add('published-54', 1, 0);
  // Reverse/rotate ordering to reduce the advantage of always running last.
  for (const [round, order] of [[1, [1, 2, 4, 8]], [2, [8, 4, 2, 1]], [3, [4, 1, 8, 2]]]) {
    for (const concurrency of order) await add('normal', concurrency, round);
  }
  await add('published-54', 1, 1);
  for (const scenario of ['read-latency-2ms', '600-locks']) {
    for (const concurrency of [1, 2, 4, 8]) await add(scenario, concurrency, 1);
  }
  report.summary = [1, 2, 4, 8].map(concurrency => {
    const values = report.results.filter(x => x.scenario === 'normal' && x.concurrency === concurrency)
      .map(x => x.elapsedMs).sort((a, b) => a - b);
    return { concurrency, medianMs: values[Math.floor(values.length / 2)], minMs: values[0], maxMs: values.at(-1) };
  });
  await save(); console.log(JSON.stringify({ summary: report.summary }));
}

if (process.argv[2] === '--case') {
  measure(path.resolve(process.argv[3]), process.argv[4], Number(process.argv[5]))
    .then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error); process.exitCode = 1; });
} else {
  main(process.argv[2], process.argv[3]).catch(error => { console.error(error); process.exitCode = 1; });
}
