// Scancat — page processing off the main thread: warp → enhance → rotate.

import * as V from "./vision.js";
import { frameSharpness, fuseFrames } from "./fusion.js";

let burstFrames = [];

self.onmessage = (e) => {
  const { id, op } = e.data;
  try {
    if (op === "burst-reset") { burstFrames = []; self.postMessage({ id }); return; }
    if (op === "burst-add") {
      const { data, w, h, corners, frameId } = e.data;
      const size = V.outputSize(corners, Math.max(w, h));
      const out = V.warp(data, w, h, corners, size.w, size.h);
      const score = frameSharpness(out, size.w, size.h);
      burstFrames.push({ data: out, ...size, score, frameId });
      burstFrames.sort((a, b) => b.score - a.score);
      burstFrames = burstFrames.slice(0, 5);
      self.postMessage({ id, score, best: burstFrames[0].frameId === frameId });
      return;
    }
    if (op === "burst-finish") {
      const result = fuseFrames(burstFrames); burstFrames = [];
      self.postMessage({ id, ...result }, [result.data.buffer]); return;
    }
    if (op === "process") {
      const { data, w, h, corners, mode, rot, maxSide, sharpness, receiptContrast } = e.data;
      const size = V.outputSize(corners, maxSide || 2600);
      let out = V.warp(data, w, h, corners, size.w, size.h);
      out = V.enhance(out, size.w, size.h, mode, sharpness, receiptContrast);
      const r = V.rotate(out, size.w, size.h, rot || 0);
      self.postMessage({ id, data: r.data, w: r.w, h: r.h }, [r.data.buffer]);
      return;
    }
    throw new Error(`unknown op ${op}`);
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
