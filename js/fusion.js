// Conservative, measurement-only frame fusion. No generated text or upscaling.
import { grayFromRGBA, warp, frameCorners } from "./vision.js";

export function frameSharpness(data, w, h) {
  const gray = grayFromRGBA(data, w, h);
  let energy = 0, mean = 0, n = 0, clipped = 0;
  const borderX = Math.max(2, Math.round(w * 0.12)), borderY = Math.max(2, Math.round(h * 0.12));
  for (let y = borderY; y < h - borderY; y += 2) for (let x = borderX; x < w - borderX; x += 2) {
    const i = y * w + x, v = gray[i];
    const lap = 4 * v - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
    energy += Math.min(4000, lap * lap); mean += v; n++;
    if (v > 250 || v < 3) clipped++;
  }
  if (!n) return 0;
  return (energy / n) / Math.max(400, (mean / n) ** 2) * (1 - 0.8 * clipped / n);
}

function match(ref, other, w, h, x0, y0, x1, y1, cx, cy, radius, step, offset) {
  let best = { dx: cx, dy: cy, cost: Infinity };
  for (let dy = cy - radius; dy <= cy + radius; dy++) for (let dx = cx - radius; dx <= cx + radius; dx++) {
    let cost = 0, n = 0;
    for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue;
      cost += Math.min(40, Math.abs(ref[y * w + x] - other[yy * w + xx] - offset)); n++;
    }
    if (n && cost / n < best.cost) best = { dx, dy, cost: cost / n };
  }
  return best;
}

export function fuseFrames(input) {
  if (!input.length) throw new Error("No frames to combine");
  const frames = [...input].sort((a, b) => b.score - a.score).slice(0, 5);
  const ref = frames[0], { w, h } = ref;
  const gray = grayFromRGBA(ref.data, w, h);
  const sum = new Float32Array(ref.data.length), count = new Uint8Array(w * h).fill(2);
  for (let i = 0; i < ref.data.length; i++) sum[i] = ref.data[i] * 2;
  let usedFrames = 1;
  for (const frame of frames.slice(1)) {
    if (Math.abs(frame.w / frame.h / (w / h) - 1) > 0.2) continue;
    const data = frame.w === w && frame.h === h ? frame.data : warp(frame.data, frame.w, frame.h, frameCorners(frame.w, frame.h), w, h);
    const other = grayFromRGBA(data, w, h);
    let offset = 0, samples = 0;
    for (let i = 0; i < gray.length; i += 31) { offset += gray[i] - other[i]; samples++; }
    offset = Math.max(-20, Math.min(20, offset / samples));
    // Coarse registration on a grid, followed by local translation for small
    // changes in paper tension. Reject blocks that do not match the reference.
    const stride = Math.max(1, Math.round(Math.max(w, h) / 320));
    let global = { dx: 0, dy: 0, cost: Infinity };
    for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) {
      const candidate = match(gray, other, w, h, 8, 8, w - 8, h - 8, dx * stride, dy * stride, 0, Math.max(2, stride * 2), offset);
      if (candidate.cost < global.cost) global = candidate;
    }
    global = match(gray, other, w, h, 8, 8, w - 8, h - 8, global.dx, global.dy, Math.min(4, stride), Math.max(4, stride * 2), offset);
    let accepted = 0;
    for (let y0 = 0; y0 < h; y0 += 48) for (let x0 = 0; x0 < w; x0 += 48) {
      const x1 = Math.min(w, x0 + 48), y1 = Math.min(h, y0 + 48);
      const local = match(gray, other, w, h, x0, y0, x1, y1, global.dx, global.dy, 2, 4, offset);
      if (local.cost > 12) continue;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const xx = x + local.dx, yy = y + local.dy;
        if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue;
        const i = y * w + x, j = yy * w + xx;
        // Disagreeing pixels (occlusions, shifted letters, new creases) retain
        // the sharp reference instead of becoming a double image.
        if (Math.abs(gray[i] - other[j] - offset) > 18) continue;
        for (let c = 0; c < 3; c++) sum[i * 4 + c] += Math.max(0, Math.min(255, data[j * 4 + c] + offset));
        count[i]++; accepted++;
      }
    }
    if (accepted > w * h * 0.1) usedFrames++;
  }
  const out = new Uint8ClampedArray(ref.data.length);
  for (let i = 0; i < count.length; i++) {
    for (let c = 0; c < 3; c++) out[i * 4 + c] = sum[i * 4 + c] / count[i];
    out[i * 4 + 3] = 255;
  }
  return { data: out, w, h, usedFrames, referenceId: ref.frameId };
}
