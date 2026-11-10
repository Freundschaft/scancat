import assert from "node:assert/strict";
import { SettledCapture, frameMotion } from "../js/autocapture.js";

const gate = new SettledCapture();
assert.equal(gate.update(10000, true, false).fire, false, "must be explicitly armed");
gate.arm();
for (let t = 0; t < 3000; t += 100) assert.equal(gate.update(t, true, false).fire, false);
assert.equal(gate.update(3000, true, false).fire, true);
assert.equal(gate.update(3100, true, false).fire, false, "one shot only");

gate.arm();
for (let t = 0; t <= 2900; t += 100) gate.update(t, true, false);
gate.update(2950, true, true); // hand moving across a stable outline
assert.equal(gate.update(3000, true, false).progress, 0, "motion restarts countdown");
for (let t = 3100; t < 6000; t += 100) assert.equal(gate.update(t, true, false).fire, false);
assert.equal(gate.update(6000, true, false).fire, true);

gate.arm(); gate.update(0, true, false); gate.update(100, true, false);
assert.equal(gate.update(5000, true, false).fire, false, "background/stalled tab must not finish countdown");
assert.equal(gate.update(5100, false, false).progress, 0, "lost outline must restart countdown");
gate.cancel();
assert.equal(gate.update(9000, true, false).fire, false, "cancel stops capture");

const w = 100, h = 60, still = new Uint8ClampedArray(w * h * 4).fill(100);
const noise = new Uint8ClampedArray(still).map(v => v + 2);
assert.equal(frameMotion(still, noise, w, h), 0, "small camera noise should not count as motion");
const hand = new Uint8ClampedArray(still);
for (let y = 20; y < 40; y++) for (let x = 30; x < 60; x++) {
  const i = (y * w + x) * 4; hand[i] = 210; hand[i + 1] = 160; hand[i + 2] = 120;
}
assert(frameMotion(still, hand, w, h, [[20, 20], [80, 20], [80, 40], [20, 40]]) > 0.015, "hand motion must delay capture even with fixed corners");
assert.equal(frameMotion(null, still, w, h), 1, "first frame cannot be considered steady");
console.log("Prepared capture: settling, motion, lost outlines, tab pauses, cancellation, and one-shot behavior passed.");
