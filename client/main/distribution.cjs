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
function getProfile(id = PROFILE_ID) {
  if (id !== PROFILE_ID) throw new Error('Unknown Client distribution: ' + String(id));
  const { schema, keys } = updateTrust || {};
  if (schema !== 1 || !keys || typeof keys !== 'object' || Array.isArray(keys) ||
      Object.values(keys).some(value => typeof value !== 'string' ||
        Buffer.from(value, 'base64').length !== 32 || Buffer.from(value, 'base64').toString('base64') !== value)) {
    throw new Error('Client distribution has invalid update trust');
  }
  const build = packageInfo.build || {};
  const productName = packageInfo.productName || build.productName || 'SoduWork';
  const profile = JSON.parse(JSON.stringify({
    distributionId: PROFILE_ID, hubOrigin: PRODUCTION_HUB, websiteUrl: packageInfo.homepage || '',
    appId: build.appId || 'com.soduwork.app', productName,
    windowsExecutableName: build.win?.executableName || productName,
    linuxExecutableName: build.linux?.executableName || packageInfo.name,
    linuxPackageName: build.deb?.packageName || packageInfo.name,
    nsisGuid: build.nsis?.guid || '', userDataName: productName, workspaceName: productName, updateTrust,
  }));
  // Empty trust is valid for source builds and cannot authorize an update manifest.
  return freeze({ ...profile, configSha256: digest(profile) });
}

function selected(env = process.env) {
  const profile = getProfile(env.SODUWORK_DISTRIBUTION || PROFILE_ID);
  if (env.SODUWORK_RELEASE_HUB_URL && String(env.SODUWORK_RELEASE_HUB_URL).replace(/\/+$/, '') !== profile.hubOrigin) {
    throw new Error('Release Hub URL does not match Client distribution');
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

// Package identity and update trust are fixed; hub-endpoint owns editable service selection.
function current() { return fromMetadata(packageInfo.soduworkDistribution); }
function publicInfo() {
  const { distributionId, hubOrigin, websiteUrl, productName, configSha256 } = current();
  return { distributionId, hubOrigin, websiteUrl, productName, configSha256 };
}

module.exports = { getProfile, selected, current, fromMetadata, publicInfo, digest };
