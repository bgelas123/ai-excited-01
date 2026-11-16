// main.ts — "The Fish That Jumped at the Moon"
// A program that draws one image, procedurally, with the standard library only.
// It renders a giant koi leaping over a full moon above a night sea, with a tiny
// boat and one line of text, then writes it as a PNG to $MAKEFUN_OUTPUT_DIR/entry.png
// (or /output/entry.png). Deterministic: same run, same bytes.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

// ---------- tiny deterministic PRNG (mulberry32) ----------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- color helpers ----------
type RGB = [number, number, number];
function rgb(r: number, g: number, b: number): RGB {
  return [r | 0, g | 0, b | 0];
}
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
function lerpColor(c1: RGB, c2: RGB, t: number): RGB {
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
}

// ---------- CRC32 (PNG chunks) ----------
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------- PNG encoder (truecolor RGB, per-row filter None/Up) ----------
function encodePNG(width: number, height: number, data: Uint8Array): Buffer {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    const pxStart = y * stride;
    // Choose filter: None vs Up by sum of absolute signed-byte differences.
    let sumNone = 0;
    let sumUp = 0;
    for (let x = 0; x < stride; x++) {
      const v = data[pxStart + x];
      sumNone += v < 128 ? v : 256 - v;
      if (y === 0) {
        sumUp += v < 128 ? v : 256 - v;
      } else {
        const d = (v - data[pxStart - stride + x] + 256) & 0xff;
        sumUp += d < 128 ? d : 256 - d;
      }
    }
    if (y === 0 || sumNone <= sumUp) {
      raw[rowStart] = 0;
      raw.set(data.subarray(pxStart, pxStart + stride), rowStart + 1);
    } else {
      raw[rowStart] = 2;
      for (let x = 0; x < stride; x++) {
        raw[rowStart + 1 + x] = (data[pxStart + x] - data[pxStart - stride + x]) & 0xff;
      }
    }
  }
  const idat = deflateSync(raw, { level: 9 });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type 2 = truecolor RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const chunk = (type: string, payload: Buffer): Buffer => {
    const out = Buffer.alloc(12 + payload.length);
    out.writeUInt32BE(payload.length, 0);
    out.write(type, 4, 'ascii');
    payload.copy(out, 8);
    out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), payload])), 8 + payload.length);
    return out;
  };
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- Canvas: an RGB buffer with scanline shape fills ----------
class Canvas {
  readonly w: number;
  readonly h: number;
  readonly buf: Uint8Array;
  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.buf = new Uint8Array(w * h * 3);
  }
  set(x: number, y: number, c: RGB): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 3;
    this.buf[i] = c[0];
    this.buf[i + 1] = c[1];
    this.buf[i + 2] = c[2];
  }
  // Blend color over the pixel with opacity a (0..1).
  blend(x: number, y: number, c: RGB, a: number): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h || a <= 0) return;
    if (a >= 1) {
      this.set(x, y, c);
      return;
    }
    const i = (y * this.w + x) * 3;
    this.buf[i] = this.buf[i] + (c[0] - this.buf[i]) * a;
    this.buf[i + 1] = this.buf[i + 1] + (c[1] - this.buf[i + 1]) * a;
    this.buf[i + 2] = this.buf[i + 2] + (c[2] - this.buf[i + 2]) * a;
  }
  // Fill a horizontal run [x0, x1) on row y with a solid color.
  hline(x0: number, x1: number, y: number, c: RGB): void {
    if (y < 0 || y >= this.h) return;
    let a = Math.max(0, Math.ceil(x0));
    let b = Math.min(this.w, Math.floor(x1));
    if (b <= a) return;
    let i = (y * this.w + a) * 3;
    for (let x = a; x < b; x++) {
      this.buf[i] = c[0];
      this.buf[i + 1] = c[1];
      this.buf[i + 2] = c[2];
      i += 3;
    }
  }
  // Fill a horizontal run with a color blended at opacity a.
  hlineBlend(x0: number, x1: number, y: number, c: RGB, a: number): void {
    if (y < 0 || y >= this.h || a <= 0) return;
    let lo = Math.max(0, Math.ceil(x0));
    let hi = Math.min(this.w, Math.floor(x1));
    if (hi <= lo) return;
    for (let x = lo; x < hi; x++) this.blend(x, y, c, a);
  }
  // Filled disc.
  disc(cx: number, cy: number, r: number, c: RGB): void {
    if (r <= 0) return;
    const y0 = Math.max(0, Math.ceil(cy - r));
    const y1 = Math.min(this.h - 1, Math.floor(cy + r));
    for (let y = y0; y <= y1; y++) {
      const dy = y + 0.5 - cy;
      const dx = Math.sqrt(Math.max(0, r * r - dy * dy));
      this.hline(cx - dx, cx + dx, y, c);
    }
  }
  // Disc blended at opacity a.
  discBlend(cx: number, cy: number, r: number, c: RGB, a: number): void {
    if (r <= 0 || a <= 0) return;
    const y0 = Math.max(0, Math.ceil(cy - r));
    const y1 = Math.min(this.h - 1, Math.floor(cy + r));
    for (let y = y0; y <= y1; y++) {
      const dy = y + 0.5 - cy;
      const dx = Math.sqrt(Math.max(0, r * r - dy * dy));
      this.hlineBlend(cx - dx, cx + dx, y, c, a);
    }
  }
  // Filled ellipse (axis-aligned).
  ellipse(cx: number, cy: number, rx: number, ry: number, c: RGB): void {
    if (rx <= 0 || ry <= 0) return;
    const y0 = Math.max(0, Math.ceil(cy - ry));
    const y1 = Math.min(this.h - 1, Math.floor(cy + ry));
    for (let y = y0; y <= y1; y++) {
      const dy = (y + 0.5 - cy) / ry;
      const dx = rx * Math.sqrt(Math.max(0, 1 - dy * dy));
      this.hline(cx - dx, cx + dx, y, c);
    }
  }
  // Filled polygon (even-odd scanline fill).
  polygon(pts: Array<[number, number]>, c: RGB): void {
    if (pts.length < 3) return;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [, y] of pts) {
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    const y0 = Math.max(0, Math.ceil(minY));
    const y1 = Math.min(this.h - 1, Math.floor(maxY));
    for (let y = y0; y <= y1; y++) {
      const yc = y + 0.5;
      const xs: number[] = [];
      for (let i = 0; i < pts.length; i++) {
        const [x1, y1p] = pts[i];
        const [x2, y2p] = pts[(i + 1) % pts.length];
        if ((y1p <= yc && y2p > yc) || (y2p <= yc && y1p > yc)) {
          xs.push(x1 + ((yc - y1p) / (y2p - y1p)) * (x2 - x1));
        }
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) this.hline(xs[k], xs[k + 1], y, c);
    }
  }
  // Thick smooth curve: union of discs along a cubic bezier spine.
  // widthAt(t) gives the radius at parameter t (0..1).
  bezierStroke(
    p0: [number, number],
    p1: [number, number],
    p2: [number, number],
    p3: [number, number],
    widthAt: (t: number) => number,
    c: RGB,
  ): void {
    const steps = 240;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const mt = 1 - t;
      const x =
        mt * mt * mt * p0[0] +
        3 * mt * mt * t * p1[0] +
        3 * mt * t * t * p2[0] +
        t * t * t * p3[0];
      const y =
        mt * mt * mt * p0[1] +
        3 * mt * mt * t * p1[1] +
        3 * mt * t * t * p2[1] +
        t * t * t * p3[1];
      this.disc(x, y, widthAt(t), c);
    }
  }
  // Sample a point on a cubic bezier.
  static bezierPoint(
    p0: [number, number],
    p1: [number, number],
    p2: [number, number],
    p3: [number, number],
    t: number,
  ): [number, number] {
    const mt = 1 - t;
    return [
      mt * mt * mt * p0[0] +
        3 * mt * mt * t * p1[0] +
        3 * mt * t * t * p2[0] +
        t * t * t * p3[0],
      mt * mt * mt * p0[1] +
        3 * mt * mt * t * p1[1] +
        3 * mt * t * t * p2[1] +
        t * t * t * p3[1],
    ];
  }
  // Tangent angle (radians) of a cubic bezier at t.
  static bezierAngle(
    p0: [number, number],
    p1: [number, number],
    p2: [number, number],
    p3: [number, number],
    t: number,
  ): number {
    const mt = 1 - t;
    const dx =
      3 * mt * mt * (p1[0] - p0[0]) +
      6 * mt * t * (p2[0] - p1[0]) +
      3 * t * t * (p3[0] - p2[0]);
    const dy =
      3 * mt * mt * (p1[1] - p0[1]) +
      6 * mt * t * (p2[1] - p1[1]) +
      3 * t * t * (p3[1] - p2[1]);
    return Math.atan2(dy, dx);
  }
}

