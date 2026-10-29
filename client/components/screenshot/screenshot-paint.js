(function (host) {
  'use strict';
  function paintMark(ctx, mark, source) {
    ctx.save(); ctx.strokeStyle = mark.color; ctx.fillStyle = mark.color;
    ctx.lineWidth = mark.width || 4; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    if (mark.type === 'text') {
      ctx.font = `${mark.size}px "Alibaba PuHuiTi", "Segoe UI", "Noto Sans SC", sans-serif`;
      ctx.textBaseline = 'top';
      mark.text.split('\n').forEach((line, index) => ctx.fillText(line, mark.x, mark.y + index * mark.size * 1.3));
    } else if (mark.type === 'mosaic') {
      const rect = host.ScreenshotModel.rectangle({ x: mark.x, y: mark.y }, { x: mark.endX, y: mark.endY }, source.naturalWidth || source.width, source.naturalHeight || source.height);
      if (rect.width >= 1 && rect.height >= 1) {
        const tile = document.createElement('canvas');
        tile.width = Math.max(1, Math.ceil(rect.width / mark.block)); tile.height = Math.max(1, Math.ceil(rect.height / mark.block));
        tile.getContext('2d').drawImage(source, rect.x, rect.y, rect.width, rect.height, 0, 0, tile.width, tile.height);
        ctx.imageSmoothingEnabled = false; ctx.drawImage(tile, 0, 0, tile.width, tile.height, rect.x, rect.y, rect.width, rect.height);
      }
    } else {
      ctx.beginPath();
      if (mark.type === 'pen') {
        mark.points.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
        if (mark.points.length === 1) ctx.lineTo(mark.points[0].x + .1, mark.points[0].y);
      } else if (mark.type === 'rect') ctx.rect(mark.x, mark.y, mark.endX - mark.x, mark.endY - mark.y);
      else if (mark.type === 'ellipse') ctx.ellipse((mark.x + mark.endX) / 2, (mark.y + mark.endY) / 2, Math.abs(mark.endX - mark.x) / 2, Math.abs(mark.endY - mark.y) / 2, 0, 0, Math.PI * 2);
      else if (mark.type === 'arrow') {
        const angle = Math.atan2(mark.endY - mark.y, mark.endX - mark.x), head = Math.max(12, mark.width * 3.5);
        ctx.moveTo(mark.x, mark.y); ctx.lineTo(mark.endX, mark.endY);
        ctx.moveTo(mark.endX - head * Math.cos(angle - Math.PI / 6), mark.endY - head * Math.sin(angle - Math.PI / 6));
        ctx.lineTo(mark.endX, mark.endY);
        ctx.lineTo(mark.endX - head * Math.cos(angle + Math.PI / 6), mark.endY - head * Math.sin(angle + Math.PI / 6));
      }
      ctx.stroke();
    }
    ctx.restore();
  }
  function paint(ctx, marks, source, selection) {
    ctx.save();
    if (selection) { ctx.beginPath(); ctx.rect(selection.x, selection.y, selection.width, selection.height); ctx.clip(); }
    for (const mark of marks) paintMark(ctx, mark, source);
    ctx.restore();
  }
  function exportPng(source, selection, marks) {
    const bounds = host.ScreenshotModel.cropBounds(selection, source.naturalWidth || source.width, source.naturalHeight || source.height);
    const canvas = document.createElement('canvas'); canvas.width = bounds.width; canvas.height = bounds.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(source, bounds.x, bounds.y, bounds.width, bounds.height, 0, 0, bounds.width, bounds.height);
    ctx.translate(-bounds.x, -bounds.y); paint(ctx, marks, source, selection);
    return canvas.toDataURL('image/png');
  }
  host.ScreenshotPaint = { paint, exportPng };
})(window);
