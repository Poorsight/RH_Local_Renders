"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { jobLights, rigScale } = require("./rig.cjs");

const CAMERA_YAW = { R: { F: 0, FH: 0, TQ: -36 }, L: { F: 0, FH: 0, TQ: 36 }, U: { F: 0, FH: 0, TQ: 36 } };
const PADDING = { left: { value: 0.0016, snapping: false }, right: { value: 0.0016, snapping: false }, top: { value: 0.0016, snapping: false }, bottom: { value: 0.0016, snapping: false } };
const RESOLUTION_PROFILES = {
  high: {
    Fabric: { Name: "Fabric", Resolution: { X: 5000, Y: 5000 }, SensorSize: { X: 36, Y: 36 } },
    Shadow: { Name: "Shadow", Resolution: { X: 15000, Y: 5000 }, SensorSize: { X: 108, Y: 36 } }
  },
  low: {
    Fabric: { Name: "Fabric", Resolution: { X: 500, Y: 500 }, SensorSize: { X: 36, Y: 36 } },
    Shadow: { Name: "Shadow", Resolution: { X: 1500, Y: 500 }, SensorSize: { X: 108, Y: 36 } }
  }
};
const RESOLUTIONS = RESOLUTION_PROFILES.high;
const renderProfile = value => String(value || "high").toLowerCase() === "low" ? "low" : "high";

const safeSegment = value => String(value || "job").replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "") || "job";
const uniqueJobId = (jobsFolder, stem, count = "") => {
  const stamp = new Date().toISOString().replace(/\D/g, ""), base = `${count ? `batch_${count}` : safeSegment(stem)}_${stamp}`;
  let id = base, suffix = 1;
  while (fs.existsSync(path.join(jobsFolder, `${id}.job.json`))) id = `${base}_${suffix++}`;
  return id;
};
const groupedMaterials = rows => {
  const groups = new Map();
  for (const row of rows || []) {
    const material = String(row.material || "").trim(); if (!material) throw new Error(`Material is empty for ${(row.meshes || []).join(", ")}`);
    if (!groups.has(material)) groups.set(material, []); groups.get(material).push(...(row.meshes || []).map(String));
  }
  if (!groups.size) throw new Error("At least one material assignment is required");
  return [...groups].map(([name, meshes]) => ({ meshes: [...new Set(meshes.map(mesh => mesh.toLowerCase()))], list: [{ name, ApplyExposure: false, postProccessName: "RH_POST_PROCESS" }] }));
};

const fabricFileNameFormat = materials => {
  const upholsteryMesh = (materials || []).flatMap(group => group.meshes || []).find(mesh => /(?:^|[_:])uph\d*$/i.test(mesh));
  if (!upholsteryMesh) throw new Error("Fabric output requires an UPH component ID");
  return `00000000_{camera}_Product_{material:${String(upholsteryMesh).toLowerCase()}}`;
};

