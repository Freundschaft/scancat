// Scancat — UI: camera, live detection, capture, tray, editor, export.

import * as V from "./vision.js";
import { buildPdf } from "./pdf.js";
import { SettledCapture, frameMotion } from "./autocapture.js";

const $ = (id) => document.getElementById(id);

const DET_W = 384;           // detection frame width (px)
const LOOP_MS = 66;          // ~15 detections per second
const STEADY_FRAMES = 10;    // hold still this many frames to auto-capture
const MIN_SCORE = 0.22;      // below this a quad is ignored
const GOOD_SUPPORT = 0.6;    // above this the outline turns teal
const MAX_SIDE = 2600;       // longest side of a scanned page (px)

const S = {
  stream: null, running: false, pages: [], seq: 0,
  mode: "color", pageSize: "fit", auto: true, sound: true, deviceId: null,
  zoom: 1, zoomX: 0.5, zoomY: 0.5,
  sharpness: 0.5,
  receiptContrast: 3,
  multi: false,
  cameraPrefs: {}, starting: false,
  busy: 0, editing: null, corner: null,
  det: { smooth: null, stable: 0, lost: 99, armed: true, lastCap: null, score: 0, support: 0, ms: 0, w: 0, h: 0 },
};

/* ---------- prefs ---------- */

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem("scancat:prefs") || "{}");
    if (V.MODES.includes(p.mode)) S.mode = p.mode;
    if (["fit", "a4", "letter"].includes(p.pageSize)) S.pageSize = p.pageSize;
    if (typeof p.auto === "boolean") S.auto = p.auto;
    if (typeof p.sound === "boolean") S.sound = p.sound;
    if (typeof p.multi === "boolean") S.multi = p.multi;
    if (typeof p.deviceId === "string") S.deviceId = p.deviceId;
    if (Number.isFinite(p.sharpness)) S.sharpness = Math.max(0, Math.min(2, p.sharpness));
    if (Number.isFinite(p.receiptContrast)) S.receiptContrast = Math.max(1, Math.min(8, p.receiptContrast));
    if (p.cameraPrefs && typeof p.cameraPrefs === "object" && !Array.isArray(p.cameraPrefs)) S.cameraPrefs = p.cameraPrefs;
  } catch { /* ignore */ }
}
function savePrefs() {
  try {
    localStorage.setItem("scancat:prefs", JSON.stringify({ mode: S.mode, pageSize: S.pageSize, auto: S.auto, sound: S.sound, deviceId: S.deviceId, sharpness: S.sharpness, receiptContrast: S.receiptContrast, cameraPrefs: S.cameraPrefs, multi: S.multi }));
  } catch { /* ignore */ }
}

/* ---------- worker ---------- */

const worker = new Worker("js/worker.js?v=burst-v1", { type: "module" });
const pending = new Map();
let wid = 0;
worker.onmessage = (e) => {
  const { id, error } = e.data;
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  if (error) p.reject(new Error(error)); else p.resolve(e.data);
};
worker.onerror = (e) => { for (const p of pending.values()) p.reject(new Error(e.message || "worker failed")); pending.clear(); };
function callWorker(msg, transfer = []) {
  return new Promise((resolve, reject) => {
    const id = ++wid;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, ...msg }, transfer);
  });
}

/* ---------- helpers ---------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pillHold = 0;
/** Status line. A `holdMs` keeps a transient message on screen despite the live loop. */
function setPill(text, cls = "", holdMs = 0) {
  if (!holdMs && performance.now() < pillHold) return;
  const pill = $("pill");
  if (pill.textContent !== text) pill.textContent = text;
  pill.className = `pill mono ${cls}`.trim();
  if (holdMs) pillHold = performance.now() + holdMs;
}

function setRing(frac) {
  const ring = $("ring");
  if (frac == null) { ring.hidden = true; return; }
  ring.hidden = false;
  $("ringfg").style.strokeDashoffset = String(97.4 * (1 - Math.max(0, Math.min(1, frac))));
}

function showErr(msg) {
  const el = $("camerr");
  el.textContent = msg;
  el.hidden = !msg;
}

function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

let actx = null;
function shutterSound() {
  if (!S.sound) return;
  try {
    actx = actx || new AudioContext();
    const sr = actx.sampleRate, t = actx.currentTime;
    const burst = (at, len, freq, gain) => {
      const buf = actx.createBuffer(1, Math.round(sr * len), sr);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (sr * len * 0.18));
      const src = actx.createBufferSource(); src.buffer = buf;
      const f = actx.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = freq; f.Q.value = 0.8;
      const g = actx.createGain(); g.gain.value = gain;
      src.connect(f).connect(g).connect(actx.destination);
      src.start(at);
    };
    burst(t, 0.05, 3200, 0.5);
    burst(t + 0.07, 0.08, 1600, 0.35);
  } catch { /* no audio, no problem */ }
}

function flash() {
  const el = $("flash");
  el.classList.remove("go");
  void el.offsetWidth;
  el.classList.add("go");
}

/* ---------- digital zoom ---------- */

function zoomCrop(vw, vh) {
  const z = Math.max(1, Math.min(4, S.zoom));
  const sw = vw / z, sh = vh / z;
  const hx = 0.5 / z, hy = 0.5 / z;
  S.zoomX = Math.max(hx, Math.min(1 - hx, S.zoomX));
  S.zoomY = Math.max(hy, Math.min(1 - hy, S.zoomY));
  return { sx: S.zoomX * vw - sw / 2, sy: S.zoomY * vh - sh / 2, sw, sh };
}

function updateZoomUI() {
  const z = S.zoom;
  const video = $("video");
  const viewport = $("viewport");
  const tx = (0.5 - S.zoomX * z) * 100;
  const ty = (0.5 - S.zoomY * z) * 100;
  video.style.transform = z === 1 ? "" : `translate(${tx}%, ${ty}%) scale(${z})`;
  viewport.classList.toggle("zoomed", z > 1);
  $("zoomhint").hidden = z === 1;
  $("zoomvalue").value = `${Number.isInteger(z) ? z : z.toFixed(2).replace(/0$/, "")}×`;
  $("zoomreset").disabled = z === 1;
}

function setZoom(value, resetCenter = false) {
  S.zoom = Math.max(1, Math.min(4, Number(value) || 1));
  if (resetCenter || S.zoom === 1) S.zoomX = S.zoomY = 0.5;
  const video = $("video");
  if (video.videoWidth) zoomCrop(video.videoWidth, video.videoHeight);
  $("zoom").value = String(S.zoom);
  updateZoomUI();
  resetDetection();
}

/* ---------- camera ---------- */

let changingResolution = false;
const RESOLUTIONS = ["max", "1280x720", "1920x1080", "2560x1440", "3840x2160"];
function savedResolution(deviceId) {
  const value = S.cameraPrefs?.[deviceId]?.resolution;
  return RESOLUTIONS.includes(value) ? value : "max";
}

function rememberCameraControls(track) {
  const settings = track.getSettings();
  if (!settings.deviceId) return;
  const pref = { ...(S.cameraPrefs[settings.deviceId] || {}) };
  for (const key of ["exposureMode", "exposureTime", "exposureCompensation", "focusMode", "focusDistance"]) {
    if (settings[key] !== undefined) pref[key] = settings[key];
  }
  S.cameraPrefs[settings.deviceId] = pref;
  savePrefs();
}

