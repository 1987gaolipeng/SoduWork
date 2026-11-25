'use strict';

function missingArchive(reply, ref) {
  return reply?.ok === true && reply.data?.ok === false && reply.data.ref === ref &&
    reply.data.code === 'NATIVE_HISTORY_MISSING' && Array.isArray(reply.data.items) && !reply.data.items.length;
}

// The Runner keeps a query slot until its reply drains. A subsequent page or
// a simultaneous sidebar read can hit that slot even after the caller got its
// reply. Only retry an explicit pre-admission refusal of these read-only RPCs.
async function readQuery(runtime, op, payload, timeoutMs) {
  for (const delay of [0, 25, 75, 200, 400]) {
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    const reply = await runtime.rpc(op, payload, timeoutMs);
    if (!(reply?.ok === false && reply.code === 'RUNNER_RPC_BUSY' &&
        reply.retryable === true && reply.uncertain === false)) return reply;
  }
  throw Object.assign(Error('本机执行机暂忙，未能核验历史。请稍后重新打开会话'), { code: 'RUNNER_HISTORY_BUSY' });
}
function historyPage(runtime, params, timeoutMs) {
  return readQuery(runtime, 'job.session', { ...params, historyRead: true }, timeoutMs);
}
function admissionStatus(runtime, params, timeoutMs) {
  return readQuery(runtime, 'job.has', { ...params, checkPendingWork: true }, timeoutMs);
}

// Checking by ref includes a dispatch in progress and native runs. Checking
// by admission key additionally reaches receipts evicted from the live queue.
async function confirmedAbsent(runtime, ref, sameDispatchConnection, { reportBusy = false } = {}) {
  const key = 'dispatch:' + ref;
  const absent = reply => reply?.ok === true && reply.data?.has === false &&
    reply.data.inflight === false && reply.data.persisted === false &&
    reply.data.localWorkPending === false &&
    reply.data.admissionDurable === true && Boolean(reply.data.bootId);
  try {
    if (sameDispatchConnection && !sameDispatchConnection()) return false;
    const receipt = await admissionStatus(runtime, { ref, admissionKey: key }, 5000);
    if (!absent(receipt) || receipt.data.admissionKey !== key) return false;
    const live = await admissionStatus(runtime, { ref }, 5000);
    return absent(live) && live.data.bootId === receipt.data.bootId &&
      (!sameDispatchConnection || sameDispatchConnection());
  } catch (error) {
    if (reportBusy && error.code === 'RUNNER_HISTORY_BUSY') throw error;
    return false;
  }
}

module.exports = { confirmedAbsent, missingArchive, historyPage, admissionStatus };
