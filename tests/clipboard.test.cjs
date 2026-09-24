'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readClipboardImages } = require('../src/clipboard.cjs');

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const PNG = Buffer.from('normalized-png');
const PNG_URL = `data:image/png;base64,${PNG.toString('base64')}`;

function item(representations) {
  const requested = [];
  return {
    types: Object.keys(representations),
    requested,
    async getType(type) {
      requested.push(type);
      const value = representations[type];
      if (value instanceof Error) throw value;
      return value instanceof Blob ? value : new Blob([value], { type });
    },
  };
}

function setup(items, { empty = false, png = PNG, decodeError } = {}) {
  const decoded = [];
  let reads = 0;
  return {
    decoded,
    get reads() { return reads; },
    // Deliberately expose only Electron's current asynchronous clipboard API.
    clipboard: { async read() { reads++; return items; } },
    nativeImage: {
      createFromBuffer(buffer) {
        decoded.push(buffer);
        if (decodeError) throw decodeError;
        return {
          isEmpty: () => empty,
          toPNG: () => png,
          toDataURL: () => `data:image/png;base64,${png.toString('base64')}`,
        };
      },
    },
  };
}

function friendlyError(error) {
  assert.ok(error instanceof Error);
  assert.match(error.message, /[\u4e00-\u9fff]/);
  assert.doesNotMatch(error.message, /RAW_NATIVE_ERROR|readImage is not a function/);
  return true;
}

test('reads an image using the asynchronous API without the removed readImage method', async () => {
  const source = item({ 'image/png': 'clipboard-png' });
  const dependencies = setup([source]);
  assert.equal(dependencies.clipboard.readImage, undefined);
  const attachments = await readClipboardImages(dependencies);
  assert.deepEqual(attachments, [{ type: 'image', name: '粘贴的图片.png', dataUrl: PNG_URL }]);
  assert.equal(dependencies.reads, 1);
  assert.deepEqual(source.requested, ['image/png']);
  assert.equal(dependencies.decoded[0].toString(), 'clipboard-png');
});

test('waits for clipboard.read to resolve before returning attachments', async () => {
  const dependencies = setup([]);
  let resolveRead;
  dependencies.clipboard.read = () => new Promise((resolve) => { resolveRead = resolve; });
  const pending = readClipboardImages(dependencies);
  assert.equal(dependencies.decoded.length, 0);
  resolveRead([item({ 'image/png': 'delayed-image' })]);
  assert.equal((await pending)[0].dataUrl, PNG_URL);
});

test('prefers PNG when a single clipboard item also offers other image representations', async () => {
  const source = item({ 'image/jpeg': 'jpeg-copy', 'text/html': '<img>', 'image/png': 'png-copy', 'image/webp': 'webp-copy' });
  const dependencies = setup([source]);
  const attachments = await readClipboardImages(dependencies);
  assert.equal(attachments.length, 1);
  assert.deepEqual(source.requested, ['image/png']);
  assert.equal(dependencies.decoded.length, 1);
  assert.equal(dependencies.decoded[0].toString(), 'png-copy');
});

test('normalizes supported non-PNG images into PNG attachments', async (t) => {
  for (const type of ['image/jpeg', 'image/webp', 'image/bmp', 'image/gif']) {
    await t.test(type, async () => {
      const source = item({ [type]: `${type}-input` });
      const dependencies = setup([source]);
      const attachments = await readClipboardImages(dependencies);
      assert.deepEqual(attachments, [{ type: 'image', name: '粘贴的图片.png', dataUrl: PNG_URL }]);
      assert.deepEqual(source.requested, [type]);
      assert.equal(dependencies.decoded[0].toString(), `${type}-input`);
    });
  }
});

test('empty and text-only clipboards produce no attachments and never decode images', async () => {
  for (const items of [[], [item({ 'text/plain': 'hello', 'text/html': '<b>hello</b>' })]]) {
    const dependencies = setup(items);
    assert.deepEqual(await readClipboardImages(dependencies), []);
    assert.deepEqual(dependencies.decoded, []);
    for (const source of items) assert.deepEqual(source.requested, []);
  }
});

test('multiple clipboard items each contribute one image without duplicating representations', async () => {
  const sources = [
    item({ 'image/jpeg': 'first-jpeg', 'image/png': 'first-png' }),
    item({ 'text/plain': 'copied text' }),
    item({ 'image/webp': 'second-webp' }),
  ];
  const dependencies = setup(sources);
  const attachments = await readClipboardImages(dependencies);
  assert.equal(attachments.length, 2);
  assert.deepEqual(dependencies.decoded.map((buffer) => buffer.toString()), ['first-png', 'second-webp']);
  assert.deepEqual(sources[1].requested, []);
});