async function restoreCameraControls(track) {
  const pref = S.cameraPrefs[track.getSettings().deviceId];
  if (!pref || typeof pref !== "object") return;
  const caps = track.getCapabilities?.() || {};
  const bounded = (key) => {
    const range = caps[key];
    return range && Number.isFinite(pref[key]) ? Math.max(range.min, Math.min(range.max, pref[key])) : undefined;
  };
  // Restore independently so an unsupported focus mode cannot discard exposure.
  for (const kind of ["exposure", "focus"]) {
    const modeKey = `${kind}Mode`, valueKey = kind === "focus" ? "focusDistance" : "exposureTime";
    const value = bounded(valueKey), change = {};
    if (["manual", "continuous"].includes(pref[modeKey]) && caps[modeKey]?.includes(pref[modeKey])) {
      if (pref[modeKey] !== "manual" || value !== undefined) {
        change[modeKey] = pref[modeKey];
        if (pref[modeKey] === "manual") change[valueKey] = value;
      }
    }
    if (kind === "exposure" && bounded("exposureCompensation") !== undefined) change.exposureCompensation = bounded("exposureCompensation");
    if (!Object.keys(change).length) continue;
    try {
      await track.applyConstraints(cameraAdjustments(track, change));
      if (change[modeKey] && track.getSettings()[modeKey] !== change[modeKey]) throw new Error("Camera ignored saved mode");
    }
    catch { setPill(`Camera could not restore saved ${kind}`, "bad", 4000); }
  }
}

// Updating one camera control must not silently reset the other manual controls.
function cameraAdjustments(track, change = {}) {
  const settings = track.getSettings();
  return { ...(track.getConstraints?.() || {}), advanced: [{
    ...(settings.exposureMode === "manual" ? { exposureMode: "manual", exposureTime: settings.exposureTime } : {}),
    ...(settings.focusMode === "manual" ? { focusMode: "manual", focusDistance: settings.focusDistance } : {}),
    ...change,
  }] };
}

function setupFocus(track) {
  const caps = track.getCapabilities?.() || {}, r = caps.focusDistance;
  $("focusctl").hidden = !r || !caps.focusMode?.includes("manual") || r.min === r.max;
  if ($("focusctl").hidden) return;
  const input = $("focus");
  input.min = r.min; input.max = r.max; input.step = r.step || 1;
  input.value = track.getSettings().focusDistance ?? r.min;
  $("focusauto").hidden = !caps.focusMode.includes("continuous");
}

function setupExposure(track) {
  const caps = track.getCapabilities?.() || {};
  if (caps.exposureTime && caps.exposureMode?.includes("manual")) {
    $("exposurectl").hidden = false;
    const input = $("exposure"), settings = track.getSettings();
    input.dataset.manual = "true";
    input.min = Math.log2(Math.max(0.01, caps.exposureTime.min));
    input.max = Math.log2(caps.exposureTime.max); input.step = 0.25;
    input.value = Math.log2(settings.exposureTime || caps.exposureTime.min);
    $("exposurevalue").value = `${(settings.exposureTime * 0.1).toFixed(1)}ms ${settings.exposureMode === "manual" ? "locked" : "auto"}`;
    $("exposureauto").hidden = false;
    return;
  }
  const range = track.getCapabilities?.().exposureCompensation;
  $("exposureauto").hidden = true;
  $("exposure").dataset.manual = "false";
  $("exposurectl").hidden = !range || range.min === range.max;
  if (!range || range.min === range.max) return;
  const input = $("exposure");
  input.min = range.min; input.max = range.max; input.step = range.step || 0.1;
  input.value = track.getSettings().exposureCompensation ?? 0;
  $("exposurevalue").value = input.value;
}

function updateStreamSize() {
  const video = $("video");
  if (!video.videoWidth || !video.videoHeight) return;
  $("viewport").style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
  $("res").textContent = `${video.videoWidth}×${video.videoHeight}`;
  resetDetection();
}

async function changeResolution() {
  const track = S.stream?.getVideoTracks()[0];
  if (!track || changingResolution) return;
  const sel = $("resolution"), note = $("resolutionnote");
  const requested = sel.value;
  changingResolution = true;
  sel.disabled = true;
  $("camera").disabled = true;
  $("shutter").disabled = true;
  resetDetection();
  note.hidden = false;
  note.textContent = "Changing stream resolution…";
  try {
    let constraints;
    if (requested === "max") {
      const caps = track.getCapabilities?.() || {};
      constraints = { width: { ideal: caps.width?.max || 3840 }, height: { ideal: caps.height?.max || 2160 } };
    } else {
      const [width, height] = requested.split("x").map(Number);
      constraints = { width: { exact: width }, height: { exact: height } };
    }
    // Chrome can route a mixed resolution + Image Capture request entirely to
    // the imaging controls, silently ignoring width/height. Apply separately.
    const controls = cameraAdjustments(track).advanced[0];
    await track.applyConstraints(constraints);
    if (Object.keys(controls).length) await track.applyConstraints({ advanced: [controls] });
    const actual = track.getSettings();
    if (requested !== "max") {
      const [width, height] = requested.split("x").map(Number);
      if (actual.width !== width || actual.height !== height) throw new Error("Camera ignored requested dimensions");
    }
    note.textContent = `Stream: ${actual.width} × ${actual.height}.`;
    if (requested === "max") note.textContent += " Highest resolution requested from this camera driver.";
    sel.dataset.applied = requested;
    updateStreamSize();
    const id = actual.deviceId || S.deviceId;
    if (id) {
      S.cameraPrefs[id] = { ...(S.cameraPrefs[id] || {}), resolution: requested };
      savePrefs();
    }
  } catch (e) {
    sel.value = sel.dataset.applied || "max";
    const caps = track.getCapabilities?.() || {};
    const actual = track.getSettings();
    const limit = caps.width?.max && caps.height?.max
      ? ` Browser-reported limit: ${caps.width.max} × ${caps.height.max}.` : "";
    note.textContent = `This camera driver could not provide that resolution.${limit} Current stream: ${actual.width} × ${actual.height}.`;
    if (e?.constraint) note.textContent += ` Rejected constraint: ${e.constraint}.`;
  } finally {
    changingResolution = false;
    sel.disabled = false;
    $("camera").disabled = false;
    $("shutter").disabled = false;
    resetDetection();
  }
}

function stopStream() {
  if (timedCapture) cancelTimedCapture("timer cancelled — camera stopped");
  if (burstState) cancelBurst("burst cancelled — camera stopped");
  if (S.stream) for (const t of S.stream.getTracks()) t.stop();
  S.stream = null;
}

function cameraError(e) {
  if (!window.isSecureContext) return "Camera access needs a secure page (https or localhost).";
  switch (e && e.name) {
    case "NotAllowedError": case "SecurityError":
      return "Camera access was blocked. Allow it for this site (the camera icon in the address bar, or the browser's site settings) and press Start camera again.";
    case "NotFoundError": case "OverconstrainedError": return "No camera was found on this device.";
    case "NotReadableError": case "AbortError": return "The camera is busy in another app. Close it (or pick another camera) and try again.";
    default: return `Couldn't start the camera: ${e && e.message || e}`;
  }
}

