"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { PNG } = require("pngjs");

const CACHE_VERSION = 1;
const CACHE_FILE = path.join("local", "cache", "crop-profiles.json");
const CALIBRATION_FOLDER = "_crop_calibration";
const DEFAULT_MARGIN = 0.05;
const OUTPUT_ALIGNMENT = 8;

const clone = value => JSON.parse(JSON.stringify(value));
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const cachePath = root => process.env.RH_CROP_CACHE_FILE ? path.resolve(process.env.RH_CROP_CACHE_FILE) : path.join(root, CACHE_FILE);

function modelFingerprint(modelPath) {
  const resolved = path.resolve(String(modelPath || ""));
  const info = fs.statSync(resolved);
  return crypto.createHash("sha1").update(`${resolved.toLowerCase()}|${info.size}|${info.mtimeMs}`).digest("hex").slice(0, 16);
}

const profileKey = (fingerprint, camera) => `${String(fingerprint || "")}:${String(camera || "").toUpperCase()}`;

function readCropProfiles(root) {
  const file = cachePath(root);
  if (!fs.existsSync(file)) return { version: CACHE_VERSION, profiles: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed.version === CACHE_VERSION && parsed.profiles && typeof parsed.profiles === "object" ? parsed : { version: CACHE_VERSION, profiles: {} };
  } catch { return { version: CACHE_VERSION, profiles: {} }; }
}

function writeCropProfiles(root, records) {
  const file = cachePath(root), store = readCropProfiles(root);
  for (const record of records || []) store.profiles[profileKey(record.fingerprint, record.camera)] = record;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  return file;
}

const cropProfileFor = (store, fingerprint, camera) => store?.profiles?.[profileKey(fingerprint, camera)] || null;

function significantVerticalBounds(image, layer) {
  const rowCounts = new Uint32Array(image.height), alphaThreshold = layer === "Shadow" ? 8 : 8;
  for (let y = 0; y < image.height; y += 1) {
    let count = 0;
    for (let x = 0; x < image.width; x += 1) if (image.data[((y * image.width + x) << 2) + 3] > alphaThreshold) count += 1;
    rowCounts[y] = count;
  }
  const minimumRowPixels = Math.max(2, Math.ceil(image.width * (layer === "Shadow" ? 0.0008 : 0.0015)));
  let top = 0, bottom = image.height - 1;
  while (top < image.height && rowCounts[top] < minimumRowPixels) top += 1;
  while (bottom >= 0 && rowCounts[bottom] < minimumRowPixels) bottom -= 1;
  if (top > bottom) throw new Error(`${layer} calibration has no significant alpha pixels`);
  return { top, bottom, height: image.height, minimumRowPixels };
}

function analyzeCalibrationPair(fabricFile, shadowFile, options = {}) {
  const fabric = PNG.sync.read(fs.readFileSync(fabricFile)), shadow = PNG.sync.read(fs.readFileSync(shadowFile));
  if (fabric.height !== shadow.height) throw new Error(`Calibration heights differ (${fabric.height} vs ${shadow.height})`);
  const fabricBounds = significantVerticalBounds(fabric, "Fabric"), shadowBounds = significantVerticalBounds(shadow, "Shadow");
  const sourceHeight = fabric.height, margin = clamp(Number(options.margin ?? DEFAULT_MARGIN), 0, 0.2), marginPixels = Math.ceil(sourceHeight * margin);
  const unionTop = Math.max(0, Math.min(fabricBounds.top, shadowBounds.top) - marginPixels);
  const unionBottom = Math.min(sourceHeight - 1, Math.max(fabricBounds.bottom, shadowBounds.bottom) + marginPixels);
  const center = (sourceHeight - 1) / 2;
  const halfExtent = Math.max(center - unionTop, unionBottom - center);
  const symmetricTop = Math.max(0, Math.floor(center - halfExtent));
  const symmetricBottom = Math.min(sourceHeight - 1, Math.ceil(center + halfExtent));
  const safeHeight = symmetricBottom - symmetricTop + 1;
  return {
    version: CACHE_VERSION,
    cropRatio: clamp(safeHeight / sourceHeight, 0.2, 1),
    sourceHeight,
    margin,
    bounds: { fabric: fabricBounds, shadow: shadowBounds, union: { top: unionTop, bottom: unionBottom }, safe: { top: symmetricTop, bottom: symmetricBottom } },
    analyzedAt: new Date().toISOString()
  };
}

function applyCropProfile(layerResolution, profile) {
  const result = clone(layerResolution), baseHeight = Number(result.Resolution?.Y), baseSensorHeight = Number(result.SensorSize?.Y);
  if (!(baseHeight > 0) || !(baseSensorHeight > 0)) return result;
  const ratio = clamp(Number(profile?.cropRatio) || 1, 0.2, 1);
  const height = Math.min(baseHeight, Math.max(OUTPUT_ALIGNMENT, Math.ceil((baseHeight * ratio) / OUTPUT_ALIGNMENT) * OUTPUT_ALIGNMENT));
  const effectiveRatio = height / baseHeight;
  result.Resolution.Y = height;
  result.SensorSize.Y = Number((baseSensorHeight * effectiveRatio).toFixed(6));
  result._rhLocalCrop = { ratio: effectiveRatio, source: profile?.analyzedAt || "cache", symmetric: true };
  return result;
}

function applyCropProfileToCamera(camera, profile) {
  const result = clone(camera);
  result.LayerResolutions = (result.LayerResolutions || []).map(layer => applyCropProfile(layer, profile));
  result._rhLocalCrop = { ...(result._rhLocalCrop || {}), status: "ready", cropRatio: profile.cropRatio };
  return result;
}

function calibrationFiles(folder, camera) {
  if (!fs.existsSync(folder)) return { fabric: null, shadow: null };
  const token = new RegExp(`(?:^|_)${String(camera).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:_|\\.)`, "i");
  const files = fs.readdirSync(folder).filter(name => name.toLowerCase().endsWith(".png") && token.test(name));
  return {
    fabric: files.map(name => path.join(folder, name)).find(file => !/(?:^|_)shadow(?:_|\.)/i.test(path.basename(file))) || null,
    shadow: files.map(name => path.join(folder, name)).find(file => /(?:^|_)shadow(?:_|\.)/i.test(path.basename(file))) || null
  };
}

module.exports = {
  CACHE_VERSION, CACHE_FILE, CALIBRATION_FOLDER, DEFAULT_MARGIN, OUTPUT_ALIGNMENT,
  modelFingerprint, profileKey, readCropProfiles, writeCropProfiles, cropProfileFor,
  significantVerticalBounds, analyzeCalibrationPair, applyCropProfile, applyCropProfileToCamera, calibrationFiles
};
