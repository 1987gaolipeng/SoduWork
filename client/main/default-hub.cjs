'use strict';

const DEFAULT_HUB_URL = 'https://service.soduwork.ai';

function normalizeDefaultHub(value) {
  // This value becomes public package metadata. Never accept credentials or
  // silently strip a path/query that the operator expected the client to use.
  const message = 'Default Hub must be an http(s) origin without credentials, path, query or fragment';
  if (typeof value !== 'string' || !/^https?:\/\/[^/?#\\\s@]+\/?$/.test(value)) throw new Error(message);
  let url;
  try { url = new URL(value); } catch (_) { throw new Error(message); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) throw new Error(message);
  return url.origin;
}

function bundledDefaultHub(metadata = require('../package.json')) {
  return normalizeDefaultHub(metadata.soduworkDefaultHubUrl === undefined
    ? DEFAULT_HUB_URL : metadata.soduworkDefaultHubUrl);
}

// Only build tools read this variable. Installed clients read bundled metadata.
function buildDefaultHub(env = process.env) {
  const value = env.SODUWORK_DEFAULT_HUB_URL;
  return normalizeDefaultHub(value === undefined || value === '' ? DEFAULT_HUB_URL : value);
}

module.exports = { DEFAULT_HUB_URL, normalizeDefaultHub, bundledDefaultHub, buildDefaultHub };
