/* Native file associations: identical to the user's desktop file manager. */
(function (global) {
  'use strict';
  const MIME_TYPES = {
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-word.document.macroenabled.12': 'docm',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.ms-excel.sheet.macroenabled.12': 'xlsm',
    'application/vnd.ms-powerpoint': 'ppt',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'application/vnd.ms-powerpoint.presentation.macroenabled.12': 'pptm',
    'application/pdf': 'pdf', 'text/markdown': 'md', 'text/x-markdown': 'md',
    'text/plain': 'txt', 'text/html': 'html', 'text/csv': 'csv',
    'application/zip': 'zip', 'application/x-7z-compressed': '7z',
    'application/json': 'json', 'application/xml': 'xml',
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif',
    'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/tiff': 'tiff',
    'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'video/mp4': 'mp4', 'video/webm': 'webm',
    'application/vnd.oasis.opendocument.text': 'odt',
    'application/vnd.oasis.opendocument.spreadsheet': 'ods',
    'application/vnd.oasis.opendocument.presentation': 'odp',
  };
  const cache = new Map(), pending = new Map();
  function typeOf(item) {
    if (item?.kind === 'folder') return '$folder';
    // A renamed display title is not the stored file format. A real extension
    // also takes precedence over generic/misreported MIME and library kind.
    const filename = String(item?.filename || '').split(/[\\/]/).pop();
    const suffix = filename.lastIndexOf('.');
    if (suffix > 0) {
      const ext = filename.slice(suffix + 1).toLowerCase();
      if (/^[a-z0-9][a-z0-9_-]{0,15}$/.test(ext)) return ext;
    }
    const mime = String(item?.contentType || '').split(';')[0].trim().toLowerCase();
    return MIME_TYPES[mime] || '';
  }
  const valid = value => /^data:image\/png;base64,[a-z0-9+/=]+$/i.test(String(value || ''));
  function markup(item) {
    const type = typeOf(item), saved = cache.get(type);
    return '<span class="library-native-file-icon" data-native-file-icon="' + type + '" aria-hidden="true">' +
      '<img alt="" draggable="false"' + (saved ? ' src="' + saved + '"' : ' hidden') + '>' +
      '<span class="library-file-extension"' + (saved ? ' hidden' : '') + '>' + (type === '$folder' ? '' : type.toUpperCase()) + '</span></span>';
  }
  function load(type) {
    if (cache.has(type)) return Promise.resolve(cache.get(type));
    if (pending.has(type)) return pending.get(type);
    const api = global.soduWorkAPI;
    if (typeof api?.fileTypeIcon !== 'function') return Promise.resolve('');
    const request = Promise.resolve().then(() => api.fileTypeIcon(type)).then(result => {
      const url = result?.ok && valid(result.dataUrl) ? result.dataUrl : '';
      if (url) {
        if (cache.size >= 256) cache.delete(cache.keys().next().value);
        cache.set(type, url);
      }
      return url;
    }).catch(() => '').finally(() => pending.delete(type));
    pending.set(type, request);
    return request;
  }
  function hydrate(root) {
    root.querySelectorAll('[data-native-file-icon]').forEach(node => {
      const type = node.dataset.nativeFileIcon;
      load(type).then(url => {
        if (!url || !node.isConnected || node.dataset.nativeFileIcon !== type) return;
        const image = node.querySelector('img'), label = node.querySelector('.library-file-extension');
        image.onload = () => { if (node.isConnected) { image.hidden = false; label.hidden = true; } };
        image.onerror = () => { image.hidden = true; label.hidden = false; };
        if (image.src !== url) image.src = url;
        else if (image.complete && image.naturalWidth) { image.hidden = false; label.hidden = true; }
      });
    });
  }
  const api = { typeOf, markup, hydrate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.SoduWorkLibraryFileIcons = api;
})(globalThis);
