/* Portable plugin artwork: embedded PNG only; never fetch remote/file URLs. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SoduWorkPluginIcon = api;
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  const PREFIX = 'data:image/png;base64,';
  const MAX_BYTES = 96 * 1024;
  function normalize(value) {
    if (value == null || value === '') return '';
    if (typeof value !== 'string' || value.length > PREFIX.length + MAX_BYTES * 4 / 3 ||
        !/^data:image\/png;base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
      throw new Error('插件图标需为不超过 96 KB 的 PNG 图片，请重新上传图标');
    }
    const encoded = value.slice(PREFIX.length);
    const bytes = typeof Buffer === 'function' ? Buffer.from(encoded, 'base64')
      : Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
    const u32 = n => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(n);
    if (bytes.length < 57 || bytes.length > MAX_BYTES ||
        ![137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82].every((v, i) => bytes[i] === v) ||
        u32(16) < 1 || u32(16) > 256 || u32(20) < 1 || u32(20) > 256 ||
        ![0,0,0,0,73,69,78,68,174,66,96,130].every((v, i) => bytes[bytes.length - 12 + i] === v)) {
      throw new Error('插件图标格式无效或尺寸超过 256 × 256，请重新上传图标');
    }
    return value;
  }
  function image(value) {
    try { const src = normalize(value); return src ? '<img class="cap-plugin-custom-icon" src="' + src + '" alt="" draggable="false">' : ''; }
    catch (_) { return ''; }
  }
  /* Catalog payloads have changed shape over time. Keep icon lookup in one
     place so the composer, slash picker and plugin library all render the
     author's artwork instead of silently falling back to a generic glyph. */
  function source(value) {
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object') return '';
    const candidates = [
      value.icon,
      value.iconData,
      value.manifest && value.manifest.icon,
      value.body && value.body.icon,
      value.body && value.body.manifest && value.body.manifest.icon,
      value.metadata && value.metadata.icon,
      value.presentation && value.presentation.icon,
    ];
    for (const candidate of candidates) {
      if (typeof candidate !== 'string' || !candidate.trim()) continue;
      try { return normalize(candidate); } catch (_) { /* try the next published shape */ }
    }
    return '';
  }
  function imageFor(value) { return image(source(value)); }
  function fallback(value) {
    const item = value && typeof value === 'object' ? value : {};
    const cap = item.capabilities && typeof item.capabilities === 'object' ? item.capabilities : {};
    const hasWorkflow = cap.executionMode === 'workflow' ||
      (Array.isArray(item.workflow) && item.workflow.length);
    const kind = item.kind || (cap.mcpServers && cap.mcpServers.length ? 'connector' :
      cap.skills && cap.skills.length ? 'skill' : hasWorkflow ? 'workflow' : 'plugin');
    if (kind === 'connector') return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="7" r="2.5"/><circle cx="18" cy="17" r="2.5"/><path d="m8.4 11 7.2-3m-7.2 5 7.2 3"/></svg>';
    if (kind === 'skill') return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m12 4 1.1 3.4a4.8 4.8 0 0 0 3.1 3.1l3.3 1.1-3.3 1.1a4.8 4.8 0 0 0-3.1 3.1L12 19.2l-1.1-3.4a4.8 4.8 0 0 0-3.1-3.1l-3.3-1.1 3.3-1.1a4.8 4.8 0 0 0 3.1-3.1z"/></svg>';
    if (kind === 'workflow') return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="3.5" y="4" width="6" height="5" rx="1.5"/><rect x="14.5" y="15" width="6" height="5" rx="1.5"/><path d="M9.5 6.5h2.5a5 5 0 0 1 5 5V15m-2.5-2.5 2.5 2.5 2.5-2.5"/></svg>';
    return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M8.2 4.5a2.7 2.7 0 1 1 5.2 1.1h3.1A2.5 2.5 0 0 1 19 8.1v3.1a2.7 2.7 0 1 1 0 5.2v1A2.6 2.6 0 0 1 16.4 20h-3.1a2.7 2.7 0 1 1-5.2 0H7A2.5 2.5 0 0 1 4.5 17.5v-3.1a2.7 2.7 0 1 1 0-5.2v-2A2.7 2.7 0 0 1 7.2 4.5z"/></svg>';
  }
  function markup(value) { return imageFor(value) || fallback(value); }
  async function readFile(file) {
    if (!file || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      throw new Error('请选择 PNG、JPG 或 WebP 图片');
    }
    if (file.size > 2 * 1024 * 1024) throw new Error('图片不能超过 2 MB，请选择较小的图片');
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
      if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 16 * 1024 * 1024) {
        throw new Error('图片尺寸过大，请选择不超过 1600 万像素的图片');
      }
      const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 128;
      const context = canvas.getContext('2d');
      const scale = Math.min(128 / bitmap.width, 128 / bitmap.height);
      const width = bitmap.width * scale, height = bitmap.height * scale;
      context.imageSmoothingQuality = 'high';
      context.drawImage(bitmap, (128 - width) / 2, (128 - height) / 2, width, height);
      return normalize(canvas.toDataURL('image/png'));
    } catch (error) {
      if (error && error.message && /图片|图标/.test(error.message)) throw error;
      throw new Error('图片无法读取，请换一张有效的 PNG、JPG 或 WebP 图片');
    } finally { if (bitmap) bitmap.close(); }
  }
  if (typeof document === 'object') document.addEventListener('error', event => {
    if (event.target.matches && event.target.matches('img.cap-plugin-custom-icon')) event.target.hidden = true;
  }, true);
  return { normalize, image, source, imageFor, fallback, markup, readFile, MAX_BYTES };
});
