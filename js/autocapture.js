// One-shot gate driven by observed frames, never by a standalone timer.
export class SettledCapture {
  constructor(waitMs = 3000) { this.waitMs = waitMs; this.cancel(); }
  arm() { this.armed = true; this.restart(); }
  restart() { this.stillSince = null; this.lastTick = null; }
  cancel() { this.armed = false; this.restart(); }
  update(now, valid, moving) {
    if (!this.armed) return { progress: 0, fire: false };
    if (!valid || moving || (this.lastTick !== null && now - this.lastTick > 500)) this.stillSince = null;
    this.lastTick = now;
    if (!valid || moving) return { progress: 0, fire: false };
    if (this.stillSince === null) this.stillSince = now;
    const progress = Math.min(1, (now - this.stillSince) / this.waitMs);
    if (progress < 1) return { progress, fire: false };
    this.cancel();
    return { progress: 1, fire: true };
  }
}

/** Visible motion in the paper and its surroundings, ignoring tiny pixel noise. */
export function frameMotion(previous, data, w, h, corners = null) {
  if (!previous || previous.length !== data.length) return 1;
  const xs = corners?.map(p => p[0]), ys = corners?.map(p => p[1]), margin = Math.round(w * 0.06);
  const x0 = xs ? Math.max(0, Math.floor(Math.min(...xs) - margin)) : 0;
  const x1 = xs ? Math.min(w, Math.ceil(Math.max(...xs) + margin)) : w;
  const y0 = ys ? Math.max(0, Math.floor(Math.min(...ys) - margin)) : 0;
  const y1 = ys ? Math.min(h, Math.ceil(Math.max(...ys) + margin)) : h;
  let changed = 0, count = 0;
  for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
    const i = (y * w + x) * 4;
    const delta = Math.abs(data[i] - previous[i]) + Math.abs(data[i + 1] - previous[i + 1]) + Math.abs(data[i + 2] - previous[i + 2]);
    if (delta > 42) changed++;
    count++;
  }
  return count ? changed / count : 1;
}
