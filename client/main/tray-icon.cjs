'use strict';

function createTrayIcon(nativeImage, iconPath) {
  let image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) return image;

  const { width, height } = image.getSize();
  if (width === height) {
    const pixels = image.toBitmap();
    let left = width, top = height, right = -1, bottom = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        // Ignore near-transparent export noise when measuring the visible mark.
        if (pixels[(y * width + x) * 4 + 3] < 8) continue;
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
      }
    }
    if (right >= left && bottom >= top) {
      const padding = Math.ceil(width / 256);
      const side = Math.min(width, Math.max(right - left + 1, bottom - top + 1) + padding * 2);
      const x = Math.max(0, Math.min(width - side, Math.floor((left + right + 1 - side) / 2)));
      const y = Math.max(0, Math.min(height - side, Math.floor((top + bottom + 1 - side) / 2)));
      // A square crop keeps the box and sparkle intact without stretching them.
      image = image.crop({ x, y, width: side, height: side });
    }
  }

  return image.resize({ width: 32, height: 32, quality: 'best' });
}

module.exports = { createTrayIcon };
