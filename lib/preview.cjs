"use strict";

const fs = require("fs");
const path = require("path");
const { PNG } = require("pngjs");
const { siblingBranch } = require("./output-layout.cjs");

// A raw Shadow frame is 15000x2024. Nothing in a browser wants that, so the gallery
// gets a proxy small enough to travel over FTP and still read at a glance.
const MAX_EDGE = 1200;

// Box filter over premultiplied alpha. Averaging straight RGBA drags the transparent
// black outside the silhouette into the edge pixels and leaves a dark fringe.
function downscale(source, maxEdge) {
  const scale = Math.min(1, maxEdge / Math.max(source.width, source.height));
  if (scale >= 1) return source;
  const width = Math.max(1, Math.round(source.width * scale)), height = Math.max(1, Math.round(source.height * scale));
  const target = new PNG({ width, height });
  const xEdges = new Array(width + 1), yEdges = new Array(height + 1);
  for (let x = 0; x <= width; x++) xEdges[x] = Math.min(source.width, Math.round(x * source.width / width));
  for (let y = 0; y <= height; y++) yEdges[y] = Math.min(source.height, Math.round(y * source.height / height));
  for (let y = 0; y < height; y++) {
    const y0 = yEdges[y], y1 = Math.max(yEdges[y] + 1, yEdges[y + 1]);
    for (let x = 0; x < width; x++) {
      const x0 = xEdges[x], x1 = Math.max(xEdges[x] + 1, xEdges[x + 1]);
      let r = 0, g = 0, b = 0, a = 0, count = 0;
      for (let sy = y0; sy < y1; sy++) {
        let index = (sy * source.width + x0) << 2;
        for (let sx = x0; sx < x1; sx++, index += 4) {
          const alpha = source.data[index + 3] / 255;
          r += source.data[index] * alpha; g += source.data[index + 1] * alpha; b += source.data[index + 2] * alpha;
          a += source.data[index + 3]; count++;
        }
      }
      const out = (y * width + x) << 2, alpha = a / count;
      const unpremultiply = alpha > 0 ? 255 / alpha : 0;
      target.data[out] = Math.min(255, Math.round(r / count * unpremultiply));
      target.data[out + 1] = Math.min(255, Math.round(g / count * unpremultiply));
      target.data[out + 2] = Math.min(255, Math.round(b / count * unpremultiply));
      target.data[out + 3] = Math.round(alpha);
    }
  }
  return target;
}

function writePreview(sourceFile, targetFile, maxEdge = MAX_EDGE) {
  const source = PNG.sync.read(fs.readFileSync(sourceFile));
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  fs.writeFileSync(targetFile, PNG.sync.write(downscale(source, maxEdge)));
  return targetFile;
}

function previewFileFor(rawFile) {
  return path.join(siblingBranch(path.dirname(rawFile), "preview"), path.basename(rawFile));
}

// Skips a proxy that is already newer than its source, so re-running post-process is cheap.
function publishPreviews(rawFiles, { maxEdge = MAX_EDGE } = {}) {
  const created = [], skipped = [], failed = [];
  for (const file of rawFiles) {
    const target = previewFileFor(file);
    try {
      if (fs.existsSync(target) && fs.statSync(target).mtimeMs >= fs.statSync(file).mtimeMs) { skipped.push(target); continue; }
      writePreview(file, target, maxEdge);
      created.push(target);
    } catch (error) { failed.push({ file, message: error.message }); }
  }
  return { created: created.length, skipped: skipped.length, failed };
}

module.exports = { MAX_EDGE, downscale, writePreview, previewFileFor, publishPreviews };