function taskFor(input, model, rig, outputFolder) {
  const side = String(input.side || "R").toUpperCase();
  if (!CAMERA_YAW[side]) throw new Error("Sectional side must be R, L, or U");
  const cameras = [...new Set(input.cameras || [])].filter(camera => ["F", "FH", "TQ"].includes(camera));
  if (!cameras.length) throw new Error("Select at least one sectional camera: F, FH, or TQ");
  const profileName = renderProfile(input.renderProfile), resolutions = RESOLUTION_PROFILES[profileName];
  const layers = [...new Set(input.layers || [])].filter(layer => resolutions[layer]);
  if (!layers.length) throw new Error("Select at least one render layer");
  const cameraPrefit = layers.includes("Shadow") && !layers.includes("Fabric");
  const runtimeLayers = cameraPrefit ? ["Fabric", "Shadow"] : layers;
  const dimensions = { width: +input.dimensions?.width, depth: +input.dimensions?.depth, height: +input.dimensions?.height };
  if (!Object.values(dimensions).every(value => Number.isFinite(value) && value > 0)) throw new Error("Model dimensions must be positive numbers");
  const scene = `Sectional_Indoor_${side}`, importYaw = Number(input.importYaw) || 0;
  const cameraBlocks = cameras.map(name => {
    const camera = {
      name, padding: JSON.parse(JSON.stringify(PADDING)), correctPerspective: false, fit: "horizontalFocalLength",
      Actor: { Location: { X: 0, Y: 0, Z: 0 }, Rotation: { Yaw: CAMERA_YAW[side][name] + importYaw, Pitch: 0, Roll: -90 }, Scale: { X: 1, Y: 1, Z: 1 } },
      lights: jobLights(rig, scene, name, dimensions, input.sourceMode || "B"), sequenceName: `${scene}_${name}`,
      SceneActors: [], LayerResolutions: runtimeLayers.map(layer => JSON.parse(JSON.stringify(cameraPrefit && layer === "Fabric" ? RESOLUTION_PROFILES.low.Fabric : resolutions[layer])))
    };
    if (layers.includes("Shadow")) camera._rhLocalShadowLights = jobLights(rig, scene, name, dimensions, input.sourceMode || "B", "Shadow");
    return camera;
  });
  const output = `${path.resolve(outputFolder)}${path.sep}`;
  const validIds = new Set((model.materialIds || []).map(id => String(id).toLowerCase()));
  const materialRows = validIds.size ? (input.materials || []).map(row => ({ ...row, meshes: (row.meshes || []).filter(mesh => validIds.has(String(mesh).toLowerCase())) })).filter(row => row.meshes.length) : (input.materials || []);
  const materials = groupedMaterials(materialRows);
  const layerBlocks = runtimeLayers.map(name => name === "Fabric" ? {
    name, config: "4_k_PathTrace_PNG", SubLevels: ["Sectional_Indoor_Background", "Sectional_Indoor_KeyLight"],
    output: { folder: cameraPrefit ? `${path.join(outputFolder, "_camera_prefit")}${path.sep}` : output, fileNameFormat: cameraPrefit ? "camera_prefit_{camera}" : fabricFileNameFormat(materials), overWrite: true }, doNotRender: false,
    ...(cameraPrefit ? { _rhLocalPrefit: true } : {})
  } : {
    name, config: "4_k_Lumen_PNG_Background_Shadows", SubLevels: ["Sectional_Indoor_Shadow", "Sectional_Indoor_KeyLight"],
    output: { folder: output, fileNameFormat: "00000000_{camera}_{layer}", overWrite: true }, doNotRender: false, postProcesses: ["PostProcess_shadow"]
  });
  return {
    task: { taskId: model.name, model: { objPath: model.path, offsetUniformScale: model.offsetUniformScale }, sequence: { cameras: cameraBlocks }, materials, layers: layerBlocks },
    metadata: { name: model.name, modelPath: model.path, dimensions, side, importYaw, sourceMode: input.sourceMode || "B", renderProfile: profileName, selectedLayers: layers, cameraPrefit, rigScale: rigScale(dimensions), outputFolder: output }
  };
}

function buildJob(input, model, rig, outputFolder) {
  const built = taskFor(input, model, rig, outputFolder);
  return {
    jobId: model.name, requester: "RH_Local_Renders", tasks: [built.task],
    _rhLocal: { generatedAt: new Date().toISOString(), ...built.metadata }
  };
}

function buildBatchJob(entries, rig, outputFolder, jobId) {
  if (!entries?.length) throw new Error("Add at least one model to the batch");
  const models = entries.map(({ input, model }) => taskFor(input, model, rig, path.join(outputFolder, safeSegment(model.name))));
  return {
    jobId, requester: "RH_Local_Renders", tasks: models.map(item => item.task),
    _rhLocal: { generatedAt: new Date().toISOString(), outputFolder: `${path.resolve(outputFolder)}${path.sep}`, models: models.map(item => item.metadata) }
  };
}

function writeJob(root, input, model, rig) {
  const jobsFolder = path.join(root, "local", "jobs", "generated"); fs.mkdirSync(jobsFolder, { recursive: true });
  const jobId = uniqueJobId(jobsFolder, model.name), outputFolder = path.join(root, "local", "renders", jobId);
  fs.mkdirSync(outputFolder, { recursive: true });
  const job = buildJob(input, model, rig, outputFolder), jobPath = path.join(jobsFolder, `${jobId}.job.json`);
  job.jobId = jobId; job._rhLocal.outputFolder = `${path.resolve(outputFolder)}${path.sep}`;
  fs.writeFileSync(jobPath, `${JSON.stringify(job, null, 2)}\n`, "utf8");
  return { job, jobPath, outputFolder };
}

function writeBatchJob(root, entries, rig) {
  if (entries.length === 1) return writeJob(root, entries[0].input, entries[0].model, rig);
  const jobsFolder = path.join(root, "local", "jobs", "generated");
  fs.mkdirSync(jobsFolder, { recursive: true });
  const batchId = uniqueJobId(jobsFolder, "batch", entries.length), outputFolder = path.join(root, "local", "renders", batchId);
  fs.mkdirSync(outputFolder, { recursive: true });
  const job = buildBatchJob(entries, rig, outputFolder, batchId), jobPath = path.join(jobsFolder, `${batchId}.job.json`);
  fs.writeFileSync(jobPath, `${JSON.stringify(job, null, 2)}\n`, "utf8");
  return { job, jobPath, outputFolder };
}

module.exports = { CAMERA_YAW, RESOLUTIONS, RESOLUTION_PROFILES, renderProfile, buildJob, buildBatchJob, writeJob, writeBatchJob, groupedMaterials, fabricFileNameFormat };
