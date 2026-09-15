// Builds fixtures/camera.y4m — the video Chrome plays as a fake webcam.
// Timeline (loops): page pose A · blank wall · page pose B · blank wall.
// Auto-capture must fire once per pose and re-arm across the blank gaps.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { renderFrame, defaultCorners, toY4M, toPNG } from "./synth.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, "fixtures");
fs.mkdirSync(FIX, { recursive: true });

export const CAM_W = 960, CAM_H = 540, FPS = 10;
export const POSES = [defaultCorners(CAM_W, CAM_H, 0), defaultCorners(CAM_W, CAM_H, 1)];

function blankFrame(seed) {
  const f = renderFrame({ w: CAM_W, h: CAM_H, corners: [[-9, -9], [-8, -9], [-8, -8], [-9, -8]], hand: false, seed, bgLevel: 95 });
  return f.data;
}

export function build() {
  const a = renderFrame({ w: CAM_W, h: CAM_H, corners: POSES[0], hand: true, seed: 11 }).data;
  const b = renderFrame({ w: CAM_W, h: CAM_H, corners: POSES[1], hand: true, seed: 12 }).data;
  const blank = blankFrame(13);
  const frames = [];
  const push = (f, secs) => { for (let i = 0; i < secs * FPS; i++) frames.push(f); };
  push(a, 2.2); push(blank, 1.2); push(b, 2.2); push(blank, 1.2);
  fs.writeFileSync(path.join(FIX, "camera.y4m"), toY4M(frames, CAM_W, CAM_H, FPS));
  fs.writeFileSync(path.join(FIX, "pose-a.png"), toPNG(a, CAM_W, CAM_H));
  fs.writeFileSync(path.join(FIX, "pose-b.png"), toPNG(b, CAM_W, CAM_H));
  fs.writeFileSync(path.join(FIX, "poses.json"), JSON.stringify({ w: CAM_W, h: CAM_H, poses: POSES }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  build();
  console.log("wrote fixtures/camera.y4m");
}
