"use strict";

const fs = require("node:fs");
const path = require("node:path");

function walkFbx(root) {
  if (!fs.existsSync(root)) return [];
  const output = [], stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full); else if (entry.isFile() && entry.name.toLowerCase().endsWith(".fbx")) output.push(full);
    }
  }
  return output.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
}

class ModelStore {
  constructor(root, options = {}) {
    this.root = root;
    this.modelsRoot = options.modelsRoot || process.env.RH_MODELS_ROOT || path.join(root, "local", "models");
    this.metadataPath = options.metadataPath || path.join(root, "data", "models.json");
    this.metadata = JSON.parse(fs.readFileSync(this.metadataPath, "utf8"));
  }
  list() { return walkFbx(this.modelsRoot).map(modelPath => ({ name: path.basename(modelPath, path.extname(modelPath)), path: modelPath })); }
  resolve(query) {
    const value = String(query || "").trim(); if (!value) throw new Error("Model name is required");
    if (path.isAbsolute(value) && fs.existsSync(value) && path.extname(value).toLowerCase() === ".fbx") return path.resolve(value);
    const needle = path.basename(value, path.extname(value)).toLowerCase(), models = this.list();
    const exact = models.find(model => model.name.toLowerCase() === needle), partial = models.filter(model => model.name.toLowerCase().includes(needle));
    if (exact) return exact.path; if (partial.length === 1) return partial[0].path;
    if (partial.length > 1) throw new Error(`Model name matches ${partial.length} files; enter a full name`);
    throw new Error(`FBX model not found in ${this.modelsRoot}`);
  }
  inspect(query) {
    const modelPath = this.resolve(query), name = path.basename(modelPath, path.extname(modelPath));
    const record = this.metadata.models[name];
    if (!record) throw new Error(`Model metadata is missing for ${name}. Add it to data/models.json.`);
    const [width, depth, height] = record.dimensions;
    const ids = this.metadata.profiles[record.ids];
    if (!ids) throw new Error(`Material ID profile ${record.ids} is missing for ${name}`);
    return {
      name, path: modelPath, side: record.side, materialIds: [...ids],
      dimensions: { width, depth, height }, importYaw: record.yaw, offsetUniformScale: record.scale,
      warning: record.warning || "", meshObjects: record.meshObjects || ids.length
    };
  }
}

module.exports = { ModelStore, walkFbx };
