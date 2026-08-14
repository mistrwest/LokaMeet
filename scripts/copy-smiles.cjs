const fs = require("node:fs");
const path = require("node:path");

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function copyDir(src, dst) {
  ensureDir(dst);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

const root = path.resolve(__dirname, "..");
const srcSmiles = path.join(root, "smiles");
const dstSmiles = path.join(root, "dist", "renderer", "smiles");

if (!fs.existsSync(srcSmiles)) {
  console.warn("[copy-smiles] source not found:", srcSmiles);
  process.exit(0);
}

copyDir(srcSmiles, dstSmiles);
console.log("[copy-smiles] copied smiles to", dstSmiles);

// Also copy sound files
const srcSnds = path.join(root, "snds");
const dstSnds = path.join(root, "dist", "renderer", "snds");

if (fs.existsSync(srcSnds)) {
  copyDir(srcSnds, dstSnds);
  console.log("[copy-smiles] copied sounds to", dstSnds);
}

const srcWasm = path.join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm");
const dstWasm = path.join(root, "dist", "renderer", "mediapipe", "wasm");
if (fs.existsSync(srcWasm)) {
  copyDir(srcWasm, dstWasm);
  console.log("[copy-smiles] copied mediapipe wasm to", dstWasm);
}

const srcModel = path.join(root, "public", "mediapipe", "selfie_segmenter_landscape.tflite");
const dstModel = path.join(root, "dist", "renderer", "mediapipe", "selfie_segmenter_landscape.tflite");
if (fs.existsSync(srcModel)) {
  ensureDir(path.dirname(dstModel));
  fs.copyFileSync(srcModel, dstModel);
}

const srcBg = path.join(root, "public", "camera-bg");
const dstBg = path.join(root, "dist", "renderer", "camera-bg");
if (fs.existsSync(srcBg)) {
  copyDir(srcBg, dstBg);
}

