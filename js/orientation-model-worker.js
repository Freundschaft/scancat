import * as ort from "../assets/orientation/ort.wasm.min.mjs";

// A dedicated worker keeps inference off the camera UI. One thread also works
// on ordinary static hosting without cross-origin-isolation response headers.
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
ort.env.wasm.wasmPaths = new URL("../assets/orientation/", import.meta.url).href;
let session;

self.onmessage = async ({ data: { id, input } }) => {
  try {
    session ||= ort.InferenceSession.create(new URL("../assets/orientation/document-orientation.onnx", import.meta.url).href,
      { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
    const model = await session;
    const tensor = new ort.Tensor("float32", input, [1, 3, 224, 224]);
    const output = await model.run({ [model.inputNames[0]]: tensor });
    self.postMessage({ id, scores: Array.from(output[model.outputNames[0]].data) });
    tensor.dispose();
    for (const value of Object.values(output)) value.dispose();
  } catch (error) { self.postMessage({ id, error: String(error.message || error) }); }
};
