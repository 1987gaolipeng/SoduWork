'use strict';
// Preserve lifecycle order, but retain at most one unsent download-progress
// snapshot. Slow telemetry must not build minutes of work behind the download.
function createReportQueue(send) {
  let tail = Promise.resolve(null), progress = null;
  return (state, percent = 0, extra = {}) => {
    if (state === 'downloading' && progress) {
      progress.percent = percent; progress.extra = extra;
      return progress.promise;
    }
    const entry = { state, percent, extra };
    entry.promise = tail.catch(() => null).then(() => {
      if (progress === entry) progress = null;
      return send(entry.state, entry.percent, entry.extra);
    });
    tail = entry.promise;
    // A lifecycle boundary seals earlier progress. A later attempt must not
    // overwrite a snapshot that logically preceded downloaded/failed/installed.
    progress = state === 'downloading' ? entry : null;
    return entry.promise;
  };
}
module.exports = { createReportQueue };
