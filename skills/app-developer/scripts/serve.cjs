'use strict';
// Explicit local preview only; never invoked on installation.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
function serve(root, port = 8098) {
  const directory = fs.realpathSync(path.resolve(root));
  const server = http.createServer((request, response) => {
    try {
      const name = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      const file = fs.realpathSync(path.resolve(directory, '.' + (name === '/' ? '/index.html' : name)));
      const relative = path.relative(directory, file);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !fs.statSync(file).isFile()) throw Error('missing');
      response.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream');
      response.setHeader('Cache-Control', 'no-store');
      response.end(fs.readFileSync(file));
    } catch (_) { response.writeHead(404); response.end('Not found'); }
  });
  return server.listen(port, '127.0.0.1');
}
if (require.main === module) {
  try {
    const args = process.argv.slice(2), options = {};
    for (let i = 0; i < args.length; i += 2) {
      if (!['--root', '--port'].includes(args[i]) || !args[i + 1]) throw Error('用法：--root 页面目录 --port 8098');
      options[args[i].slice(2)] = args[i + 1];
    }
    const port = options.port ? Number(options.port) : 8098;
    if (!options.root || !Number.isInteger(port) || port < 1 || port > 65535) throw Error('页面目录或端口无效');
    const server = serve(options.root, port);
    server.once('listening', () => console.log('Local preview: http://127.0.0.1:' + server.address().port + '/'));
    server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { serve };
