// Scancat unit tests for the pure algorithms (node, no browser).
//   node unit.mjs            run
//   DEBUG=1 node unit.mjs    also write PNG snapshots to fixtures/

import * as V from "../js/vision.js";
import { buildPdf } from "../js/pdf.js";
import { renderFrame, defaultCorners, toPNG } from "./synth.mjs";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, "fixtures");
fs.mkdirSync(FIX, { recursive: true });
const DEBUG = !!process.env.DEBUG;

let failures = 0, passes = 0;
function test(name, fn) {
  try { fn(); passes++; console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}
function assert(c, m) { if (!c) throw new Error(m); }

function cornerError(got, want) {
  let worst = 0;
  for (let i = 0; i < 4; i++) worst = Math.max(worst, Math.hypot(got[i][0] - want[i][0], got[i][1] - want[i][1]));
  return worst;
}

const FW = 1280, FH = 720, DW = 384;

function detectOn(frame) {
  const small = V.boxDownscale(frame.data, frame.w, frame.h, DW);
  const t0 = performance.now();
  const q = V.detectDocument(small.data, small.w, small.h);
  const ms = performance.now() - t0;
  const f = frame.w / small.w;
  return { q, ms, small, corners: q ? q.corners.map(([x, y]) => [x * f, y * f]) : null };
}

console.log("detection");
for (let variant = 0; variant < 3; variant++) {
  for (const hand of [false, true]) {
    test(`finds the page (pose ${variant}, hand ${hand ? "on" : "off"})`, () => {
      const corners = defaultCorners(FW, FH, variant);
      const frame = renderFrame({ w: FW, h: FH, corners, hand, seed: variant * 7 + 1 });
      const r = detectOn(frame);
      if (DEBUG) fs.writeFileSync(path.join(FIX, `synth-${variant}-${hand ? "hand" : "nohand"}.png`), toPNG(frame.data, FW, FH));
      assert(r.q, "no quad found");
      const err = cornerError(r.corners, corners);
      assert(err < 12, `corner error ${err.toFixed(1)}px (score ${r.q.score.toFixed(2)}, support ${r.q.support.toFixed(2)})`);
      assert(r.ms < 120, `too slow: ${r.ms.toFixed(0)} ms`);
    });
  }
}

test("no quad on a blank noisy wall", () => {
  const data = new Uint8ClampedArray(DW * 216 * 4);
  let s = 3;
  for (let i = 0; i < data.length; i += 4) { s = (s * 1103515245 + 12345) & 0x7fffffff; const v = 120 + (s % 11); data[i] = data[i + 1] = data[i + 2] = v; data[i + 3] = 255; }
  const q = V.detectDocument(data, DW, 216);
  assert(!q, `found a quad with score ${q?.score}`);
});

test("no quad when the page runs off the frame", () => {
  const corners = [[0.3 * FW, -0.2 * FH], [0.8 * FW, -0.15 * FH], [0.85 * FW, 1.2 * FH], [0.25 * FW, 1.25 * FH]];
  const frame = renderFrame({ w: FW, h: FH, corners, hand: false, seed: 9 });
  const r = detectOn(frame);
  assert(!r.q || r.q.areaFrac < 0.5, `found a quad covering ${r.q?.areaFrac}`);
});

console.log("warp");
test("receipt mode detects a narrow strip below the normal area threshold", () => {
  const w = 384, h = 216, corners = [[70, 55], [290, 65], [289, 80], [69, 70]];
  const frame = renderFrame({ w, h, corners, hand: false, docW: 300, docH: 40, gradient: 0.1 });
  const q = V.detectDocument(frame.data, w, h, { receipt: true, minArea: 0.015, minSep: 0.04, lineThreshold: 0.06, lineLength: 0.03, maxLines: 24 });
  assert(q, "receipt not found");
  // Includes the intentional 2.5% end margin plus the downsampled border.
  assert(cornerError(q.corners, corners) < 12, `receipt outline is inaccurate: ${cornerError(q.corners, corners)}`);
});

test("receipt enhancement keeps faint print visible across uneven paper lighting", () => {
  const w = 200, h = 100, d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const paper = 180 + x * 0.3, ink = y >= 49 && y <= 50;
    const i = (y * w + x) * 4;
    d[i] = d[i + 1] = d[i + 2] = paper * (ink ? 0.9 : 1); d[i + 3] = 255;
  }
  const out = V.enhance(d, w, h, "receipt");
  const gentle = V.enhance(d, w, h, "receipt", 0, 2);
  const stronger = V.enhance(d, w, h, "receipt", 0, 6);
  assert(stronger[(50 * w + 100) * 4] < gentle[(50 * w + 100) * 4], "receipt contrast must darken faint strokes");
  for (const x of [20, 100, 180]) {
    const paper = out[(40 * w + x) * 4], ink = out[(50 * w + x) * 4];
    assert(paper > 240 && paper - ink > 40, `faint ink lost at ${x}: ${paper}, ${ink}`);
  }
});

