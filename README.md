# Scancat 🐈‍⬛

**Your webcam is a scanner. Nothing leaves your device.**

**→ https://nipunbatra.github.io/scancat/**

Hold a page up to your Mac's camera (or an iPhone via Continuity Camera, or
any webcam). Scancat finds the page's edges live, captures it when you hold
still, straightens it, cleans it up the way a flatbed would, and stacks page
after page into one PDF. No phone, no AirDrop, no cropping by hand.

Scancat is the sibling of [Redacat](https://nipunbatra.github.io/redacat/)
and [Diffcat](https://nipunbatra.github.io/diffcat/) and shares their rule: a
strict `Content-Security-Policy` (`default-src 'none'`) makes network requests
impossible, so the page couldn't upload a frame even if it wanted to.

## What you get

- **Edges found live.** Every frame is downscaled and run through a small
  Canny-style edge detector, a gradient-guided Hough transform, and a search
  for the best-supported convex quadrilateral. A hand over one edge is fine.
  The outline turns teal when all four edges are solid, amber when one is
  uncertain.
- **Auto-capture.** Hold still for about two-thirds of a second and the page
  is captured; it re-arms when you swap in the next page. Or press space (or
  the big red button) whenever you like.
- **Straightened and cleaned.** A perspective warp maps the quad onto a
  rectangle at the camera's native resolution. Then uneven lighting is
  flattened (max-filter → local mean → per-pixel gain) so paper reads as flat
  white, with three looks: **colour**, **greyscale**, **black & white**
  (adaptive threshold) — plus **original** for photos.
- **A page tray.** Rotate, delete, drag to reorder; click a page to open it
  large, fix its corners by dragging them, override its look, copy it to the
  clipboard, or download it as a JPEG.
- **PDF export**, written from scratch in the tab (one JPEG per page; page box
  fits the scan, or A4 / Letter). Keyboard: space captures, ⌫ removes the last
  page, ⌘S downloads.
- **Camera picker** for machines with more than one camera (built-in, iPhone,
  USB), remembered across visits.

## Running locally / self-hosting

No build step, no dependencies. Serve the directory with any static server
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
