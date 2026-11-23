'use strict';

const { buildDefaultHub } = require('../main/default-hub.cjs');
const base = require('../package.json').build;

// Keep installer identity, filenames, signing hooks and output paths identical.
// electron-builder writes extraMetadata inside app.asar before code signing.
module.exports = {
  ...base,
  extraMetadata: { ...base.extraMetadata, soduworkDefaultHubUrl: buildDefaultHub() },
};