test("receipt mode detects a small nearly square ticket", () => {
  const w = 384, h = 216, corners = [[180, 110], [238, 110], [238, 156], [180, 156]];
  const frame = renderFrame({ w, h, corners, hand: false, docW: 80, docH: 65, bgLevel: 40, gradient: 0.15 });
  const q = V.detectDocument(frame.data, w, h, { receipt: true });
  assert(q, "small square receipt missing");
  assert(cornerError(q.corners, corners) < 10, "small receipt outline inaccurate");
});

test("multiple receipt detection returns separate outlines without brightness-threshold duplicates", () => {
  const w = 384, h = 216, data = new Uint8ClampedArray(w * h * 4);
  const papers = [[35, 40, 85, 160], [160, 80, 230, 140], [280, 35, 340, 180]];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const paper = papers.some(([x0, y0, x1, y1]) => x >= x0 && x <= x1 && y >= y0 && y <= y1);
    const v = paper ? 220 : 45, i = (y * w + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = v; data[i + 3] = 255;
  }
  const found = V.detectDocuments(data, w, h, { receipt: true });
  assert(found.length === 3, `expected three receipts, found ${found.length}`);
  for (let i = 0; i < papers.length; i++) {
    const [x0, y0, x1, y1] = papers[i];
    assert(cornerError(found[i].corners, [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) < 8, `receipt ${i + 1} outline inaccurate`);
  }
  data.fill(45);
  assert(V.detectDocuments(data, w, h, { receipt: true }).length === 0, "blank desk produces phantom receipts");
});

test("receipt crop encloses every folded edge instead of cutting off protrusions", () => {
  const boundary = [[30, 20], [110, 25], [120, 30], [115, 42], [80, 39], [65, 46], [25, 35]];
  const box = V.enclosingReceiptBox(boundary);
  assert(box.length === 4, "missing enclosing box");
  for (const [x, y] of boundary) {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = box[i], b = box[(i + 1) % 4];
      const side = Math.sign((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]));
      if (sign && side) assert(sign === side, `paper edge ${x},${y} lies outside crop`);
      if (side) sign = side;
    }
  }
});

test("sharpening increases soft stroke contrast and leaves flat paper unchanged", () => {
  const w = 32, h = 24, d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = x === 15 ? 100 : x === 14 || x === 16 ? 140 : x === 13 || x === 17 ? 190 : 220;
    const i = (y * w + x) * 4; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
  }
  const out = V.sharpen(d, w, h, 1);
  const at = (buf, x) => buf[(12 * w + x) * 4];
  assert(at(out, 15) < at(d, 15), "soft stroke was not strengthened");
  assert(at(out, 3) === at(d, 3), "flat paper changed");
  assert(out.every((v, i) => i % 4 !== 3 || v === 255), "alpha changed");
  assert(V.sharpen(d, w, h, 0).every((v, i) => v === d[i]), "off must preserve pixels");
});

test("receipt cleanup separates fine print from a broad crease shadow", () => {
  const w = 200, h = 100, data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const paper = 220 - 40 * Math.exp(-(((y - 55) / 12) ** 2));
    const v = paper * (y >= 29 && y <= 30 && x > 20 && x < 180 ? 0.85 : 1);
    const i = (y * w + x) * 4; data[i] = data[i + 1] = data[i + 2] = v; data[i + 3] = 255;
  }
  const out = V.enhance(data, w, h, "receipt", 0, 3);
  assert(out[(55 * w + 100) * 4] > 190, "broad shadow was treated as dark ink");
  assert(out[(30 * w + 100) * 4] < 150, "fine print was not strengthened");
});

