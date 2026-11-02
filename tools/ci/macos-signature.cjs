'use strict';

async function verifySignature({ app, execute }) {
  await execute('codesign', ['--verify', '--deep', '--strict', app]);
  return { verified: true, policy: 'strict' };
}

module.exports = { verifySignature };
