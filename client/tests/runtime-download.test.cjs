'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const { downloadFile, downloadLabel, errorLabel } = require('../scripts/runtime-download.cjs');

// Generate an isolated, short-lived test CA with Node alone. No committed keys,
// external OpenSSL installation or globally disabled TLS verification is needed.
const materials = new Map();
function certificate(ip = '127.0.0.1') {
  if (materials.has(ip)) return materials.get(ip);
  function der(tag, ...parts) {
    const body = Buffer.concat(parts.map(value => Buffer.isBuffer(value) ? value : Buffer.from(value)));
    const length = body.length < 128 ? Buffer.from([body.length]) : (() => {
      const bytes = []; let size = body.length;
      while (size) { bytes.unshift(size & 255); size >>>= 8; }
      return Buffer.from([128 | bytes.length, ...bytes]);
    })();
    return Buffer.concat([Buffer.from([tag]), length, body]);
  }
  const seq = (...parts) => der(0x30, ...parts);
  const oid = value => {
    const numbers = value.split('.').map(Number), bytes = [40 * numbers[0] + numbers[1]];
    for (const number of numbers.slice(2)) {
      const encoded = [number & 127]; let remaining = Math.floor(number / 128);
      while (remaining) { encoded.unshift((remaining & 127) | 128); remaining = Math.floor(remaining / 128); }
      bytes.push(...encoded);
    }
    return der(6, Buffer.from(bytes));
  };
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const algorithm = seq(oid('1.2.840.113549.1.1.11'), der(5, Buffer.alloc(0)));
  const name = seq(der(0x31, seq(oid('2.5.4.3'), der(0x0c, 'SoduWork generated download fixture ' + ip))));
  const time = offset => der(0x17, new Date(Date.now() + offset).toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z');
  const extensions = der(0xa3, seq(
    seq(oid('2.5.29.19'), der(1, Buffer.from([255])), der(4, seq(der(1, Buffer.from([255]))))),
    seq(oid('2.5.29.17'), der(4, seq(
      ...['localhost', 'archive.invalid', 'redirect.invalid'].map(host => der(0x82, host)),
      der(0x87, ip === '::1' ? Buffer.from('00000000000000000000000000000001', 'hex') : Buffer.from(ip.split('.').map(Number))),
    ))),
  ));
  const tbs = seq(der(0xa0, der(2, Buffer.from([2]))), der(2, Buffer.from([1])), algorithm, name,
    seq(time(-86400000), time(86400000)), name, pair.publicKey.export({ format: 'der', type: 'spki' }), extensions);
  const signed = seq(tbs, algorithm, der(3, Buffer.concat([Buffer.from([0]), crypto.sign('sha256', tbs, pair.privateKey)])));
  const pem = '-----BEGIN CERTIFICATE-----\n' + signed.toString('base64').match(/.{1,64}/g).join('\n') + '\n-----END CERTIFICATE-----\n';
  const material = { cert: pem, key: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }), tls: { ca: pem } };
  materials.set(ip, material);
  return material;
}

function directory(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-download-network-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  return path.join(folder, 'archive.exe');
}

async function listen(t, server, host = '127.0.0.1') {
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, host, resolve);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return server.address().port;
}

async function origin(t, handler) {
  const received = [];
  const server = https.createServer(certificate(), (request, response) => {
    received.push({ path: request.url, headers: { ...request.headers } });
    handler(request, response);
  });
  const port = await listen(t, server);
  return { port, received, url: `https://127.0.0.1:${port}/archive`, remote: `https://archive.invalid:${port}/archive` };
}

