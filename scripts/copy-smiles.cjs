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

