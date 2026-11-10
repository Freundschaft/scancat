// PP-LCNet consumes an ImageNet-normalized RGB center crop, not receipt text.
export function classifierDecision(scores) {
  if (scores?.length !== 4 || !Array.from(scores).every(Number.isFinite)) return { confident: false, turns: 0, method: "classifier" };
  const ranked = Array.from(scores, (score, index) => ({ score, index })).sort((a, b) => b.score - a.score);
  const confidence = ranked[0].score, margin = confidence - ranked[1].score;
  const confident = confidence >= 0.85 && margin >= 0.7;
  return { confident, turns: confident ? (4 - ranked[0].index) % 4 : 0,
    confidence, margin, method: "classifier" };
}

export function normalizeRgb(rgba) {
  const n = rgba.length / 4, tensor = new Float32Array(n * 3);
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  for (let channel = 0; channel < 3; channel++) for (let i = 0; i < n; i++) {
    tensor[channel * n + i] = (rgba[4 * i + channel] / 255 - mean[channel]) / std[channel];
  }
  return tensor;
}

let worker = null, sequence = 0, failedUntil = 0;
const pending = new Map();

function failWorker(error) {
  worker?.terminate(); worker = null; failedUntil = Date.now() + 30000;
  for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
  pending.clear();
}

export async function classifyOrientation(image, { retry = false } = {}) {
  if (retry) failedUntil = 0;
  if (Date.now() < failedUntil) throw new Error("Orientation model is temporarily unavailable");
  if (!worker) {
    worker = new Worker(new URL("./orientation-model-worker.js", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }) => {
      const request = pending.get(data.id); if (!request) return;
      if (data.error) { failWorker(new Error(data.error)); return; }
      pending.delete(data.id); clearTimeout(request.timer); request.resolve(classifierDecision(data.scores));
    };
    worker.onerror = () => failWorker(new Error("Orientation model could not load"));
  }
  // Official pipeline: resize short side to 256, then center-crop 224×224.
  const scale = 256 / Math.min(image.width, image.height), size = 224 / scale;
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = 224;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "white"; ctx.fillRect(0, 0, 224, 224);
  ctx.drawImage(image, (image.width - size) / 2, (image.height - size) / 2, size, size, 0, 0, 224, 224);
  const input = normalizeRgb(ctx.getImageData(0, 0, 224, 224).data), id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => failWorker(new Error("Orientation model timed out")), 10000);
    pending.set(id, { resolve, reject, timer });
    worker.postMessage({ id, input }, [input.buffer]);
  });
}
