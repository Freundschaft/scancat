// Scancat — pure image algorithms. No DOM, no dependencies; runs in the page,
// in a worker, and in node (tests). All images are RGBA Uint8ClampedArrays
// unless noted; "gray" buffers are Float32Arrays in 0..255.

/* ------------------------------------------------------------------ */
/* basics                                                              */
/* ------------------------------------------------------------------ */

export function grayFromRGBA(data, w, h) {
  const g = new Float32Array(w * h);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) {
    g[i] = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
  }
  return g;
}

/** Box-average downscale of an RGBA image to width tw (integer factor). */
export function boxDownscale(data, w, h, tw) {
  const f = Math.max(1, Math.round(w / tw));
  const ow = Math.floor(w / f), oh = Math.floor(h / f);
  const out = new Uint8ClampedArray(ow * oh * 4);
  const n = f * f;
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      let r = 0, g = 0, b = 0;
      for (let dy = 0; dy < f; dy++) {
        let p = ((y * f + dy) * w + x * f) * 4;
        for (let dx = 0; dx < f; dx++, p += 4) { r += data[p]; g += data[p + 1]; b += data[p + 2]; }
      }
      const o = (y * ow + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  return { data: out, w: ow, h: oh };
}

/** Separable 5-tap gaussian blur. */
export function blur5(src, w, h) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const xm2 = x < 2 ? 0 : x - 2, xm1 = x < 1 ? 0 : x - 1;
      const xp1 = x + 1 >= w ? w - 1 : x + 1, xp2 = x + 2 >= w ? w - 1 : x + 2;
      tmp[row + x] = (src[row + xm2] + 4 * src[row + xm1] + 6 * src[row + x] + 4 * src[row + xp1] + src[row + xp2]) / 16;
    }
  }
  for (let y = 0; y < h; y++) {
    const ym2 = (y < 2 ? 0 : y - 2) * w, ym1 = (y < 1 ? 0 : y - 1) * w;
    const yp1 = (y + 1 >= h ? h - 1 : y + 1) * w, yp2 = (y + 2 >= h ? h - 1 : y + 2) * w;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      out[row + x] = (tmp[ym2 + x] + 4 * tmp[ym1 + x] + 6 * tmp[row + x] + 4 * tmp[yp1 + x] + tmp[yp2 + x]) / 16;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* edges: Sobel → non-maximum suppression → hysteresis (Canny-lite)    */
/* ------------------------------------------------------------------ */

export function sobel(g, w, h) {
  const n = w * h;
  const gx = new Float32Array(n), gy = new Float32Array(n), mag = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const a = g[i - w - 1], b = g[i - w], c = g[i - w + 1];
      const d = g[i - 1], f = g[i + 1];
      const p = g[i + w - 1], q = g[i + w], r = g[i + w + 1];
      const sx = (c + 2 * f + r) - (a + 2 * d + p);
      const sy = (p + 2 * q + r) - (a + 2 * b + c);
      gx[i] = sx; gy[i] = sy; mag[i] = Math.hypot(sx, sy) / 4;
    }
  }
  return { gx, gy, mag };
}

function percentile(arr, frac, maxVal = 512) {
  const hist = new Int32Array(maxVal + 1);
  for (let i = 0; i < arr.length; i++) { let v = arr[i] | 0; if (v > maxVal) v = maxVal; hist[v]++; }
  const target = frac * arr.length;
  let acc = 0;
  for (let v = 0; v <= maxVal; v++) { acc += hist[v]; if (acc >= target) return v; }
  return maxVal;
}

/**
 * Binary edge map. Thresholds adapt to the frame: the high threshold is the
 * 93rd percentile of gradient magnitude, clamped so a blank wall doesn't
 * light up and a high-contrast desk doesn't drown the page border.
 */
