"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { parseCsv } = require("./csv.cjs");

const SHEET_ID = "1GD6HBWWG8AL6JY0Q97wcTg7LCzVS60ZCgBSAJjCxk8E";
const LIGHTS_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=0`;
const REFERENCE = { width: 453, depth: 279, height: 79 };
const LIGHT_ORDER = ["front_fill_lgt", "left_rim_lgt", "main_key_lgt", "right_bounce_lgt", "right_rim_lgt"];
const SOURCE_GEOMETRY = {
  front_fill_lgt: { unrealClass: "RectLight", sourceWidth: 500, sourceHeight: 500, effectiveRadius: 282.094791774 },
  left_rim_lgt: { unrealClass: "SpotLight", sourceRadius: 256, softSourceRadius: 25, effectiveRadius: 256 },
  main_key_lgt: { unrealClass: "SpotLight", sourceRadius: 52.479965, effectiveRadius: 52.479965 },
  right_bounce_lgt: { unrealClass: "RectLight", sourceWidth: 256, sourceHeight: 256, effectiveRadius: 144.432533388 },
  right_rim_lgt: { unrealClass: "RectLight", sourceWidth: 91.440002, sourceHeight: 60.900002, effectiveRadius: 42.101913103 }
};

const splitList = value => String(value || "").split(",").map(part => part.trim()).filter(Boolean);
const round6 = value => Number(Number(value).toFixed(6));
const isActive = value => ["TRUE", "1", "YES"].includes(String(value || "").trim().toUpperCase());

function filterRows(rows) {
  return rows.filter(row => isActive(row.active) && row.airtable_categories === "Sectionals" && row.environment === "Indoor" && ["F", "FH", "TQ"].some(camera => splitList(row.camera).includes(camera)));
}

function buildRig(rows) {
  const rig = {};
  for (const row of filterRows(rows)) {
    const light = {
      name: row.light_name,
      position: [+row.default_x, +row.default_y, +row.default_z],
      rotation: { Pitch: +row.default_pitch, Yaw: +row.default_yaw, Roll: +row.default_roll },
      intensity: +row.default_intensity,
      sublevel: row.light_sublevel_suffix
    };
    for (const scene of splitList(row.sequence_prefix)) for (const camera of splitList(row.camera)) {
      if (!["F", "FH", "TQ"].includes(camera)) continue;
      rig[scene] ||= {}; rig[scene][camera] ||= {}; rig[scene][camera][light.name] = { ...light, rotation: { ...light.rotation }, position: [...light.position] };
    }
  }
  return rig;
}

function rigScale(dimensions) {
  const raw = Math.cbrt((dimensions.width / REFERENCE.width) * (dimensions.depth / REFERENCE.depth) * (dimensions.height / REFERENCE.height));
  return { raw, value: Math.max(1, raw) };
}

function jobLights(rig, scene, camera, dimensions, mode = "B") {
  const base = rig[scene]?.[camera];
  if (!base || Object.keys(base).length !== 5) throw new Error(`Light sheet has no complete ${scene} / ${camera} rig`);
  const { value: k } = rigScale(dimensions);
  return LIGHT_ORDER.map(name => {
    const light = base[name], geometry = SOURCE_GEOMETRY[name] || {};
    const [x, y, z] = light.position, d2 = x * x + y * y + z * z, radius2 = (geometry.effectiveRadius || 0) ** 2;
    const intensity = mode === "A" ? light.intensity * k * k : light.intensity * ((k * k * d2 + radius2) / (d2 + radius2));
    const sizeScale = mode === "A" ? k : 1;
    const result = {
      name, Location: { X: round6(x * k), Y: round6(y * k), Z: round6(z * k) }, rotation: { ...light.rotation },
      intensity: round6(intensity), InnerConeAngle: -1, OuterConeAngle: -1,
      LevelName: `Sectional_Indoor_${light.sublevel}`
    };
    if (geometry.sourceWidth != null) { result.RectSourceWidth = round6(geometry.sourceWidth * sizeScale); result.RectSourceHeight = round6(geometry.sourceHeight * sizeScale); }
    if (geometry.sourceRadius != null) { result.SourceRadius = round6(geometry.sourceRadius * sizeScale); if (geometry.softSourceRadius != null) result.SoftSourceRadius = round6(geometry.softSourceRadius * sizeScale); }
    return result;
  });
}

class SheetStore {
  constructor(root) {
    this.fallbackPath = path.join(root, "data", "sectionals-indoor.csv");
    this.cachePath = path.join(root, "local", "cache", "sectionals-indoor.csv");
    this.rows = []; this.source = "fallback"; this.updatedAt = null;
    this.loadLocal();
  }
  loadLocal() {
    const candidate = fs.existsSync(this.cachePath) ? this.cachePath : this.fallbackPath;
    this.rows = filterRows(parseCsv(fs.readFileSync(candidate, "utf8")));
    this.source = candidate === this.cachePath ? "cache" : "fallback";
    this.updatedAt = fs.statSync(candidate).mtime.toISOString();
  }
  async refresh() {
    const response = await fetch(LIGHTS_URL, { signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error(`Google Sheets returned ${response.status}`);
    const text = await response.text(), rows = filterRows(parseCsv(text));
    const rig = buildRig(rows);
    for (const scene of ["Sectional_Indoor_R", "Sectional_Indoor_L", "Sectional_Indoor_U"]) for (const camera of ["F", "FH", "TQ"]) {
      if (Object.keys(rig[scene]?.[camera] || {}).length !== 5) throw new Error(`Live sheet is incomplete for ${scene} / ${camera}`);
    }
    fs.mkdirSync(path.dirname(this.cachePath), { recursive: true }); fs.writeFileSync(this.cachePath, text, "utf8");
    this.rows = rows; this.source = "live"; this.updatedAt = new Date().toISOString();
    return this.status();
  }
  status() { return { source: this.source, rows: this.rows.length, updatedAt: this.updatedAt }; }
  rig() { return buildRig(this.rows); }
}

module.exports = { SheetStore, buildRig, filterRows, jobLights, rigScale, REFERENCE, LIGHTS_URL };
