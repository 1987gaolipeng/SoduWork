'use strict';

// AgentSession.abort stops the model/tool loop and retries, but its idle wait
// also includes a native summary with a separate AbortController. Cancel that
// request first, otherwise steering can wait for the entire summary response.
function interrupt(session, turnCompletion) {
  let active = true;
  const stopSummaries = () => {
    session.abortCompaction?.();
    session.abortBranchSummary?.();
  };
  // Observe compaction for the whole interruption, including preflight and
  // authentication. SDK 1.4 creates the controller before compaction_start.
  const unsubscribe = session.subscribe?.(event => {
    if (event.type === 'compaction_start') queueMicrotask(() => { if (active) stopSummaries(); });
  });
  const release = () => { active = false; unsubscribe?.(); };
  try {
    stopSummaries();
    const aborted = Promise.resolve(session.abort());
    // Keep watching until this original submission has settled, then retire
    // the listener before the next queued turn can begin.
    const lifetime = turnCompletion ? Promise.allSettled([aborted, turnCompletion]) : aborted;
    lifetime.then(release, release);
    return aborted;
  } catch (error) { release(); throw error; }
}
module.exports = { interrupt };
