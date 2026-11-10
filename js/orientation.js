// Local orientation/script detection. Model files and worker code are served
// from this app's own origin; no receipt pixels are sent to a server.
import { classifyOrientation } from "./orientation-model.js";
export const MIN_ORIENTATION_CONFIDENCE = 8;

export function hasOrientationSignal(data) {
  let min = 255, max = 0;
  for (let i = 0; i < data.length; i += 16) {
    const v = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    min = Math.min(min, v); max = Math.max(max, v);
    if (max - min >= 24) return true;
  }
  return false;
}

export function orientationDecision(data, minimum = MIN_ORIENTATION_CONFIDENCE) {
  const angle = data?.orientation_degrees, confidence = data?.orientation_confidence;
  if (![0, 90, 180, 270].includes(angle) || !Number.isFinite(confidence) || confidence < minimum) {
    return { confident: false, turns: 0, confidence: Number.isFinite(confidence) ? confidence : 0 };
  }
  // Tesseract.js maps its internal orientation ID to the clockwise correction
  // angle, not the angle originally applied to the input image.
  return { confident: true, turns: angle / 90, confidence };
}

export function recognitionScore(data, turns) {
  const text = typeof data?.text === "string" ? data.text : "";
  const words = text.match(/[\p{L}\p{N}]+/gu) || [];
  const characters = words.join("").length, letters = (text.match(/\p{L}/gu) || []).length;
  const confidence = Number.isFinite(data?.confidence) ? data.confidence : 0;
  return { turns, confidence, characters, letters,
    // Confidence dominates: sideways barcode strokes can produce long strings
    // of low-quality letters. Character quantity is only logarithmic evidence.
    score: confidence ** 2 * Math.log1p(characters) };
}

export function recognitionDecision(candidates) {
  const ranked = [...candidates].sort((a, b) => b.score - a.score), best = ranked[0];
  const margin = best?.score > 0 ? (best.score - (ranked[1]?.score || 0)) / best.score : 0;
  const confident = !!best && best.confidence >= 55 && best.characters >= 10 && (best.letters >= 6 || best.characters >= 24) && margin >= 0.12;
  return { confident, turns: confident ? best.turns : 0, confidence: best?.confidence || 0, method: "ocr", margin, candidates };
}

let workerPromise = null;
let textWorkerPromise = null;
let queue = Promise.resolve();
let failedUntil = 0;
let loadAttempt = 0;
let libraryPromise = null;

function getLibrary() {
  if (!libraryPromise) {
    const library = new URL("../assets/ocr/tesseract.esm.min.js", import.meta.url);
    if (loadAttempt++) library.searchParams.set("retry", String(loadAttempt));
    libraryPromise = import(library.href).catch(error => { libraryPromise = null; throw error; });
  }
  return libraryPromise;
}

async function getWorker() {
  if (!workerPromise) {
    const initialization = (async () => {
      const { default: Tesseract } = await getLibrary();
      const worker = await Tesseract.createWorker("osd", 0, {
        workerPath: new URL("../assets/ocr/worker.min.js", import.meta.url).href,
        corePath: new URL("../assets/ocr/core/", import.meta.url).href,
        langPath: new URL("../assets/ocr/", import.meta.url).href.replace(/\/$/, ""),
        legacyCore: true, legacyLang: true, workerBlobURL: false,
        cachePath: "scancat-osd-v1", errorHandler() {},
      });
      await worker.setParameters({ user_defined_dpi: "300" });
      return worker;
    })();
    const pending = initialization.catch(error => { if (workerPromise === pending) workerPromise = null; throw error; });
    workerPromise = pending;
  }
  return workerPromise;
}

async function getTextWorker() {
  if (!textWorkerPromise) {
    const initialization = (async () => {
      const { default: Tesseract } = await getLibrary();
      const worker = await Tesseract.createWorker("eng+deu", 1, {
        workerPath: new URL("../assets/ocr/worker.min.js", import.meta.url).href,
        corePath: new URL("../assets/ocr/core/", import.meta.url).href,
        langPath: new URL("../assets/ocr/", import.meta.url).href.replace(/\/$/, ""),
        legacyCore: true, legacyLang: false, workerBlobURL: false,
        cachePath: "scancat-text-v1", errorHandler() {},
      });
      await worker.setParameters({ user_defined_dpi: "300", tessedit_pageseg_mode: "11" });
      return worker;
    })();
    const pending = initialization.catch(error => { if (textWorkerPromise === pending) textWorkerPromise = null; throw error; });
    textWorkerPromise = pending;
  }
  return textWorkerPromise;
}

/** Serialized because one OCR worker is shared by all pages in a batch. */
export function detectOrientation(image, { retry = false } = {}) {
  if (image?.getContext && !hasOrientationSignal(image.getContext("2d").getImageData(0, 0, image.width, image.height).data)) {
    return Promise.resolve({ confident: false, turns: 0, confidence: 0 });
  }
  const job = queue.then(async () => {
    if (retry) failedUntil = 0;
    // The 224px classifier takes one pass. Full text recognition is only a
    // fallback for uncertain predictions or a missing/unsupported model.
    try {
      const prediction = await classifyOrientation(image, { retry });
      if (prediction.confident) return prediction;
    } catch { /* OCR remains usable if model loading/inference fails. */ }
    if (Date.now() < failedUntil) throw new Error("Orientation detector is unavailable; manual rotation still works");
    const workers = [];
    let expired = false, timer;
    const own = async promise => {
      const worker = await promise; workers.push(worker);
      if (expired) { await worker.terminate(); throw new Error("Orientation detection timed out"); }
      return worker;
    };
    const detection = (async () => {
      const worker = await own(getWorker());
      const osd = orientationDecision((await worker.detect(image)).data);
      if (osd.confident) return { ...osd, method: "osd" };
      const reader = await own(getTextWorker()), candidates = [];
      const scale = Math.min(2, 1800 / Math.max(image.width, image.height));
      for (const turns of [0, 1, 2, 3]) {
        if (expired) throw new Error("Orientation detection timed out");
        const canvas = document.createElement("canvas");
        canvas.width = Math.round((turns % 2 ? image.height : image.width) * scale);
        canvas.height = Math.round((turns % 2 ? image.width : image.height) * scale);
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "white"; ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.translate(canvas.width / 2, canvas.height / 2); ctx.rotate(turns * Math.PI / 2);
        ctx.drawImage(image, -image.width * scale / 2, -image.height * scale / 2, image.width * scale, image.height * scale);
        const result = await reader.recognize(canvas, {}, { text: true });
        // Keep only quality metrics, never recognized receipt text.
        candidates.push(recognitionScore(result.data, turns));
      }
      return recognitionDecision(candidates);
    })();
    try {
      const result = await Promise.race([detection, new Promise((_, reject) => {
        timer = setTimeout(() => { expired = true; reject(new Error("Orientation detection timed out")); }, 20000);
      })]);
      return result;
    } catch (error) {
      failedUntil = Date.now() + 30000;
      if (expired) { workerPromise = null; textWorkerPromise = null; workers.forEach(worker => worker.terminate().catch(() => {})); }
      throw error;
    } finally { clearTimeout(timer); }
  });
  queue = job.catch(() => {});
  return job;
}
