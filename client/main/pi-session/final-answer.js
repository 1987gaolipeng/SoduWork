'use strict';

const stream = require('./event-stream');
const sessionHelpers = require('./session-helpers');
const goalFinalizer = require('../conversation/goal-finalizer');

async function runOnce(value, retry) {
  let finalSession = null;
  let unsubscribe = null;
  try {
    const sdk = value.sdk;
    if (!sdk || !sdk.SessionManager || typeof sdk.SessionManager.inMemory !== 'function') {
      throw new Error('in-memory finalizer session is unavailable');
    }
    const resources = await value.resourceFactory([goalFinalizer.systemPrompt()]);
    const created = await sdk.createAgentSession({
      model: value.model,
      modelRuntime: value.runtime,
      cwd: value.cwd,
      agentDir: value.agentDir,
      settingsManager: resources.settingsManager,
      resourceLoader: resources.resourceLoader,
      sessionManager: sdk.SessionManager.inMemory(),
      tools: [],
      thinkingLevel: 'low',
    });
    finalSession = created.session;
    const accumulator = stream.create();
    unsubscribe = finalSession.subscribe((event) => {
      try { accumulator.push(event); } catch (error) { /* isolated presenter */ }
    });
    await finalSession.prompt(goalFinalizer.prompt(
      value.goal,
      value.reviewed,
      value.evidence,
      value.outputSnapshot,
      retry,
    ), { images: [] });
    return sessionHelpers.lastAssistantText(accumulator.snapshot());
  } finally {
    try { if (typeof unsubscribe === 'function') unsubscribe(); } catch (error) { /* ignore */ }
    try {
      if (finalSession && typeof finalSession.dispose === 'function') {
        await Promise.resolve(finalSession.dispose());
      }
    } catch (error) { /* isolated presenter cleanup */ }
  }
}

async function compose(options) {
  const value = options || {};
  const outputs = goalFinalizer.outputItems(value.outputSnapshot);
  const status = value.reviewed && value.reviewed.phase === 'reviewed' ? 'completed' : 'blocked';
  const facts = goalFinalizer.context(
    value.goal, value.reviewed, value.evidence, value.outputSnapshot);
  const rejected = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const raw = await runOnce(value, attempt > 0);
      const structured = goalFinalizer.normalize(raw, outputs);
      const gate = goalFinalizer.qualityGate(raw, structured, status, facts);
      if (gate.ok) {
        return {
          structured,
          rendered: goalFinalizer.render(structured),
          source: attempt ? 'model-retry' : 'model',
          attempts: attempt + 1,
          rejected,
        };
      }
      rejected.push(...gate.reasons);
    } catch (error) {
      rejected.push(String(error && error.message || error));
    }
  }
  const structured = goalFinalizer.fallback(
    value.goal, value.reviewed, value.evidence, value.outputSnapshot);
  return {
    structured,
    rendered: goalFinalizer.render(structured),
    source: 'deterministic-fallback',
    attempts: 2,
    rejected: [...new Set(rejected)].slice(0, 8),
  };
}

module.exports = { compose, _runOnce: runOnce };
