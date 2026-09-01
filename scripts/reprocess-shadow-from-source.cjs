"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { loadConfig, prepareSubstrateShadow } = require("../lib/post-process.cjs");

const root = path.resolve(__dirname, ".."), batch = path.resolve(String(process.argv[2] || ""));
const productType = String(process.argv[3] || "sofas").toLowerCase();
if (!batch || !fs.existsSync(batch) || path.parse(batch).root === batch) {
  console.error("Usage: node scripts/reprocess-shadow-from-source.cjs <batch folder> [product type]");
  process.exit(2);
}
const suffix = ".substrate-rgb.bak", sources = [];
const visit = folder => {
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) visit(file);
    else if (entry.name.endsWith(suffix)) sources.push(file);
  }
};
for (const branch of ["raw", "calibration"]) {
  const folder = path.join(batch, branch); if (fs.existsSync(folder)) visit(folder);
}
if (!sources.length) throw new Error(`No ${suffix} files found below ${batch}`);

const config = loadConfig(root), results = [];
for (let index = 0; index < sources.length; index += 1) {
  const source = sources[index], target = source.slice(0, -suffix.length), relative = path.relative(batch, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || path.extname(target).toLowerCase() !== ".png") throw new Error(`Unsafe Shadow restore target: ${target}`);
  const previous = `${target}.before-${productType}-lut.bak`;
  if (fs.existsSync(target) && !fs.existsSync(previous)) fs.copyFileSync(target, previous);
  fs.copyFileSync(source, target);
  results.push(prepareSubstrateShadow(target, { config, productType }));
  process.stdout.write(`reprocessed ${index + 1}/${sources.length} ${relative}\n`);
}
console.log(JSON.stringify({ batch, productType, files: results.length, directLut: results.filter(result => result.calibration?.mode === "direct-luma-lut").length }, null, 2));