export function edges(gray, w, h, opts = {}) {
  const g = blur5(gray, w, h);
  const { gx, gy, mag } = sobel(g, w, h);
  let hi = opts.hi ?? Math.min(70, Math.max(7, percentile(mag, 0.93)));
  const lo = opts.lo ?? hi * 0.4;
  const n = w * h;
  const nms = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x, m = mag[i];
      if (m < lo) continue;
      const ax = Math.abs(gx[i]), ay = Math.abs(gy[i]);
      let n1, n2;
      if (ax > 2.414 * ay) { n1 = mag[i - 1]; n2 = mag[i + 1]; }
      else if (ay > 2.414 * ax) { n1 = mag[i - w]; n2 = mag[i + w]; }
      else if (gx[i] * gy[i] > 0) { n1 = mag[i - w - 1]; n2 = mag[i + w + 1]; }
      else { n1 = mag[i - w + 1]; n2 = mag[i + w - 1]; }
      if (m >= n1 && m >= n2) nms[i] = m;
    }
  }
  const edge = new Uint8Array(n);
  const stack = new Int32Array(n);
  let sp = 0;
  for (let i = 0; i < n; i++) if (nms[i] >= hi) { edge[i] = 1; stack[sp++] = i; }
  while (sp > 0) {
    const i = stack[--sp];
    const x = i % w, y = (i - x) / w;
    for (let dy = -1; dy <= 1; dy++) {
      if (y + dy <= 0 || y + dy >= h - 1) continue;
      for (let dx = -1; dx <= 1; dx++) {
        if (x + dx <= 0 || x + dx >= w - 1) continue;
        const j = i + dy * w + dx;
        if (!edge[j] && nms[j] >= lo) { edge[j] = 1; stack[sp++] = j; }
      }
    }
  }
  return { edge, gx, gy, hi, lo };
}

/* ------------------------------------------------------------------ */
/* Hough lines (gradient-guided)                                       */
/* ------------------------------------------------------------------ */

const DEG = Math.PI / 180;
const COS = new Float32Array(180), SIN = new Float32Array(180);
for (let t = 0; t < 180; t++) { COS[t] = Math.cos(t * DEG); SIN[t] = Math.sin(t * DEG); }

/**
 * Lines in normal form x·cosθ + y·sinθ = ρ, θ in [0, π). Each edge pixel
 * votes only for angles near its gradient direction, which makes peaks
 * sharp and cheap. Returns up to maxLines peaks, strongest first.
 */
export function houghLines(edge, gx, gy, w, h, opts = {}) {
  const maxLines = opts.maxLines ?? 18, win = opts.window ?? 12;
  const D = Math.ceil(Math.hypot(w, h));
  const nR = 2 * D + 1;
  const acc = new Int32Array(nR * 180);
  let edgeCount = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!edge[i]) continue;
      edgeCount++;
      let phi = Math.atan2(gy[i], gx[i]) / DEG;
      if (phi < 0) phi += 180;
      if (phi >= 180) phi -= 180;
      const c = Math.round(phi);
      for (let dt = -win; dt <= win; dt++) {
        let t = c + dt;
        if (t < 0) t += 180; else if (t >= 180) t -= 180;
        const r = Math.round(x * COS[t] + y * SIN[t]) + D;
        acc[r * 180 + t]++;
      }
    }
  }
  if (!edgeCount) return [];
  let max = 0;
  for (let i = 0; i < acc.length; i++) if (acc[i] > max) max = acc[i];
  const thr = Math.max(Math.round(max * 0.18), Math.round(Math.min(w, h) * 0.08));
  const cands = [];
  for (let r = 0; r < nR; r++) {
    for (let t = 0; t < 180; t++) {
      const v = acc[r * 180 + t];
      if (v < thr) continue;
      // local max in a 3x3 (rho, theta) window
      let isMax = true;
      for (let dr = -1; dr <= 1 && isMax; dr++) {
        const rr = r + dr; if (rr < 0 || rr >= nR) continue;
        for (let dt = -1; dt <= 1; dt++) {
          let tt = t + dt; if (tt < 0) tt += 180; else if (tt >= 180) tt -= 180;
          if ((dr || dt) && acc[rr * 180 + tt] > v) { isMax = false; break; }
        }
      }
      if (isMax) cands.push({ rho: r - D, t, votes: v });
    }
  }
  cands.sort((a, b) => b.votes - a.votes);
  const out = [];
  const sep = Math.max(6, Math.round(Math.min(w, h) * 0.03));
  for (const c of cands) {
    let dup = false;
    for (const o of out) {
      let dt = Math.abs(c.t - o.t), dr = Math.abs(c.rho - o.rho);
      if (dt > 90) { dt = 180 - dt; dr = Math.abs(c.rho + o.rho); }
      if (dt <= 6 && dr <= sep) { dup = true; break; }
    }
    if (!dup) { out.push({ rho: c.rho, theta: c.t * DEG, votes: c.votes }); if (out.length >= maxLines) break; }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* quad search                                                         */
/* ------------------------------------------------------------------ */

function intersect(a, b) {
  const c1 = Math.cos(a.theta), s1 = Math.sin(a.theta), c2 = Math.cos(b.theta), s2 = Math.sin(b.theta);
  const det = c1 * s2 - s1 * c2;
  if (Math.abs(det) < 1e-6) return null;
  return [(a.rho * s2 - b.rho * s1) / det, (c1 * b.rho - c2 * a.rho) / det];
}

function angleDiff(a, b) {
  let d = Math.abs(a - b) % Math.PI;
  return d > Math.PI / 2 ? Math.PI - d : d;
}

function polyArea(p) {
  let s = 0;
  for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1]; }
  return s / 2;
}

