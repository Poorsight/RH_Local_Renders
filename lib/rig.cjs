"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { parseCsv } = require("./csv.cjs");

const SHEET_ID = "1GD6HBWWG8AL6JY0Q97wcTg7LCzVS60ZCgBSAJjCxk8E";
const LIGHTS_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=0`;
const splitList = value => String(value || "").split(",").map(part => part.trim()).filter(Boolean);
const round6 = value => Number(Number(value).toFixed(6));
const isActive = value => ["TRUE", "1", "YES"].includes(String(value || "").trim().toUpperCase());
const numberOr = (value, fallback) => {
  const text = String(value ?? "").trim();
  if (!text) return fallback;
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) throw new Error(`Light sheet contains an invalid number: ${text}`);
  return parsed;
};

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
      innerConeAngle: numberOr(row.default_InnerConeAngle, -1),
      outerConeAngle: numberOr(row.default_OuterConeAngle, -1),
      sublevel: row.light_sublevel_suffix
    };
    light.shadow = {
      position: light.position.map((value, index) => numberOr([row.shadow_x, row.shadow_y, row.shadow_z][index], value)),
      rotation: {
        Pitch: numberOr(row.shadow_pitch, light.rotation.Pitch),
        Yaw: numberOr(row.shadow_yaw, light.rotation.Yaw),
        Roll: numberOr(row.shadow_roll, light.rotation.Roll)
      },
      intensity: numberOr(row.shadow_intensity, light.intensity),
      innerConeAngle: numberOr(row.shadow_InnerConeAngle, light.innerConeAngle),
      outerConeAngle: numberOr(row.shadow_OuterConeAngle, light.outerConeAngle)
    };
    for (const scene of splitList(row.sequence_prefix)) for (const camera of splitList(row.camera)) {
      if (!["F", "FH", "TQ"].includes(camera)) continue;
      rig[scene] ||= {}; rig[scene][camera] ||= {}; rig[scene][camera][light.name] = {
        ...light, rotation: { ...light.rotation }, position: [...light.position],
        shadow: { ...light.shadow, rotation: { ...light.shadow.rotation }, position: [...light.shadow.position] }
      };
    }
  }
  return rig;
}

function jobLights(rig, scene, camera, variant = "Default") {
  // The rig is a sun now: nothing about the model changes where a light sits, how
  // bright it is or how big its source is. Every value goes out exactly as the
  // sheet lists it, sorted by name so the job is byte-stable.
  const base = rig[scene]?.[camera];
  if (!base || !Object.keys(base).length) throw new Error(`Light sheet has no ${scene} / ${camera} lights`);
  return Object.keys(base).sort().map(name => {
    const light = base[name], settings = String(variant).toLowerCase() === "shadow" ? light.shadow : light;
    const [x, y, z] = settings.position;
    return {
      name, Location: { X: round6(x), Y: round6(y), Z: round6(z) }, rotation: { ...settings.rotation },
      intensity: round6(settings.intensity), InnerConeAngle: settings.innerConeAngle, OuterConeAngle: settings.outerConeAngle,
      LevelName: `Sectional_Indoor_${light.sublevel}`
    };
  });
}

class SheetStore {
  constructor(root) {
    this.fallbackPath = path.join(root, "data", "sectionals-indoor.csv");
    this.rows = []; this.source = "fallback"; this.updatedAt = null;
    this.loadLocal();
  }
  loadLocal() {
    this.rows = filterRows(parseCsv(fs.readFileSync(this.fallbackPath, "utf8")));
    this.source = "fallback";
    this.updatedAt = fs.statSync(this.fallbackPath).mtime.toISOString();
  }
  async refresh() {
    const response = await fetch(LIGHTS_URL, { signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error(`Google Sheets returned ${response.status}`);
    const text = await response.text(), rows = filterRows(parseCsv(text));
    const rig = buildRig(rows);
    for (const scene of ["Sectional_Indoor_R", "Sectional_Indoor_L", "Sectional_Indoor_U"]) for (const camera of ["F", "FH", "TQ"]) {
      if (!Object.keys(rig[scene]?.[camera] || {}).length) throw new Error(`Live sheet is incomplete for ${scene} / ${camera}`);
    }
    this.rows = rows; this.source = "live"; this.updatedAt = new Date().toISOString();
    return this.status();
  }
  status() { return { source: this.source, rows: this.rows.length, updatedAt: this.updatedAt }; }
  rig() { return buildRig(this.rows); }
}

module.exports = { SheetStore, buildRig, filterRows, jobLights, LIGHTS_URL };