test('eight image items are accepted, while a ninth rejects the complete paste', async () => {
  const sources = Array.from({ length: 9 }, (_, index) => item({ 'image/png': `image-${index}` }));
  assert.equal((await readClipboardImages(setup(sources.slice(0, 8)))).length, 8);
  await assert.rejects(readClipboardImages(setup(sources)), (error) => {
    friendlyError(error);
    assert.match(error.message, /8/);
    return true;
  });
});

test('clipboard read failures expose an actionable Chinese error instead of the native exception', async () => {
  const dependencies = setup([]);
  dependencies.clipboard.read = async () => { throw new Error('RAW_NATIVE_ERROR: clipboard lock'); };
  await assert.rejects(readClipboardImages(dependencies), friendlyError);
  assert.deepEqual(dependencies.decoded, []);
});

test('image retrieval failures reject the entire paste instead of returning preceding images', async () => {
  const dependencies = setup([
    item({ 'image/png': 'valid-first-image' }),
    item({ 'image/png': new Error('RAW_NATIVE_ERROR: missing clipboard representation') }),
  ]);
  await assert.rejects(readClipboardImages(dependencies), friendlyError);
});

test('a clipboard Blob that fails while reading bytes gives a friendly error', async () => {
  const source = {
    types: ['image/png'],
    async getType() {
      return { size: 12, async arrayBuffer() { throw new Error('RAW_NATIVE_ERROR: buffer read failed'); } };
    },
  };
  const dependencies = setup([source]);
  await assert.rejects(readClipboardImages(dependencies), friendlyError);
  assert.deepEqual(dependencies.decoded, []);
});

test('an image that decodes to an empty native image produces a friendly error', async () => {
  const dependencies = setup([item({ 'image/png': 'corrupt-image' })], { empty: true });
  await assert.rejects(readClipboardImages(dependencies), friendlyError);
});

test('native image decode failures do not leak native exception text', async () => {
  const dependencies = setup([item({ 'image/png': 'corrupt-image' })], { decodeError: new Error('RAW_NATIVE_ERROR: invalid decoder input') });
  await assert.rejects(readClipboardImages(dependencies), friendlyError);
});

test('an empty PNG conversion is rejected instead of returning an unusable attachment', async () => {
  const dependencies = setup([item({ 'image/png': 'source-image' })], { png: Buffer.alloc(0) });
  await assert.rejects(readClipboardImages(dependencies), friendlyError);
});

test('oversized source images are rejected before decoding', async () => {
  const dependencies = setup([item({ 'image/png': new Blob([Buffer.alloc(MAX_IMAGE_BYTES + 1)], { type: 'image/png' }) })]);
  await assert.rejects(readClipboardImages(dependencies), (error) => {
    friendlyError(error);
    assert.match(error.message, /15\s*MB/i);
    return true;
  });
  assert.deepEqual(dependencies.decoded, []);
});

test('small source images whose normalized PNG exceeds the limit are rejected', async () => {
  const dependencies = setup([item({ 'image/jpeg': 'small-compressed-image' })], { png: Buffer.alloc(MAX_IMAGE_BYTES + 1) });
  await assert.rejects(readClipboardImages(dependencies), (error) => {
    friendlyError(error);
    assert.match(error.message, /15\s*MB/i);
    return true;
  });
});

test('a source image exactly at the byte limit can be normalized to a smaller valid PNG', async () => {
  const bytes = Buffer.alloc(MAX_IMAGE_BYTES);
  const dependencies = setup([item({ 'image/png': new Blob([bytes], { type: 'image/png' }) })]);
  const attachments = await readClipboardImages(dependencies);
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].dataUrl, PNG_URL);
});

test('encoded attachments remain within the chat service data URL size limit', async () => {
  const prefixBytes = 'data:image/png;base64,'.length;
  const largestPngBytes = Math.floor((MAX_IMAGE_BYTES - prefixBytes) / 4) * 3;
  const validDependencies = setup([item({ 'image/png': 'small-source' })], { png: Buffer.alloc(largestPngBytes) });
  const [attachment] = await readClipboardImages(validDependencies);
  assert.ok(attachment.dataUrl.length <= MAX_IMAGE_BYTES);
  const oversizedDependencies = setup([item({ 'image/png': 'small-source' })], { png: Buffer.alloc(largestPngBytes + 1) });
  await assert.rejects(readClipboardImages(oversizedDependencies), (error) => {
    friendlyError(error);
    assert.match(error.message, /15\s*MB/i);
    return true;
  });
});
