'use strict';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

// Only accept actual raster bytes from imageGeneration events, never a model's
// Markdown URL or a filesystem path. This also validates persisted image data.
function imageDataUrl(result) {
  if (typeof result !== 'string' || result.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 100) return null;
  const encoded = result.replace(/^data:image\/(?:png|jpeg|webp|gif);base64,/, '');
  if (!encoded || encoded.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > MAX_IMAGE_BYTES) return null;
  let mime;
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) mime = 'png';
  else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) mime = 'jpeg';
  else if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') mime = 'webp';
  else if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())) mime = 'gif';
  return mime ? `data:image/${mime};base64,${encoded}` : null;
}

function generatedImage(item) {
  if (!item || item.type !== 'imageGeneration' || item.status !== 'completed' || item.failure) return null;
  const dataUrl = imageDataUrl(item.result);
  return dataUrl ? { id: String(item.id), dataUrl } : null;
}

module.exports = { imageDataUrl, generatedImage };
