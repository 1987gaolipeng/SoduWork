'use strict';

// Only the executor's terminal collection path can use this compatibility read.
// Older Hubs reconcile outputs on a ref-pinned GET and do not register the POST.
async function collect(request, route, ref) {
  const status = route + '/ai-status';
  try {
    return await request(status, { ref });
  } catch (error) {
    if (error.status !== 405) throw error;
    return request(status + '?ref=' + encodeURIComponent(ref));
  }
}

module.exports = { collect };
