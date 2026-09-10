"use strict";

// Read-only audit: compare Unreal's corrected PNG with its preserved MRQ RGB input.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { PNG } = require("pngjs");

const [file, calibrationFile] = process.argv.slice(2);
if (!file || !calibrationFile) throw new Error("Usage: node scripts/audit-native-shadow.cjs <Shadow.png> <ShadowAlphaLut.json>");
const bytes = fs.readFileSync(file), sourceBytes = fs.readFileSync(`${file}.substrate-rgb.bak`);
const output = PNG.sync.read(bytes), source = PNG.sync.read(sourceBytes);
if (output.width !== source.width || output.height !== source.height) throw new Error("Source and output dimensions differ");
const tokens = path.basename(file).toUpperCase().split(/[_.]/);
const camera = ["TQB", "TQ", "FH", "P", "F"].find(name => tokens.includes(name));
const lut = JSON.parse(fs.readFileSync(calibrationFile, "utf8")).curves?.[camera];
if (!Array.isArray(lut) || lut.length !== 256) throw new Error(`No direct LUT for ${camera}; fallback needs a separate audit`);
let mismatchedAlpha = 0, nonBlackPixels = 0, visiblePixels = 0, alphaMin = 255, alphaMax = 0;
let left = output.width, right = -1, top = output.height, bottom = -1;
for (let i = 0; i < output.data.length; i += 4) {
  const expected = lut[Math.round(source.data[i] * 0.2126 + source.data[i + 1] * 0.7152 + source.data[i + 2] * 0.0722)];
  const alpha = output.data[i + 3];
  if (alpha !== expected) mismatchedAlpha++;
  if (output.data[i] || output.data[i + 1] || output.data[i + 2]) nonBlackPixels++;
  alphaMin = Math.min(alphaMin, alpha); alphaMax = Math.max(alphaMax, alpha);
  if (alpha) {
    visiblePixels++;
    const pixel = i / 4, x = pixel % output.width, y = Math.floor(pixel / output.width);
    left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
}
const digest = buffer => crypto.createHash("sha256").update(buffer).digest("hex");
console.log(JSON.stringify({file:path.resolve(file),camera,width:output.width,height:output.height,alphaMin,alphaMax,visiblePixels,
  bounds:visiblePixels?{left,top,right,bottom}:null,mismatchedAlpha,nonBlackPixels,
  sha256:digest(bytes),sourceSha256:digest(sourceBytes),passed:mismatchedAlpha===0 && nonBlackPixels===0 && visiblePixels>0},null,2));
if (mismatchedAlpha || nonBlackPixels || !visiblePixels) process.exitCode = 1;
