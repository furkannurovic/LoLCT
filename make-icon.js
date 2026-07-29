// Generates the app icons with no external deps:
// a dark rounded tile + coral checkmark, matching the app theme.
//
//   build/icon.ico  — 256x256, used by electron-builder for Windows
//   build/icon.png  — 1024x1024, used by electron-builder for macOS (.icns is
//                     generated from it; Apple's tooling needs >= 512px)
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/** Render the icon at size S and return it as a PNG buffer. */
function render(S) {
  const k = S / 256;                    // all geometry below is authored at 256
  const buf = Buffer.alloc(S * S * 4);  // RGBA

  function setPx(x, y, r, g, b, a) {
    if (x < 0 || y < 0 || x >= S || y >= S) return;
    const i = (y * S + x) * 4;
    // alpha-blend onto existing pixel
    const sa = a / 255;
    const da = buf[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    if (oa === 0) return;
    buf[i]     = Math.round((r * sa + buf[i]     * da * (1 - sa)) / oa);
    buf[i + 1] = Math.round((g * sa + buf[i + 1] * da * (1 - sa)) / oa);
    buf[i + 2] = Math.round((b * sa + buf[i + 2] * da * (1 - sa)) / oa);
    buf[i + 3] = Math.round(oa * 255);
  }

  // distance helpers for a rounded square
  function roundedRectAlpha(x, y, left, top, right, bottom, radius) {
    // returns coverage 0..1 (cheap anti-alias via clamping)
    const cx = Math.min(Math.max(x, left + radius), right - radius);
    const cy = Math.min(Math.max(y, top + radius), bottom - radius);
    let d;
    if (x >= left + radius && x <= right - radius) {
      d = Math.min(y - top, bottom - y);
      d = Math.min(d, right - x, x - left);
      return d >= 0 ? 1 : 0;
    }
    if (y >= top + radius && y <= bottom - radius) {
      d = Math.min(x - left, right - x);
      return d >= 0 ? 1 : 0;
    }
    const dist = Math.hypot(x - cx, y - cy);
    return Math.max(0, Math.min(1, radius - dist + 0.5));
  }

  // 1) background rounded tile with vertical gradient (dark)
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const cov = roundedRectAlpha(x + 0.5, y + 0.5, 8 * k, 8 * k, S - 8 * k, S - 8 * k, 52 * k);
      if (cov <= 0) continue;
      const t = y / S;
      const r = Math.round(0x2b + (0x1f - 0x2b) * t);
      const g = Math.round(0x2a + (0x1e - 0x2a) * t);
      const b = Math.round(0x27 + (0x1d - 0x27) * t);
      setPx(x, y, r, g, b, Math.round(255 * cov));
    }
  }

  // 2) coral checkmark — polyline through three points, drawn as a distance
  // field so caps and the joint are round and anti-aliased at any size.
  const pts = [
    { x: 70 * k, y: 132 * k },
    { x: 112 * k, y: 174 * k },
    { x: 190 * k, y: 84 * k },
  ];
  const stroke = 22 * k;

  function distToSeg(px, py, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((px - a.x) * dx + (py - a.y) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
  }

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const px = x + 0.5, py = y + 0.5;
      const d = Math.min(distToSeg(px, py, pts[0], pts[1]), distToSeg(px, py, pts[1], pts[2]));
      const cov = Math.max(0, Math.min(1, stroke - d + 0.5));
      if (cov > 0) setPx(x, y, 0xd9, 0x77, 0x57, Math.round(255 * cov));
    }
  }

  return encodePng(buf, S);
}

// ---- PNG encoding ----
const crcTable = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b) {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(buf, S) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0);
  ihdr.writeUInt32BE(S, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const raw = Buffer.alloc((S * 4 + 1) * S);
  for (let y = 0; y < S; y++) {
    raw[y * (S * 4 + 1)] = 0; // filter: none
    buf.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- ICO wrapping (single PNG-compressed 256x256 entry) ----
function wrapIco(png) {
  const ico = Buffer.alloc(6 + 16);
  ico.writeUInt16LE(0, 0);     // reserved
  ico.writeUInt16LE(1, 2);     // type: icon
  ico.writeUInt16LE(1, 4);     // count
  ico[6] = 0;                  // width (0 => 256)
  ico[7] = 0;                  // height (0 => 256)
  ico[8] = 0;                  // colors
  ico[9] = 0;                  // reserved
  ico.writeUInt16LE(1, 10);    // planes
  ico.writeUInt16LE(32, 12);   // bpp
  ico.writeUInt32LE(png.length, 14); // size
  ico.writeUInt32LE(22, 18);   // offset
  return Buffer.concat([ico, png]);
}

const dir = path.join(__dirname, 'build');
fs.mkdirSync(dir, { recursive: true });

const ico = wrapIco(render(256));
fs.writeFileSync(path.join(dir, 'icon.ico'), ico);
console.log('Wrote build/icon.ico (256x256, ' + ico.length + ' bytes)');

const big = render(1024);
fs.writeFileSync(path.join(dir, 'icon.png'), big);
console.log('Wrote build/icon.png (1024x1024, ' + big.length + ' bytes) — macOS .icns source');
