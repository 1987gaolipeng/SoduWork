'use strict';

// Keep the desktop picker and the Hub package parser on the same boundary.
// The Hub currently accepts packages up to 10 MB (compressed size).
const MAX_PACKAGE_BYTES = 10 * 1024 * 1024;

module.exports = {
  MAX_PACKAGE_BYTES,
  MAX_PACKAGE_LABEL: '10MB',
};
