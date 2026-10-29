'use strict';

// Retry only the same authenticated, signed artifact endpoint. A failing node
// must never send the updater to a different installer or an unsigned fallback.
async function requestArtifact(request, wait, relative, offset = 0) {
  for (let attempt = 0; ; attempt++) {
    const response = await request(relative, offset
      ? { headers: { Range: `bytes=${offset}-` } } : {}, 30000, async res => {
      if (res.ok && res.body) return { res };
      let detail = '';
      try {
        const data = JSON.parse(await res.text());
        if (typeof data.detail === 'string') detail = data.detail.slice(0, 600);
      } catch (_) { /* a proxy can return a non-JSON error page */ }
      return { res, error: new Error('安装包下载失败 HTTP ' + res.status + (detail ? '：' + detail : '')) };
    });
    if (!response.error) return response.res;
    if (attempt >= 2 || ![502, 503, 504].includes(response.res.status)) throw response.error;
    await wait(1000 * (attempt + 1));
  }
}

module.exports = { requestArtifact };
