"use strict";

const crypto = require('node:crypto');
const updateTrust = require('../update-trust.json');
const packageInfo = require('../package.json');
const { PRODUCTION_HUB } = require('./hub-endpoint.cjs');
const PROFILE_ID = 'self-hosted';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}
function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function getProfile(id = 'internal') {
  if (typeof id !== 'string' || !Object.hasOwn(profiles, id)) {
    throw new Error('Unknown Client distribution: ' + String(id));
  }
  const profile = JSON.parse(JSON.stringify({ distributionId: id, ...profiles[id],
    updateTrust: id === 'internal' || id === 'stage' ? internalTrust : profiles[id].updateTrust }));
  const { keys, schema } = profile.updateTrust || {};
  if (schema !== 1 || !keys || !Object.keys(keys).length || Object.values(keys).some(value =>
    typeof value !== 'string' || Buffer.from(value, 'base64').length !== 32)) {
    throw new Error('Client distribution has invalid update trust: ' + id);
  }
  // The stage profile points the bundled origin at the stage Hub while
  // keeping the internal install identity and signing trust, so testers
  // install exactly the product they are accepting.
  return freeze({ ...profile, configSha256: digest(profile) });
}

// Build variables select registered public configuration; credentials and private keys never enter client metadata.
function selected(env = process.env) {
  const profile = getProfile(env.SODUWORK_DISTRIBUTION || 'internal');
  if (env.SODUWORK_RELEASE_HUB_URL && String(env.SODUWORK_RELEASE_HUB_URL).replace(/\/+$/, '') !== profile.hubOrigin) {
    throw new Error('Release Hub URL does not match Client distribution: ' + profile.distributionId);
  }
  return profile;
}

function fromMetadata(metadata) {
  const profile = getProfile();
  if (metadata === undefined) return profile;
  if (!metadata || typeof metadata !== 'object' || digest(metadata) !== digest(profile)) {
    throw new Error('Bundled Client distribution differs from its registered configuration');
  }
  return profile;
}

// Installed clients read bundled metadata only; runtime environment variables and saved addresses cannot change the distribution environment.
function current() { return fromMetadata(packageInfo.soduworkDistribution); }
function publicInfo() {
  const { distributionId, hubOrigin, websiteUrl, productName, configSha256 } = current();
  return { distributionId, hubOrigin, websiteUrl, productName, configSha256 };
}

module.exports = { getProfile, selected, current, fromMetadata, publicInfo, digest };
