"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { unrealScaleFor } = require("./model-check.cjs");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const MODEL_EXTENSIONS = new Set([".fbx", ".obj"]);
const isModelFile = name => MODEL_EXTENSIONS.has(path.extname(name).toLowerCase());

function walkModels(root) {
  if (!fs.existsSync(root)) return [];
  const output = [], stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full); else if (entry.isFile() && isModelFile(entry.name)) output.push(full);
    }
  }
  return output.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
}

// The first folder under the models root names the product type, so sectionals and sofas
// can share one library without the scanner having to guess from a filename.
function modelGroup(modelsRoot, modelPath) {
  const relative = path.relative(path.resolve(modelsRoot), path.resolve(modelPath));
  const segments = relative.split(path.sep);
  return segments.length > 1 ? segments[0] : "";
}

function findBlender() {
  if (process.env.RH_BLENDER && fs.existsSync(process.env.RH_BLENDER)) return process.env.RH_BLENDER;
  const foundation = "C:\\Program Files\\Blender Foundation";
  if (fs.existsSync(foundation)) {
    const candidates = fs.readdirSync(foundation, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name.startsWith("Blender "))
      .map(entry => path.join(foundation, entry.name, "blender.exe"))
      .filter(fs.existsSync)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    if (candidates[0]) return candidates[0];
  }
  throw new Error("Blender was not found. Install Blender or set RH_BLENDER to blender.exe.");
}

