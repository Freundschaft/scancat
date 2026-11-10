import assert from "node:assert/strict";
import { orientationDecision, recognitionScore, recognitionDecision, hasOrientationSignal, MIN_ORIENTATION_CONFIDENCE } from "../js/orientation.js";
import { classifierDecision, normalizeRgb } from "../js/orientation-model.js";

for (let index = 0; index < 4; index++) {
  const scores = [0.02, 0.02, 0.02, 0.02]; scores[index] = 0.94;
  assert.equal(classifierDecision(scores).turns, (4 - index) % 4);
  assert.equal(classifierDecision(scores).confident, true);
}
for (const scores of [null, [], [NaN, 0, 0, 1], [0.4, 0.3, 0.2, 0.1], [0.84, 0.06, 0.05, 0.05]]) {
  assert.equal(classifierDecision(scores).confident, false);
  assert.equal(classifierDecision(scores).turns, 0);
}
const normalized = normalizeRgb(new Uint8Array([255, 0, 128, 255, 0, 255, 255, 255]));
const want = [(1 - .485) / .229, -.485 / .229, -.456 / .224, (1 - .456) / .224, (128 / 255 - .406) / .225, (1 - .406) / .225];
normalized.forEach((n, i) => assert(Math.abs(n - want[i]) < 1e-6, "RGB normalization and CHW layout"));
console.log("Classifier: angle mapping, confidence guards and ImageNet RGB preprocessing passed.");

for (const degrees of [0, 90, 180, 270]) {
  const result = orientationDecision({ orientation_degrees: degrees, orientation_confidence: 20 });
  assert.equal(result.confident, true);
  assert.equal(result.turns, degrees / 90, "Tesseract's angle is already the clockwise correction");
}
for (const data of [null, {}, { orientation_degrees: 90, orientation_confidence: null }, { orientation_degrees: 90, orientation_confidence: MIN_ORIENTATION_CONFIDENCE - 0.1 }, { orientation_degrees: 45, orientation_confidence: 50 }, { orientation_degrees: 90, orientation_confidence: NaN }]) {
  const result = orientationDecision(data);
  assert.equal(result.confident, false);
  assert.equal(result.turns, 0, "unknown or low-confidence text must not rotate the scan");
}
console.log("Orientation decisions: all quarter-turns, missing text, invalid angles and confidence guard passed.");
assert.equal(hasOrientationSignal(new Uint8ClampedArray(400).fill(255)), false, "blank paper should not load the OCR engine");
const ink = new Uint8ClampedArray(400).fill(255); ink[0] = ink[1] = ink[2] = 0;
assert.equal(hasOrientationSignal(ink), true);

const good = recognitionScore({ text: "Bitte entwerten. Einzelfahrt Wien 2,40 EUR", confidence: 90 }, 2);
const bad = recognitionScore({ text: "x ii mm rnn oo", confidence: 34 }, 0);
assert.equal(recognitionDecision([bad, good]).turns, 2);
assert.equal(recognitionDecision([good, { ...good, turns: 0 }]).confident, false, "ambiguous readings must not rotate");
assert.equal(recognitionDecision([recognitionScore({ text: "0", confidence: 99 }, 1)]).confident, false, "a lone digit is not orientation evidence");
const barcode = [
  { turns: 0, confidence: 47, characters: 51, letters: 48 },
  { turns: 1, confidence: 26, characters: 21, letters: 8 },
  { turns: 2, confidence: 55, characters: 48, letters: 48 },
  { turns: 3, confidence: 66, characters: 26, letters: 3 },
].map(c => ({ ...c, score: c.confidence ** 2 * Math.log1p(c.characters) }));
assert.equal(recognitionDecision(barcode).turns, 3, "barcode ticket must favor clearer short reading over longer gibberish");
console.log("OCR fallback: clear text, ambiguity, sparse digits and barcode-ticket regression passed.");
