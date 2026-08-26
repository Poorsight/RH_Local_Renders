"use strict";

const path = require("path");

// One batch folder, four branches, no mixing:
//   raw/<MODEL>/          what Unreal wrote, untouched
//   calibration/<MODEL>/  the 500px crop probes and camera prefits
//   preview/<MODEL>/      downscaled proxies, cheap enough to serve over the web
//   POST/<MODEL>/         the delivery files and nothing else
const BRANCHES = { raw: "raw", calibration: "calibration", preview: "preview", delivery: "POST" };

// Batches rendered before the split kept everything inside the model folder.
const LEGACY_CALIBRATION = "_crop_calibration";
const LEGACY_PREFIT = "_camera_prefit";
const LEGACY_DELIVERY = "_READY_TO_UPLOAD";

// Folders that hold working files rather than renders, so readers can skip them.
const NON_RENDER_FOLDERS = [BRANCHES.calibration, BRANCHES.preview, BRANCHES.delivery, LEGACY_CALIBRATION, LEGACY_PREFIT, LEGACY_DELIVERY];

function branchFolder(batchRoot, kind, modelSegment) {
  const name = BRANCHES[kind];
  if (!name) throw new Error(`Unknown output branch: ${kind}`);
  const base = path.join(path.resolve(batchRoot), name);
  return `${modelSegment ? path.join(base, modelSegment) : base}${path.sep}`;
}

// Turns raw/<MODEL>/ into its sibling branch. A folder with no raw segment is a
// pre-split batch, so the answer there is the old nested folder instead.
function siblingBranch(rawFolder, kind) {
  const resolved = path.resolve(String(rawFolder || "")), parts = resolved.split(path.sep);
  const index = parts.lastIndexOf(BRANCHES.raw);
  if (index === -1) {
    const legacy = kind === "calibration" ? LEGACY_CALIBRATION : kind === "preview" ? BRANCHES.preview : BRANCHES[kind];
    return `${path.join(resolved, legacy)}${path.sep}`;
  }
  const name = BRANCHES[kind];
  if (!name) throw new Error(`Unknown output branch: ${kind}`);
  parts[index] = name;
  return `${parts.join(path.sep)}${path.sep}`;
}

// The batch folder a raw/<MODEL>/ path belongs to, or the folder itself when the
// layout predates the split.
function batchRootOf(rawFolder) {
  const resolved = path.resolve(String(rawFolder || "")), parts = resolved.split(path.sep);
  const index = parts.lastIndexOf(BRANCHES.raw);
  return index === -1 ? resolved : parts.slice(0, index).join(path.sep);
}

function isInBranch(file, kind) {
  const name = BRANCHES[kind];
  const segments = path.resolve(String(file || "")).split(path.sep);
  if (kind === "calibration") return segments.includes(name) || segments.includes(LEGACY_CALIBRATION);
  if (kind === "delivery") return segments.includes(name) || segments.includes(LEGACY_DELIVERY);
  return segments.includes(name);
}

module.exports = { BRANCHES, LEGACY_CALIBRATION, LEGACY_PREFIT, LEGACY_DELIVERY, NON_RENDER_FOLDERS, branchFolder, siblingBranch, batchRootOf, isInBranch };
