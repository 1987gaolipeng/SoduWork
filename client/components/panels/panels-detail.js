/* Compatibility entry names for stored links and execution callbacks.
   The requirement drawer owns details; NativeChat owns every conversation. */
function openDetail(value) {
  detailId = String(value || '');
  return window.openDetailEntry?.(detailId);
}
function refreshOpenDetail(id) {
  if (String(id) === detailId && document.querySelector('.rq-detail-backdrop')) {
    return window.RequirementsDetail?.refresh?.(id);
  }
}
