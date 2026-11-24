'use strict';

const { createHash } = require('node:crypto');
const { accountId } = require('../device-auth-request');
const { OPAQUE_REFERENCE } = require('./local-model-runtime-privacy.cjs');

// Device model names and service addresses stay in the device catalog.
function capture(runtimeModel, prepared, identity) {
  if (!prepared || prepared.historical || runtimeModel?.provider !== 'soduwork' ||
      runtimeModel.id !== prepared.id) return null;
  const local = prepared.localOnly === true;
  const model = local ? prepared.modelRef : prepared.id;
  const provider = local ? '' : prepared.quotaProvider;
  const identifier = /^[\p{L}\p{N}][\p{L}\p{N}._:/-]{0,159}$/u;
  const publicId = value => typeof value === 'string' && identifier.test(value) &&
    !/\/\/|\b(?:\d{1,3}\.){3}\d{1,3}\b|^(?:sk-|gh[pousr]_|AKIA)[a-z\d_-]{10,}/i.test(value);
  if (local && !OPAQUE_REFERENCE.test(model)) return null;
  const user = accountId(identity);
  const scope = user && identity?.hub && identity.clientId ? createHash('sha256')
    .update(JSON.stringify([identity.hub.replace(/\/+$/, ''), identity.clientId, user])).digest('hex') : '';
  return { local, model: local || publicId(model) ? model : '', provider: publicId(provider) ? provider : '', scope,
    revision: /^[a-f0-9]{64}$/.test(prepared.configRevision) ? prepared.configRevision : '' };
}
module.exports = { capture };