async function startCamera(deviceId) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showErr("This browser can't access the camera. Try a current Chrome, Safari, Firefox or Edge.");
    return false;
  }
  S.starting = true;
  S.running = false;
  stopStream();
  const requested = savedResolution(deviceId);
  const [width, height] = requested === "max" ? [3840, 2160] : requested.split("x").map(Number);
  const base = { width: { ideal: width }, height: { ideal: height } };
  const constraints = deviceId ? { ...base, deviceId: { exact: deviceId } } : { ...base, facingMode: "environment" };
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: constraints, audio: false });
  } catch (e) {
    if (deviceId && ["OverconstrainedError", "NotFoundError", "NotReadableError"].includes(e.name)) return startCamera(null);
    showErr(cameraError(e));
    S.starting = false;
    return false;
  }
  showErr("");
  S.stream = stream;
  const video = $("video");
  video.srcObject = stream;
  await new Promise((res) => {
    if (video.readyState >= 1 && video.videoWidth) return res();
    video.addEventListener("loadedmetadata", () => res(), { once: true });
  });
  try { await video.play(); } catch { /* autoplay is muted so this shouldn't fail */ }
  const track = stream.getVideoTracks()[0];
  setupExposure(track);
  setupFocus(track);
  const st = track.getSettings ? track.getSettings() : {};
  S.deviceId = st.deviceId || deviceId || null;
  savePrefs();
  const vw = video.videoWidth, vh = video.videoHeight;
  setZoom(1, true);
  $("viewport").style.aspectRatio = `${vw} / ${vh}`;
  $("res").textContent = `${vw}×${vh}`;
  $("resolution").value = savedResolution(S.deviceId);
  $("resolution").dataset.applied = RESOLUTIONS.includes(`${vw}x${vh}`) ? `${vw}x${vh}` : "max";
  $("resolutionnote").hidden = true;
  track.addEventListener("ended", () => { if (S.running) { setPill("camera stopped", "bad"); } });
  await refreshDevices();
  document.body.classList.add("live");
  $("scanner").hidden = false;
  S.running = true;
  await changeResolution();
  await restoreCameraControls(track);
  setupExposure(track);
  setupFocus(track);
  S.starting = false;
  resetDetection();
  setPill("looking for a page…");
  requestAnimationFrame(loop);
  return true;
}