async function analyzeWithBlender(root, modelPath) {
  const blender = findBlender(), script = path.join(root, "scripts", "inspect_fbx.py");
  const { stdout, stderr } = await execFileAsync(blender, ["-b", "--factory-startup", "--python", script, "--", modelPath], {
    windowsHide: true, timeout: 20 * 60 * 1000, maxBuffer: 20 * 1024 * 1024
  });
  const combined = `${stdout || ""}\n${stderr || ""}`;
  const line = combined.split(/\r?\n/).find(value => value.startsWith("RH_MODEL_JSON "));
  if (!line) {
    const failure = combined.split(/\r?\n/).find(value => value.startsWith("RH_MODEL_ERROR "));
    throw new Error(failure ? failure.slice("RH_MODEL_ERROR ".length) : "Blender did not return model metadata");
  }
  return JSON.parse(line.slice("RH_MODEL_JSON ".length));
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function fingerprint(file) {
  const info = fs.statSync(file);
  return { size: info.size, modifiedMs: Math.round(info.mtimeMs) };
}

const sameFingerprint = (left, right) => left && right && left.size === right.size && left.modifiedMs === right.modifiedMs;

function sectionalFormFactor(name, side = "") {
  const modelName = String(name || "").toUpperCase(), recorded = String(side || "").toUpperCase();
  if (/(?:^|_)U(?:_|$)/.test(modelName) || modelName.includes("U_SECTIONAL") || modelName.includes("U_CHAISE")) return "U";
  if (/(?:^|_)RIGHT_ARM(?:_|$)/.test(modelName)) return "R";
  if (/(?:^|_)LEFT_ARM(?:_|$)/.test(modelName)) return "L";
  if (recorded === "R" || recorded.includes("RIGHT")) return "R";
  if (recorded === "L" || recorded.includes("LEFT")) return "L";
  if (recorded === "U" || recorded.includes("U_SHAPE") || recorded.includes("U_SECTIONAL") || recorded.includes("U_CHAISE")) return "U";
  return "UNKNOWN";
}

class ModelStore {
  constructor(root, options = {}) {
    this.root = root;
    this.modelsRoot = options.modelsRoot || process.env.RH_MODELS_ROOT || path.join(root, "local", "models");
    this.metadataPath = options.metadataPath || path.join(root, "data", "models.json");
    this.metadata = JSON.parse(fs.readFileSync(this.metadataPath, "utf8"));
    this.localMetadataPath = options.localMetadataPath || path.join(root, "local", "model-metadata.json");
    this.localMetadata = readJson(this.localMetadataPath, { version: 1, models: {} });
    this.analyzeModel = options.analyzeModel || (modelPath => analyzeWithBlender(root, modelPath));
    this.pending = new Map();
  }
  cacheKey(modelPath) {
    const relative = path.relative(path.resolve(this.modelsRoot), path.resolve(modelPath));
    return relative && !relative.startsWith("..") ? relative.split(path.sep).join("/") : path.resolve(modelPath);
  }
  list() {
    return walkModels(this.modelsRoot).map(modelPath => ({
      name: path.basename(modelPath, path.extname(modelPath)), path: modelPath,
      format: path.extname(modelPath).toLowerCase().slice(1), group: modelGroup(this.modelsRoot, modelPath)
    }));
  }
  resolve(query) {
    const value = String(query || "").trim(); if (!value) throw new Error("Model name is required");
    if (path.isAbsolute(value) && fs.existsSync(value) && isModelFile(value)) return path.resolve(value);
    const needle = path.basename(value, path.extname(value)).toLowerCase(), models = this.list();
    const exact = models.find(model => model.name.toLowerCase() === needle), partial = models.filter(model => model.name.toLowerCase().includes(needle));
    if (exact) return exact.path; if (partial.length === 1) return partial[0].path;
    if (partial.length > 1) throw new Error(`Model name matches ${partial.length} files; enter a full name`);
    throw new Error(`No FBX or OBJ model matches that name in ${this.modelsRoot}`);
  }
  result(modelPath, record, source, newlyAnalyzed = false) {
    const name = path.basename(modelPath, path.extname(modelPath)), [width, depth, height] = record.dimensions;
    const ids = record.materialIds || this.metadata.profiles[record.ids];
    if (!ids?.length) throw new Error(`Material IDs are missing for ${name}`);
    return {
      name, path: modelPath, side: sectionalFormFactor(name, record.side), materialIds: [...ids],
      dimensions: { width, depth, height }, importYaw: record.yaw, offsetUniformScale: unrealScaleFor(record, path.extname(modelPath).slice(1)) ?? record.scale,
      warning: record.warning || "", meshObjects: record.meshObjects || ids.length, metadataSource: source, newlyAnalyzed,
      scale: record.scale, analysis: record.analysis || null, format: path.extname(modelPath).toLowerCase().slice(1), group: modelGroup(this.modelsRoot, modelPath)
    };
  }
  saveLocal() {
    fs.mkdirSync(path.dirname(this.localMetadataPath), { recursive: true });
    fs.writeFileSync(this.localMetadataPath, `${JSON.stringify(this.localMetadata, null, 2)}\n`, "utf8");
  }
  async inspect(query) {
    const modelPath = this.resolve(query), name = path.basename(modelPath, path.extname(modelPath));
    const tracked = this.metadata.models[name];
    if (tracked) return this.result(modelPath, tracked, "tracked");
    // Keyed by where the file is, not just what it is called: two models can share a basename
    // across folders — a raw download and its repaired copy, say — and a name-only key hands
    // one file's measurements to the other.
    const cacheKey = this.cacheKey(modelPath);
    const sourceFingerprint = fingerprint(modelPath);
    const cached = this.localMetadata.models[cacheKey] || this.localMetadata.models[name];
    if (cached && sameFingerprint(cached.fingerprint, sourceFingerprint)) return this.result(modelPath, cached, "local");
    if (!this.pending.has(modelPath)) this.pending.set(modelPath, (async () => {
      const analyzed = await this.analyzeModel(modelPath);
      const record = { ...analyzed, fingerprint: sourceFingerprint, analyzedAt: new Date().toISOString() };
      this.localMetadata.models[cacheKey] = record; this.saveLocal();
      return this.result(modelPath, record, "local", true);
    })().finally(() => this.pending.delete(modelPath)));
    return this.pending.get(modelPath);
  }
}

module.exports = { ModelStore, walkModels, modelGroup, isModelFile, MODEL_EXTENSIONS, analyzeWithBlender, findBlender, sectionalFormFactor };
