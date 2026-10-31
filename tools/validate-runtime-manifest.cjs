#!/usr/bin/env node
'use strict';

// Repository entry point for the same contract enforced by the packaged client.
const fs = require('node:fs');
const path = require('node:path');
const { validateRuntimeManifest } = require('../client/main/runtime-manifest.cjs');

function validateFile(file = path.resolve(__dirname, '../client/runtime-manifest.json')) {
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  const errors = validateRuntimeManifest(manifest);
  if (errors.length) throw new Error(errors.join('; '));
  return manifest;
}

if (require.main === module) {
  try {
    const file = process.argv[2] || path.resolve(__dirname, '../client/runtime-manifest.json');
    validateFile(file);
    console.log(`OK ${path.resolve(file)}`);
  } catch (error) {
    console.error(`runtime manifest: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { validateFile, validateRuntimeManifest };
