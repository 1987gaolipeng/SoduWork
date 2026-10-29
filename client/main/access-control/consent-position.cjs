'use strict';

// CSS coordinates belong to the requesting WebContents, not its BrowserWindow.
function sourceBounds(parent, source) {
  const content = parent.getContentBounds?.() || parent.getBounds();
  if (!source || source === parent.webContents) return content;
  function find(view, x, y) {
    const bounds = view.getBounds();
    const origin = { x: x + bounds.x, y: y + bounds.y, width: bounds.width, height: bounds.height };
    if (view.webContents === source) return origin;
    for (const child of view.children || []) { const result = find(child, origin.x, origin.y); if (result) return result; }
    return null;
  }
  for (const child of parent.contentView?.children || []) {
    const result = find(child, content.x, content.y);
    if (result) return result;
  }
  return null;
}

function create(parent, options, screen) {
  const source = options.source, anchor = options.anchor;
  const initial = sourceBounds(parent, source);
  const embedded = source && source !== parent.webContents;
  return function position(naturalHeight) {
    const content = sourceBounds(parent, source);
    if (!content || (source && source.isDestroyed())) throw Error('Confirmation source is no longer attached');
    const area = screen.getDisplayMatching(content).workArea;
    const region = embedded ? {
      x: Math.max(area.x, content.x), y: Math.max(area.y, content.y),
      right: Math.min(area.x + area.width, content.x + content.width),
      bottom: Math.min(area.y + area.height, content.y + content.height),
    } : { x: area.x, y: area.y, right: area.x + area.width, bottom: area.y + area.height };
    if (embedded && (region.right - region.x <= 24 || region.bottom <= region.y)) throw Error('Confirmation source has no visible space');
    const width = embedded ? Math.max(1, Math.min(384, region.right - region.x - 24))
      : Math.min(384, Math.max(240, area.width - 32));
    const zoom = Number(source?.getZoomFactor?.()) || 1;
    const finite = key => anchor?.[key] != null && Number.isFinite(Number(anchor[key]));
    const local = finite('left') && finite('top');
    const absolute = !source && finite('screenX') && finite('screenY');
    const anchored = local || absolute;
    const left = absolute ? Number(anchor.screenX) : content.x + Number(anchor?.left || 0) * zoom;
    const rawTop = absolute ? Number(anchor.screenY) : content.y + Number(anchor?.top || 0) * zoom +
      (embedded && initial ? content.height - initial.height : 0);
    const top = embedded ? Math.max(region.y, Math.min(rawTop, region.bottom)) : rawTop;
    const anchorWidth = Math.max(0, Number(anchor?.width) || 0) * zoom;
    const anchorHeight = Math.max(0, Number(anchor?.height) || 0) * zoom;
    const maxHeight = embedded ? Math.max(1, Math.min(region.bottom - region.y - 16, anchored ? top - region.y - 20 : Infinity)) : Math.max(1, area.height - 40);
    const height = Math.min(Math.max(220, Math.round(naturalHeight)), maxHeight);
    const preferredX = anchored ? Math.round(left + (anchorWidth - width) / 2)
      : Math.round(content.x + (content.width - width) / 2);
    const below = anchored ? Math.round(top + anchorHeight + 12) : Math.round(content.y + (content.height - height) / 2);
    const preferredY = anchored && (embedded || below + height > area.y + area.height)
      ? Math.round(top - height - 12) : below;
    const margin = embedded ? 12 : 0;
    return { x: Math.round(Math.max(region.x + margin, Math.min(preferredX, region.right - width - margin))),
      y: Math.round(Math.max(region.y, Math.min(preferredY, region.bottom - height))), width, height };
  };
}
module.exports = { create, sourceBounds };