async function refreshDevices() {
  let devs = [];
  try { devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput"); } catch { /* ignore */ }
  const sel = $("camera");
  sel.innerHTML = "";
  devs.forEach((d, i) => {
    const o = document.createElement("option");
    o.value = d.deviceId;
    o.textContent = d.label || `camera ${i + 1}`;
    sel.appendChild(o);
  });
  if (S.deviceId && devs.some((d) => d.deviceId === S.deviceId)) sel.value = S.deviceId;
  sel.parentElement.hidden = devs.length < 2;
}

/* ---------- detection loop ---------- */

const detCanvas = document.createElement("canvas");
const detCtx = detCanvas.getContext("2d", { willReadFrequently: true });
let lastTick = 0;
let previousDetectionFrame = null;
const preparedCapture = new SettledCapture();
let burstState = null;
let timedCapture = null;

function cancelTimedCapture(message = "timed capture cancelled") {
  if (!timedCapture) return;
  clearTimeout(timedCapture.timer); timedCapture = null;
  $("timedcapture").textContent = "Capture in 5s (T)";
  $("timedcapture").setAttribute("aria-pressed", "false");
  setRing(null); setPill(message, "", 1200);
}

function toggleTimedCapture() {
  if (timedCapture) { cancelTimedCapture(); return; }
  if (!S.running || S.starting || S.busy || S.editing) return;
  if (burstState) cancelBurst();
  preparedCapture.cancel(); syncPreparedCapture();
  const state = { deadline: performance.now() + 5000, timer: null };
  timedCapture = state;
  $("timedcapture").textContent = "cancel timer (T)";
  $("timedcapture").setAttribute("aria-pressed", "true");
  setPill("capture in 5 — hold the receipt flat", "ok", 0);
  state.timer = setTimeout(async () => {
    if (timedCapture !== state) return;
    timedCapture = null; $("timedcapture").textContent = "Capture in 5s (T)";
    $("timedcapture").setAttribute("aria-pressed", "false"); setRing(null);
    if (!await capture("manual")) setPill("Timed capture could not run — camera is not ready", "bad", 3000);
  }, 5000);
}

function tickTimedCapture(ts) {
  if (!timedCapture) return;
  const left = Math.max(0, timedCapture.deadline - ts);
  setRing(1 - left / 5000);
  setPill(`capture in ${Math.max(1, Math.ceil(left / 1000))} — keep holding the receipt flat`, "ok");
}
const burstCanvas = document.createElement("canvas");
const burstCtx = burstCanvas.getContext("2d", { willReadFrequently: true });
const burstDetection = document.createElement("canvas");
const burstDetCtx = burstDetection.getContext("2d", { willReadFrequently: true });

function cancelBurst(message = "burst cancelled") {
  if (!burstState) return;
  burstState.cancelled = true; burstState = null;
  $("burstcapture").textContent = "Combine frames (8s)";
  $("burstcapture").setAttribute("aria-pressed", "false");
  setRing(null); setPill(message, "", 1500);
  callWorker({ op: "burst-reset" }).catch(console.error);
}

async function sampleBurst(state) {
  state.pending = true;
  try {
    const video = $("video"), crop = zoomCrop(video.videoWidth, video.videoHeight);
    const fw = Math.round(crop.sw), fh = Math.round(crop.sh);
    burstCanvas.width = fw; burstCanvas.height = fh;
    burstCtx.drawImage(video, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, fw, fh);
    // Detect and retain corners from this exact frame, not a smoothed outline
    // from an earlier moment while the paper is being pulled.
    burstDetection.width = DET_W; burstDetection.height = Math.round(fh * DET_W / fw);
    burstDetCtx.drawImage(burstCanvas, 0, 0, burstDetection.width, burstDetection.height);
    const small = burstDetCtx.getImageData(0, 0, burstDetection.width, burstDetection.height);
    const q = V.detectDocument(small.data, small.width, small.height, S.mode === "receipt" ? { receipt: true, minArea: 0.008, minSep: 0.04, lineThreshold: 0.06, lineLength: 0.03, maxLines: 24 } : {});
    if (!q || q.score < MIN_SCORE) return;
    const corners = q.corners.map(([x, y]) => [x * fw / small.width, y * fh / small.height]);
    const img = burstCtx.getImageData(0, 0, fw, fh), frameId = ++state.frames;
    const result = await callWorker({ op: "burst-add", data: img.data, w: fw, h: fh, corners, frameId }, [img.data.buffer]);
    if (result.best && burstState === state && !state.cancelled) {
      const frame = await new Promise(resolve => burstCanvas.toBlob(resolve, "image/jpeg", 0.98));
      state.best = { frame, fw, fh, corners, frameId };
    }
  } catch (e) { if (burstState === state) cancelBurst(`burst failed: ${e.message}`); }
  finally { state.pending = false; }
}

async function finishBurst(state) {
  state.finishing = true;
  if (!state.best) { cancelBurst("No receipt outline found during burst — move it closer and retry"); return; }
  S.busy++;
  setPill("aligning and combining frames…", "", 1000);
  try {
    const result = await callWorker({ op: "burst-finish" });
    if (burstState !== state || state.cancelled) return;
    const c = document.createElement("canvas"); c.width = result.w; c.height = result.h;
    c.getContext("2d").putImageData(new ImageData(result.data, result.w, result.h), 0, 0);
    const fusionFrame = await new Promise(resolve => c.toBlob(resolve, "image/png"));
    const best = state.best;
    if (result.referenceId !== best.frameId) throw new Error("Burst reference frame changed");
    const page = { id: ++S.seq, fw: best.fw, fh: best.fh, frame: best.frame, frameReady: Promise.resolve(best.frame),
      corners: best.corners, fusionCorners: best.corners.map(p => [...p]), fusionFrame, fusedFrames: result.usedFrames,
      rot: 0, mode: null, out: null, url: "", w: 0, h: 0, cropped: true };
    await processPage(page);
    if (burstState !== state || state.cancelled) { if (page.url) URL.revokeObjectURL(page.url); return; }
    S.pages.push(page); renderTray(); flash(); shutterSound();
    S.det.armed = false; S.det.lastCap = S.det.smooth?.map(p => [...p]);
    setPill(result.usedFrames > 1 ? `page ${S.pages.length} captured — combined ${result.usedFrames} aligned frames` : `page ${S.pages.length} captured — sharpest frame (others did not align)`, "ok", 4000);
  } catch (e) { setPill(`couldn't combine frames: ${e.message}`, "bad", 4000); }
  finally {
    S.busy--;
    if (burstState === state) {
      burstState = null; $("burstcapture").textContent = "Combine frames (8s)";
      $("burstcapture").setAttribute("aria-pressed", "false"); setRing(null);
    }
  }
}

function tickBurst(ts) {
  const state = burstState;
  if (!state || state.finishing) return;
  if (S.editing || S.starting || changingResolution) { cancelBurst("burst cancelled — camera or editor changed"); return; }
  const elapsed = ts - state.start;
  setRing(Math.min(1, elapsed / 8000));
  setPill(elapsed < 2000 ? "get ready — stretch the receipt and keep holding" : `recording ${Math.max(1, Math.ceil((8000 - elapsed) / 1000))}s — keep pulling; ${state.frames} usable frames`, "ok");
  if (state.pending) return;
  if (elapsed >= 8000) { finishBurst(state); return; }
  if (elapsed >= 2000 && ts - state.lastSample >= 300) { state.lastSample = ts; sampleBurst(state); }
}

function syncPreparedCapture() {
  $("preparecapture").textContent = preparedCapture.armed ? "cancel capture" : "Flatten & capture";
  $("preparecapture").setAttribute("aria-pressed", String(preparedCapture.armed));
}

function resetDetection() {
  if (timedCapture) cancelTimedCapture("timed capture cancelled — camera framing changed");
  if (burstState) cancelBurst("burst cancelled — camera framing changed");
  preparedCapture.restart();
  previousDetectionFrame = null;
  Object.assign(S.det, { smooth: null, stable: 0, lost: 99, armed: true, lastCap: null, score: 0, support: 0, quads: [], multiMoving: false });
  drawOverlay(null);
  setRing(null);
}

function loop(ts) {
  if (!S.running) return;
  requestAnimationFrame(loop);
  if (ts - lastTick < LOOP_MS || document.hidden || S.starting || changingResolution || zoomDrag) return;
  lastTick = ts;
  const video = $("video");
  if (video.readyState < 2 || !video.videoWidth) return;
  const vw = video.videoWidth, vh = video.videoHeight;
  const crop = zoomCrop(vw, vh);
  const dw = DET_W, dh = Math.max(8, Math.round(vh * dw / vw));
  if (detCanvas.width !== dw || detCanvas.height !== dh) { detCanvas.width = dw; detCanvas.height = dh; }
  detCtx.drawImage(video, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, dw, dh);
  const img = detCtx.getImageData(0, 0, dw, dh);
  const motion = frameMotion(previousDetectionFrame, img.data, dw, dh, S.multi ? null : S.det.smooth);
  previousDetectionFrame = img.data;
  const t0 = performance.now();
  let q = null;
  const receipt = S.mode === "receipt";
  try {
    const opts = receipt || S.multi ? { receipt: true, minArea: 0.008, minSep: 0.04, lineThreshold: 0.06, lineLength: 0.03, maxLines: 24 } : {};
    if (S.multi) {
      const quads = V.detectDocuments(img.data, dw, dh, opts).filter(q => q.score >= MIN_SCORE);
      const prior = S.det.quads || [];
      S.det.multiMoving = quads.length !== prior.length || quads.some((q, i) => !prior[i] || maxShift(q.corners, prior[i].corners) > 0.02 * dw);
      S.det.quads = quads; q = quads[0] || null;
    } else { S.det.quads = []; q = V.detectDocument(img.data, dw, dh, opts); }
  } catch (e) { console.error(e); }
  S.det.ms = performance.now() - t0;
  S.det.w = dw; S.det.h = dh;
  track(q, dw, dh, motion, ts);
  tickBurst(ts);
  tickTimedCapture(ts);
}

function maxShift(a, b) {
  let m = 0;
  for (let i = 0; i < 4; i++) m = Math.max(m, Math.hypot(a[i][0] - b[i][0], a[i][1] - b[i][1]));
  return m;
}

function track(q, dw, dh, motion = 0, ts = performance.now()) {
  const D = S.det;
  if (S.busy || S.editing) { preparedCapture.restart(); setPill(S.busy ? "processing…" : "close the editor to resume capture"); setRing(null); return; }
  if (!q || q.score < MIN_SCORE) {
    preparedCapture.update(ts, false, true);
    D.lost++;
    if (D.lost > 3) { D.smooth = null; D.stable = 0; drawOverlay(null); setRing(null); D.score = 0; D.support = 0; }
    if (D.lost > 8) D.armed = true;
    if (D.lost > 3) setPill(preparedCapture.armed ? "flatten the receipt — waiting for a clear outline" : S.pages.length && !D.armed ? "captured — next page" : "looking for a page — hold it up, fill the frame");
    return;
  }
  D.lost = 0;
  D.score = q.score; D.support = q.support;
  const shifted = D.smooth && maxShift(q.corners, D.smooth) > 0.01 * dw;
  if (!D.smooth) { D.smooth = q.corners.map((c) => [c[0], c[1]]); D.stable = 0; }
  else {
    const shift = maxShift(q.corners, D.smooth);
    for (let i = 0; i < 4; i++) {
      D.smooth[i][0] += (q.corners[i][0] - D.smooth[i][0]) * 0.45;
      D.smooth[i][1] += (q.corners[i][1] - D.smooth[i][1]) * 0.45;
    }
    if (shift < 0.02 * dw) D.stable++; else D.stable = 0;
  }
  if (!D.armed && D.lastCap && maxShift(D.smooth, D.lastCap) > 0.15 * dw) D.armed = true;
  if (S.multi && (motion > 0.015 || D.multiMoving)) D.stable = 0;
  drawOverlay(D.smooth, q.support >= GOOD_SUPPORT);
  if (burstState || timedCapture) return;
  if (preparedCapture.armed) {
    const result = preparedCapture.update(ts, q.support >= GOOD_SUPPORT && (!S.multi || D.quads.every(q => q.support >= GOOD_SUPPORT)), motion > 0.015 || shifted || (S.multi && D.multiMoving));
    setRing(result.progress);
    setPill(result.progress > 0 ? `capture in ${Math.max(1, Math.ceil(3 * (1 - result.progress)))} — keep still` : "flatten the receipt, then move your hands clear", "ok");
    if (result.fire) {
      D.armed = false; D.stable = 0; D.lastCap = D.smooth.map(c => [...c]);
      setRing(null); syncPreparedCapture(); capture("prepared");
    }
    return;
  }
  if (S.auto && D.armed) {
    const frac = D.stable / STEADY_FRAMES;
    setRing(frac);
    setPill(D.stable < 2 ? "page found — hold still" : "hold still…", q.support >= GOOD_SUPPORT ? "ok" : "");
    if (D.stable >= STEADY_FRAMES) {
      D.armed = false; D.stable = 0; D.lastCap = D.smooth.map((c) => [c[0], c[1]]);
      setRing(null);
      capture("auto");
    }
  } else {
    setRing(null);
    setPill(!D.armed && S.auto ? "captured — move to the next page" : "page found — space to capture", q.support >= GOOD_SUPPORT ? "ok" : "");
  }
}

function drawOverlay(corners, good = true) {
  const svg = $("overlay"), poly = $("quad"), dots = $("dots");
  const extra = $("multiquads"); extra.replaceChildren();
  if (!corners) { poly.setAttribute("points", ""); dots.innerHTML = ""; return; }
  svg.setAttribute("viewBox", `0 0 ${S.det.w} ${S.det.h}`);
  poly.setAttribute("points", corners.map((c) => `${c[0].toFixed(1)},${c[1].toFixed(1)}`).join(" "));
  poly.classList.toggle("weak", !good);
  if (dots.childElementCount !== 4) {
    dots.innerHTML = "";
    for (let i = 0; i < 4; i++) { const c = document.createElementNS("http://www.w3.org/2000/svg", "circle"); c.setAttribute("r", "4"); dots.appendChild(c); }
  }
  Array.from(dots.children).forEach((c, i) => { c.setAttribute("cx", corners[i][0].toFixed(1)); c.setAttribute("cy", corners[i][1].toFixed(1)); });
  if (S.multi) (S.det.quads || []).forEach((q, i) => {
    if (i) {
      const p = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
      p.setAttribute("points", q.corners.map(c => c.join(",")).join(" "));
      p.setAttribute("fill", "rgba(14,107,82,0.12)"); p.setAttribute("stroke", "#0e6b52");
      p.setAttribute("stroke-width", "3"); p.setAttribute("vector-effect", "non-scaling-stroke"); extra.appendChild(p);
    }
    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", q.corners[0][0] + 3); label.setAttribute("y", q.corners[0][1] + 12);
    label.setAttribute("fill", "white"); label.setAttribute("stroke", "#141412"); label.setAttribute("stroke-width", "2");
    label.setAttribute("paint-order", "stroke"); label.setAttribute("font-size", "10"); label.textContent = String(i + 1); extra.appendChild(label);
  });
}

/* ---------- pages ---------- */

const fullCanvas = document.createElement("canvas");
const fullCtx = fullCanvas.getContext("2d", { willReadFrequently: true });

function shrinkQuad(corners, frac) {
  const cx = (corners[0][0] + corners[1][0] + corners[2][0] + corners[3][0]) / 4;
  const cy = (corners[0][1] + corners[1][1] + corners[2][1] + corners[3][1]) / 4;
  return corners.map(([x, y]) => [x + (cx - x) * frac, y + (cy - y) * frac]);
}

async function capture(source = "manual") {
  const video = $("video");
  if (!S.running || S.starting || S.busy || changingResolution || video.readyState < 2 || !video.videoWidth) return null;
  if (timedCapture) cancelTimedCapture("manual capture");
  if (burstState) cancelBurst("manual capture");
  if (source === "manual" && preparedCapture.armed) { preparedCapture.cancel(); syncPreparedCapture(); }
  const vw = video.videoWidth, vh = video.videoHeight;
  const crop = zoomCrop(vw, vh);
  const fw = Math.max(1, Math.round(crop.sw)), fh = Math.max(1, Math.round(crop.sh));
  const det = S.det.smooth;
  const f = fw / (S.det.w || DET_W);
  const corners = det ? shrinkQuad(det.map(([x, y]) => [x * f, y * f]), S.mode === "receipt" ? 0 : 0.008) : V.frameCorners(fw, fh);
  if (fullCanvas.width !== fw || fullCanvas.height !== fh) { fullCanvas.width = fw; fullCanvas.height = fh; }
  fullCtx.drawImage(video, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, fw, fh);
  const img = fullCtx.getImageData(0, 0, fw, fh);
  let scans = [{ corners, cropped: !!det }];
  if (S.multi) {
    burstDetection.width = DET_W; burstDetection.height = Math.round(fh * DET_W / fw);
    burstDetCtx.drawImage(fullCanvas, 0, 0, burstDetection.width, burstDetection.height);
    const small = burstDetCtx.getImageData(0, 0, burstDetection.width, burstDetection.height);
    const quads = V.detectDocuments(small.data, small.width, small.height, { receipt: true }).filter(q => q.score >= MIN_SCORE);
    if (quads.length) scans = quads.map(q => ({ corners: q.corners.map(([x, y]) => [x * fw / small.width, y * fh / small.height]), cropped: true }));
    else scans = [{ corners: V.frameCorners(fw, fh), cropped: false }];
  }
  flash();
  shutterSound();
  if (source === "manual") { S.det.armed = false; S.det.lastCap = det ? det.map((c) => [c[0], c[1]]) : null; S.det.stable = 0; }
  const frameReady = new Promise(resolve => fullCanvas.toBlob(resolve, "image/jpeg", S.mode === "receipt" ? 0.98 : 0.92));
  let firstPage = null;
  S.busy++;
  setPill("processing…");
  try {
    for (let i = 0; i < scans.length; i++) {
      const scan = scans[i];
      const page = { id: ++S.seq, fw, fh, corners: scan.corners, rot: 0, mode: null, frame: null, out: null, url: "", w: 0, h: 0, cropped: scan.cropped };
      page.frameReady = frameReady.then(frame => { page.frame = frame; return frame; });
      setPill(`processing ${i + 1} of ${scans.length}…`);
      // Processing transfers its buffer to the worker. Other receipts need a
      // fresh buffer from the same frozen camera frame, not another video frame.
      await processPage(page, i === 0 ? img : fullCtx.getImageData(0, 0, fw, fh));
      S.pages.push(page); if (!firstPage) firstPage = page; renderTray();
    }
    setPill(scans.length > 1 ? `${scans.length} receipts captured` : firstPage.cropped ? `page ${S.pages.length} captured` : `page ${S.pages.length} captured (whole frame — no page edges found)`, firstPage.cropped ? "ok" : "", 2000);
  } catch (e) {
    console.error(e);
    setPill(`couldn't process that page: ${e.message}`, "bad", 4000);
  } finally {
    S.busy--;
  }
  return firstPage;
}

async function frameImageData(page) {
  await page.frameReady;
  const bmp = await createImageBitmap(page.frame);
  const c = document.createElement("canvas");
  c.width = bmp.width; c.height = bmp.height;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return ctx.getImageData(0, 0, c.width, c.height);
}

async function processPage(page, img = null) {
  const fused = page.fusionFrame && JSON.stringify(page.corners) === JSON.stringify(page.fusionCorners);
  if (fused) img = await frameImageData({ frame: page.fusionFrame, frameReady: Promise.resolve() });
  else img = img || await frameImageData(page);
  const res = await callWorker({
    op: "process", data: img.data, w: img.width, h: img.height,
    corners: fused ? V.frameCorners(img.width, img.height) : page.corners, mode: page.mode || S.mode, rot: page.rot,
    sharpness: S.sharpness,
    receiptContrast: S.receiptContrast,
    maxSide: (page.mode || S.mode) === "receipt" ? Math.max(page.fw, page.fh) : MAX_SIDE,
  }, [img.data.buffer]);
  const c = document.createElement("canvas");
  c.width = res.w; c.height = res.h;
  c.getContext("2d").putImageData(new ImageData(res.data, res.w, res.h), 0, 0);
  const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", (page.mode || S.mode) === "receipt" ? 0.97 : 0.9));
  if (page.url) URL.revokeObjectURL(page.url);
  page.out = blob; page.url = URL.createObjectURL(blob); page.w = res.w; page.h = res.h;
  return page;
}

async function reprocess(page) {
  const li = $("pages").querySelector(`[data-id="${page.id}"]`);
  if (li) li.classList.add("busy");
  S.busy++;
  try { await processPage(page); }
  finally { S.busy--; if (li) li.classList.remove("busy"); }
  renderTray();
  if (S.editing === page) $("edimg").src = page.url;
}

async function reprocessAll() {
  const targets = S.pages.filter((p) => !p.mode);
  for (let i = 0; i < targets.length; i++) {
    setPill(`re-rendering page ${i + 1} of ${targets.length}…`);
    await reprocess(targets[i]);
  }
}

function removePage(page) {
  const i = S.pages.indexOf(page);
  if (i < 0) return;
  S.pages.splice(i, 1);
  if (page.url) URL.revokeObjectURL(page.url);
  if (S.editing === page) closeEditor();
  renderTray();
}

function movePage(from, to) {
  if (from === to || from < 0 || to < 0 || from >= S.pages.length || to >= S.pages.length) return;
  const [p] = S.pages.splice(from, 1);
  S.pages.splice(to, 0, p);
  renderTray();
}

/* ---------- tray ---------- */

let dragId = null;

function renderTray() {
  const ol = $("pages");
  const n = S.pages.length;
  $("count").textContent = n ? `${n} page${n === 1 ? "" : "s"}` : "no pages yet";
  $("trayhint").hidden = n > 0;
  $("pdf").disabled = !n; $("jpgs").disabled = !n; $("clear").disabled = !n;
  const seen = new Set();
  S.pages.forEach((p, i) => {
    seen.add(p.id);
    let li = ol.querySelector(`[data-id="${p.id}"]`);
    if (!li) {
      li = document.createElement("li");
      li.className = "page";
      li.dataset.id = p.id;
      li.draggable = true;
      li.tabIndex = 0;
      li.innerHTML = `<img alt=""><span class="num mono"></span><div class="acts"><button type="button" data-act="rot" title="Rotate right">⟳</button><button type="button" data-act="del" title="Delete">×</button></div>`;
      li.addEventListener("click", (e) => {
        const act = e.target.dataset && e.target.dataset.act;
        if (act === "rot") { p.rot = (p.rot + 1) % 4; reprocess(p); }
        else if (act === "del") removePage(p);
        else openEditor(p);
      });
      li.addEventListener("keydown", (e) => { if (e.key === "Enter") openEditor(p); });
      li.addEventListener("dragstart", (e) => { dragId = p.id; li.classList.add("drag"); e.dataTransfer.effectAllowed = "move"; });
      li.addEventListener("dragend", () => { dragId = null; li.classList.remove("drag"); ol.querySelectorAll(".over").forEach((x) => x.classList.remove("over")); });
      li.addEventListener("dragover", (e) => { if (dragId != null) { e.preventDefault(); li.classList.add("over"); } });
      li.addEventListener("dragleave", () => li.classList.remove("over"));
      li.addEventListener("drop", (e) => {
        e.preventDefault();
        const from = S.pages.findIndex((x) => x.id === dragId), to = S.pages.findIndex((x) => x.id === p.id);
        movePage(from, to);
      });
      ol.appendChild(li);
    }
    const img = li.querySelector("img");
    if (img.src !== p.url) img.src = p.url;
    img.alt = `page ${i + 1}`;
    li.querySelector(".num").textContent = String(i + 1);
    li.setAttribute("aria-label", `page ${i + 1}`);
    if (ol.children[i] !== li) ol.insertBefore(li, ol.children[i] || null);
  });
  Array.from(ol.children).forEach((li) => { if (!seen.has(+li.dataset.id)) li.remove(); });
}

/* ---------- editor ---------- */

function openEditor(page) {
  if (timedCapture) cancelTimedCapture("timer cancelled — editor opened");
  if (burstState) cancelBurst("burst cancelled — editor opened");
  S.editing = page;
  $("edimg").src = page.url;
  $("edtitle").textContent = `page ${S.pages.indexOf(page) + 1} of ${S.pages.length}`;
  $("edmode").value = page.mode || "";
  leaveCornerMode();
  $("editor").hidden = false;
  $("edclose").focus();
}

function closeEditor() {
  S.editing = null;
  leaveCornerMode();
  $("editor").hidden = true;
}

function leaveCornerMode() {
  S.corner = null;
  $("cornerpane").hidden = true;
  $("edview").hidden = false;
}

async function enterCornerMode() {
  const page = S.editing;
  if (!page) return;
  $("cornerpane").querySelector(".cornerhint").textContent = page.fusionFrame ? "drag corners onto the paper — changing the crop uses the sharpest original frame" : "drag the corners onto the page's corners";
  await page.frameReady;
  const bmp = await createImageBitmap(page.frame);
  const cv = $("cornercv");
  const maxW = Math.min(960, window.innerWidth - 80), maxH = Math.max(240, window.innerHeight - 260);
  const k = Math.min(1, maxW / bmp.width, maxH / bmp.height);
  cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k);
  cv.getContext("2d").drawImage(bmp, 0, 0, cv.width, cv.height);
  bmp.close();
  const svg = $("cornersvg");
  svg.setAttribute("viewBox", `0 0 ${page.fw} ${page.fh}`);
  S.corner = { page, pts: page.corners.map((c) => [c[0], c[1]]), drag: -1 };
  drawCornerUI();
  $("edview").hidden = true;
  $("cornerpane").hidden = false;
}

