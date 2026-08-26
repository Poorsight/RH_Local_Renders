"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { branchFolder, siblingBranch } = require("./output-layout.cjs");
const { jobLights, sublevelPrefix } = require("./rig.cjs");
const { applyCropProfileToCamera } = require("./crop.cjs");

const CAMERA_YAW = { R: { F: 0, FH: 0, TQ: -36 }, L: { F: 0, FH: 0, TQ: 36 }, U: { F: 0, FH: 0, TQ: 36 } };
// A camera angle is the model actor being turned, not the camera moving, so these yaws land
// on the actor. A sofa has no sides, so one set covers it.
const SOFA_CAMERA_YAW = { F: 0, P: 90, TQ: 30, TQB: 150 };

// The blocker keeps the key light off the backdrop; it is invisible and never moves, so it
// travels with the type rather than with a model.
const SOFA_LIGHT_BLOCKER = {
  name: "light_blocker",
  Transform: { Location: { X: -193, Y: 21, Z: 98.213623 }, Rotation: { Pitch: 0, Yaw: -53.298207, Roll: 90 }, Scale: { X: 0.4, Y: 0.4, Z: 0.4 } },
  Visibility: false, LevelName: "Sofa_Indoor_Background"
};

// What differs between products, gathered so a job builder does not have to know.
const PRODUCT_TYPES = {
  sectionals: {
    cameras: ["F", "FH", "TQ"],
    scene: side => `Sectional_Indoor_${side}`,
    cameraYaw: (side, camera) => CAMERA_YAW[side][camera],
    // An FBX from this library exports its axes turned, and the actor carries the correction.
    actorRoll: -90,
    layers: ["Fabric", "Shadow"],
    sceneActors: () => [],
    requiresSide: true
  },
  sofas: {
    cameras: ["F", "P", "TQ", "TQB"],
    scene: () => "Sofa_Indoor",
    cameraYaw: (_side, camera) => SOFA_CAMERA_YAW[camera],
    actorRoll: 0,
    // The farm renders sofas Fabric-only today, but the scene carries a Shadow sublevel with
    // its post-process volume and the sheet fills the shadow columns for the key light, so
    // the pass is available here.
    layers: ["Fabric", "Shadow"],
    sceneActors: () => [JSON.parse(JSON.stringify(SOFA_LIGHT_BLOCKER))],
    requiresSide: false
  }
};
const productType = value => PRODUCT_TYPES[String(value || "sectionals").toLowerCase()] || PRODUCT_TYPES.sectionals;
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
const cropMode = value => String(value || "full").toLowerCase() === "optimized" ? "optimized" : "full";

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

// The profile sets the frame a render starts from; these let it be set from the page instead,
// per layer, and land in the job the same way. A missing or unusable number keeps the
// profile's value rather than turning a frame into NaN.
function withResolutionOverrides(profile, overrides) {
  if (!overrides || typeof overrides !== "object") return profile;
  const positive = (value, fallback) => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
  };
  const merged = {};
  for (const [layer, base] of Object.entries(profile)) {
    const asked = overrides[layer] || {};
    merged[layer] = {
      Name: base.Name,
      Resolution: {
        X: Math.round(positive(asked.Resolution?.X, base.Resolution.X)),
        Y: Math.round(positive(asked.Resolution?.Y, base.Resolution.Y))
      },
      SensorSize: {
        X: positive(asked.SensorSize?.X, base.SensorSize.X),
        Y: positive(asked.SensorSize?.Y, base.SensorSize.Y)
      }
    };
  }
  return merged;
}

