// Scancat end-to-end suite: serves the repo, drives the real UI in headless
// Chrome with a fake webcam (fixtures/camera.y4m), and checks captures,
// auto-capture re-arming, editing, and the exported PDF (opened with MuPDF).
// Run `node make-fixtures.mjs` first.
//
//   CHROME_PATH=/path/to/chrome node run-tests.mjs
//   BASE=https://... node run-tests.mjs        (test a deployed copy)

import puppeteer from "puppeteer-core";
import * as mupdf from "mupdf";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const FIX = path.join(HERE, "fixtures");
const DL = path.join(FIX, "downloads");
const PORT = 8646;
const BASE = process.env.BASE || `http://localhost:${PORT}/`;
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CAM = path.join(FIX, "camera.y4m");
if (!fs.existsSync(CAM)) { console.error("run `node make-fixtures.mjs` first"); process.exit(2); }
const POSES = JSON.parse(fs.readFileSync(path.join(FIX, "poses.json"), "utf8"));

fs.rmSync(DL, { recursive: true, force: true });
fs.mkdirSync(DL, { recursive: true });

/* ---------- tiny static server ---------- */

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2",
};
let server = null;
if (!process.env.BASE) {
  server = http.createServer((req, res) => {
    const clean = path.normalize(decodeURIComponent(new URL(req.url, BASE).pathname));
    let file = path.join(ROOT, clean);
    if (clean === "/" || clean === "\\") file = path.join(ROOT, "index.html");
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  }).listen(PORT);
}

/* ---------- harness ---------- */

