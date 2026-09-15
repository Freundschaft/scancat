// Synthetic webcam frames with a known document quad — used by the node unit
// tests and to build the fake-camera video for the browser suite.

import { homography, applyH } from "../js/vision.js";

/** Deterministic PRNG (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Render a frame: a white page (with "text" lines and a dark heading block)
 * mapped onto `corners` (TL,TR,BR,BL in frame pixels), over a shaded, noisy
 * dark background, optionally with a skin-toned "hand" blob at the bottom
 * edge and a lighting gradient across the page.
 */
export function renderFrame({ w, h, corners, hand = true, seed = 1, docW = 210, docH = 297, bgLevel = 70, gradient = 0.35 }) {
  const rnd = rng(seed);
  const data = new Uint8ClampedArray(w * h * 4);
  const H = homography(corners, [[0, 0], [docW, 0], [docW, docH], [0, docH]]);
  // hand: ellipse around the middle of the bottom edge, overlapping the page
  const bl = corners[3], br = corners[2];
  const hx = (bl[0] + br[0]) / 2, hy = (bl[1] + br[1]) / 2;
  const hrx = Math.hypot(br[0] - bl[0], br[1] - bl[1]) * 0.12, hry = h * 0.12;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      let r, g, b;
      const [u, v] = applyH(H, x + 0.5, y + 0.5);
      const inDoc = u >= 0 && u < docW && v >= 0 && v < docH;
      if (inDoc) {
        // paper with lighting falloff left→right and top→bottom
        let paper = 245 - gradient * 120 * (u / docW) - gradient * 40 * (v / docH);
        let ink = false;
        // heading block
        if (u > 20 && u < 120 && v > 18 && v < 30) ink = true;
        // text lines: 4 mm pitch, 2 mm tall, ragged right, word gaps
        const line = Math.floor((v - 40) / 5);
        const inLine = v > 40 && (v - 40) % 5 < 2 && line >= 0 && line < 48 && u > 20;
        if (inLine) {
          const len = 170 - (line % 7) * 12;
          const gap = Math.floor(u / 9) % 5 === 4;
          if (u < len && !gap) ink = true;
        }
        const val = ink ? paper * 0.14 : paper;
        r = val; g = val; b = val * 0.97;
      } else {
        // background: dark, brighter towards the top-right, with a subtle desk edge
        const bgv = bgLevel + 40 * (x / w) * (1 - y / h) + (y > h * 0.86 ? 25 : 0);
        r = bgv * 0.95; g = bgv; b = bgv * 1.05;
      }
      if (hand) {
        const dx = (x - hx) / hrx, dy = (y - hy) / hry;
        if (dx * dx + dy * dy < 1) { r = 205; g = 150; b = 120; }
      }
      const nz = (rnd() - 0.5) * 10;
      data[o] = r + nz; data[o + 1] = g + nz; data[o + 2] = b + nz; data[o + 3] = 255;
    }
  }
  return { data, w, h, corners };
}

/** A tilted, slightly rotated A4 page held in a 16:9 frame. */
export function defaultCorners(w, h, variant = 0) {
  const sets = [
    [[0.28, 0.08], [0.66, 0.11], [0.71, 0.93], [0.24, 0.90]],
    [[0.33, 0.15], [0.74, 0.06], [0.78, 0.86], [0.30, 0.95]],
    [[0.20, 0.20], [0.55, 0.22], [0.54, 0.78], [0.19, 0.80]],
  ];
  return sets[variant % sets.length].map(([fx, fy]) => [fx * w, fy * h]);
}

/** Write frames (RGBA) as a Y4M video Chrome can use as a fake camera. */
export function toY4M(frames, w, h, fps = 15) {
  const header = Buffer.from(`YUV4MPEG2 W${w} H${h} F${fps}:1 Ip A1:1 C420jpeg\n`);
  const parts = [header];
  const cw = w >> 1, ch = h >> 1;
  for (const f of frames) {
    const Y = Buffer.alloc(w * h), U = Buffer.alloc(cw * ch), Vp = Buffer.alloc(cw * ch);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4, r = f[o], g = f[o + 1], b = f[o + 2];
        Y[y * w + x] = Math.max(0, Math.min(255, 0.257 * r + 0.504 * g + 0.098 * b + 16));
        if (!(x & 1) && !(y & 1)) {
          const c = (y >> 1) * cw + (x >> 1);
          U[c] = Math.max(0, Math.min(255, -0.148 * r - 0.291 * g + 0.439 * b + 128));
          Vp[c] = Math.max(0, Math.min(255, 0.439 * r - 0.368 * g - 0.071 * b + 128));
        }
      }
    }
    parts.push(Buffer.from("FRAME\n"), Y, U, Vp);
  }
  return Buffer.concat(parts);
}

/** Minimal uncompressed-ish PNG writer (stored deflate blocks) for debug shots. */
export function toPNG(data, w, h) {
  const { deflateSync } = require_zlib();
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(data.buffer, data.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const chunks = [];
  const chunk = (type, body) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
    const tb = Buffer.concat([Buffer.from(type), body]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(tb) >>> 0);
    chunks.push(len, tb, crc);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  chunk("IHDR", ihdr);
  chunk("IDAT", deflateSync(raw));
  chunk("IEND", Buffer.alloc(0));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ...chunks]);
}

import { createRequire } from "node:module";
function require_zlib() { return createRequire(import.meta.url)("node:zlib"); }

let CRC_TABLE;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c;
}
