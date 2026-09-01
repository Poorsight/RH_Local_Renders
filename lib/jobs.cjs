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
    key: "sectionals",
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
    key: "sofas",
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
const materialNames = row => (Array.isArray(row?.materials) ? row.materials : [row?.material])
  .map(value => String(value || "").trim()).filter(Boolean);

// BatchRender expands separate FMaterialSet lists as a Cartesian product. When two component
// groups carry the same ordered multi-variant list, they are one product choice, not two
// independent choices: merge their meshes so variant 1 is applied to both, then variant 2,
// and so on. Identical fixed one-item groups must be merged too: otherwise BatchRender
// can apply the material but leave one of the filename tokens unresolved. A fixed group
// with a different material (wooden feet, for example) still stays separate.
const synchronizeMaterialGroups = materials => {
  const result = [], synchronized = new Map();
  let linkedSignature = null, linkedMeshes = [];
  for (const source of materials || []) {
    const group = {
      ...source,
      meshes: [...new Set((source.meshes || []).map(mesh => String(mesh).toLowerCase()))],
      list: (source.list || []).map(item => ({ ...item }))
    };
    const multiply = source._rhLocalMultiply === true;
    if (!group.list.length || multiply) { result.push(group); continue; }
    const signature = JSON.stringify(group.list.map(item => [
      String(item?.name || "").toLowerCase(), Boolean(item?.ApplyExposure), String(item?.postProccessName || "")
    ]));
    // New jobs explicitly record false for linked groups. Different linked lists cannot be
    // expressed by the current BatchRender schema without a Cartesian product, so refuse the
    // ambiguity instead of silently rendering hundreds of unwanted combinations. Legacy jobs
    // have no flag and keep their historical behaviour unless their lists are identical.
    if (group.list.length > 1 && source._rhLocalMultiply === false) {
      if (linkedSignature && linkedSignature !== signature) {
        throw new Error(`Linked material lists differ for ${[...linkedMeshes, ...group.meshes].join(", ")}. Keep the same ordered variants or enable Multiply for an independent ID.`);
      }
      linkedSignature = signature; linkedMeshes = [...new Set([...linkedMeshes, ...group.meshes])];
    }
    const existing = synchronized.get(signature);
    if (!existing) { synchronized.set(signature, group); result.push(group); continue; }
    existing.meshes = [...new Set([...existing.meshes, ...group.meshes])];
  }
  return result;
};

// One FMaterialSet describes one synchronized group of mesh IDs and every material variant
// that may be assigned to all of them. Distinct lists still remain independent.
const groupedMaterials = rows => {
  const groups = new Map();
  for (const row of rows || []) {
    const meshes = [...new Set((row.meshes || []).map(mesh => String(mesh).toLowerCase()))];
    if (!meshes.length) continue;
    const names = materialNames(row);
    if (!names.length) throw new Error(`Material is empty for ${meshes.join(", ")}`);
    const key = [...meshes].sort().join("\u0000");
    if (!groups.has(key)) groups.set(key, { meshes, names: [], multiply: false });
    const group = groups.get(key);
    group.multiply ||= row.multiply === true || row._rhLocalMultiply === true;
    for (const name of names) if (!group.names.some(saved => saved.toLowerCase() === name.toLowerCase())) group.names.push(name);
  }
  if (!groups.size) throw new Error("At least one material assignment is required");
  return synchronizeMaterialGroups([...groups.values()].map(group => ({
    meshes: group.meshes,
    _rhLocalMultiply: group.multiply,
    list: group.names.map(name => ({ name, ApplyExposure: false, postProccessName: "RH_POST_PROCESS" }))
  })));
};

const materialCombinationCount = materials => synchronizeMaterialGroups(materials)
  .reduce((product, group) => product * Math.max(group.list?.length || 0, 1), 1);

