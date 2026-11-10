// Camera negotiation checks without requiring a physical camera.
import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const src = fs.readFileSync(new URL("../js/app.js", import.meta.url), "utf8");
const code = src.slice(src.indexOf("let changingResolution"), src.indexOf("function stopStream"));
const els = Object.fromEntries(["video", "viewport", "res", "resolution", "resolutionnote", "camera", "shutter"].map(id => [id, {
  style: {}, dataset: { applied: "max" }, value: "1920x1080", videoWidth: 1920, videoHeight: 1080,
}]));
let applied;
const track = {
  getCapabilities: () => ({ width: { max: 3840 }, height: { max: 2160 } }),
  getSettings: () => ({ width: 1920, height: 1080 }),
  applyConstraints: async c => { applied = c; },
};
const ctx = vm.createContext({ S: { stream: { getVideoTracks: () => [track] } }, $: id => els[id], resetDetection: () => {} });
vm.runInContext(code, ctx);
await vm.runInContext("changeResolution()", ctx);
assert.equal(applied.width.exact, 1920);
assert.equal(els.shutter.disabled, false);
assert.equal(els.res.textContent, "1920×1080");
els.resolution.value = "max";
await vm.runInContext("changeResolution()", ctx);
assert.equal(applied.width.ideal, 3840);
track.applyConstraints = async () => { throw Error("unsupported"); };
els.resolution.value = "3840x2160";
await vm.runInContext("changeResolution()", ctx);
assert.equal(els.resolution.value, "max");
assert.match(els.resolutionnote.textContent, /could not provide/);
assert.equal(els.camera.disabled, false);
track.getSettings = () => ({ width: 3840, height: 2160, exposureMode: "manual", exposureTime: 78.125, focusMode: "manual", focusDistance: 480 });
const focusChange = vm.runInContext("cameraAdjustments(S.stream.getVideoTracks()[0], {focusDistance: 500})", ctx);
assert.equal(focusChange.advanced[0].exposureMode, "manual");
assert.equal(focusChange.advanced[0].exposureTime, 78.125);
assert.equal(focusChange.advanced[0].focusDistance, 500);
track.applyConstraints = async c => {
  assert(!(c.width && c.advanced), "resolution and imaging controls must use separate requests");
  applied = c;
};
els.resolution.value = "max";
await vm.runInContext("changeResolution()", ctx);
assert.equal(applied.advanced[0].exposureTime, 78.125);
assert.equal(applied.advanced[0].focusDistance, 480);
console.log("Resolution negotiation, failure recovery, and preservation of manual exposure/focus passed.");

// Simulate a fresh camera stream after a full preference save/load cycle.
let settings = { deviceId: "usb-receipt", width: 3840, height: 2160, exposureMode: "manual", exposureTime: 78.125, exposureCompensation: 0, focusMode: "manual", focusDistance: 508 };
track.getSettings = () => ({ ...settings });
track.getCapabilities = () => ({ exposureMode: ["manual", "continuous"], exposureTime: { min: 1, max: 5000 }, exposureCompensation: { min: 0, max: 15 }, focusMode: ["manual", "continuous"], focusDistance: { min: 0, max: 1023 } });
track.applyConstraints = async c => { for (const a of c.advanced || []) Object.assign(settings, a); };
ctx.S.cameraPrefs = { "usb-receipt": { resolution: "1920x1080" } };
ctx.S.autoOrient = false;
let stored = "{}";
ctx.localStorage = { getItem: () => stored, setItem: (_, value) => { stored = value; } };
ctx.V = { MODES: ["receipt", "color"] };
vm.runInContext(src.slice(src.indexOf("function loadPrefs()"), src.indexOf("/* ---------- worker")), ctx);
vm.runInContext("rememberCameraControls(S.stream.getVideoTracks()[0])", ctx);
assert.equal(JSON.parse(stored).cameraPrefs["usb-receipt"].exposureTime, 78.125);
assert.equal(JSON.parse(stored).cameraPrefs["usb-receipt"].resolution, "1920x1080", "saving exposure must retain resolution");
assert.equal(JSON.parse(stored).autoOrient, false);
ctx.S.cameraPrefs = {};
ctx.S.autoOrient = true;
vm.runInContext("loadPrefs()", ctx);
assert.equal(ctx.S.autoOrient, false, "orientation opt-out must survive reload");
assert.equal(vm.runInContext("savedResolution('usb-receipt')", ctx), "1920x1080");
assert.equal(vm.runInContext("savedResolution('different-camera')", ctx), "max");
settings = { ...settings, exposureMode: "continuous", exposureTime: 200, focusMode: "continuous", focusDistance: 0 };
await vm.runInContext("restoreCameraControls(S.stream.getVideoTracks()[0])", ctx);
assert.equal(settings.exposureMode, "manual");
assert.equal(settings.exposureTime, 78.125);
assert.equal(settings.focusMode, "manual");
assert.equal(settings.focusDistance, 508);
settings = { ...settings, deviceId: "different-camera", exposureMode: "continuous" };
await vm.runInContext("restoreCameraControls(S.stream.getVideoTracks()[0])", ctx);
assert.equal(settings.exposureMode, "continuous", "another camera must not inherit manual exposure");
console.log("Reload restores saved camera controls without leaking them to other cameras.");