async function proxy(t, originPort, { secure = false, authorization = '', tlsMaterial, host = '127.0.0.1' } = {}) {
  const received = [], upstreams = new Set();
  const server = secure ? https.createServer(tlsMaterial || certificate()) : http.createServer();
  server.on('connect', (request, socket, head) => {
    received.push({ target: request.url, headers: { ...request.headers } });
    if (authorization && request.headers['proxy-authorization'] !== authorization) {
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const upstream = net.connect(originPort, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
    upstreams.add(upstream);
    upstream.once('close', () => upstreams.delete(upstream));
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.once('close', () => upstream.destroy());
  });
  const port = await listen(t, server, host);
  t.after(() => { for (const socket of upstreams) socket.destroy(); });
  return { received, url: `${secure ? 'https' : 'http'}://${host.includes(':') ? '[' + host + ']' : host}:${port}` };
}

function options(environment = {}, extra = {}) {
  return { environment, tls: certificate().tls, timeoutMs: 5000, log() {}, ...extra };
}

test('downloads HTTPS through a real CONNECT proxy with lowercase environment precedence', async t => {
  const target = directory(t), source = await origin(t, (_request, response) => response.end('proxied fixture'));
  const tunnel = await proxy(t, source.port);
  assert.equal(await downloadFile(source.remote, target, options({ HTTPS_PROXY: 'http://127.0.0.1:1',
    https_proxy: tunnel.url, NO_PROXY: '*', no_proxy: '' })), target);
  assert.equal(fs.readFileSync(target, 'utf8'), 'proxied fixture');
  assert.equal(tunnel.received.length, 1);
  assert.equal(tunnel.received[0].target, `archive.invalid:${source.port}`);
});

test('HTTP_PROXY also provides HTTPS CONNECT routing when HTTPS_PROXY is absent', async t => {
  const target = directory(t), source = await origin(t, (_request, response) => response.end('HTTP fallback'));
  const tunnel = await proxy(t, source.port);
  await downloadFile(source.remote, target, options({ HTTP_PROXY: tunnel.url }));
  assert.equal(tunnel.received.length, 1);
  assert.equal(fs.readFileSync(target, 'utf8'), 'HTTP fallback');
});

test('an explicitly empty environment does not inherit host proxies', async t => {
  const target = directory(t), source = await origin(t, (_request, response) => response.end('direct fixture'));
  const previous = process.env.https_proxy;
  process.env.https_proxy = 'http://127.0.0.1:1';
  try { await downloadFile(source.url, target, options({})); }
  finally { if (previous === undefined) delete process.env.https_proxy; else process.env.https_proxy = previous; }
  assert.equal(fs.readFileSync(target, 'utf8'), 'direct fixture');
});

test('NO_PROXY honors an exact host and port, wildcard, and port mismatch', async t => {
  const source = await origin(t, (_request, response) => response.end('bypass fixture'));
  const tunnel = await proxy(t, source.port);
  for (const no_proxy of [`127.0.0.1:${source.port}`, '*']) {
    await downloadFile(source.url, directory(t), options({ https_proxy: 'http://127.0.0.1:1', no_proxy }));
  }
  await downloadFile(source.url, directory(t), options({ https_proxy: tunnel.url, no_proxy: '127.0.0.1:1' }));
  assert.equal(tunnel.received.length, 1, 'a different NO_PROXY port must not bypass the configured proxy');
});

test('trusted HTTPS proxies work and proxy credentials never reach the origin', async t => {
  const target = directory(t), source = await origin(t, (_request, response) => response.end('authenticated tunnel'));
  const authorization = 'Basic ' + Buffer.from('fixture-user:fixture-password').toString('base64');
  const tunnel = await proxy(t, source.port, { secure: true, authorization });
  const authenticated = tunnel.url.replace('https://', 'https://fixture-user:fixture-password@');
  await downloadFile(source.remote, target, options({ https_proxy: authenticated }));
  assert.equal(tunnel.received[0].headers['proxy-authorization'], authorization);
  assert.equal(source.received[0].headers['proxy-authorization'], undefined);
  assert.equal(source.received[0].headers.authorization, undefined);
});

test('HTTPS proxy DNS names retain SNI and trusted certificate checks', async t => {
  const source = await origin(t, (_request, response) => response.end('DNS proxy fixture'));
  const tunnel = await proxy(t, source.port, { secure: true });
  const target = directory(t);
  await downloadFile(source.remote, target, options({ https_proxy: tunnel.url.replace('127.0.0.1', 'localhost') }));
  assert.equal(fs.readFileSync(target, 'utf8'), 'DNS proxy fixture');
});

test('trusted IPv6 HTTPS proxies connect without sending an IP literal as SNI', async t => {
  const source = await origin(t, (_request, response) => response.end('IPv6 proxy fixture'));
  const ipv6 = certificate('::1');
  const tunnel = await proxy(t, source.port, { secure: true, host: '::1', tlsMaterial: ipv6 });
  const target = directory(t);
  await downloadFile(source.remote, target, options({ https_proxy: tunnel.url },
    { tls: { ca: [certificate().cert, ipv6.cert] } }));
  assert.equal(fs.readFileSync(target, 'utf8'), 'IPv6 proxy fixture');
});

test('an IPv6 HTTPS proxy with only a DNS name and a different IP SAN fails verification', async t => {
  const source = await origin(t, (_request, response) => response.end('unexpected'));
  const wrong = certificate('127.0.0.2');
  const tunnel = await proxy(t, source.port, { secure: true, host: '::1', tlsMaterial: wrong });
  const target = directory(t);
  await assert.rejects(downloadFile(source.remote, target, options({ https_proxy: tunnel.url },
    { tls: { ca: [certificate().cert, wrong.cert] } })), /ERR_TLS_CERT_ALTNAME_INVALID/);
  assert.equal(source.received.length, 0);
  assert.equal(fs.existsSync(target), false);
});

test('a trusted HTTPS proxy certificate with the wrong IP is rejected before reaching the origin', async t => {
  const source = await origin(t, (_request, response) => response.end('must not arrive'));
  const wrong = certificate('127.0.0.2');
  const tunnel = await proxy(t, source.port, { secure: true, tlsMaterial: wrong });
  const target = directory(t);
  await assert.rejects(downloadFile(source.remote, target, options({ https_proxy: tunnel.url },
    { tls: { ca: [certificate().cert, wrong.cert] } })), /ERR_TLS_CERT_ALTNAME_INVALID/);
  assert.equal(source.received.length, 0);
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.existsSync(target + '.part'), false);
});

test('redirects select a new CONNECT destination and retain origin credential isolation', async t => {
  let port;
  const source = await origin(t, (request, response) => {
    if (request.url === '/archive') { response.writeHead(302, { Location: `https://redirect.invalid:${port}/complete` }); response.end(); }
    else response.end('redirected fixture');
  });
  port = source.port;
  const tunnel = await proxy(t, source.port), target = directory(t);
  await downloadFile(source.remote, target, options({ https_proxy: tunnel.url }));
  assert.equal(fs.readFileSync(target, 'utf8'), 'redirected fixture');
  assert.deepEqual(tunnel.received.map(item => item.target), [`archive.invalid:${port}`, `redirect.invalid:${port}`]);
  assert.ok(source.received.every(item => item.headers['proxy-authorization'] === undefined));
});

test('redirect destinations re-evaluate NO_PROXY', async t => {
  let port;
  const source = await origin(t, (request, response) => {
    if (request.url === '/archive') { response.writeHead(307, { Location: `https://127.0.0.1:${port}/complete` }); response.end(); }
    else response.end('direct after redirect');
  });
  port = source.port;
  const tunnel = await proxy(t, source.port), target = directory(t);
  await downloadFile(source.remote, target, options({ https_proxy: tunnel.url, no_proxy: '127.0.0.1' }));
  assert.equal(tunnel.received.length, 1, 'the redirected loopback origin must bypass the proxy');
  assert.equal(fs.readFileSync(target, 'utf8'), 'direct after redirect');
});

test('HTTPS downgrade redirects are rejected without publishing or retaining partial data', async t => {
  const source = await origin(t, (_request, response) => {
    response.writeHead(302, { Location: 'http://archive.invalid/insecure' }); response.end();
  });
  const target = directory(t);
  await assert.rejects(downloadFile(source.url, target, options()), /HTTPS|redirect|protocol/i);
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.existsSync(target + '.part'), false);
});