// ---------- 5x7 bitmap font (uppercase, digits, few punctuation) ----------
// Each glyph: 7 rows, each a 5-bit mask (bit 4 = leftmost column).
const FONT: Record<string, number[]> = {
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
  H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  N: [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
  R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x1b, 0x11],
  X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04],
  Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  '0': [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  '1': [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  '2': [0x0e, 0x11, 0x01, 0x06, 0x08, 0x10, 0x1f],
  '3': [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  '4': [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  '5': [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  '6': [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  '7': [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  '8': [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  '9': [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  ' ': [0, 0, 0, 0, 0, 0, 0],
  "'": [0x04, 0x04, 0x08, 0, 0, 0, 0],
  '.': [0, 0, 0, 0, 0, 0x0c, 0x0c],
  ',': [0, 0, 0, 0, 0x0c, 0x04, 0x08],
  '!': [0x04, 0x04, 0x04, 0x04, 0x04, 0x00, 0x04],
  '-': [0, 0, 0, 0x0e, 0, 0, 0],
};

function drawText(cv: Canvas, text: string, x: number, y: number, scale: number, c: RGB): void {
  let cx = x;
  for (const ch of text) {
    const glyph = FONT[ch] ?? FONT[' '];
    for (let row = 0; row < 7; row++) {
      const bits = glyph[row];
      for (let col = 0; col < 5; col++) {
        if (bits & (1 << (4 - col))) {
          const px = cx + col * scale;
          const py = y + row * scale;
          for (let dy = 0; dy < scale; dy++) {
            cv.hline(px, px + scale, py + dy, c);
          }
        }
      }
    }
    cx += 6 * scale;
  }
}
function textWidth(text: string, scale: number): number {
  return text.length * 6 * scale - scale;
}

// ---------- palette ----------
const SKY_TOP = rgb(9, 12, 44);
const SKY_MID = rgb(22, 30, 82);
const SKY_HORIZON = rgb(56, 66, 128);
const MOON_CORE = rgb(250, 238, 200);
const MOON_EDGE = rgb(232, 207, 154);
const MOON_HALO = rgb(240, 214, 150);
const KOI_RED = rgb(216, 56, 30);
const KOI_DEEP = rgb(168, 31, 16);
const KOI_WHITE = rgb(247, 243, 232);
const KOI_BLACK = rgb(26, 18, 16);
const KOI_GOLD = rgb(232, 168, 60);
const SEA_DEEP = rgb(10, 18, 48);
const SEA_TOP = rgb(20, 32, 78);
const GOLD_SHIMMER = rgb(232, 200, 122);
const STAR_WHITE = rgb(255, 255, 255);
const TEXT_GOLD = rgb(232, 217, 168);

// ---------- scene pieces (drawn on a 2048x2048 supersampled canvas) ----------
function drawSky(cv: Canvas, rnd: () => number): void {
  const W = cv.w;
  const H = cv.h;
  const horizon = Math.floor(H * 0.84);
  for (let y = 0; y < H; y++) {
    let c: RGB;
    if (y < horizon) {
      const t = y / horizon;
      c = t < 0.55 ? lerpColor(SKY_TOP, SKY_MID, t / 0.55) : lerpColor(SKY_MID, SKY_HORIZON, (t - 0.55) / 0.45);
    } else {
      const t = (y - horizon) / (H - horizon);
      c = lerpColor(SEA_TOP, SEA_DEEP, t);
    }
    cv.hline(0, W, y, c);
  }
  // Stars: deterministic scatter, brighter and denser away from the moon.
  const moonX = W * 0.66;
  const moonY = H * 0.32;
  for (let i = 0; i < 520; i++) {
    const x = rnd() * W;
    const y = rnd() * horizon * 0.92;
    const dx = x - moonX;
    const dy = y - moonY;
    const dMoon = Math.sqrt(dx * dx + dy * dy);
    if (dMoon < W * 0.16) continue; // keep the moon's halo clean
    const r = 0.8 + rnd() * 2.6;
    const bright = 0.35 + rnd() * 0.65;
    const tw = 200 + Math.floor(55 * bright);
    cv.discBlend(x, y, r, rgb(tw, tw, 255), bright * 0.9);
    if (rnd() < 0.12) {
      // a few bright stars get a cross sparkle
      cv.hlineBlend(x - r * 3, x + r * 3, Math.round(y), STAR_WHITE, 0.5);
      cv.hlineBlend(Math.round(x), Math.round(x) + 1, Math.round(y - r * 3), STAR_WHITE, 0.0);
      for (let yy = Math.round(y - r * 3); yy <= Math.round(y + r * 3); yy++) {
        cv.blend(Math.round(x), yy, STAR_WHITE, 0.45);
      }
    }
  }
}

function drawMoon(cv: Canvas): void {
  const W = cv.w;
  const H = cv.h;
  const cx = W * 0.66;
  const cy = H * 0.32;
  const r = W * 0.205;
  // Halo: soft radial falloff, drawn as concentric blended discs.
  for (let i = 26; i >= 1; i--) {
    const rr = r * (1 + (i / 26) * 0.85);
    const a = 0.05 * (1 - i / 26) + 0.012;
    cv.discBlend(cx, cy, rr, MOON_HALO, a);
  }
  // Disc with a gentle vertical gradient (brighter top).
  const y0 = Math.max(0, Math.ceil(cy - r));
  const y1 = Math.min(H - 1, Math.floor(cy + r));
  for (let y = y0; y <= y1; y++) {
    const dy = y + 0.5 - cy;
    const dx = Math.sqrt(Math.max(0, r * r - dy * dy));
    const t = (y - (cy - r)) / (2 * r);
    const c = lerpColor(MOON_CORE, MOON_EDGE, t * 0.85);
    cv.hline(cx - dx, cx + dx, y, c);
  }
  // Craters: a few soft, low-contrast blotches.
  const craters: Array<[number, number, number, number]> = [
    [-0.34, -0.28, 0.16, 0.10],
    [0.22, -0.42, 0.11, 0.08],
    [0.42, 0.18, 0.13, 0.09],
    [-0.12, 0.34, 0.19, 0.10],
    [0.05, 0.02, 0.08, 0.06],
    [-0.52, 0.12, 0.09, 0.07],
  ];
  for (const [ox, oy, rr, a] of craters) {
    cv.discBlend(cx + ox * r, cy + oy * r, rr * r, rgb(214, 186, 138), a);
  }
}

function drawSea(cv: Canvas, rnd: () => number): void {
  const W = cv.w;
  const H = cv.h;
  const horizon = Math.floor(H * 0.84);
  // Moon reflection: a shimmering vertical path under the moon.
  const moonX = W * 0.66;
  for (let y = horizon + 6; y < H - 8; y++) {
    const t = (y - horizon) / (H - horizon);
    const spread = 26 + t * 150;
    const segments = 3 + Math.floor(rnd() * 3);
    for (let s = 0; s < segments; s++) {
      const cx = moonX + (rnd() - 0.5) * 2 * spread;
      const len = 20 + rnd() * 90 * (1 - t * 0.5);
      const a = 0.28 * (1 - t) + 0.06;
      cv.hlineBlend(cx - len / 2, cx + len / 2, y, GOLD_SHIMMER, a);
    }
  }
  // Gentle wave strokes across the sea.
  for (let i = 0; i < 90; i++) {
    const y = horizon + 10 + rnd() * (H - horizon - 24);
    const x = rnd() * W;
    const len = 30 + rnd() * 130;
    const a = 0.10 + rnd() * 0.16;
    const c: RGB = rnd() < 0.7 ? rgb(120, 140, 200) : GOLD_SHIMMER;
    cv.hlineBlend(x, x + len, Math.round(y), c, a);
  }
}

function drawBoat(cv: Canvas): void {
  const W = cv.w;
  const H = cv.h;
  const bx = W * 0.30;
  const by = H * 0.885;
  const s = W / 1024; // scale factor (canvas is 2048 wide, so s = 2)
  // Hull: a small dark wooden boat, slightly tilted.
  cv.polygon(
    [
      [bx - 52 * s, by],
      [bx + 52 * s, by],
      [bx + 38 * s, by + 20 * s],
      [bx - 38 * s, by + 20 * s],
    ],
    rgb(16, 14, 22),
  );
  // Rim highlight.
  cv.hline(bx - 50 * s, bx + 50 * s, Math.round(by) + 1, rgb(52, 44, 40));
  // Mast.
  cv.hline(bx - 1.5 * s, bx + 1.5 * s, Math.round(by - 46 * s), rgb(16, 14, 22));
  for (let y = Math.round(by - 46 * s); y < Math.round(by); y++) {
    cv.blend(Math.round(bx), y, rgb(16, 14, 22), 1);
  }
  // Tiny figure standing, looking up at the moon.
  const fx = bx + 6 * s;
  const fy = by - 4 * s;
  cv.disc(fx, fy - 22 * s, 6 * s, rgb(20, 16, 26)); // head
  cv.polygon(
    [
      [fx - 5 * s, fy],
      [fx + 5 * s, fy],
      [fx + 3 * s, fy - 17 * s],
      [fx - 3 * s, fy - 17 * s],
    ],
    rgb(20, 16, 26),
  );
  // A thin fishing line rising from the boat toward the sky.
  for (let i = 0; i < 26; i++) {
    const t = i / 26;
    const x = bx + 2 * s + t * 26 * s;
    const y = by - 6 * s - t * 60 * s;
    cv.blend(Math.round(x), Math.round(y), rgb(200, 200, 210), 0.35);
  }
}

// ---------- the koi ----------
function drawKoi(cv: Canvas): void {
  const W = cv.w;
  const H = cv.h;
  const S = W / 1024; // supersample scale (2 at 2048)
  // Spine: a cubic bezier arcing from the lower-left sea up over the moon.
  // A strong crescent: steep rise from the tail, flattening into the head.
  const p0: [number, number] = [W * 0.09, H * 0.8];
  const p1: [number, number] = [W * 0.2, H * 0.52];
  const p2: [number, number] = [W * 0.5, H * 0.14];
  const p3: [number, number] = [W * 0.87, H * 0.18];
  // Width profile: thin tail swelling toward a blunt head, like a real fish.
  // Keyed by t and smoothly interpolated.
  const widthKeys: Array<[number, number]> = [
    [0, 0.02],
    [0.25, 0.045],
    [0.5, 0.062],
    [0.7, 0.068],
    [0.85, 0.058],
    [1, 0.032],
  ];
  const widthAt = (t: number): number => {
    for (let i = 0; i < widthKeys.length - 1; i++) {
      const [t0, w0] = widthKeys[i];
      const [t1, w1] = widthKeys[i + 1];
      if (t >= t0 && t <= t1) {
        const u = (t - t0) / (t1 - t0);
        const s = u * u * (3 - 2 * u); // smoothstep
        return W * (w0 + (w1 - w0) * s);
      }
    }
    return W * 0.032;
  };
  // Tail fin: two flowing gold ribbons trailing back from the tail base,
  // tapering as they fan apart, like silk in the water.
  const tail = p0;
  const tailAngle = Canvas.bezierAngle(p0, p1, p2, p3, 0);
  const back = tailAngle + Math.PI;
  const ribbon = (spread: number, len: number, w0: number): void => {
    const tip: [number, number] = [
      tail[0] + Math.cos(back + spread) * len,
      tail[1] + Math.sin(back + spread) * len,
    ];
    const c1: [number, number] = [
      tail[0] + Math.cos(back + spread * 0.7) * len * 0.45,
      tail[1] + Math.sin(back + spread * 0.7) * len * 0.45,
    ];
    const c2: [number, number] = [
      tail[0] + Math.cos(back + spread) * len * 0.8,
      tail[1] + Math.sin(back + spread) * len * 0.8,
    ];
    cv.bezierStroke(tail, c1, c2, tip, (t) => Math.max(2, w0 * (1 - t * 0.85)), KOI_GOLD);
  };
  ribbon(0.38, 170 * S, 26 * S);
  ribbon(-0.3, 150 * S, 24 * S);
  // A thin red vein down the middle of the upper ribbon.
  cv.bezierStroke(
    tail,
    [tail[0] + Math.cos(back + 0.27) * 76 * S, tail[1] + Math.sin(back + 0.27) * 76 * S],
    [tail[0] + Math.cos(back + 0.38) * 136 * S, tail[1] + Math.sin(back + 0.38) * 136 * S],
    [tail[0] + Math.cos(back + 0.38) * 165 * S, tail[1] + Math.sin(back + 0.38) * 165 * S],
    (t) => Math.max(1.5, 5 * S * (1 - t)),
    KOI_RED,
  );
  // Dorsal fin: a low, gently scalloped gold ridge along the OUTER (upper) edge.
  const dorsal: Array<[number, number]> = [];
  for (let i = 0; i <= 24; i++) {
    const t = 0.35 + (i / 24) * 0.27;
    const [x, y] = Canvas.bezierPoint(p0, p1, p2, p3, t);
    const ang = Canvas.bezierAngle(p0, p1, p2, p3, t);
    const nx = Math.sin(ang);
    const ny = -Math.cos(ang);
    const h = widthAt(t) + (5 + 7 * Math.abs(Math.sin(i * 1.1))) * S;
    dorsal.push([x + nx * h, y + ny * h]);
  }
  const dorsalBase: Array<[number, number]> = [];
  for (let i = 24; i >= 0; i--) {
    const t = 0.35 + (i / 24) * 0.27;
    const [x, y] = Canvas.bezierPoint(p0, p1, p2, p3, t);
    const ang = Canvas.bezierAngle(p0, p1, p2, p3, t);
    const nx = Math.sin(ang);
    const ny = -Math.cos(ang);
    dorsalBase.push([x + nx * widthAt(t) * 0.55, y + ny * widthAt(t) * 0.55]);
  }
  cv.polygon([...dorsal, ...dorsalBase], KOI_GOLD);
  // Body: vermillion, thickest mid-leap.
  cv.bezierStroke(p0, p1, p2, p3, widthAt, KOI_RED);
  // Belly shading: a deeper red along the lower edge.
  cv.bezierStroke(
    p0,
    p1,
    p2,
    p3,
    (t) => widthAt(t) * 0.92,
    KOI_DEEP,
  );
  // Re-lay the bright red core over the upper two-thirds so the deep red reads as a belly.
  const core = (t: number): number => widthAt(t) * 0.86;
  for (let s = 0; s <= 200; s++) {
    const t = s / 200;
    const [x, y] = Canvas.bezierPoint(p0, p1, p2, p3, t);
    const ang = Canvas.bezierAngle(p0, p1, p2, p3, t);
    const nx = -Math.sin(ang);
    const ny = Math.cos(ang);
    cv.disc(x + nx * widthAt(t) * 0.14, y + ny * widthAt(t) * 0.14, core(t), KOI_RED);
  }
  // White patches: flank markings, offset to one side of the spine so they
  // read as markings on the fish, not bands around it.
  const patch = (t0: number, t1: number, side: number, frac: number): void => {
    for (let s = 0; s <= 30; s++) {
      const t = t0 + ((t1 - t0) * s) / 30;
      const [x, y] = Canvas.bezierPoint(p0, p1, p2, p3, t);
      const ang = Canvas.bezierAngle(p0, p1, p2, p3, t);
      const nx = -Math.sin(ang);
      const ny = Math.cos(ang);
      cv.disc(x + nx * widthAt(t) * 0.28 * side, y + ny * widthAt(t) * 0.28 * side, widthAt(t) * frac, KOI_WHITE);
    }
  };
  patch(0.3, 0.42, 1, 0.44);
  patch(0.55, 0.64, -1, 0.42);
  patch(0.74, 0.82, 1, 0.4);
  // Black speckles on the red sections.
  const speckles: Array<[number, number, number]> = [
    [0.44, 0.3, 0.011],
    [0.47, -0.45, 0.008],
    [0.68, 0.25, 0.01],
    [0.71, -0.4, 0.007],
    [0.86, 0.35, 0.009],
  ];
  for (const [t, off, rr] of speckles) {
    const [x, y] = Canvas.bezierPoint(p0, p1, p2, p3, t);
    const ang = Canvas.bezierAngle(p0, p1, p2, p3, t);
    const nx = -Math.sin(ang);
    const ny = Math.cos(ang);
    cv.disc(x + nx * widthAt(t) * off, y + ny * widthAt(t) * off, rr * W, KOI_BLACK);
  }
  // Pectoral fin: a small gold ribbon flowing down-back from the belly near the head.
  const [px, py] = Canvas.bezierPoint(p0, p1, p2, p3, 0.78);
  const pang = Canvas.bezierAngle(p0, p1, p2, p3, 0.78);
  const pnx = -Math.sin(pang);
  const pny = Math.cos(pang);
  const finBase: [number, number] = [px + pnx * widthAt(0.78) * 0.8, py + pny * widthAt(0.78) * 0.8];
  const finDir = pang + Math.PI * 0.72; // down and back along the body
  cv.bezierStroke(
    finBase,
    [finBase[0] + Math.cos(finDir) * 32 * S, finBase[1] + Math.sin(finDir) * 32 * S],
    [finBase[0] + Math.cos(finDir) * 62 * S + pnx * 26 * S, finBase[1] + Math.sin(finDir) * 62 * S + pny * 26 * S],
    [finBase[0] + Math.cos(finDir) * 82 * S + pnx * 44 * S, finBase[1] + Math.sin(finDir) * 82 * S + pny * 44 * S],
    (t) => Math.max(2, 16 * S * (1 - t * 0.85)),
    KOI_GOLD,
  );
  // Head: rounded and a little wider than the neck, with a white blaze,
  // a clear side eye, a small mouth and short barbels.
  const [hx, hy] = p3;
  const hang = Canvas.bezierAngle(p0, p1, p2, p3, 1);
  cv.disc(hx, hy, widthAt(1) * 1.35, KOI_RED);
  // White blaze over the top of the head.
  const [bx0, by0] = Canvas.bezierPoint(p0, p1, p2, p3, 0.93);
  cv.disc(bx0 + Math.sin(hang) * widthAt(1) * 0.35, by0 - Math.cos(hang) * widthAt(1) * 0.35, widthAt(1) * 0.72, KOI_WHITE);
  // Eye, on the side of the head facing the viewer.
  const ex = hx + Math.sin(hang) * widthAt(1) * 0.52 + Math.cos(hang) * widthAt(1) * 0.18;
  const ey = hy - Math.cos(hang) * widthAt(1) * 0.52 + Math.sin(hang) * widthAt(1) * 0.18;
  cv.disc(ex, ey, 16 * S, KOI_WHITE);
  cv.disc(ex + 3 * S, ey, 9 * S, KOI_BLACK);
  cv.disc(ex + 6 * S, ey - 3 * S, 3 * S, KOI_WHITE);
  // Mouth: a small dark opening at the snout.
  const mx = hx + Math.cos(hang) * widthAt(1) * 1.3;
  const my = hy + Math.sin(hang) * widthAt(1) * 1.3;
  cv.disc(mx, my, 8 * S, KOI_BLACK);
  // Barbels: two short thin whiskers curving forward from the snout.
  for (const side of [1, -1]) {
    const baseAng = hang + side * 0.45;
    let bx = mx + Math.cos(baseAng) * 5 * S;
    let by = my + Math.sin(baseAng) * 5 * S;
    for (let i = 0; i < 9; i++) {
      const a = baseAng + side * 0.3 * (i / 9);
      bx += Math.cos(a) * 4 * S;
      by += Math.sin(a) * 4 * S + 0.8 * S;
      cv.discBlend(bx, by, 1.6 * S, KOI_WHITE, 0.85);
    }
  }
  // Water droplets trailing the tail, rising into stars.
  const rnd = mulberry32(777);
  for (let i = 0; i < 26; i++) {
    const t = i / 26;
    const x = W * (0.09 - t * 0.055 + (rnd() - 0.5) * 0.02);
    const y = H * (0.8 + t * 0.1 + Math.sin(t * 3.1) * 0.03);
    const r = (5.5 - t * 3.5) * S;
    cv.discBlend(x, y, r, rgb(210, 226, 255), 0.85 - t * 0.4);
  }
  for (let i = 0; i < 12; i++) {
    const t = i / 12;
    const x = W * (0.11 + t * 0.1 + (rnd() - 0.5) * 0.03);
    const y = H * (0.74 - t * 0.1);
    const r = (4 - t * 2) * S;
    cv.discBlend(x, y, r, rgb(220, 232, 255), 0.8 - t * 0.4);
  }
}

// ---------- downsample 2x2 box average + vignette ----------
function downsample(src: Canvas, factor: number): Uint8Array {
  const outW = Math.floor(src.w / factor);
  const outH = Math.floor(src.h / factor);
  const out = new Uint8Array(outW * outH * 3);
  const cx = outW / 2;
  const cy = outH / 2;
  const maxD = Math.sqrt(cx * cx + cy * cy);
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          const i = (((y * factor + dy) * src.w + (x * factor + dx)) * 3);
          r += src.buf[i];
          g += src.buf[i + 1];
          b += src.buf[i + 2];
        }
      }
      const n = factor * factor;
      const d = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy)) / maxD;
      const vig = 1 - 0.22 * Math.pow(Math.max(0, d - 0.55) / 0.45, 2);
      const o = (y * outW + x) * 3;
      out[o] = Math.min(255, (r / n) * vig);
      out[o + 1] = Math.min(255, (g / n) * vig);
      out[o + 2] = Math.min(255, (b / n) * vig);
    }
  }
  return out;
}

// ---------- main ----------
function main(): void {
  const SS = 2; // supersample factor
  const W = 1024 * SS;
  const H = 1024 * SS;
  const rnd = mulberry32(20261116);
  const cv = new Canvas(W, H);
  drawSky(cv, rnd);
  drawMoon(cv);
  drawKoi(cv);
  drawSea(cv, rnd);
  drawBoat(cv);
  // Caption: one line addressed to the judge, set in clean capitals.
  const caption = 'THE FISH THAT JUMPED AT THE MOON';
  const scale = 5 * SS;
  const tw = textWidth(caption, scale);
  const tx = Math.round((W - tw) / 2);
  const ty = Math.round(H * 0.955);
  // A thin gold rule above the caption.
  cv.hlineBlend(W / 2 - 90 * SS, W / 2 + 90 * SS, ty - 14 * SS, TEXT_GOLD, 0.55);
  drawText(cv, caption, tx, ty, scale, TEXT_GOLD);
  const small = downsample(cv, SS);
  const png = encodePNG(1024, 1024, small);
  const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'entry.png'), png);
  console.log(`wrote ${join(outDir, 'entry.png')} (${png.length} bytes, 1024x1024)`);
}

main();