/** Corners ordered top-left, top-right, bottom-right, bottom-left. */
export function orderCorners(pts) {
  const cx = (pts[0][0] + pts[1][0] + pts[2][0] + pts[3][0]) / 4;
  const cy = (pts[0][1] + pts[1][1] + pts[2][1] + pts[3][1]) / 4;
  const s = pts.map((p) => ({ p, a: Math.atan2(p[1] - cy, p[0] - cx) })).sort((u, v) => u.a - v.a).map((o) => o.p);
  // s is clockwise in image coords (y down). Rotate so the first is top-left (min x+y).
  let k = 0, best = Infinity;
  for (let i = 0; i < 4; i++) { const v = s[i][0] + s[i][1]; if (v < best) { best = v; k = i; } }
  return [s[k], s[(k + 1) % 4], s[(k + 2) % 4], s[(k + 3) % 4]];
}

function dilate(edge, w, h, r) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!edge[y * w + x]) continue;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx; if (xx < 0 || xx >= w) continue;
          out[yy * w + xx] = 1;
        }
      }
    }
  }
  return out;
}

function sideSupport(sup, w, h, a, b, n = 24) {
  let hits = 0;
  for (let k = 0; k < n; k++) {
    const t = 0.04 + 0.92 * (k + 0.5) / n;
    const x = Math.round(a[0] + (b[0] - a[0]) * t), y = Math.round(a[1] + (b[1] - a[1]) * t);
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    if (sup[y * w + x]) hits++;
  }
  return hits / n;
}

/**
 * Pick the quadrilateral bounded by four detected lines that best explains
 * the edge map: two roughly parallel pairs, roughly perpendicular to each
 * other, convex, large, with edge pixels along all four sides.
 */
export function bestQuad(lines, edge, w, h, opts = {}) {
  const minArea = (opts.minArea ?? 0.06) * w * h;
  const margin = (opts.margin ?? 0.04) * Math.max(w, h);
  const sup = dilate(edge, w, h, 2);
  const K = Math.min(lines.length, opts.maxLines ?? 18);
  const minSep = Math.min(w, h) * 0.12;
  const pairs = [];
  for (let i = 0; i < K; i++) {
    for (let j = i + 1; j < K; j++) {
      const a = lines[i], b = lines[j];
      if (angleDiff(a.theta, b.theta) > 35 * DEG) continue;
      const flip = Math.abs(a.theta - b.theta) > Math.PI / 2;
      const dist = Math.abs(a.rho - (flip ? -b.rho : b.rho));
      if (dist < minSep) continue;
      pairs.push({ a, b, ang: flip ? a.theta : (a.theta + b.theta) / 2 });
    }
  }
  let best = null;
  for (let p = 0; p < pairs.length; p++) {
    for (let q = p + 1; q < pairs.length; q++) {
      const A = pairs[p], B = pairs[q];
      if (angleDiff(A.ang, B.ang) < 50 * DEG) continue;
      const c0 = intersect(A.a, B.a), c1 = intersect(B.a, A.b), c2 = intersect(A.b, B.b), c3 = intersect(B.b, A.a);
      if (!c0 || !c1 || !c2 || !c3) continue;
      const poly = [c0, c1, c2, c3];
      let ok = true;
      for (const c of poly) {
        if (c[0] < -margin || c[1] < -margin || c[0] > w + margin || c[1] > h + margin) { ok = false; break; }
      }
      if (!ok) continue;
      const area = Math.abs(polyArea(poly));
      if (area < minArea) continue;
      // convexity + interior angles
      let sign = 0;
      for (let i = 0; i < 4 && ok; i++) {
        const a = poly[i], b = poly[(i + 1) % 4], c = poly[(i + 2) % 4];
        const ux = b[0] - a[0], uy = b[1] - a[1], vx = c[0] - b[0], vy = c[1] - b[1];
        const cross = ux * vy - uy * vx;
        const s = Math.sign(cross);
        if (sign === 0) sign = s; else if (s !== sign) ok = false;
        const cosang = (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy) || 1);
        const turn = Math.acos(Math.max(-1, Math.min(1, cosang)));
        if (turn < 40 * DEG || turn > 140 * DEG) ok = false;
      }
      if (!ok) continue;
      const s0 = sideSupport(sup, w, h, c0, c1), s1 = sideSupport(sup, w, h, c1, c2);
      const s2 = sideSupport(sup, w, h, c2, c3), s3 = sideSupport(sup, w, h, c3, c0);
      const minS = Math.min(s0, s1, s2, s3);
      if (minS < 0.2) continue;
      const support = (s0 + s1 + s2 + s3) / 4;
      const areaFrac = area / (w * h);
      const score = support * (0.35 + 0.65 * Math.sqrt(areaFrac));
      if (!best || score > best.score) {
        best = { corners: orderCorners(poly), score, support, areaFrac, sides: [s0, s1, s2, s3] };
      }
    }
  }
  return best;
}

