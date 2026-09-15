// Scancat — page processing off the main thread: warp → enhance → rotate.

import * as V from "./vision.js";

self.onmessage = (e) => {
  const { id, op } = e.data;
  try {
    if (op === "process") {
      const { data, w, h, corners, mode, rot, maxSide } = e.data;
      const size = V.outputSize(corners, maxSide || 2600);
      let out = V.warp(data, w, h, corners, size.w, size.h);
      out = V.enhance(out, size.w, size.h, mode);
      const r = V.rotate(out, size.w, size.h, rot || 0);
      self.postMessage({ id, data: r.data, w: r.w, h: r.h }, [r.data.buffer]);
      return;
    }
    throw new Error(`unknown op ${op}`);
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