let browser;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function assert(c, m) { if (!c) throw new Error(`assert failed: ${m}`); }
function assertEq(got, want, m) { if (got !== want) throw new Error(`assert failed: ${m} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }

async function until(fn, what, timeoutMs = 15000, step = 100) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await sleep(step);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function newPage(dialogPlan = []) {
  const page = await browser.newPage();
  const ctx = { page, errors: [], dialogs: [], requests: [], dialogPlan };
  page.on("console", (m) => { if (m.type() === "error") ctx.errors.push(m.text()); });
  page.on("pageerror", (e) => ctx.errors.push(String(e)));
  page.on("request", (r) => { if (/^https?:/.test(r.url())) ctx.requests.push(r.url()); });
  page.on("dialog", async (d) => {
    ctx.dialogs.push({ type: d.type(), message: d.message() });
    const plan = ctx.dialogPlan.shift();
    if (plan?.dismiss) await d.dismiss(); else await d.accept(plan?.text);
  });
  const cdp = await page.createCDPSession();
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: DL, eventsEnabled: true });
  await page.goto(BASE, { waitUntil: "networkidle0" });
  // Keep existing camera/algorithm tests independent of OCR runtime and text
  // guesses on synthetic bars. Orientation has its own real-engine test below.
  await page.evaluate(() => {
    window.__scancat.S.autoOrient = false;
    document.getElementById("autoorient").checked = false;
  });
  return ctx;
}

async function waitForDownload(pattern, timeoutMs = 20000) {
  return until(() => {
    const f = fs.readdirSync(DL).find((n) => pattern.test(n) && !n.endsWith(".crdownload"));
    return f ? path.join(DL, f) : null;
  }, `download ${pattern}`, timeoutMs, 200);
}

function readZip(file) {
  const bytes = fs.readFileSync(file), end = bytes.length - 22;
  assertEq(bytes.readUInt32LE(end), 0x06054b50, "ZIP footer");
  const count = bytes.readUInt16LE(end + 10), entries = [];
  let pos = bytes.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    assertEq(bytes.readUInt32LE(pos), 0x02014b50, "ZIP directory entry");
    assertEq(bytes.readUInt16LE(pos + 10), 0, "stored entry preserves scan bytes");
    const size = bytes.readUInt32LE(pos + 24), nameLen = bytes.readUInt16LE(pos + 28), offset = bytes.readUInt32LE(pos + 42);
    const name = bytes.toString("utf8", pos + 46, pos + 46 + nameLen);
    assertEq(bytes.readUInt32LE(offset), 0x04034b50, "ZIP local entry");
    const start = offset + 30 + bytes.readUInt16LE(offset + 26) + bytes.readUInt16LE(offset + 28);
    entries.push({ name, bytes: bytes.subarray(start, start + size) });
    pos += 46 + nameLen + bytes.readUInt16LE(pos + 30) + bytes.readUInt16LE(pos + 32);
  }
  return entries;
}

const state = (page) => page.evaluate(() => {
  const S = window.__scancat.S;
  return {
    running: S.running, busy: S.busy, n: S.pages.length,
    pages: S.pages.map((p) => ({ id: p.id, w: p.w, h: p.h, rot: p.rot, cropped: p.cropped, mode: p.mode, fw: p.fw, fh: p.fh, corners: p.corners })),
    det: { smooth: S.det.smooth, score: S.det.score, support: S.det.support, ms: S.det.ms, w: S.det.w, h: S.det.h, armed: S.det.armed, stable: S.det.stable },
    pill: document.getElementById("pill").textContent,
    res: document.getElementById("res").textContent,
  };
});

function quadError(got, want) {
  let worst = 0;
  for (let i = 0; i < 4; i++) worst = Math.max(worst, Math.hypot(got[i][0] - want[i][0], got[i][1] - want[i][1]));
  return worst;
}

/** Fraction of pixels of a page's rendered JPEG that are near-black or near-white. */
const twoLevelFraction = (page, id) => page.evaluate(async (id) => {
  const p = window.__scancat.S.pages.find((x) => x.id === id);
  const bmp = await createImageBitmap(p.out);
  const c = document.createElement("canvas"); c.width = bmp.width; c.height = bmp.height;
  const ctx = c.getContext("2d"); ctx.drawImage(bmp, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let ext = 0, n = 0;
  for (let i = 0; i < d.length; i += 16) { n++; if (d[i] < 40 || d[i] > 215) ext++; }
  return ext / n;
}, id);

/* ---------- tests ---------- */

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("landing page: no errors, camera off, no network beyond the origin", async () => {
  const ctx = await newPage();
  const { page } = ctx;
  assertEq(await page.$eval("h1", (h) => h.textContent.trim()), "Your webcam is a scanner.", "headline");
  assert(await page.$eval("#scanner", (el) => el.hidden), "scanner hidden before start");
  const foreign = ctx.requests.filter((u) => !u.startsWith(BASE));
  assertEq(foreign.length, 0, `cross-origin requests: ${foreign.join(", ")}`);
  assertEq(ctx.errors.length, 0, `console errors: ${ctx.errors.join(" | ")}`);
  assertEq(ctx.requests.filter(url => url.includes("/assets/ocr/")).length, 0, "landing must not load OCR assets");
  await page.close();
});

test("start camera → live detection finds the page within a few frames", async () => {
  const ctx = await newPage();
  const { page } = ctx;
  await page.click("#start");
  await until(async () => (await state(page)).running, "camera running");
  const st = await state(page);
  assertEq(st.res, `${POSES.w}×${POSES.h}`, "reported resolution");
  assert(await page.$eval("body", (b) => b.classList.contains("live")), "live class");
  const det = await until(async () => { const s = await state(page); return s.det.smooth ? s.det : null; }, "a detected quad", 8000);
  assert(det.ms < 60, `detection took ${det.ms.toFixed(1)} ms`);
  const scale = POSES.w / det.w;
  const got = det.smooth.map(([x, y]) => [x * scale, y * scale]);
  const err = Math.min(...POSES.poses.map((p) => quadError(got, p)));
  assert(err < 0.03 * POSES.w, `quad ${err.toFixed(1)}px off (score ${det.score.toFixed(2)}, support ${det.support.toFixed(2)})`);
  assert(det.support >= 0.6, `support ${det.support}`);
  assert((await page.$eval("#quad", (q) => q.getAttribute("points"))).split(" ").length === 4, "overlay polygon drawn");
  assertEq(ctx.errors.length, 0, `console errors: ${ctx.errors.join(" | ")}`);
  ctx.page = page;
  global.live = ctx; // reused by the next tests
});

test("auto-capture fires once per pose and re-arms across the blank gap", async () => {
  const { page } = global.live;
  await until(async () => (await state(page)).n >= 2, "two auto-captured pages", 20000, 200);
  await until(async () => !(await state(page)).busy, "processing done");
  const st = await state(page);
  assert(st.n >= 2 && st.n <= 3, `expected 2 pages after one loop, got ${st.n}`);
  for (const p of st.pages) {
    assert(p.cropped, `page ${p.id} should be cropped to the detected quad`);
    assert(p.w > 200 && p.h > 200, `page ${p.id} size ${p.w}×${p.h}`);
  }
  // the two poses have different shapes, so the two scans must differ
  const [a, b] = st.pages;
  assert(Math.abs(a.w / a.h - b.w / b.h) > 0.02 || quadError(a.corners, b.corners) > 20, "pages from different poses should differ");
  assert(!(await page.$eval("#pdf", (b) => b.disabled)), "download enabled");
  assertEq(await page.$eval("#count", (e) => e.textContent), `${st.n} pages`, "count");
  assertEq(await page.$$eval("#pages .page", (l) => l.length), st.n, "thumbnails");
});

test("manual capture with auto off; rotation swaps the page dimensions", async () => {
  const { page } = global.live;
  await page.click("#auto");
  assert(!(await page.$eval("#auto", (c) => c.checked)), "auto off");
  const before = (await state(page)).n;
  await page.focus("#shutter");
  await page.keyboard.press("Space");
  await until(async () => (await state(page)).n === before + 1, "one more page after space");
  await until(async () => !(await state(page)).busy, "processing done");
  let st = await state(page);
  const last = st.pages[st.n - 1];
  // rotate the last page via the editor
  await page.click(`#pages .page[data-id="${last.id}"] img`);
  assert(!(await page.$eval("#editor", (e) => e.hidden)), "editor open");
  assertEq(await page.$eval("#edtitle", (e) => e.textContent), `page ${st.n} of ${st.n}`, "editor title");
  await page.click("#edrotr");
  await until(async () => { const s = await state(page); return !s.busy && s.pages[s.n - 1].rot === 1 && s.pages[s.n - 1].w === last.h; }, "rotated page");
  st = await state(page);
  assertEq(st.pages[st.n - 1].h, last.w, "rotated height");
  await page.keyboard.press("Escape");
  assert(await page.$eval("#editor", (e) => e.hidden), "editor closed by escape");
});