/** Full pipeline on a small RGBA frame → quad or null. */
export function detectDocument(data, w, h, opts = {}) {
  const gray = grayFromRGBA(data, w, h);
  const e = edges(gray, w, h, opts);
  const lines = houghLines(e.edge, e.gx, e.gy, w, h, opts);
  if (lines.length < 4) return null;
  const q = bestQuad(lines, e.edge, w, h, opts);
  if (q) q.lines = lines.length;
  return q;
}

/* ------------------------------------------------------------------ */
/* homography + perspective warp                                       */
/* ------------------------------------------------------------------ */

/** Solve H so that dst_i ~ H · src_i for four point pairs. Returns Float64Array(9). */
export function homography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [X, Y] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]); b.push(X);
    A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]); b.push(Y);
  }
  const n = 8;
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]]; [b[c], b[piv]] = [b[piv], b[c]];
    const d = A[c][c] || 1e-12;
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / d;
      if (!f) continue;
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const x = new Float64Array(9);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k];
    x[r] = s / (A[r][r] || 1e-12);
  }
  x[8] = 1;
  return x;
}

export function applyH(H, x, y) {
  const d = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / d, (H[3] * x + H[4] * y + H[5]) / d];
}

/** Natural output size for a quad (max opposite side lengths), capped. */
export function outputSize(corners, maxSide = 2400, scale = 1) {
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const [tl, tr, br, bl] = corners;
  let w = Math.max(d(tl, tr), d(bl, br)) * scale, h = Math.max(d(tl, bl), d(tr, br)) * scale;
  const m = Math.max(w, h);
  if (m > maxSide) { w *= maxSide / m; h *= maxSide / m; }
  return { w: Math.max(8, Math.round(w)), h: Math.max(8, Math.round(h)) };
}

/** Inverse-map a quad of the source image onto an ow×oh rectangle (bilinear). */
export function warp(src, sw, sh, corners, ow, oh) {
  const H = homography([[0, 0], [ow, 0], [ow, oh], [0, oh]], corners);
  const out = new Uint8ClampedArray(ow * oh * 4);
  const mx = sw - 1, my = sh - 1;
  for (let v = 0; v < oh; v++) {
    const vy = v + 0.5;
    // per-row incremental evaluation of the projective map
    let nx = H[1] * vy + H[2] + H[0] * 0.5, ny = H[4] * vy + H[5] + H[3] * 0.5, nd = H[7] * vy + H[8] + H[6] * 0.5;
    let o = v * ow * 4;
    for (let u = 0; u < ow; u++, nx += H[0], ny += H[3], nd += H[6], o += 4) {
      let x = nx / nd - 0.5, y = ny / nd - 0.5;
      if (x < 0) x = 0; else if (x > mx) x = mx;
      if (y < 0) y = 0; else if (y > my) y = my;
      const x0 = x | 0, y0 = y | 0;
      const x1 = x0 < mx ? x0 + 1 : x0, y1 = y0 < my ? y0 + 1 : y0;
      const fx = x - x0, fy = y - y0;
      const i00 = (y0 * sw + x0) * 4, i01 = (y0 * sw + x1) * 4, i10 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
      const w00 = (1 - fx) * (1 - fy), w01 = fx * (1 - fy), w10 = (1 - fx) * fy, w11 = fx * fy;
      out[o] = src[i00] * w00 + src[i01] * w01 + src[i10] * w10 + src[i11] * w11;
      out[o + 1] = src[i00 + 1] * w00 + src[i01 + 1] * w01 + src[i10 + 1] * w10 + src[i11 + 1] * w11;
      out[o + 2] = src[i00 + 2] * w00 + src[i01 + 2] * w01 + src[i10 + 2] * w10 + src[i11 + 2] * w11;
      out[o + 3] = 255;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* scanner-style enhancement                                           */
/* ------------------------------------------------------------------ */

/** Local mean via a summed-area table. `g` is Float32 0..255. */
function boxMean(g, w, h, r) {
  const W = w + 1;
  const sat = new Float64Array(W * (h + 1));
  for (let y = 1; y <= h; y++) {
    let row = 0;
    for (let x = 1; x <= w; x++) {
      row += g[(y - 1) * w + (x - 1)];
      sat[y * W + x] = sat[(y - 1) * W + x] + row;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const s = sat[y1 * W + x1] - sat[y0 * W + x1] - sat[y1 * W + x0] + sat[y0 * W + x0];
      out[y * w + x] = s / ((y1 - y0) * (x1 - x0));
    }
  }
  return out;
}

/** Separable max filter (grey dilation) — lifts thin ink out of the background estimate. */
function maxFilter(g, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let m = 0;
      const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
      for (let k = x0; k <= x1; k++) { const v = g[row + k]; if (v > m) m = v; }
      tmp[row + x] = m;
    }
  }
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let k = y0; k <= y1; k++) { const v = tmp[k * w + x]; if (v > m) m = v; }
      out[y * w + x] = m;
    }
  }
  return out;
}

