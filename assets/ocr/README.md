# Local orientation detector

Vendored browser assets, loaded on demand by `js/orientation.js`. No CDN or
external language/model URL is used at runtime.

- Tesseract.js 7.0.0: `tesseract.esm.min.js`, `worker.min.js`, license files.
  Source: https://registry.npmjs.org/tesseract.js/-/tesseract.js-7.0.0.tgz
  Archive SHA-256: `9a93bf51c3387f945d10a24bf8b3a4bf2e45c7c7161b8242aafbaf9d3c4b606a`
- Tesseract.js-core 7.0.0: the three embedded-WASM Legacy-capable core builds
  (baseline, SIMD, relaxed SIMD) and its license. The library selects the best
  supported build. These full builds support both Legacy OSD (OEM 0) and
  LSTM text recognition (OEM 1); separate LSTM-only builds are unnecessary.
  Source: https://registry.npmjs.org/tesseract.js-core/-/tesseract.js-core-7.0.0.tgz
  Archive SHA-256: `ba584355515eaff877552022853c0e71f2cb70466e759d1d6940484929718ee0`
- Orientation/script model: `osd.traineddata.gz` from the project's model host,
  https://tessdata.projectnaptha.com/4.0.0/osd.traineddata.gz
  SHA-256: `d1c9e6aad4f23167d0bb88a35e496596774b536cf85c190d3a0fa5cab48bbdfd`
  Tesseract trained data is distributed under Apache-2.0:
  https://github.com/tesseract-ocr/tessdata
- English and German LSTM models for short-receipt fallback recognition:
  https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz
  SHA-256: `45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91`
  https://cdn.jsdelivr.net/npm/@tesseract.js-data/deu/4.0.0_best_int/deu.traineddata.gz
  SHA-256: `306c4280d0cbed46fbff727486bd43b92730181bae80f56941a091f363bdf28b`
  These sources are download provenance only; the bundled files are served locally.

The distribution's license notices are included beside the files. The core
builds embed their WASM binaries; no separate `.wasm` files are needed.
The page CSP permits WebAssembly compilation (`wasm-unsafe-eval`) while
JavaScript eval, off-origin connections and Blob workers remain disallowed.

The complete bundle is about 22 MiB. A browser loads only one core build plus
the roughly 4 MiB OSD model on first use, and caches them locally afterwards.
When OSD is uncertain, English/German recognition compares all four rotations.
Only confidence and character counts are retained, never recognized text.
