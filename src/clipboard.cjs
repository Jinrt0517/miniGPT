'use strict';

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/bmp', 'image/gif'];

async function readClipboardImages({ clipboard, nativeImage }) {
  let items;
  try {
    // Electron 44 exposes asynchronous ClipboardItems, not readImage().
    items = await clipboard.read();
  } catch {
    throw new Error('暂时无法读取剪贴板，请重新复制图片后重试。');
  }
  if (!Array.isArray(items)) throw new Error('无法读取剪贴板中的图片，请重新复制后重试。');
  const images = [];
  for (const item of items) {
    // Multiple MIME types in one item are alternate representations of one image.
    const type = IMAGE_TYPES.find(type => item.types?.includes(type));
    if (!type) continue;
    if (images.length >= 8) throw new Error('每次最多粘贴 8 张图片。');
    let blob, bytes;
    try { blob = await item.getType(type); }
    catch { throw new Error('剪贴板图片读取失败，请重新复制图片后重试。'); }
    if (!blob || typeof blob.arrayBuffer !== 'function') throw new Error('无法读取这张图片，请重新复制后重试。');
    if (blob.size > MAX_IMAGE_BYTES) throw new Error('图片最大支持 15 MB，请缩小后重试。');
    try { bytes = Buffer.from(await blob.arrayBuffer()); }
    catch { throw new Error('剪贴板图片读取失败，请重新复制图片后重试。'); }
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error('图片最大支持 15 MB，请缩小后重试。');
    let png;
    try {
      const image = nativeImage.createFromBuffer(bytes);
      if (image.isEmpty()) throw new Error('Empty image');
      png = image.toPNG();
    } catch { throw new Error('剪贴板中的图片无法解码，请重新复制有效的图片。'); }
    if (!png?.length) throw new Error('剪贴板中的图片为空，请重新复制后重试。');
    if (png.length > MAX_IMAGE_BYTES) throw new Error('图片转换后超过 15 MB，请缩小后重试。');
    const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
    if (dataUrl.length > MAX_IMAGE_BYTES) throw new Error('图片编码后超过 15 MB，请缩小后重试。');
    images.push({ type: 'image', name: images.length ? `粘贴的图片 ${images.length + 1}.png` : '粘贴的图片.png', dataUrl });
  }
  return images;
}

module.exports = { readClipboardImages };