test("homography round-trips the four corners", () => {
  const src = [[0, 0], [100, 0], [100, 150], [0, 150]];
  const dst = [[30, 20], [220, 40], [240, 300], [10, 280]];
  const H = V.homography(src, dst);
  for (let i = 0; i < 4; i++) {
    const p = V.applyH(H, src[i][0], src[i][1]);
    assert(Math.hypot(p[0] - dst[i][0], p[1] - dst[i][1]) < 1e-6, `corner ${i} off`);
  }
});

test("warping the detected quad recovers the page (text lines straight, paper white)", () => {
  const corners = defaultCorners(FW, FH, 1);
  const frame = renderFrame({ w: FW, h: FH, corners, hand: true, seed: 5 });
  const r = detectOn(frame);
  assert(r.q, "no quad");
  const { w, h } = V.outputSize(r.corners, 1200);
  const out = V.warp(frame.data, FW, FH, r.corners, w, h);
  // heading block sits at u∈[20,120] v∈[18,30] mm → dark; paper at v=35mm → bright
  const px = (u, v) => { const o = (Math.round((v / 297) * h) * w + Math.round((u / 210) * w)) * 4; return out[o]; };
  assert(px(70, 24) < 90, `heading not dark: ${px(70, 24)}`);
  assert(px(70, 35) > 150, `paper not bright: ${px(70, 35)}`);
  assert(px(190, 35) > 90, `shaded paper too dark: ${px(190, 35)}`);
  if (DEBUG) fs.writeFileSync(path.join(FIX, "warped-original.png"), toPNG(out, w, h));
  // enhancement modes
  for (const mode of V.MODES) {
    const e = V.enhance(out, w, h, mode);
    if (DEBUG) fs.writeFileSync(path.join(FIX, `warped-${mode}.png`), toPNG(e, w, h));
    const at = (u, v) => { const o = (Math.round((v / 297) * h) * w + Math.round((u / 210) * w)) * 4; return e[o]; };
    if (mode !== "original") {
      assert(at(70, 35) > 235 && at(190, 35) > 235, `${mode}: paper should be flat white (${at(70, 35)}, ${at(190, 35)})`);
      assert(at(70, 24) < 60, `${mode}: heading should be dark (${at(70, 24)})`);
    }
    if (mode === "bw") assert(new Set(Array.from(e.filter((_, i) => i % 4 === 0))).size === 2, "bw should be two-level");
  }
});

test("rotate 90° moves the top-left pixel to the top-right", () => {
  const d = new Uint8ClampedArray(2 * 3 * 4);
  d.set([255, 0, 0, 255], 0);
  const r = V.rotate(d, 2, 3, 1);
  assert(r.w === 3 && r.h === 2, "size");
  assert(r.data[(0 * 3 + 2) * 4] === 255, "pixel position");
});

console.log("pdf");
test("builds a multi-page PDF with a valid xref", () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
  const bytes = buildPdf([{ jpeg, width: 800, height: 1100 }, { jpeg, width: 1100, height: 800 }], { pageSize: "fit", title: "test" });
  const txt = new TextDecoder("latin1").decode(bytes);
  assert(txt.startsWith("%PDF-1.4"), "header");
  assert(txt.includes("/Count 2"), "page count");
  assert(txt.includes("/Filter /DCTDecode"), "jpeg filter");
  const m = txt.match(/startxref\n(\d+)\n%%EOF\n?$/);
  assert(m, "trailer");
  assert(txt.slice(+m[1], +m[1] + 4) === "xref", "startxref points at the xref table");
  // every xref offset must point at "N 0 obj"
  const xref = txt.slice(+m[1]);
  const lines = xref.split("\n");
  const count = +lines[1].split(" ")[1];
  for (let i = 1; i < count; i++) {
    const off = +lines[2 + i].slice(0, 10);
    assert(txt.slice(off, off + 20).startsWith(`${i} 0 obj`), `xref entry ${i} → "${txt.slice(off, off + 12)}"`);
  }
});

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