test("black & white look re-renders pages as two-level images", async () => {
  const { page } = global.live;
  const st0 = await state(page);
  const before = await twoLevelFraction(page, st0.pages[0].id);
  await page.select("#mode", "bw");
  await until(async () => !(await state(page)).busy && /captured|re-rendering|page/.test((await state(page)).pill), "re-render finished", 20000);
  await until(async () => !(await state(page)).busy, "idle");
  const after = await twoLevelFraction(page, st0.pages[0].id);
  assert(after > 0.97, `bw page should be two-level, got ${after.toFixed(3)} (colour was ${before.toFixed(3)})`);
  await page.select("#mode", "color");
  await until(async () => !(await state(page)).busy, "idle again", 20000);
});

test("digital zoom crops the detected and captured camera region", async () => {
  const { page } = global.live;
  await page.$eval("#zoom", (el) => { el.value = "2"; el.dispatchEvent(new Event("input", { bubbles: true })); });
  assertEq(await page.$eval("#zoomvalue", (el) => el.value), "2×", "zoom readout");
  const before = (await state(page)).n;
  await page.focus("#shutter");
  await page.keyboard.press("Space");
  await until(async () => (await state(page)).n === before + 1, "zoomed capture");
  await until(async () => !(await state(page)).busy, "zoomed processing done");
  const captured = (await state(page)).pages.at(-1);
  assertEq(captured.fw, POSES.w / 2, "zoomed frame width");
  assertEq(captured.fh, POSES.h / 2, "zoomed frame height");
  await page.click("#zoomreset");
  assertEq(await page.$eval("#zoomvalue", (el) => el.value), "1×", "reset zoom readout");
});

