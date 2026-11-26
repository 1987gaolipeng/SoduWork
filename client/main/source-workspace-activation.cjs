'use strict';

const crypto = require('node:crypto');
const dgram = require('node:dgram');
const fs = require('node:fs');
const path = require('node:path');

// Only the desktop owning this source profile can confirm that it opened the workspace.
function listen(app, openWorkspace) {
  const endpoint = path.join(app.getPath('userData'), 'source-workspace-activation.json');
  const token = crypto.randomBytes(32).toString('hex');
  const request = Buffer.from('open-workspace ' + token);
  const socket = dgram.createSocket('udp4');
  let published = false;
  let stopped = false;

  function stop() {
    if (stopped) return;
    stopped = true;
    app.removeListener('before-quit', stop);
    if (published) {
      try {
        if (JSON.parse(fs.readFileSync(endpoint, 'utf8')).token === token) fs.unlinkSync(endpoint);
      } catch { /* A missing or replaced descriptor no longer belongs to this session. */ }
    }
    socket.close();
  }

  socket.on('error', error => {
    console.warn('[source-launcher] Workspace activation unavailable:', error.message);
    stop();
  });
  socket.on('message', (packet, peer) => {
    if (stopped || !published || peer.address !== '127.0.0.1' || !packet.equals(request)) return;
    try {
      if (openWorkspace()) socket.send('opened', peer.port, peer.address);
    } catch (error) {
      console.warn('[source-launcher] Could not reopen workspace:', error.message);
    }
  });
  app.once('before-quit', stop);
  socket.bind({ address: '127.0.0.1', port: 0, exclusive: true }, () => {
    if (stopped) return;
    const temporary = endpoint + '.' + crypto.randomUUID() + '.tmp.json';
    try {
      const contents = JSON.stringify({ port: socket.address().port, token });
      const options = { flag: 'wx', mode: 0o600 };
      fs.writeFileSync(temporary, contents, options);
      try {
        fs.renameSync(temporary, endpoint);
      } catch (error) {
        if (error.code !== 'EXDEV') throw error;
        // Managed Windows volumes may refuse even same-directory renames.
        // Unlink the stale entry and create exclusively so we never write through a link.
        fs.rmSync(endpoint, { force: true });
        fs.writeFileSync(endpoint, contents, options);
      }
      published = true;
    } catch (error) {
      console.warn('[source-launcher] Could not publish workspace activation:', error.message);
      stop();
    } finally {
      try { fs.unlinkSync(temporary); } catch { /* Renamed or never created. */ }
    }
  });
}

module.exports = { listen };