const fabricFileNameFormat = materials => {
  const upholsteryMesh = (materials || []).flatMap(group => group.meshes || []).find(mesh => /(?:^|[_:])uph\d*$/i.test(mesh));
  if (!upholsteryMesh) throw new Error("Fabric output requires an UPH component ID");
  const materialTokens = (materials || []).map(group => {
    const mesh = (group.meshes || []).find(value => /(?:^|[_:])uph\d*$/i.test(value)) || group.meshes?.[0];
    return mesh ? `{material:${String(mesh).toLowerCase()}}` : null;
  }).filter(Boolean);
  return `00000000_{camera}_Product_${materialTokens.join("_")}`;
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
      camera._rhLocalCrop = { status: profile ? "ready" : "pending", fingerprint: input.modelFingerprint || null, camera: name, contextToken: input.cropContextTokens?.[name] || null };
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
  const materialOutput = `${path.join(output, "materials")}${path.sep}`;
  const shadowOutput = `${path.join(output, "shadows")}${path.sep}`;
  const prefitOutput = branchFolder(outputFolder, "calibration", safeSegment(model.name));
  const validIds = new Set((model.materialIds || []).map(id => String(id).toLowerCase()));
  const materialRows = validIds.size ? (input.materials || []).map(row => ({ ...row, meshes: (row.meshes || []).filter(mesh => validIds.has(String(mesh).toLowerCase())) })).filter(row => row.meshes.length) : (input.materials || []);
  const materials = groupedMaterials(materialRows);
  const layerBlocks = runtimeLayers.map(name => name === "Fabric" ? {
    name, config: "4_k_PathTrace_PNG", SubLevels: [`${sublevelPrefix(scene)}_Background`, `${sublevelPrefix(scene)}_KeyLight`],
    output: { folder: cameraPrefit ? prefitOutput : materialOutput, fileNameFormat: cameraPrefit ? "camera_prefit_{camera}" : fabricFileNameFormat(materials), overWrite: true }, doNotRender: false,
    ...(cameraPrefit ? { _rhLocalPrefit: true } : {})
  } : {
    name, config: "4_k_Lumen_PNG_Background_Shadows", SubLevels: [`${sublevelPrefix(scene)}_Shadow`, `${sublevelPrefix(scene)}_KeyLight`],
    output: { folder: shadowOutput, fileNameFormat: "00000000_{camera}_{layer}", overWrite: true }, doNotRender: false, postProcesses: ["PostProcess_shadow"]
  });
  return {
    task: { taskId: model.name, model: { objPath: model.path, offsetUniformScale: model.offsetUniformScale }, sequence: { cameras: cameraBlocks }, materials, layers: layerBlocks },
    metadata: { name: model.name, modelPath: model.path, productType: type.key, renderEnvironment: input.renderEnvironment || "ue56", baseFrame: resolutions, dimensions, side, importYaw, renderProfile: profileName, cropMode: cropModeName, cropProfiles: cameraBlocks.filter(camera => camera._rhLocalCrop?.status === "ready").length, cropCalibration: cameraBlocks.filter(camera => camera._rhLocalCrop?.status === "pending").length, cameraPrefit, outputFolder: output }
  };
}

function buildJob(input, model, rig, outputFolder) {
  const built = taskFor(input, model, rig, outputFolder);
  return {
    jobId: model.name, requester: "RH_Local_Renders", tasks: [built.task],
    // Per-model metadata points at the raw branch, but the job root has to stay the batch
    // folder: it is where the delivery and the manifest are written.
    _rhLocal: { generatedAt: new Date().toISOString(), ...built.metadata, renderEnvironment: built.metadata.renderEnvironment, outputFolder: `${path.resolve(outputFolder)}${path.sep}` }
  };
}

function buildBatchJob(entries, rig, outputFolder, jobId) {
  if (!entries?.length) throw new Error("Add at least one model to the batch");
  const models = entries.map(({ input, model }) => taskFor(input, model, rig, outputFolder));
  return {
    jobId, requester: "RH_Local_Renders", tasks: models.map(item => item.task),
    _rhLocal: { generatedAt: new Date().toISOString(), renderEnvironment: models[0]?.metadata?.renderEnvironment || "ue56", outputFolder: `${path.resolve(outputFolder)}${path.sep}`, models: models.map(item => item.metadata) }
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

module.exports = { CAMERA_YAW, withResolutionOverrides, SOFA_CAMERA_YAW, PRODUCT_TYPES, productType, RESOLUTIONS, RESOLUTION_PROFILES, renderProfile, cropMode, buildJob, buildBatchJob, writeJob, writeBatchJob, groupedMaterials, synchronizeMaterialGroups, materialCombinationCount, fabricFileNameFormat };