test("corner editor: 'use the whole frame' re-warps the page to the full camera frame", async () => {
  const { page } = global.live;
  const st = await state(page);
  const target = st.pages[0];
  await page.click(`#pages .page[data-id="${target.id}"] img`);
  await page.click("#edcorners");
  await until(() => page.$eval("#cornerpane", (e) => !e.hidden), "corner pane");
  await page.click("#cornerfull");
  await page.click("#cornerapply");
  await until(async () => { const s = await state(page); const p = s.pages.find((x) => x.id === target.id); return !s.busy && p.w === p.fw && p.h === p.fh; }, "full-frame page", 15000);
  await page.click("#edclose");
});

test("reordered receipts export as ZIPs with individual PDFs and unchanged JPEGs", async () => {
  const { page } = global.live;
  let st = await state(page);
  const ids = st.pages.map((p) => p.id);
  // move the last page to the front with synthetic drag events
  await page.evaluate((from, to) => {
    const a = document.querySelector(`#pages .page[data-id="${from}"]`), b = document.querySelector(`#pages .page[data-id="${to}"]`);
    const dt = new DataTransfer();
    a.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
    b.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
    b.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
    a.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
  }, ids[ids.length - 1], ids[0]);
  st = await state(page);
  assertEq(st.pages[0].id, ids[ids.length - 1], "last page moved to the front");
  assertEq(await page.$eval("#pages .page .num", (e) => e.textContent), "1", "numbering updated");
  // backspace removes the last page
  await page.keyboard.press("Backspace");
  st = await state(page);
  assertEq(st.n, ids.length - 1, "one page removed");
  // export
  await page.select("#pagesize", "a4");
  await page.click("#pdf");
  const file = await waitForDownload(/^scancat-\d{8}-\d{4}-pdfs\.zip$/);
  const entries = readZip(file);
  assertEq(entries.length, st.n, "one PDF per receipt");
  for (let i = 0; i < st.n; i++) {
    assert(entries[i].name.endsWith(`-receipt-${String(i + 1).padStart(2, "0")}.pdf`), "numbered in tray order");
    const doc = mupdf.Document.openDocument(entries[i].bytes, "application/pdf");
    assertEq(doc.countPages(), 1, "each PDF contains exactly one receipt");
    const b = doc.loadPage(0).getBounds();
    const bw = b[2] - b[0], bh = b[3] - b[1];
    const [ew, eh] = st.pages[i].h >= st.pages[i].w ? [595.28, 841.89] : [841.89, 595.28];
    assert(Math.abs(bw - ew) < 0.5 && Math.abs(bh - eh) < 0.5, `page ${i + 1}: A4 media box matching orientation, got ${bw}×${bh}`);
  }
  // render the page that is still a cropped scan: mostly white with dark ink
  const idx = st.pages.findIndex((p) => p.w !== p.fw);
  assert(idx >= 0, "a cropped page remains");
  const doc = mupdf.Document.openDocument(entries[idx].bytes, "application/pdf");
  const pix = doc.loadPage(0).toPixmap(mupdf.Matrix.scale(0.5, 0.5), mupdf.ColorSpace.DeviceGray, false);
  const px = pix.getPixels(), n = pix.getWidth() * pix.getHeight();
  let white = 0, dark = 0;
  for (let i = 0; i < n; i++) { if (px[i] > 225) white++; else if (px[i] < 70) dark++; }
  assert(white / n > 0.55, `rendered scan should be mostly paper-white (${(white / n).toFixed(2)})`);
  assert(dark / n > 0.03, `rendered scan should contain ink (${(dark / n).toFixed(3)})`);
  assert(/ZIP saved/.test((await state(page)).pill), "status confirms save");
  await page.click("#jpgs");
  const jpgs = readZip(await waitForDownload(/^scancat-\d{8}-\d{4}-jpegs\.zip$/));
  assertEq(jpgs.length, st.n, "one JPEG per receipt");
  const expected = await page.evaluate(async () => Promise.all(window.__scancat.S.pages.map(async p => Array.from(new Uint8Array(await p.out.arrayBuffer())))));
  for (let i = 0; i < jpgs.length; i++) {
    assert(jpgs[i].name.endsWith(`-receipt-${String(i + 1).padStart(2, "0")}.jpg`), "JPEG tray order");
    assert(Buffer.from(expected[i]).equals(jpgs[i].bytes), "JPEG bytes must remain unchanged");
  }
  await page.screenshot({ path: path.join(HERE, "shot-live.png") });
});

