import assert from "node:assert/strict";
import { fuseFrames, frameSharpness } from "../js/fusion.js";
import { blur5, grayFromRGBA } from "../js/vision.js";

const w = 144, h = 96, n = w * h;
const truth = new Uint8ClampedArray(n * 4);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const v = x > 15 && x < 130 && y > 12 && y < 84 && ((x % 17 < 3 && y % 13 < 8) || y % 19 < 2) ? 45 : 190;
  const i = (y * w + x) * 4; truth[i] = truth[i + 1] = truth[i + 2] = v; truth[i + 3] = 255;
}
function noisyShift(seed, dx, dy) {
  const data = new Uint8ClampedArray(truth.length);
  let s = seed;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const xx = Math.max(0, Math.min(w - 1, x - dx)), yy = Math.max(0, Math.min(h - 1, y - dy));
    const v = truth[(yy * w + xx) * 4] + (s % 17) - 8, i = (y * w + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = v; data[i + 3] = 255;
  }
  return data;
}
const frames = [[0, 0], [2, -1], [-2, 1], [1, 2], [-1, -2]].map(([dx, dy], i) => ({ data: noisyShift(i + 1, dx, dy), w, h, score: 10 - i, frameId: i }));
const fused = fuseFrames(frames);
assert.equal(fused.referenceId, 0);
assert(fused.usedFrames >= 3, "aligned frames were not combined");
function mse(data) {
  let error = 0, count = 0;
  for (let y = 12; y < h - 12; y++) for (let x = 12; x < w - 12; x++) {
    const i = (y * w + x) * 4; error += (data[i] - truth[i]) ** 2; count++;
  }
  return error / count;
}
assert(mse(fused.data) < mse(frames[0].data) * 0.8, `fusion should reduce measured noise: ${mse(fused.data)} vs ${mse(frames[0].data)}`);
const intruder = new Uint8ClampedArray(truth);
for (let y = 25; y < 65; y++) for (let x = 40; x < 80; x++) {
  const i = (y * w + x) * 4; intruder[i] = 240; intruder[i + 1] = 110; intruder[i + 2] = 70;
}
const protectedImage = fuseFrames([{ data: truth, w, h, score: 2, frameId: 1 }, { data: intruder, w, h, score: 1, frameId: 2 }]);
const point = (45 * w + 55) * 4;
assert.equal(protectedImage.data[point], truth[point], "moving hand must not be blended into reference");
const single = fuseFrames([frames[0]]);
assert(single.data.every((v, i) => v === frames[0].data[i]), "single-frame fallback changes pixels");
const softGray = blur5(grayFromRGBA(truth, w, h), w, h), soft = new Uint8ClampedArray(truth);
for (let i = 0; i < n; i++) soft[i * 4] = soft[i * 4 + 1] = soft[i * 4 + 2] = softGray[i];
assert(frameSharpness(truth, w, h) > frameSharpness(soft, w, h), "ranking should prefer resolved strokes");
console.log("Frame fusion: registration, noise reduction, moving occlusions, sharpness ranking and single-frame fallback passed.");