test('untrusted server certificates fail verification', async t => {
  const target = directory(t), source = await origin(t, (_request, response) => response.end('untrusted fixture'));
  await assert.rejects(downloadFile(source.url, target, { environment: {}, timeoutMs: 3000, log() {} }));
  await assert.rejects(downloadFile(source.url, target, {
    environment: {}, tls: { rejectUnauthorized: false }, timeoutMs: 3000, log() {},
  }), 'test injection must not allow production certificate validation to be disabled');
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.existsSync(target + '.part'), false);
});

test('redirect loops are bounded', async t => {
  const source = await origin(t, (_request, response) => { response.writeHead(302, { Location: '/archive' }); response.end(); });
  await assert.rejects(downloadFile(source.url, directory(t), options()), /redirect/i);
  assert.ok(source.received.length <= 8);
});

test('the total deadline ends a continuously active response and cleans partial data', async t => {
  const source = await origin(t, (_request, response) => {
    response.writeHead(200); response.flushHeaders();
    const timer = setInterval(() => response.write('fixture-data'), 5);
    response.once('close', () => clearInterval(timer));
  });
  const target = directory(t);
  await assert.rejects(downloadFile(source.url, target, options({}, { timeoutMs: 200, idleTimeoutMs: 1000 })), /total|deadline|time limit/i);
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.existsSync(target + '.part'), false);
});

