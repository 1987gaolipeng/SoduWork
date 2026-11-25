'use strict';

// Build-time transport. Each download owns its proxy dispatcher; no runtime
// model requests or global HTTP agents inherit this policy.
const fs = require('node:fs');
const { isIP } = require('node:net');
const { pipeline } = require('node:stream/promises');

class DownloadError extends Error {}

function downloadLabel(value) {
  try {
    const url = new URL(value);
    return url.origin + url.pathname;
  } catch { return '[download URL]'; }
}

function errorLabel(error) {
  if (error instanceof DownloadError) return error.message;
  const code = error?.cause?.code || error?.code;
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) return code;
  return 'network or TLS connection failed';
}

function proxyOptions(environment) {
  const options = {
    httpProxy: environment.http_proxy ?? environment.HTTP_PROXY ?? '',
    httpsProxy: environment.https_proxy ?? environment.HTTPS_PROXY ?? '',
    noProxy: environment.no_proxy ?? environment.NO_PROXY ?? '',
  };
  for (const value of [options.httpProxy, options.httpsProxy]) {
    if (!value) continue;
    let parsed;
    try { parsed = new URL(value); } catch { throw new DownloadError('Invalid HTTP(S) download proxy'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new DownloadError('Download proxy must use HTTP or HTTPS');
  }
  return options;
}

function checkedUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new DownloadError('Invalid runtime download URL'); }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new DownloadError('Runtime downloads and redirects must use HTTPS without URL credentials');
  }
  return url.href;
}

async function downloadFile(url, target, { environment = process.env, timeoutMs = 300000,
  idleTimeoutMs = 60000, expectedBytes, resume = false, log = console.error, tls = {} } = {}) {
  // CA injection is used by isolated TLS tests and managed certificate stores.
  // It never allows a caller to disable peer or hostname verification.
  if (Object.keys(tls).some(key => key !== 'ca')) throw new DownloadError('Only a trusted CA may configure download TLS');
  const { EnvHttpProxyAgent, Client, request } = require('undici');
  const certificate = {
    ...(tls.ca ? { ca: tls.ca } : {}),
    checkServerIdentity(host, cert) {
      const tlsCheck = require('node:tls').checkServerIdentity;
      if (isIP(host) !== 6) return tlsCheck(host, cert);
      // Node releases that apply IDNA to an IPv6 literal lose the comparison
      // name. OpenSSL checks the binary IP SAN directly, independently of SNI.
      if (new (require('node:crypto').X509Certificate)(cert.raw).checkIP(host)) return undefined;
      return Object.assign(Error('Certificate does not match the destination IPv6 address'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
    },
  };
  const dispatcher = new EnvHttpProxyAgent({ ...proxyOptions(environment),
    connect: certificate, requestTls: certificate, proxyTls: certificate,
    clientFactory: (origin, options) => new Client(origin, { ...options,
      connect: (target, callback) => {
        // SNI carries DNS names, never IP literals. Retain Undici's connector,
        // destination hostname and certificate verification for IP proxies.
        const name = typeof target.servername === 'string' ? target.servername.replace(/^\[|\]$/g, '') : '';
        const servername = name && isIP(name)
          ? undefined : target.servername;
        return options.connect({ ...target, servername }, callback);
      } }),
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DownloadError('Runtime download exceeded total time limit')), timeoutMs);
  const partial = target + '.part';
  let body;
  let discardPartial = !resume;
  try {
    let current = checkedUrl(url), redirects = 0, resets = 0;
    if (!resume) fs.rmSync(partial, { force: true });
    for (;;) {
      const offset = resume && fs.existsSync(partial) ? fs.statSync(partial).size : 0;
      const headers = { 'user-agent': 'SoduWork-runtime-build' };
      if (offset) headers.range = 'bytes=' + offset + '-';
      const response = await request(current, { dispatcher, method: 'GET', headers,
        maxRedirections: 0, signal: controller.signal,
        headersTimeout: idleTimeoutMs, bodyTimeout: idleTimeoutMs });
      body = response.body;
      // Discarded redirect/range bodies emit UND_ERR_ABORTED when destroyed.
      // Transfers still propagate errors through pipeline below.
      body.on('error', () => {});
      const status = response.statusCode;
      if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
        body.destroy(); body = null;
        if (++redirects > 6) throw new DownloadError('Too many runtime download redirects');
        current = checkedUrl(new URL(response.headers.location, current).href);
        continue;
      }
      const range = String(response.headers['content-range'] || '');
      if (status === 416 && offset) {
        body.destroy(); body = null;
        const total = range.match(/^bytes \*\/(\d+)$/);
        if (total && Number(total[1]) === offset && (expectedBytes === undefined || offset === expectedBytes)) {
          fs.renameSync(partial, target);
          return target;
        }
        fs.rmSync(partial, { force: true });
        if (++resets > 1) throw new DownloadError('Invalid runtime download byte range');
        continue;
      }
      if (status !== 200 && status !== 206) throw new DownloadError('Runtime download failed: HTTP ' + status);
      const interval = range.match(/^bytes (\d+)-(\d+)\/(\d+|\*)$/);
      if (status === 206 && (!offset || !interval || Number(interval[1]) !== offset ||
          Number(interval[2]) < offset || (interval[3] !== '*' && Number(interval[2]) >= Number(interval[3])))) {
        body.destroy(); body = null;
        fs.rmSync(partial, { force: true });
        if (++resets > 1) throw new DownloadError('Invalid runtime download byte range');
        continue;
      }
      let bytes = status === 206 ? offset : 0, lastProgress = Date.now();
      let checkpoint = bytes;
      body.on('data', chunk => {
        bytes += chunk.length;
        if (expectedBytes !== undefined) {
          if (bytes > expectedBytes) {
            discardPartial = true;
            controller.abort(new DownloadError('Runtime download exceeds the expected archive size'));
            return;
          }
          // Only a pinned, finite payload can earn more time, in 64 KiB steps.
          // Redirects, cached prefixes and tiny keepalive writes earn no extension.
          if (bytes - checkpoint >= 64 * 1024) {
            timer.refresh();
            checkpoint = bytes;
          }
        }
        if (Date.now() - lastProgress >= 30000) {
          log(`[runtime-download] ${downloadLabel(current)}: ${bytes} bytes received`);
          lastProgress = Date.now();
        }
      });
      await pipeline(body, fs.createWriteStream(partial, { flags: status === 206 ? 'a' : 'w' }),
        { signal: controller.signal });
      body = null;
      if (expectedBytes !== undefined && bytes !== expectedBytes) {
        throw new DownloadError('Runtime download ended before the expected archive size');
      }
      fs.renameSync(partial, target);
      return target;
    }
  } catch (error) {
    if (discardPartial) fs.rmSync(partial, { force: true });
    if (controller.signal.aborted) throw controller.signal.reason;
    if (error instanceof DownloadError) throw error;
    // Proxy and TLS libraries may include credential-bearing URLs in errors.
    throw new DownloadError('Runtime download failed: ' + errorLabel(error));
  } finally {
    clearTimeout(timer);
    body?.destroy();
    await dispatcher.destroy();
  }
}

module.exports = { downloadFile, downloadLabel, errorLabel };