/** Per-pixel gain that flattens uneven lighting so paper reads as uniform white. */
function paperGain(gray, w, h) {
  const rMax = Math.max(2, Math.round(Math.min(w, h) / 250));
  const lifted = maxFilter(gray, w, h, rMax);
  const bg = boxMean(lifted, w, h, Math.max(8, Math.round(Math.min(w, h) / 24)));
  const gain = new Float32Array(w * h);
  for (let i = 0; i < gain.length; i++) {
    let g = 236 / Math.max(bg[i], 30);
    if (g < 0.6) g = 0.6; else if (g > 4) g = 4;
    gain[i] = g;
  }
  return gain;
}

function stretchParams(lum) {
  const black = Math.min(60, percentile(lum, 0.01, 255));
  const white = 232;
  return { black, scale: 255 / Math.max(1, white - black) };
}

export const MODES = ["color", "gray", "bw", "original"];

/** Returns a new RGBA buffer with the chosen look applied. */
export function enhance(data, w, h, mode) {
  const n = w * h;
  const out = new Uint8ClampedArray(n * 4);
  if (mode === "original" || !MODES.includes(mode)) { out.set(data); return out; }
  const gray = grayFromRGBA(data, w, h);
  const gain = paperGain(gray, w, h);
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) lum[i] = Math.min(255, gray[i] * gain[i]);
  if (mode === "color") {
    const { black, scale } = stretchParams(lum);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const g = gain[i];
      out[j] = (data[j] * g - black) * scale;
      out[j + 1] = (data[j + 1] * g - black) * scale;
      out[j + 2] = (data[j + 2] * g - black) * scale;
      out[j + 3] = 255;
    }
    return out;
  }
  if (mode === "gray") {
    const { black, scale } = stretchParams(lum);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const v = (lum[i] - black) * scale;
      out[j] = out[j + 1] = out[j + 2] = v; out[j + 3] = 255;
    }
    return out;
  }
  // bw: adaptive threshold on the flattened luminance
  const mean = boxMean(lum, w, h, Math.max(6, Math.round(Math.min(w, h) / 40)));
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const v = lum[i] < Math.min(mean[i] - 22, 205) ? 0 : 255;
    out[j] = out[j + 1] = out[j + 2] = v; out[j + 3] = 255;
  }
  return out;
}

/** Rotate an RGBA image by k quarter-turns clockwise. */
export function rotate(data, w, h, k) {
  k = ((k % 4) + 4) % 4;
  if (k === 0) return { data: new Uint8ClampedArray(data), w, h };
  const ow = k % 2 ? h : w, oh = k % 2 ? w : h;
  const out = new Uint8ClampedArray(ow * oh * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let nx, ny;
      if (k === 1) { nx = h - 1 - y; ny = x; }
      else if (k === 2) { nx = w - 1 - x; ny = h - 1 - y; }
      else { nx = y; ny = w - 1 - x; }
      const s = (y * w + x) * 4, d = (ny * ow + nx) * 4;
      out[d] = data[s]; out[d + 1] = data[s + 1]; out[d + 2] = data[s + 2]; out[d + 3] = 255;
    }
  }
  return { data: out, w: ow, h: oh };
}

/** Full-frame rectangle as corners (used when no page is detected). */
export function frameCorners(w, h) {
  return [[0, 0], [w, 0], [w, h], [0, h]];
}
