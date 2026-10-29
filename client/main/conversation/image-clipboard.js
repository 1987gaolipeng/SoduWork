'use strict';

/* Electron 44 uses async MIME-based clipboard writes; older clients still expose
   writeImage. Keep this main-process helper image-only and await the OS write
   before telling the renderer it succeeded. Never expose arbitrary formats. */
async function writeImage(image, runtime = require('electron')) {
  if (!image || image.isEmpty()) throw new Error('图片内容无法识别');
  const { clipboard, ClipboardItem } = runtime;
  if (typeof clipboard.write === 'function' && typeof ClipboardItem === 'function') {
    const png = image.toPNG();
    if (!png.byteLength) throw new Error('图片转换失败');
    await clipboard.write([new ClipboardItem({
      'image/png': new Blob([png], { type: 'image/png' }),
    })]);
    return;
  }
  if (typeof clipboard.writeImage === 'function') {
    await clipboard.writeImage(image);
    return;
  }
  throw new Error('当前客户端不支持复制图片，请更新客户端');
}

// This is the only renderer-byte entry point: bounded PNG bytes, never a path,
// URL, HTML, custom OS format or renderer-authored ClipboardItem.
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
async function writePng(data, runtime = require('electron')) {
  if (!(data instanceof Uint8Array) || !data.byteLength || data.byteLength > MAX_IMAGE_BYTES) {
    throw new Error('转换后的图片为空或超过 20 MB，无法复制');
  }
  const png = Buffer.from(data);
  if (png.length < 8 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error('转换后的图片不是 PNG');
  }
  await writeImage(runtime.nativeImage.createFromBuffer(png), runtime);
}

module.exports = { writeImage, writePng, MAX_IMAGE_BYTES };
