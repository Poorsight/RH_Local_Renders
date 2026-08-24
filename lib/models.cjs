"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { parseCsv } = require("./csv.cjs");

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

function reportRows(root, classifierRoot) {
  const files = [path.join(root, "local", "classifier", "report.csv"), path.join(classifierRoot, "report.csv")];
  for (const file of files) if (fs.existsSync(file)) return parseCsv(fs.readFileSync(file, "utf8"));
  return [];
}

function componentId(name) {
  const last = String(name || "").split(":").pop().trim();
  return last.replace(/\.\d{3}$/i, "");
}

class ModelStore {
  constructor(root, options = {}) {
    this.root = root;
    this.modelsRoot = options.modelsRoot || process.env.RH_MODELS_ROOT || path.join(root, "local", "models");
    this.classifierRoot = options.classifierRoot || process.env.RH_CLASSIFIER_ROOT || "D:\\GitHub\\sectional-classifier";
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
    const cachePath = path.join(this.classifierRoot, "cache", `${name}.json`);
    if (!fs.existsSync(cachePath)) throw new Error(`Geometry cache is missing for ${name}. Run sectional-classifier first.`);
    const cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    const report = reportRows(this.root, this.classifierRoot).find(row => row.file === name);
    const realSize = String(report?.real_size_m || "").match(/([\d.]+)\s*x\s*([\d.]+)\s*x\s*([\d.]+)/i);
    const bbox = cache.bbox_min && cache.bbox_max ? cache.bbox_max.map((value, index) => value - cache.bbox_min[index]) : [0, 0, 0];
    let dimensions = realSize ? realSize.slice(1).map(Number).map(value => value * 100) : bbox.map(value => value * 100);
    const warning = report?.warnings || "", importYaw = /model is rotated/i.test(warning) ? -90 : 0;
    if (importYaw) dimensions = [dimensions[1], dimensions[0], dimensions[2]];
    const ids = [...new Map((cache.objects || []).map(object => componentId(object.name)).filter(Boolean).map(id => [id.toLowerCase(), id])).values()];
    const priority = id => ({ uph: 0, stitches: 1, feet: 2 })[id.toLowerCase()] ?? 10;
    ids.sort((a, b) => priority(a) - priority(b) || a.localeCompare(b));
    return {
      name, path: modelPath, side: report?.final_label || "UNKNOWN", materialIds: ids,
      dimensions: { width: +dimensions[0].toFixed(1), depth: +dimensions[1].toFixed(1), height: +dimensions[2].toFixed(1) },
      importYaw, offsetUniformScale: /needs x2\.54/i.test(report?.unit || "") ? 2.54 : 1,
      warning, meshObjects: cache.n_mesh_objects || ids.length
    };
  }
}

module.exports = { ModelStore, componentId, walkFbx };
