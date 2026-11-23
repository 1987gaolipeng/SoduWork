'use strict';

const crypto = require('node:crypto');
const titles = require('./titles');
const { visibleTitleText } = require('../pi-session/session-helpers');
const { fetchModel } = require('../pi-session/model-config');
const { runtime } = require('../agent-runtime/runtime-catalog');
const { create: createGenerator } = require('../app-ai-generate.cjs');

function create({ app, identityOf, authorizeAI, isCurrent, resolveModel = fetchModel, fetchImpl = global.fetch }) {
  const drafts = new WeakSet(), generators = new Map();
  function generator(agent) {
    if (!generators.has(agent)) generators.set(agent, createGenerator({
      app, authenticatedIdentityOf: identityOf, authorizeAI, fetchImpl,
      async resolveModel(identity, name, timeout, fetch, force, _defaultAgent, options) {
        const result = await resolveModel(identity, name, timeout, fetch, force, agent, options);
        return result?.model?.id === name ? result : null;
      },
    }));
    return generators.get(agent);
  }

  // Capture the model chosen for this submission before submit() can yield to
  // a model change. Only a newly opened, unnamed interactive chat is enrolled.
  function prepare(handle, text) {
    if (!drafts.has(handle) || typeof text !== 'string') return null;
    try {
      const visible = visibleTitleText(text).replace(/\s+/g, ' ').trim();
      const input = visible.match(/^.{41,512}/u)?.[0];
      if (!input) return null;
      const agent = handle.adapterId || 'pi';
      if (runtime(agent)?.modelMode !== 'managed' || titles.read(app, handle.sessionId)) return null;
      const snapshot = handle.snapshot();
      if (snapshot.messages?.some(message => message.role === 'user')) return null;
      const selected = snapshot.modelSelection?.model;
      if (!selected?.id || selected.unavailable || ['image', 'video'].includes(selected.modality)) return null;
      return { input, agent, model: selected.id };
    } catch (_) { return null; } // Optional naming must never prevent sending the message.
  }

  async function accepted(handle, request) {
    if (!drafts.delete(handle) || !request) return;
    const id = handle.sessionId;
    function assertCurrent() {
      if (!isCurrent(handle) || handle.taskRef || handle.taskIds?.length || titles.read(app, id))
        throw Error('Conversation title is no longer pending');
    }
    try {
      assertCurrent();
      const result = await generator(request.agent)({ appBridge: { appId: 'conversation-title' } }, {
        requestId: crypto.randomUUID(), model: request.model, input: request.input,
        instructions: 'Write a single plain-text title for this request in the user’s language, at most 36 characters. Preserve issue numbers. Do not answer the request.',
        // Some gateways charge hidden reasoning against the completion limit,
        // even when the catalog reports a non-reasoning model.
        maxOutputTokens: 512, timeoutMs: 30000,
      }, assertCurrent);
      if (!result.ok || result.finishReason === 'length') return;
      const title = result.text.trim();
      if (!title || /[\x00-\x1f\x7f]/.test(title) || Array.from(title).length > 36) return;
      assertCurrent();
      if (titles.save(app, id, title, { automatic: true })) handle.applyGeneratedTitle(title);
    } catch (_) { /* Keep the existing preview if generation or persistence fails. */ }
  }
  return { enroll: handle => drafts.add(handle), prepare, accepted };
}

module.exports = { create };
