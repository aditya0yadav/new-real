// generateIcons.js — run once: node generateIcons.js
// Generates PNG icons for the extension without any dependencies

const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

function makeCRCTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  return table;
}
const CRC_TABLE = makeCRCTable();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf  = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcVal  = crc32(Buffer.concat([typeBuf, data]));
  const crcBuf  = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crcVal, 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function generatePNG(size, r, g, b) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(size, 0);
  ihdrData.writeUInt32BE(size, 4);
  ihdrData[8] = 8;   // bit depth
  ihdrData[9] = 2;   // color type: RGB
  const ihdr = chunk('IHDR', ihdrData);

  // IDAT — draw a circle with gradient-ish effect
  const rows = [];
  const cx = size / 2, cy = size / 2, radius = size / 2 - 1;
  for (let y = 0; y < size; y++) {
    const row = [0]; // filter type: none
    for (let x = 0; x < size; x++) {
      const dx = x - cx, dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= radius) {
        // Slight radial gradient (lighter at top-left)
        const factor = 1 - (dist / radius) * 0.3;
        row.push(Math.min(255, Math.round(r * factor)));
        row.push(Math.min(255, Math.round(g * factor)));
        row.push(Math.min(255, Math.round(b * factor)));
      } else {
        row.push(0, 0, 0); // transparent-ish (black bg — will be transparent in practice)
      }
    }
    rows.push(Buffer.from(row));
  }
  const raw  = Buffer.concat(rows);
  const comp = zlib.deflateSync(raw, { level: 9 });
  const idat = chunk('IDAT', comp);

  const iend = chunk('IEND', Buffer.alloc(0));
  return Buffer.concat([sig, ihdr, idat, iend]);
}

const iconsDir = path.join(__dirname, 'extension', 'icons');
if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir, { recursive: true });

// Indigo/purple color: #6366f1 → 99, 102, 241
[16, 48, 128].forEach(size => {
  const png = generatePNG(size, 99, 102, 241);
  const outPath = path.join(iconsDir, `icon${size}.png`);
  fs.writeFileSync(outPath, png);
  console.log(`✅ Created icon${size}.png (${png.length} bytes)`);
});

console.log('\nAll icons generated in extension/icons/');