test('a known-size archive can finish beyond the original deadline with sustained progress', async t => {
  const chunk = Buffer.alloc(32 * 1024, 0x53);
  const chunks = 10;
  const source = await origin(t, (_request, response) => {
    let sent = 1;
    response.write(chunk);
    const timer = setInterval(() => {
      if (++sent === chunks) response.end(chunk);
      else response.write(chunk);
    }, 80);
    response.once('close', () => clearInterval(timer));
  });
  const target = directory(t);
  await downloadFile(source.url, target, options({}, {
    resume: true, expectedBytes: chunk.length * chunks, timeoutMs: 400, idleTimeoutMs: 2000,
  }));
  assert.deepEqual(fs.readFileSync(target), Buffer.alloc(chunk.length * chunks, 0x53));
});

test('a resumed prefix and small trickles do not renew the progress deadline', async t => {
  const target = directory(t);
  const prefix = Buffer.alloc(64 * 1024 - 1);
  fs.writeFileSync(target + '.part', prefix);
  const expectedBytes = prefix.length + 3;
  const source = await origin(t, (_request, response) => {
    response.writeHead(206, { 'Content-Range': `bytes ${prefix.length}-${expectedBytes - 1}/${expectedBytes}` });
    let sent = 0;
    const timer = setInterval(() => {
      if (++sent === 3) response.end('x');
      else response.write('x');
    }, 240);
    response.once('close', () => clearInterval(timer));
  });
  await assert.rejects(downloadFile(source.url, target, options({}, {
    resume: true, expectedBytes, timeoutMs: 600, idleTimeoutMs: 1500,
  })), /time limit|deadline|progress.*timeout/i);
  assert.equal(fs.existsSync(target), false);
  const retained = fs.statSync(target + '.part').size;
  assert.ok(retained > prefix.length && retained < expectedBytes);
});

test('redirects share one total deadline', async t => {
  const source = await origin(t, (_request, response) => {
    const timer = setTimeout(() => { response.writeHead(302, { Location: '/archive' }); response.end(); }, 80);
    response.once('close', () => clearTimeout(timer));
  });
  const target = directory(t);
  await assert.rejects(downloadFile(source.url, target, options({}, { timeoutMs: 200 })), /total|deadline|time limit/i);
  assert.equal(fs.existsSync(target + '.part'), false);
});

test('a response with no body progress hits the idle timeout', async t => {
  const source = await origin(t, (_request, response) => { response.writeHead(200); response.flushHeaders(); });
  const started = Date.now();
  await assert.rejects(downloadFile(source.url, directory(t), options({}, { idleTimeoutMs: 80, timeoutMs: 3000 })), /timeout|timed out/i);
  assert.ok(Date.now() - started < 2500, 'idle response should fail before the overall deadline');
});

test('Range resume appends a matching 206 response', async t => {
  const content = 'complete fixture', prefix = content.slice(0, 5), target = directory(t);
  fs.writeFileSync(target + '.part', prefix);
  const source = await origin(t, (_request, response) => {
    response.writeHead(206, { 'Content-Range': `bytes ${prefix.length}-${content.length - 1}/${content.length}` });
    response.end(content.slice(prefix.length));
  });
  await downloadFile(source.url, target, options({}, { resume: true }));
  assert.equal(source.received[0].headers.range, `bytes=${prefix.length}-`);
  assert.equal(fs.readFileSync(target, 'utf8'), content);
  assert.equal(fs.existsSync(target + '.part'), false);
});

test('a server ignoring Range with 200 replaces the old partial instead of appending', async t => {
  const target = directory(t); fs.writeFileSync(target + '.part', 'stale prefix');
  const source = await origin(t, (_request, response) => response.end('fresh complete fixture'));
  await downloadFile(source.url, target, options({}, { resume: true }));
  assert.equal(fs.readFileSync(target, 'utf8'), 'fresh complete fixture');
});