function taskFor(input, model, rig, outputFolder) {
  const type = productType(input.productType || model.group);
  const side = String(input.side || "R").toUpperCase();
  if (type.requiresSide && !CAMERA_YAW[side]) throw new Error("Sectional side must be R, L, or U");
  const cameras = [...new Set(input.cameras || [])].filter(camera => type.cameras.includes(camera));
  if (!cameras.length) throw new Error(`Select at least one camera: ${type.cameras.join(", ")}`);
  const profileName = renderProfile(input.renderProfile), cropModeName = cropMode(input.cropMode);
  const resolutions = withResolutionOverrides(RESOLUTION_PROFILES[profileName], input.resolutions);
  const layers = [...new Set(input.layers || [])].filter(layer => resolutions[layer] && type.layers.includes(layer));
  if (!layers.length) throw new Error("Select at least one render layer");
  const cameraPrefit = type.layers.includes("Shadow") && layers.includes("Shadow") && !layers.includes("Fabric");
  const runtimeLayers = cameraPrefit ? ["Fabric", "Shadow"] : layers;
  const dimensions = { width: +input.dimensions?.width, depth: +input.dimensions?.depth, height: +input.dimensions?.height };
  if (!Object.values(dimensions).every(value => Number.isFinite(value) && value > 0)) throw new Error("Model dimensions must be positive numbers");
  const scene = type.scene(side), importYaw = Number(input.importYaw) || 0;
  const cameraBlocks = cameras.map(name => {
    let camera = {
      name, padding: JSON.parse(JSON.stringify(PADDING)), correctPerspective: false, fit: "horizontalFocalLength",
      Actor: { Location: { X: 0, Y: 0, Z: 0 }, Rotation: { Yaw: type.cameraYaw(side, name) + importYaw, Pitch: 0, Roll: type.actorRoll }, Scale: { X: 1, Y: 1, Z: 1 } },
      lights: jobLights(rig, scene, name), sequenceName: `${scene}_${name}`,
      SceneActors: type.sceneActors(), LayerResolutions: runtimeLayers.map(layer => JSON.parse(JSON.stringify(cameraPrefit && layer === "Fabric" ? RESOLUTION_PROFILES.low.Fabric : resolutions[layer])))
    };
    if (layers.includes("Shadow")) camera._rhLocalShadowLights = jobLights(rig, scene, name, "Shadow");
    if (cropModeName === "optimized") {
      const profile = input.cropProfiles?.[name] || null;
      camera._rhLocalCrop = { status: profile ? "ready" : "pending", fingerprint: input.modelFingerprint || null, camera: name };
      if (profile) {
        const prefitResolution = cameraPrefit ? camera.LayerResolutions.find(layer => layer.Name === "Fabric") : null;
        camera = applyCropProfileToCamera(camera, profile);
        if (prefitResolution) camera.LayerResolutions = camera.LayerResolutions.map(layer => layer.Name === "Fabric" ? prefitResolution : layer);
      }
    }
    return camera;
  });
  // outputFolder is the batch root: raw renders and the throwaway prefits live in
  // separate branches so neither ever lands in the delivery folder.
  const output = branchFolder(outputFolder, "raw", safeSegment(model.name));
  const prefitOutput = branchFolder(outputFolder, "calibration", safeSegment(model.name));
  const validIds = new Set((model.materialIds || []).map(id => String(id).toLowerCase()));
  const materialRows = validIds.size ? (input.materials || []).map(row => ({ ...row, meshes: (row.meshes || []).filter(mesh => validIds.has(String(mesh).toLowerCase())) })).filter(row => row.meshes.length) : (input.materials || []);
  const materials = groupedMaterials(materialRows);
  const layerBlocks = runtimeLayers.map(name => name === "Fabric" ? {
    name, config: "4_k_PathTrace_PNG", SubLevels: [`${sublevelPrefix(scene)}_Background`, `${sublevelPrefix(scene)}_KeyLight`],
    output: { folder: cameraPrefit ? prefitOutput : output, fileNameFormat: cameraPrefit ? "camera_prefit_{camera}" : fabricFileNameFormat(materials), overWrite: true }, doNotRender: false,
    ...(cameraPrefit ? { _rhLocalPrefit: true } : {})
  } : {
    name, config: "4_k_Lumen_PNG_Background_Shadows", SubLevels: [`${sublevelPrefix(scene)}_Shadow`, `${sublevelPrefix(scene)}_KeyLight`],
    output: { folder: output, fileNameFormat: "00000000_{camera}_{layer}", overWrite: true }, doNotRender: false, postProcesses: ["PostProcess_shadow"]
  });
  return {
    task: { taskId: model.name, model: { objPath: model.path, offsetUniformScale: model.offsetUniformScale }, sequence: { cameras: cameraBlocks }, materials, layers: layerBlocks },
    metadata: { name: model.name, modelPath: model.path, dimensions, side, importYaw, renderProfile: profileName, cropMode: cropModeName, cropProfiles: cameraBlocks.filter(camera => camera._rhLocalCrop?.status === "ready").length, cropCalibration: cameraBlocks.filter(camera => camera._rhLocalCrop?.status === "pending").length, cameraPrefit, outputFolder: output }
  };
}

function buildJob(input, model, rig, outputFolder) {
  const built = taskFor(input, model, rig, outputFolder);
  return {
    jobId: model.name, requester: "RH_Local_Renders", tasks: [built.task],
    // Per-model metadata points at the raw branch, but the job root has to stay the batch
    // folder: it is where the delivery and the manifest are written.
    _rhLocal: { generatedAt: new Date().toISOString(), ...built.metadata, outputFolder: `${path.resolve(outputFolder)}${path.sep}` }
  };
}

function buildBatchJob(entries, rig, outputFolder, jobId) {
  if (!entries?.length) throw new Error("Add at least one model to the batch");
  const models = entries.map(({ input, model }) => taskFor(input, model, rig, outputFolder));
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

module.exports = { CAMERA_YAW, withResolutionOverrides, SOFA_CAMERA_YAW, PRODUCT_TYPES, productType, RESOLUTIONS, RESOLUTION_PROFILES, renderProfile, cropMode, buildJob, buildBatchJob, writeJob, writeBatchJob, groupedMaterials, fabricFileNameFormat };
