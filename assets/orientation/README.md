# Local document orientation classifier

The app runs PP-LCNet_x1_0_doc_ori in a dedicated module worker using ONNX
Runtime Web's single-threaded WASM execution provider. All files are served
from the app's origin; no image or prediction is sent elsewhere. Assets load
only when orientation is requested. The session stays loaded between scans.

## Model provenance

Official PaddlePaddle ONNX export (Apache-2.0), pinned to revision
`7330ab7039123e46af2dc03154b9969aa412c61d`:

https://huggingface.co/PaddlePaddle/PP-LCNet_x1_0_doc_ori_onnx/tree/7330ab7039123e46af2dc03154b9969aa412c61d

- `inference.onnx`, renamed `document-orientation.onnx` (6,788,069 bytes).
  SHA-256: `af9a0a4f317ff0709ce752067807f819cb15d883f8ecad89f28df1c6ee2d9c92`
- `inference.yml` records the official preprocessing: RGB, resize short side
  to 256, center crop 224, ImageNet mean/std normalization, CHW layout.
- Labels are 0, 90, 180, 270 degrees. They describe input rotation; the app
  applies the inverse clockwise correction. Predictions require probability
  >= 0.85 and a >= 0.7 gap over the runner-up. These are application guards,
  not calibrated guarantees of correctness. Uncertain results use local OCR.
- License: `LICENSE-PaddleOCR`, from PaddlePaddle/PaddleOCR.

## Runtime provenance

ONNX Runtime Web **1.31.1**, MIT license:

https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-1.31.1.tgz

Only these matching WASM-runtime files are included:

| File | SHA-256 |
| --- | --- |
| ort.wasm.min.mjs | c21d9c326d453a4a61398270c804d5979e118540597cb0c07f7b3d64e6098234 |
| ort-wasm-simd-threaded.mjs | 30ed0b5cd1182ede931fea448afb567d4dc705ec957af09f108a2be5f770dac3 |
| ort-wasm-simd-threaded.wasm | 4b884c203b0fa48d057be3332c65513ff85aa3c5bdddd6946acc0fab7ecda001d |

`LICENSE-ONNX-Runtime` and `ThirdPartyNotices.txt` are from Microsoft's
onnxruntime v1.31.1 tag. No WebGPU/JSEP, asyncify, or JSPI runtime is bundled.
The runtime adds about 14.2 MiB beyond the roughly 6.5 MiB model. The same
origin CSP remains in force, including WASM compilation permission without
JavaScript eval or Blob workers. Cross-origin isolation is not required.

The worker has a ten-second load/inference timeout. A failed worker is
terminated and skipped for thirty seconds while OCR remains available.
The editor's explicit auto-rotation action can retry immediately.