test("clear asks for confirmation, then empties the tray; no foreign requests or console errors in the whole session", async () => {
  const ctx = global.live;
  const { page } = ctx;
  // dismiss first, then accept
  const n0 = (await state(page)).n;
  assert(n0 > 0, "pages to clear");
  ctx.dialogPlan.push({ dismiss: true });
  await page.click("#clear");
  await sleep(200);
  assertEq((await state(page)).n, n0, "dismissing keeps the pages");
  assert(/Discard all/.test(ctx.dialogs.at(-1)?.message || ""), "confirm text");
  await page.click("#clear");
  await until(async () => (await state(page)).n === 0, "tray emptied");
  assertEq(await page.$eval("#count", (e) => e.textContent), "no pages yet", "count reset");
  assertEq(ctx.requests.filter(url => /orientation-model-worker\.js|\/assets\/(ocr|orientation)\//.test(url)).length, 0, "disabled orientation must not load model assets during captures");
  assert(await page.$eval("#pdf", (b) => b.disabled), "download disabled again");
  const foreign = ctx.requests.filter((u) => !u.startsWith(BASE));
  assertEq(foreign.length, 0, `cross-origin requests: ${foreign.join(", ")}`);
  assertEq(ctx.errors.length, 0, `console errors: ${ctx.errors.join(" | ")}`);
  await page.close();
});

test("screenshots for the record (landing, phone width)", async () => {
  const ctx = await newPage();
  await ctx.page.screenshot({ path: path.join(HERE, "shot-landing.png") });
  await ctx.page.setViewport({ width: 400, height: 860 });
  await ctx.page.evaluate(() => { window.__scancat.S.auto = true; document.getElementById("auto").checked = true; });
  await ctx.page.click("#start");
  await until(async () => (await state(ctx.page)).running, "camera running");
  await until(async () => (await state(ctx.page)).n >= 1, "a capture", 20000, 200);
  await until(async () => !(await state(ctx.page)).busy, "idle");
  const overflow = await ctx.page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  assert(!overflow, "page must not scroll horizontally at phone width");
  await ctx.page.screenshot({ path: path.join(HERE, "shot-phone.png"), fullPage: true });
  await ctx.page.close();
});

test("multiple receipts, T timer and aligned-frame capture work through the real UI", async () => {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  try {
    await page.goto(BASE, { waitUntil: "networkidle0" });
    await page.evaluate(async () => {
      const canvas = document.createElement("canvas"); canvas.width = 1280; canvas.height = 720;
      const ctx = canvas.getContext("2d"); ctx.fillStyle = "#303030"; ctx.fillRect(0, 0, 1280, 720);
      for (const [x, y, w, h] of [[150, 160, 230, 390], [710, 240, 310, 240]]) {
        ctx.fillStyle = "#eeeeea"; ctx.fillRect(x, y, w, h); ctx.fillStyle = "#202020"; ctx.font = "18px monospace";
        for (let i = 0; i < 8; i++) ctx.fillText(`Item ${i} 12.50`, x + 20, y + 35 + i * 22);
      }
      setInterval(() => { ctx.fillStyle = "#303030"; ctx.fillRect(0, 0, 2, 2); }, 100);
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: async () => canvas.captureStream(10) });
      Object.defineProperty(navigator.mediaDevices, "enumerateDevices", { value: async () => [] });
      window.__scancat.S.auto = false; window.__scancat.S.mode = "receipt";
      document.getElementById("auto").checked = false; document.getElementById("mode").value = "receipt";
      await window.__scancat.startCamera();
    });
    await page.click("#multiple");
    await until(() => page.evaluate(() => window.__scancat.S.det.quads?.length === 2), "two receipt outlines");
    await page.click("#shutter");
    await until(async () => (await state(page)).n === 2 && !(await state(page)).busy, "two separate receipt scans");
    await page.focus("#sharpness"); // T also works after adjusting a camera slider.
    const start = Date.now(); await page.keyboard.press("t");
    await until(async () => (await state(page)).n === 4 && !(await state(page)).busy, "two timed scans", 9000);
    assert(Date.now() - start >= 4900, "T fired before the five-second timer");
    await page.click("#multiple");
    await page.click("#burstcapture");
    await until(async () => (await state(page)).n === 5 && !(await state(page)).busy, "combined-frame scan", 25000);
    const fused = await page.evaluate(() => {
      const p = window.__scancat.S.pages.at(-1); return { frames: p.fusedFrames, raw: !!p.fusionFrame, original: !!p.frame };
    });
    assert(fused.frames >= 2 && fused.raw && fused.original, "burst did not preserve a composite and the sharpest original");
  } finally { await context.close(); }
});

