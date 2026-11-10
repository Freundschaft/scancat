# Scancat 🐈‍⬛

**Your webcam is a scanner. Nothing leaves your device.**

**→ https://nipunbatra.github.io/scancat/**

Hold a page up to your Mac's camera (or an iPhone via Continuity Camera, or
any webcam). Scancat finds the page's edges live, captures it when you hold
still, straightens it, cleans it up the way a flatbed would, and stacks page
after page into a tray. Download a ZIP of individual receipt PDFs or JPEGs.
No phone, no AirDrop, no cropping by hand.

Scancat is the sibling of [Redacat](https://nipunbatra.github.io/redacat/)
and [Diffcat](https://nipunbatra.github.io/diffcat/) and shares their rule: a
strict `Content-Security-Policy` (`default-src 'none'`) makes network requests
impossible, so the page couldn't upload a frame even if it wanted to.

## What you get

- **Automatic text orientation.** New cropped scans are checked locally for
  upright text, with confidence-gated quarter-turn rotation. Disable
  “auto-orient text” to keep the camera orientation. Existing scans have an
  “auto rotate” button in the editor; manual arrows always remain available.
  A small PP-LCNet classifier checks a 224-pixel preview in a background worker.
  Uncertain predictions use orientation detection and an English/German OCR
  fallback comparing all four directions, which can take a few extra seconds.
  Sparse or blurry text may still be uncertain and is left unchanged.
  Recognized text is not retained. The bundled models and runtime load on first
  use and never upload images. Changing a scan's look does not override a
  manual rotation. See [model provenance](assets/orientation/README.md).

- **Edges found live.** Every frame is downscaled and run through a small
  Canny-style edge detector, a gradient-guided Hough transform, and a search
  for the best-supported convex quadrilateral. A hand over one edge is fine.
  The outline turns teal when all four edges are solid, amber when one is
  uncertain.
- **Auto-capture.** Hold still for about two-thirds of a second and the page
  is captured; it re-arms when you swap in the next page. Or press space (or
  the big red button) whenever you like.
- **Flatten & capture.** Press once, straighten the receipt by hand, then move
  your hands clear. Capture waits for a detected page and three seconds of
  stillness; visible movement or a lost outline restarts the countdown. Press
  again to cancel. This uses image motion, not hand recognition.
- **Five-second timer.** Press **T** or “Capture in 5s” and keep holding the
  receipt stretched. Capture fires after five seconds without waiting for
  stillness or hands to leave. Press T again to cancel. Changing camera
  settings, opening the editor, or leaving the tab cancels the timer.
- **Combine frames.** An eight-second burst gives two seconds to get ready,
  then samples frames while you keep holding the paper. Up to five sharp
  frames are straightened, locally aligned and averaged where they agree to
  reduce noise. Disagreeing regions keep the sharpest source; this does not
  invent missing text or increase sensor resolution. Everything stays local.
  Changing corners afterwards uses the retained sharpest original frame.
- **Multiple receipts.** Enable the checkbox to outline up to eight separated
  receipts. One shutter press (or the T timer) produces a separate scan for
  every detected receipt from the same camera frame. Leave space between
  papers; touching/overlapping receipts may merge. Frame combining is available
  in single-receipt mode.
- **Straightened and cleaned.** A perspective warp maps the quad onto a
  rectangle at the camera's native resolution. Then uneven lighting is
  flattened (max-filter → local mean → per-pixel gain) so paper reads as flat
  white, with three looks: **colour**, **greyscale**, **black & white**
  (adaptive threshold) — plus **original** for photos.
- **A page tray.** Rotate, delete, drag to reorder; click a page to open it
  large, fix its corners by dragging them, override its look, copy it to the
  clipboard, or download it as a JPEG.
- **ZIP export**, with a separate PDF or JPEG for each receipt, numbered in tray
  order. PDFs fit the scan, or use A4 / Letter. Exports reuse the processed images
  without rerunning OCR or reducing quality. Keyboard: space captures,
  ⌫ removes the last page, ⌘S downloads the PDF ZIP.
- **Camera picker** for machines with more than one camera (built-in, iPhone,
  USB), remembered across visits.
- **Stream resolution.** Request the highest available resolution or choose
  720p, 1080p, 1440p, or 4K. The actual stream dimensions are shown beside the
  controls; unsupported requests keep the previous setting. Linked-phone
  cameras may be limited by their Windows driver or connection. Digital zoom
  crops the available pixels, so it reduces scan resolution.
  Resolution choices are remembered per camera across restarts.
- **Zoom and pan.** Zoom up to 4× and drag the live preview to frame a smaller
  portion of the camera image. Edge detection and capture use exactly the area
  shown in the preview.
- **Receipts.** Choose “receipt (faint print)” for narrow or folded receipts
  on a darker background. This also preserves faint print during cleanup.
  On supported cameras, move the exposure slider left to protect bright paper;
  “auto” restores automatic exposure. Cleanup is applied to captured pages,
  while exposure changes the live camera feed.
  “Receipt detail” adjusts sharpening of receipt scans (0 disables it).
  “Receipt contrast” darkens faint print independently of sharpening.
  Supported cameras also expose manual focus with an “auto” reset; use this
  to focus on small print before capture.
  Exposure and focus choices are remembered separately for each camera and
  restored when it starts. The exposure readout shows “locked” for manual
  exposure and “auto” when the camera is adjusting it.

## Running locally / self-hosting

No build step or dependency installation. The orientation engine is vendored
under `assets/ocr` and runs in a local Web Worker. Serve the directory with any static server
(camera access needs https or localhost):

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

`js/vision.js` holds the pure algorithms (edges, Hough, quad search,
homography, warp, enhancement) with no DOM; `js/worker.js` runs the heavy
warp/enhance step off the main thread; `js/pdf.js` is the PDF writer;
`js/app.js` is the UI.

## Tests

Unit tests exercise the algorithms on synthetic frames with a known page pose
(detection accuracy, warp, all looks, PDF structure). A headless-Chrome suite
then drives the real UI with a **fake webcam**: Chrome plays a generated video
(page pose A · blank wall · page pose B · blank wall) through
`--use-file-for-fake-video-capture`, and the tests check live detection
accuracy, that auto-capture fires once per pose and re-arms across the gap,
manual capture, rotation, the black & white look, the corner editor,
reordering, deletion, the exported PDF (opened with MuPDF), the confirm-to-clear
flow, phone-width layout, and that the whole session makes zero cross-origin
requests. Runs on every push via GitHub Actions.

```sh
cd tests
npm install
node unit.mjs
node make-fixtures.mjs
node run-tests.mjs                 # local checkout
BASE=https://nipunbatra.github.io/scancat/ node run-tests.mjs   # live site
```

## License

[MIT](LICENSE). Font: [Archivo Black](https://fonts.google.com/specimen/Archivo+Black) (OFL).
Bundled Tesseract.js, Tesseract.js-core and OSD model: Apache-2.0; see
[OCR asset provenance and licenses](assets/ocr/README.md).