function drawCornerUI() {
  const C = S.corner; if (!C) return;
  $("cornerpoly").setAttribute("points", C.pts.map((c) => `${c[0]},${c[1]}`).join(" "));
  $("cornersvg").querySelectorAll(".h").forEach((h, i) => { h.setAttribute("cx", C.pts[i][0]); h.setAttribute("cy", C.pts[i][1]); });
}

function cornerPointer(e) {
  const C = S.corner, svg = $("cornersvg");
  const r = svg.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width * C.page.fw, y = (e.clientY - r.top) / r.height * C.page.fh;
  return [Math.max(0, Math.min(C.page.fw, x)), Math.max(0, Math.min(C.page.fh, y))];
}

function wireCornerEditor() {
  const svg = $("cornersvg");
  svg.addEventListener("pointerdown", (e) => {
    const C = S.corner; if (!C) return;
    const [x, y] = cornerPointer(e);
    let best = -1, bd = Infinity;
    C.pts.forEach((p, i) => { const d = Math.hypot(p[0] - x, p[1] - y); if (d < bd) { bd = d; best = i; } });
    const r = svg.getBoundingClientRect();
    if (bd * r.width / C.page.fw > 40) return;
    C.drag = best;
    svg.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  svg.addEventListener("pointermove", (e) => {
    const C = S.corner; if (!C || C.drag < 0) return;
    C.pts[C.drag] = cornerPointer(e);
    drawCornerUI();
  });
  const up = () => { if (S.corner) S.corner.drag = -1; };
  svg.addEventListener("pointerup", up);
  svg.addEventListener("pointercancel", up);
  $("cornerfull").addEventListener("click", () => { const C = S.corner; if (!C) return; C.pts = V.frameCorners(C.page.fw, C.page.fh); drawCornerUI(); });
  $("cornercancel").addEventListener("click", leaveCornerMode);
  $("cornerapply").addEventListener("click", async () => {
    const C = S.corner; if (!C) return;
    C.page.corners = V.orderCorners(C.pts.map((c) => [c[0], c[1]]));
    C.page.cropped = true;
    leaveCornerMode();
    await reprocess(C.page);
  });
}

async function pagePng(page) {
  const bmp = await createImageBitmap(page.out);
  const c = document.createElement("canvas");
  c.width = bmp.width; c.height = bmp.height;
  c.getContext("2d").drawImage(bmp, 0, 0);
  bmp.close();
  return new Promise((r) => c.toBlob(r, "image/png"));
}

/* ---------- export ---------- */

async function downloadPdf() {
  if (!S.pages.length || S.busy) return null;
  S.busy++;
  setPill("writing PDF…");
  try {
    const pages = [];
    for (const p of S.pages) pages.push({ jpeg: new Uint8Array(await p.out.arrayBuffer()), width: p.w, height: p.h });
    const bytes = buildPdf(pages, { pageSize: S.pageSize, title: `Scan ${stamp()}` });
    const blob = new Blob([bytes], { type: "application/pdf" });
    download(blob, `scancat-${stamp()}.pdf`);
    setPill(`PDF saved — ${pages.length} page${pages.length === 1 ? "" : "s"}, ${(blob.size / 1048576).toFixed(1)} MB`, "ok", 3000);
    return blob;
  } finally { S.busy--; }
}

async function downloadJpegs() {
  const base = `scancat-${stamp()}`;
  for (let i = 0; i < S.pages.length; i++) {
    download(S.pages[i].out, `${base}-p${String(i + 1).padStart(2, "0")}.jpg`);
    await sleep(350);
  }
}

/* ---------- wiring ---------- */

let zoomDrag = null;

function wireZoom() {
  $("zoom").addEventListener("input", (e) => setZoom(e.target.value));
  $("zoomreset").addEventListener("click", () => setZoom(1, true));

  const viewport = $("viewport");
  viewport.addEventListener("pointerdown", (e) => {
    if (S.zoom <= 1 || e.button !== 0) return;
    zoomDrag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    viewport.setPointerCapture(e.pointerId);
    viewport.classList.add("dragging");
    resetDetection();
    e.preventDefault();
  });
  viewport.addEventListener("pointermove", (e) => {
    if (!zoomDrag || zoomDrag.id !== e.pointerId) return;
    const r = viewport.getBoundingClientRect();
    S.zoomX -= (e.clientX - zoomDrag.x) / (r.width * S.zoom);
    S.zoomY -= (e.clientY - zoomDrag.y) / (r.height * S.zoom);
    zoomDrag.x = e.clientX; zoomDrag.y = e.clientY;
    const video = $("video");
    if (video.videoWidth) zoomCrop(video.videoWidth, video.videoHeight);
    updateZoomUI();
  });
  const endDrag = (e) => {
    if (!zoomDrag || zoomDrag.id !== e.pointerId) return;
    zoomDrag = null;
    viewport.classList.remove("dragging");
    resetDetection();
  };
  viewport.addEventListener("pointerup", endDrag);
  viewport.addEventListener("pointercancel", endDrag);
}

function wire() {
  loadPrefs();
  $("mode").value = S.mode; $("pagesize").value = S.pageSize;
  $("auto").checked = S.auto; $("sound").checked = S.sound;
  updateZoomUI();
  wireZoom();
  $("multiple").checked = S.multi;
  $("burstcapture").disabled = S.multi;
  $("multiple").addEventListener("change", e => {
    S.multi = e.target.checked; $("burstcapture").disabled = S.multi;
    savePrefs(); resetDetection();
  });
  $("preparecapture").addEventListener("click", () => {
    if (timedCapture) cancelTimedCapture();
    if (burstState) cancelBurst();
    if (preparedCapture.armed) { preparedCapture.cancel(); setRing(null); setPill("capture cancelled", "", 1000); }
    else { preparedCapture.arm(); setPill("flatten the receipt, then move your hands clear", "", 1000); }
    syncPreparedCapture();
  });
  $("burstcapture").addEventListener("click", async () => {
    if (timedCapture) cancelTimedCapture();
    if (burstState) { cancelBurst(); return; }
    if (!S.running || S.busy || S.starting || S.multi) return;
    preparedCapture.cancel(); syncPreparedCapture();
    const state = { start: performance.now(), lastSample: 0, pending: true, finishing: false, frames: 0, best: null, cancelled: false };
    burstState = state;
    $("burstcapture").textContent = "cancel recording";
    $("burstcapture").setAttribute("aria-pressed", "true");
    try { await callWorker({ op: "burst-reset" }); state.pending = false; }
    catch (e) { if (burstState === state) cancelBurst(e.message); }
  });
  $("timedcapture").addEventListener("click", toggleTimedCapture);
  $("receiptcontrast").value = S.receiptContrast;
  $("receiptcontrastvalue").value = String(S.receiptContrast);
  $("receiptcontrast").addEventListener("input", (e) => { $("receiptcontrastvalue").value = e.target.value; });
  $("receiptcontrast").addEventListener("change", async (e) => {
    S.receiptContrast = Number(e.target.value); savePrefs();
    for (const p of S.pages.filter(p => (p.mode || S.mode) === "receipt")) await reprocess(p);
  });
  $("sharpness").value = S.sharpness;
  $("sharpnessvalue").value = `${S.sharpness}×`;
  $("sharpness").addEventListener("input", (e) => { $("sharpnessvalue").value = `${e.target.value}×`; });
  $("sharpness").addEventListener("change", async (e) => {
    S.sharpness = Number(e.target.value); savePrefs();
    // Process all receipt pages, including pages with an explicit per-page look.
    for (const p of S.pages.filter(p => (p.mode || S.mode) === "receipt")) await reprocess(p);
  });
  $("focus").addEventListener("change", async (e) => {
    const track = S.stream?.getVideoTracks()[0];
    if (!track) return;
    try { await track.applyConstraints(cameraAdjustments(track, { focusMode: "manual", focusDistance: Number(e.target.value) })); rememberCameraControls(track); setupFocus(track); resetDetection(); }
    catch { setupFocus(track); setPill("Camera could not change focus", "bad", 3000); }
  });
  $("focusauto").addEventListener("click", async () => {
    const track = S.stream?.getVideoTracks()[0];
    if (!track) return;
    try { await track.applyConstraints(cameraAdjustments(track, { focusMode: "continuous" })); rememberCameraControls(track); setupFocus(track); resetDetection(); }
    catch { setPill("Camera could not restore autofocus", "bad", 3000); }
  });
  $("resolution").addEventListener("change", changeResolution);
  $("video").addEventListener("resize", updateStreamSize);

  $("start").addEventListener("click", async () => {
    $("start").disabled = true;
    const ok = await startCamera(S.deviceId);
    $("start").disabled = false;
    if (ok) $("shutter").focus();
  });
  $("camera").addEventListener("change", (e) => { startCamera(e.target.value); });
  navigator.mediaDevices?.addEventListener?.("devicechange", () => { if (S.running) refreshDevices(); });

  $("shutter").addEventListener("click", () => capture("manual"));
  $("auto").addEventListener("change", (e) => { S.auto = e.target.checked; savePrefs(); });
  $("sound").addEventListener("change", (e) => { S.sound = e.target.checked; savePrefs(); });
  $("pagesize").addEventListener("change", (e) => { S.pageSize = e.target.value; savePrefs(); });
  $("mode").addEventListener("change", async (e) => { S.mode = e.target.value; resetDetection(); savePrefs(); await reprocessAll(); });
  $("exposure").addEventListener("change", async (e) => {
    const track = S.stream?.getVideoTracks()[0];
    if (!track) return;
    try {
      const caps = track.getCapabilities?.() || {};
      const r = caps.exposureTime;
      const value = e.target.dataset.manual === "true" ? {
        exposureMode: "manual", exposureTime: Math.max(r.min, Math.min(r.max, r.min + Math.round((2 ** Number(e.target.value) - r.min) / (r.step || 1)) * (r.step || 1)))
      } : { exposureCompensation: Number(e.target.value) };
      await track.applyConstraints(cameraAdjustments(track, value));
      rememberCameraControls(track);
      setupExposure(track);
      resetDetection();
    } catch {
      setupExposure(track);
      setPill("Camera could not change exposure", "bad", 3000);
    }
  });
  $("exposureauto").addEventListener("click", async () => {
    const track = S.stream?.getVideoTracks()[0];
    if (!track) return;
    try { await track.applyConstraints(cameraAdjustments(track, { exposureMode: "continuous" })); rememberCameraControls(track); setupExposure(track); resetDetection(); }
    catch { setPill("Camera could not restore auto exposure", "bad", 3000); }
  });

  $("pdf").addEventListener("click", downloadPdf);
  $("jpgs").addEventListener("click", downloadJpegs);
  $("clear").addEventListener("click", () => {
    if (!S.pages.length) return;
    if (!confirm(`Discard all ${S.pages.length} scanned page${S.pages.length === 1 ? "" : "s"}?`)) return;
    for (const p of S.pages.splice(0)) if (p.url) URL.revokeObjectURL(p.url);
    closeEditor();
    renderTray();
    resetDetection();
    setPill("cleared", "", 1500);
  });

  $("edclose").addEventListener("click", closeEditor);
  $("editor").addEventListener("click", (e) => { if (e.target === $("editor")) closeEditor(); });
  $("edrotl").addEventListener("click", () => { const p = S.editing; if (p) { p.rot = (p.rot + 3) % 4; reprocess(p); } });
  $("edrotr").addEventListener("click", () => { const p = S.editing; if (p) { p.rot = (p.rot + 1) % 4; reprocess(p); } });
  $("edmode").addEventListener("change", (e) => { const p = S.editing; if (p) { p.mode = e.target.value || null; reprocess(p); } });
  $("edcorners").addEventListener("click", enterCornerMode);
  $("eddel").addEventListener("click", () => { if (S.editing) removePage(S.editing); });
  $("eddl").addEventListener("click", () => { const p = S.editing; if (p) download(p.out, `scancat-${stamp()}-p${String(S.pages.indexOf(p) + 1).padStart(2, "0")}.jpg`); });
  $("edcopy").addEventListener("click", async () => {
    const p = S.editing; if (!p) return;
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": pagePng(p) })]);
      $("edcopy").textContent = "copied";
    } catch (e) {
      $("edcopy").textContent = "copy failed";
    }
    setTimeout(() => { $("edcopy").textContent = "copy"; }, 1500);
  });
  wireCornerEditor();

  document.addEventListener("keydown", (e) => {
    const isTimerKey = e.key.toLowerCase() === "t" && !e.metaKey && !e.ctrlKey && !e.altKey;
    if (e.target.matches("input, select, textarea") && !(isTimerKey && e.target.matches("input[type=range], input[type=checkbox]"))) return;
    if (S.editing) { if (e.key === "Escape") closeEditor(); return; }
    if (!S.running) return;
    if (isTimerKey) {
      if (e.repeat) return;
      e.preventDefault(); toggleTimedCapture(); return;
    }
    if (e.code === "Space" || e.key === "Enter") {
      if (e.target.matches("button, a, li") && e.key === "Enter") return;
      e.preventDefault();
      capture("manual");
    } else if (e.key === "Backspace" || e.key === "Delete") {
      if (S.pages.length) { e.preventDefault(); removePage(S.pages[S.pages.length - 1]); }
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      downloadPdf();
    }
  });

  document.addEventListener("visibilitychange", () => { if (document.hidden && burstState) cancelBurst("burst cancelled — tab was hidden"); if (document.hidden && timedCapture) cancelTimedCapture("timer cancelled — tab was hidden"); if (!document.hidden && S.running) requestAnimationFrame(loop); });
  window.addEventListener("pagehide", stopStream);

  // test hooks
  window.__scancat = { S, capture, downloadPdf, processPage, V, buildPdf, startCamera, renderTray };
}

wire();
