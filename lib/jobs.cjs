"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { jobLights, rigScale } = require("./rig.cjs");

const CAMERA_YAW = { R: { F: 0, FH: 0, TQ: -36 }, L: { F: 0, FH: 0, TQ: 36 }, U: { F: 0, FH: 0, TQ: 36 } };
const PADDING = { left: { value: 0.0016, snapping: false }, right: { value: 0.0016, snapping: false }, top: { value: 0.0016, snapping: false }, bottom: { value: 0.0016, snapping: false } };
const RESOLUTIONS = {
  Fabric: { Name: "Fabric", Resolution: { X: 5000, Y: 5000 }, SensorSize: { X: 36, Y: 36 } },
  Shadow: { Name: "Shadow", Resolution: { X: 15000, Y: 5000 }, SensorSize: { X: 108, Y: 36 } }
};

const safeSegment = value => String(value || "job").replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "") || "job";
const groupedMaterials = rows => {
  const groups = new Map();
  for (const row of rows || []) {
    const material = String(row.material || "").trim(); if (!material) throw new Error(`Material is empty for ${(row.meshes || []).join(", ")}`);
    if (!groups.has(material)) groups.set(material, []); groups.get(material).push(...(row.meshes || []).map(String));
  }
  if (!groups.size) throw new Error("At least one material assignment is required");
  return [...groups].map(([name, meshes]) => ({ meshes: [...new Set(meshes.map(mesh => mesh.toLowerCase()))], list: [{ name, ApplyExposure: false, postProccessName: "RH_POST_PROCESS" }] }));
};

function buildJob(input, model, rig, outputFolder) {
  const side = String(input.side || "R").toUpperCase();
  if (!CAMERA_YAW[side]) throw new Error("Sectional side must be R, L, or U");
  const cameras = [...new Set(input.cameras || [])].filter(camera => ["F", "FH", "TQ"].includes(camera));
  if (!cameras.length) throw new Error("Select at least one sectional camera: F, FH, or TQ");
  const layers = [...new Set(input.layers || [])].filter(layer => RESOLUTIONS[layer]);
  if (!layers.length) throw new Error("Select at least one render layer");
  const dimensions = { width: +input.dimensions?.width, depth: +input.dimensions?.depth, height: +input.dimensions?.height };
  if (!Object.values(dimensions).every(value => Number.isFinite(value) && value > 0)) throw new Error("Model dimensions must be positive numbers");
  const scene = `Sectional_Indoor_${side}`, importYaw = Number(input.importYaw) || 0;
  const cameraBlocks = cameras.map(name => ({
    name, padding: JSON.parse(JSON.stringify(PADDING)), correctPerspective: false, fit: "horizontalFocalLength",
    Actor: { Location: { X: 0, Y: 0, Z: 0 }, Rotation: { Yaw: CAMERA_YAW[side][name] + importYaw, Pitch: 0, Roll: -90 }, Scale: { X: 1, Y: 1, Z: 1 } },
    lights: jobLights(rig, scene, name, dimensions, input.sourceMode || "B"), sequenceName: `${scene}_${name}`,
    SceneActors: [], LayerResolutions: layers.map(layer => JSON.parse(JSON.stringify(RESOLUTIONS[layer])))
  }));
  const output = `${path.resolve(outputFolder)}${path.sep}`;
  const layerBlocks = layers.map(name => name === "Fabric" ? {
    name, config: "4_k_PathTrace_PNG", SubLevels: ["Sectional_Indoor_Background", "Sectional_Indoor_KeyLight"],
    output: { folder: output, fileNameFormat: "00000000_{camera}_Product_{material:uph}", overWrite: true }, doNotRender: false
  } : {
    name, config: "4_k_Lumen_PNG_Background_Shadows", SubLevels: ["Sectional_Indoor_Shadow", "Sectional_Indoor_KeyLight"],
    output: { folder: output, fileNameFormat: "00000000_{camera}_{layer}", overWrite: true }, doNotRender: false, postProcesses: ["PostProcess_shadow"]
  });
  return {
    jobId: model.name, requester: "RH_Local_Renders",
    tasks: [{ taskId: model.name, model: { objPath: model.path, offsetUniformScale: model.offsetUniformScale }, sequence: { cameras: cameraBlocks }, materials: groupedMaterials(input.materials), layers: layerBlocks }],
    _rhLocal: { generatedAt: new Date().toISOString(), dimensions, side, importYaw, sourceMode: input.sourceMode || "B", rigScale: rigScale(dimensions), outputFolder: output }
  };
}

function writeJob(root, input, model, rig) {
  const stem = safeSegment(model.name), outputFolder = path.join(root, "local", "renders", stem), jobsFolder = path.join(root, "local", "jobs", "generated");
  fs.mkdirSync(outputFolder, { recursive: true }); fs.mkdirSync(jobsFolder, { recursive: true });
  const job = buildJob(input, model, rig, outputFolder), jobPath = path.join(jobsFolder, `${stem}.job.json`);
  fs.writeFileSync(jobPath, `${JSON.stringify(job, null, 2)}\n`, "utf8");
  return { job, jobPath, outputFolder };
}

module.exports = { CAMERA_YAW, RESOLUTIONS, buildJob, writeJob, groupedMaterials };