test('a complete partial is published after a matching 416 total', async t => {
  const target = directory(t), content = 'already complete'; fs.writeFileSync(target + '.part', content);
  const source = await origin(t, (_request, response) => { response.writeHead(416, { 'Content-Range': `bytes */${content.length}` }); response.end(); });
  await downloadFile(source.url, target, options({}, { resume: true }));
  assert.equal(fs.readFileSync(target, 'utf8'), content);
});

test('a 416 matching the partial cannot publish it at the wrong pinned size', async t => {
  const target = directory(t);
  fs.writeFileSync(target + '.part', 'part');
  const source = await origin(t, (_request, response) => {
    response.writeHead(416, { 'Content-Range': 'bytes */4' });
    response.end();
  });
  await assert.rejects(downloadFile(source.url, target, options({}, { resume: true, expectedBytes: 8 })));
  assert.equal(fs.existsSync(target), false);
});

test('a short complete response retains its bytes and the next request resumes from them', async t => {
  const target = directory(t);
  const source = await origin(t, (request, response) => {
    if (request.headers.range) {
      response.writeHead(206, { 'Content-Range': 'bytes 3-5/6' });
      response.end('def');
    } else {
      response.write('abc');
      response.end();
    }
  });
  const settings = options({}, { resume: true, expectedBytes: 6 });
  await assert.rejects(downloadFile(source.url, target, settings));
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.readFileSync(target + '.part', 'utf8'), 'abc');
  await downloadFile(source.url, target, settings);
  assert.equal(source.received[1].headers.range, 'bytes=3-');
  assert.equal(fs.readFileSync(target, 'utf8'), 'abcdef');
});

test('an oversized body removes the corrupt partial even when resume is enabled', async t => {
  const target = directory(t);
  const source = await origin(t, (_request, response) => {
    response.write('abc');
    response.end('def');
  });
  await assert.rejects(downloadFile(source.url, target, options({}, { resume: true, expectedBytes: 5 })));
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.existsSync(target + '.part'), false);
});

test('a mismatched 416 total discards the partial and retries from zero', async t => {
  const target = directory(t); fs.writeFileSync(target + '.part', 'old');
  const source = await origin(t, (request, response) => {
    if (request.headers.range) { response.writeHead(416, { 'Content-Range': 'bytes */999' }); response.end(); }
    else response.end('complete after total reset');
  });
  await downloadFile(source.url, target, options({}, { resume: true }));
  assert.equal(source.received.length, 2);
  assert.equal(source.received[1].headers.range, undefined);
  assert.equal(fs.readFileSync(target, 'utf8'), 'complete after total reset');
});

test('an invalid 206 offset restarts the request without Range', async t => {
  const target = directory(t); fs.writeFileSync(target + '.part', 'old');
  const source = await origin(t, (request, response) => {
    if (request.headers.range) { response.writeHead(206, { 'Content-Range': 'bytes 1-3/4' }); response.end('bad'); }
    else response.end('complete after range reset');
  });
  await downloadFile(source.url, target, options({}, { resume: true }));
  assert.equal(source.received.length, 2);
  assert.equal(source.received[1].headers.range, undefined);
  assert.equal(fs.readFileSync(target, 'utf8'), 'complete after range reset');
});

test('interrupted resumable transfers retain the partial while ordinary transfers remove it', async t => {
  const source = await origin(t, (_request, response) => {
    response.writeHead(200, { 'Content-Length': 1000 }); response.write('partial fixture');
    const timer = setTimeout(() => response.destroy(), 30); response.once('close', () => clearTimeout(timer));
  });
  for (const resume of [true, false]) {
    const target = directory(t);
    await assert.rejects(downloadFile(source.url, target, options({}, { resume })));
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.existsSync(target + '.part'), resume);
    if (resume) assert.equal(fs.readFileSync(target + '.part', 'utf8'), 'partial fixture');
  }
});

test('download labels and errors omit URL credentials and query secrets', () => {
  const url = 'https://fixture-user:fixture-password@mirror.invalid/archive?token=fixture-token#fixture-fragment';
  assert.equal(downloadLabel(url), 'https://mirror.invalid/archive');
  const error = Object.assign(new Error('Cannot connect to ' + url), { code: 'ECONNREFUSED' });
  const label = errorLabel(error);
  assert.doesNotMatch(label, /fixture-user|fixture-password|fixture-token|fixture-fragment|token=/);
});
