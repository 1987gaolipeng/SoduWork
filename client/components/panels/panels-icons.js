
/* Human-readable file sizes. */
function _fmtSize(b) {
  if (!b && b !== 0) return '';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(b < 10240 ? 1 : 0) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}
/* Choose document icons by extension or type; images use thumbnails instead. */
/* Shared 24x24 monochrome outline icons use currentColor for consistent cross-platform rendering. */
const _ICO = {
  ai: '<rect x="4" y="7.5" width="16" height="12" rx="3.5"/><path d="M12 3v4.5M2.5 12.5v3M21.5 12.5v3"/>' +
      '<path d="M9 13.2v1.2M15 13.2v1.2"/>',
  user: '<circle cx="12" cy="8" r="3.4"/><path d="M4.8 20a7.2 7.2 0 0 1 14.4 0"/>',
  users: '<circle cx="9.5" cy="8.5" r="3"/><path d="M3 19.5a6.5 6.5 0 0 1 13 0"/>' +
         '<path d="M16.2 5.9a3 3 0 0 1 0 5.6M17.6 19.5a6.4 6.4 0 0 0-1.3-3.9"/>',
  check: '<circle cx="12" cy="12" r="8.6"/><path d="m8.2 12.4 2.6 2.6 5.2-5.4"/>',
  fwd: '<path d="M13.5 5.5 20 12l-6.5 6.5"/><path d="M20 12H9.5A5.5 5.5 0 0 0 4 17.5V19"/>',
  ext: '<path d="M14 4h6v6M20 4l-8.5 8.5"/>' +
       '<path d="M18 14.5V19a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h4.5"/>',
  clock: '<circle cx="12" cy="12" r="8.6"/><path d="M12 7.2v5.2l3.2 1.9"/>',
  file: '<path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z"/><path d="M13.8 3.6V8.2h4.6"/>',
  fileTxt: '<path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z"/><path d="M13.8 3.6V8.2h4.6"/>' +
           '<path d="M8.6 12.4h6M8.6 15.6h4"/>',
  fileSheet: '<path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z"/><path d="M13.8 3.6V8.2h4.6"/>' +
             '<path d="M8.4 12.2h7M8.4 15.4h7M11.6 11.4v5"/>',
  fileCode: '<path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z"/><path d="M13.8 3.6V8.2h4.6"/>' +
            '<path d="m10.4 12.4-1.8 1.9 1.8 1.9M13.6 12.4l1.8 1.9-1.8 1.9"/>',
  fileZip: '<path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z"/><path d="M13.8 3.6V8.2h4.6"/>' +
           '<path d="M10.6 4v2M10.6 8v2M10.6 12v2"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.4"/><circle cx="8.8" cy="9.6" r="1.5"/>' +
         '<path d="m4.6 17.6 4.6-4.6 3.6 3.6 2.8-2.8 3.8 3.8"/>',
  video: '<rect x="3.5" y="5.5" width="17" height="13" rx="2.4"/><path d="m10.4 9.4 4.6 2.6-4.6 2.6z"/>',
  audio: '<path d="M9.5 17.5V6.2l9-1.8v11.2"/><circle cx="7" cy="17.6" r="2.6"/><circle cx="16" cy="15.6" r="2.5"/>',
  /* Folder icon for projects and repositories. */
  repo: '<path d="M3.5 7.2a2 2 0 0 1 2-2h3.3l2 2.4h7.7a2 2 0 0 1 2 2v7.6a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2z"/>',
};
function _svg(name, cls) {
  const p = _ICO[name] || _ICO.file;
  return '<svg class="ico' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24">' + p + '</svg>';
}
function _fileIcon(name, ct) {
  const ext = (String(name).split('.').pop() || '').toLowerCase();
  let k = 'file';
  if (/^(png|jpg|jpeg|gif|webp|bmp|svg)$/.test(ext) || /^image\//.test(ct || '')) k = 'image';
  else if (/^(xls|xlsx|csv)$/.test(ext)) k = 'fileSheet';
  else if (/^(zip|rar|7z|tar|gz)$/.test(ext)) k = 'fileZip';
  else if (/^(mp4|mov|avi|mkv|webm)$/.test(ext) || /^video\//.test(ct || '')) k = 'video';
  else if (/^(mp3|wav|flac|aac|ogg)$/.test(ext) || /^audio\//.test(ct || '')) k = 'audio';
  else if (/^(js|ts|py|java|json|html|css|go|rs|c|cpp)$/.test(ext)) k = 'fileCode';
  else if (/^(txt|md|log|doc|docx|rtf|pdf|ppt|pptx)$/.test(ext) || /^text\//.test(ct || '') || /pdf/.test(ct || '')) k = 'fileTxt';
  return _svg(k);
}
/*
 * Legacy FlowTemplate flow/SLA UI was replaced by plugin workflows. Show t.workflow steps
 * in details and route human decisions through approvals.
 */