test("local text orientation corrects all quarter-turns and preserves manual overrides", async () => {
  const context = await browser.createBrowserContext();
  const page = await context.newPage(), requests = [];
  page.on("request", request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
  try {
    await page.goto(BASE, { waitUntil: "networkidle0" });
    const results = await page.evaluate(async () => {
      const api = window.__scancat; api.S.mode = "original";
      const source = document.createElement("canvas"); source.width = 900; source.height = 1100;
      const ctx = source.getContext("2d"); ctx.fillStyle = "white"; ctx.fillRect(0, 0, 900, 1100);
      ctx.fillStyle = "black"; ctx.font = "24px serif";
      const lines = ["SCANCAT RECEIPT ORIENTATION TEST", "Thank you for shopping with us today.", "Fresh bread and seasonal vegetables", "Invoice number 123456 customer copy", "Subtotal 29.90 Tax 5.68 Total 35.58", "Payment received by credit card.", "Keep this receipt for your records.", "Please visit our store again soon."];
      for (let i = 0; i < 24; i++) ctx.fillText(lines[i % lines.length], 45, 65 + i * 39);
      const results = [];
      for (const turn of [0, 1, 2, 3]) {
        const canvas = document.createElement("canvas"); canvas.width = turn % 2 ? 1100 : 900; canvas.height = turn % 2 ? 900 : 1100;
        const c = canvas.getContext("2d"); c.translate(canvas.width / 2, canvas.height / 2); c.rotate(turn * Math.PI / 2); c.drawImage(source, -450, -550);
        const frame = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
        const p = { id: ++api.S.seq, fw: canvas.width, fh: canvas.height, corners: api.V.frameCorners(canvas.width, canvas.height), rot: 0, mode: "original", frame, frameReady: Promise.resolve(frame), cropped: true, orientationPending: true, url: "", out: null };
        await api.processPage(p); const initial = p.rot;
        await api.processPage(p);
        results.push({ turn, initial, rot: p.rot, w: p.w, h: p.h, confident: p.orientation.confident });
        api.S.pages.push(p);
      }
      api.renderTray(); document.getElementById("scanner").hidden = false; document.body.classList.add("live"); return results;
    });
    for (const result of results) {
      assert(result.confident, `orientation ${result.turn} should be confident`);
      assertEq(result.rot, (4 - result.turn) % 4, "clockwise correction");
      assertEq(result.initial, result.rot, "reprocessing must not rotate twice");
      assertEq(result.w, 900, "upright width"); assertEq(result.h, 1100, "upright height");
    }
    await page.click('#pages [data-id="1"] img'); await page.click("#edrotr");
    await until(() => page.evaluate(() => !window.__scancat.S.busy), "manual rotation");
    await page.select("#edmode", "gray");
    await until(() => page.evaluate(() => !window.__scancat.S.busy), "look change");
    assertEq(await page.evaluate(() => window.__scancat.S.editing.rot), 1, "look change preserves manual rotation");
    await page.click("#edautorotate");
    await until(() => page.evaluate(() => !window.__scancat.S.busy), "explicit auto rotation", 25000);
    assertEq(await page.evaluate(() => window.__scancat.S.editing.rot), 0, "auto button restores upright text");
    assertEq(requests.filter(url => !url.startsWith(BASE)).length, 0, "OCR must never request off-origin assets");
  } finally { await context.close(); }
});

for (const fallback of [false, true]) test(fallback ? "missing orientation model falls back to local OCR in all four directions" : "short tickets use the fast classifier in all four directions", async () => {
  const context = await browser.createBrowserContext(), page = await context.newPage();
  try {
    await page.goto(BASE, { waitUntil: "networkidle0" });
    if (fallback) {
      await page.setRequestInterception(true);
      page.on("request", request => /orientation-model-worker\.js|\/assets\/orientation\//.test(request.url()) ? request.abort() : request.continue());
    }
    const results = await page.evaluate(async () => {
      const { detectOrientation } = await import("./js/orientation.js");
      const source = document.createElement("canvas"); source.width = 620; source.height = 340;
      const ctx = source.getContext("2d"); ctx.fillStyle = "white"; ctx.fillRect(0, 0, 620, 340);
      ctx.fillStyle = "black"; ctx.font = "26px Arial";
      ["WIENER LINIEN", "Einzelfahrt", "Bitte entwerten", "Please validate", "1 Fahrt WIEN     EUR 2.40"].forEach((line, i) => ctx.fillText(line, 35, 55 + i * 50));
      const results = [];
      for (const turn of [0, 1, 2, 3]) {
        const c = document.createElement("canvas"); c.width = turn % 2 ? 340 : 620; c.height = turn % 2 ? 620 : 340;
        const x = c.getContext("2d"); x.translate(c.width / 2, c.height / 2); x.rotate(turn * Math.PI / 2); x.drawImage(source, -310, -170);
        results.push({ turn, ...await detectOrientation(c) });
      }
      return results;
    });
    for (const result of results) {
      assert(result.confident, `short ticket ${result.turn} must be confident`);
      assertEq(result.method, fallback ? "ocr" : "classifier", "short ticket uses expected orientation engine");
      assertEq(result.turns, (4 - result.turn) % 4, "short ticket correction");
    }
  } finally { await context.close(); }
});

for (const blank of [true, false]) test(blank ? "blank scans stay unchanged without loading OCR" : "unavailable OCR preserves the scan and manual rotation", async () => {
  const context = await browser.createBrowserContext(), page = await context.newPage(), requests = [];
  try {
    await page.goto(BASE, { waitUntil: "networkidle0" });
    page.on("request", request => requests.push(request.url()));
    if (!blank) {
      await page.setRequestInterception(true);
      page.on("request", request => /orientation-model-worker\.js|\/assets\/(ocr|orientation)\//.test(request.url()) ? request.abort() : request.continue());
    }
    const result = await page.evaluate(async blank => {
      const api = window.__scancat, c = document.createElement("canvas"); c.width = 500; c.height = 600;
      const ctx = c.getContext("2d"); ctx.fillStyle = "white"; ctx.fillRect(0, 0, 500, 600);
      if (!blank) { ctx.fillStyle = "black"; ctx.font = "22px serif"; for (let i = 0; i < 14; i++) ctx.fillText("Receipt total and item 123.45", 20, 40 + i * 35); }
      const frame = await new Promise(resolve => c.toBlob(resolve, "image/png"));
      const p = { id: 1, fw: 500, fh: 600, corners: api.V.frameCorners(500, 600), rot: 0, mode: "original", frame, frameReady: Promise.resolve(frame), orientationPending: true, cropped: true, url: "" };
      await api.processPage(p);
      return { status: p.orientation.status, rot: p.rot, saved: !!p.out, w: p.w, h: p.h };
    }, blank);
    assertEq(result.status, blank ? "uncertain" : "unavailable", "orientation fallback status");
    assert(result.saved && result.rot === 0 && result.w === 500 && result.h === 600, "scan must survive with its orientation unchanged");
    if (blank) assertEq(requests.filter(url => /orientation-model-worker\.js|\/assets\/(ocr|orientation)\//.test(url)).length, 0, "blank paper must skip both engines");
  } finally { await context.close(); }
});

/* ---------- run ---------- */

browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: [
    "--window-size=1440,1000",
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-video-capture=${CAM}`,
    "--autoplay-policy=no-user-gesture-required",
    ...(process.env.CI ? ["--no-sandbox", "--disable-dev-shm-usage"] : []),
  ],
  defaultViewport: { width: 1440, height: 1000 },
});

let failed = 0;
for (const t of tests) {
  const t0 = Date.now();
  try { await t.fn(); console.log(`  ok   ${t.name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`); }
  catch (e) { failed++; console.log(`  FAIL ${t.name}\n       ${e.stack || e}`); }
}
await browser.close();
if (server) server.close();
console.log(`\n${tests.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
