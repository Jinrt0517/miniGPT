const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const root = path.join(__dirname, '..');
const vendor = path.join(root, 'src', 'renderer', 'vendor');
fs.mkdirSync(vendor, { recursive: true });
fs.copyFileSync(path.join(path.dirname(require.resolve('marked/package.json')), 'lib', 'marked.umd.js'), path.join(vendor, 'marked.umd.js'));
fs.copyFileSync(path.join(path.dirname(require.resolve('dompurify')), 'purify.min.js'), path.join(vendor, 'purify.min.js'));
const size = 256, stride = size * 4 + 1, raw = Buffer.alloc(stride * size);
for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
  const i = y * stride + 1 + x * 4;
  const cx = x - 127.5, cy = y - 127.5;
  const round = Math.pow(Math.abs(cx) / 124, 5) + Math.pow(Math.abs(cy) / 124, 5) <= 1;
  const star = Math.pow(Math.abs(cx) / 78, 0.66) + Math.pow(Math.abs(cy) / 78, 0.66) < 1;
  raw[i] = raw[i+1] = raw[i+2] = star ? 244 : 26;
  raw[i+3] = round ? 255 : 0;
}
function crc32(buffer) { let crc = 0xffffffff; for (const b of buffer) { crc ^= b; for(let k=0;k<8;k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const name = Buffer.from(type); const length = Buffer.alloc(4); length.writeUInt32BE(data.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([name,data]))); return Buffer.concat([length,name,data,crc]); }
const header = Buffer.alloc(13); header.writeUInt32BE(size,0); header.writeUInt32BE(size,4); header[8]=8;header[9]=6;
const png = Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',zlib.deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
fs.writeFileSync(path.join(root, 'assets', 'icon.png'), png);
const icoHeader = Buffer.alloc(22); icoHeader.writeUInt16LE(1,2);icoHeader.writeUInt16LE(1,4);icoHeader.writeUInt16LE(1,10);icoHeader.writeUInt16LE(32,12);icoHeader.writeUInt32LE(png.length,14);icoHeader.writeUInt32LE(22,18);
fs.writeFileSync(path.join(root,'assets','icon.ico'), Buffer.concat([icoHeader,png]));
console.log('Renderer libraries and application icon prepared.');
