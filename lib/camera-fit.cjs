"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { modelFingerprint } = require("./crop.cjs");
const { cameraStateKey } = require("./render-plan.cjs");

const CACHE_VERSION = 1;
const FIT_ALGORITHM_VERSION = "rh-horizontal-focal-limiting-axis-v1";
const CACHE_FILE = path.join("local", "cache", "camera-fit-profiles.json");

const cachePath = root => process.env.RH_CAMERA_FIT_CACHE_FILE
  ? path.resolve(process.env.RH_CAMERA_FIT_CACHE_FILE)
  : path.join(root, CACHE_FILE);

const stable = value => {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
};

const digest = value => crypto.createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(stable(value))).digest("hex");

function fileToken(file) {
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return "missing";
  return digest(fs.readFileSync(file)).slice(0, 16);
}

function rendererToken(projectPath) {
  if (process.env.RH_CAMERA_FIT_RENDERER_TOKEN) return String(process.env.RH_CAMERA_FIT_RENDERER_TOKEN);
  const project = path.resolve(String(projectPath || "")), projectRoot = path.dirname(project);
  const plugin = path.join(projectRoot, "Plugins", "BatchRender", "Binaries", "Win64", "UnrealEditor-BatchRender.dll");
  return digest({ algorithm: FIT_ALGORITHM_VERSION, project: fileToken(project), plugin: fileToken(plugin) }).slice(0, 16);
}

function sequenceToken(projectPath, sequenceName) {
  const projectRoot = path.dirname(path.resolve(String(projectPath || ""))), name = String(sequenceName || "");
  const candidates = [
    path.join(projectRoot, "Content", "Sequences", "Selectional_Indoor", `${name}.uasset`),
    path.join(projectRoot, "Content", "Sequences", "Sectional_Indoor", `${name}.uasset`)
  ];
  const file = candidates.find(candidate => fs.existsSync(candidate));
  return file ? fileToken(file) : `name:${name.toLowerCase()}`;
}

function fitDescriptor(task, camera, options = {}) {
  const modelPath = path.resolve(String(task?.model?.objPath || ""));
  if (!fs.existsSync(modelPath)) return null;
  const sequenceName = camera?.sequenceName || camera?.name || "";
  const inputs = {
    algorithm: FIT_ALGORITHM_VERSION,
    renderer: options.rendererToken || rendererToken(options.projectPath),
    sequence: String(sequenceName).toLowerCase(),
    sequenceAsset: sequenceToken(options.projectPath, sequenceName),
    modelFingerprint: modelFingerprint(modelPath),
    modelActor: camera?.Actor || null,
    padding: camera?.padding || null,
    correctPerspective: Boolean(camera?.correctPerspective),
    offsetUniformScale: Number(task?.model?.offsetUniformScale) || 1
  };
  return { signature: digest(inputs).slice(0, 24), inputs, modelPath, sequenceName };
}

function readCameraFitProfiles(root) {
  const file = cachePath(root);
  if (!fs.existsSync(file)) return { version: CACHE_VERSION, profiles: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed.version === CACHE_VERSION && parsed.profiles && typeof parsed.profiles === "object"
      ? parsed
      : { version: CACHE_VERSION, profiles: {} };
  } catch { return { version: CACHE_VERSION, profiles: {} }; }
}

function writeStore(root, store) {
  const file = cachePath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  return file;
}

function findCamera(job, taskId, sequenceName) {
  const task = (job?.tasks || []).find(item => String(item.taskId || "").toLowerCase() === String(taskId || "").toLowerCase());
  if (!task) return null;
  const camera = (task.sequence?.cameras || []).find(item => String(item.sequenceName || item.name || "").toLowerCase() === String(sequenceName || "").toLowerCase());
  return camera ? { task, camera } : null;
}

function cameraFitStatesForJob(root, job, options = {}) {
  const store = readCameraFitProfiles(root), states = new Map(), signatures = new Map();
  let total = 0;
  for (const task of job?.tasks || []) for (const camera of task.sequence?.cameras || []) {
    total += 1;
    const descriptor = fitDescriptor(task, camera, options);
    if (!descriptor) continue;
    const key = cameraStateKey(task.taskId, camera.sequenceName || camera.name), profile = store.profiles[descriptor.signature];
    signatures.set(key, descriptor.signature);
    if (profile?.state) states.set(key, profile.state);
  }
  return { states, signatures, hits: states.size, total, file: cachePath(root) };
}

function writeCameraFitState(root, job, taskId, sequenceName, state, options = {}) {
  const found = findCamera(job, taskId, sequenceName);
  if (!found) return null;
  const descriptor = fitDescriptor(found.task, found.camera, options);
  if (!descriptor) return null;
  const store = readCameraFitProfiles(root);
  store.profiles[descriptor.signature] = {
    version: CACHE_VERSION,
    signature: descriptor.signature,
    savedAt: new Date().toISOString(),
    modelName: found.task.taskId,
    modelPath: descriptor.modelPath,
    camera: found.camera.name || sequenceName,
    sequenceName: descriptor.sequenceName,
    inputs: descriptor.inputs,
    state
  };
  writeStore(root, store);
  return store.profiles[descriptor.signature];
}

function writeCameraFitStates(root, job, cameraStates, options = {}) {
  const entries = cameraStates instanceof Map ? cameraStates : new Map(Object.entries(cameraStates || {}));
  const saved = [];
  for (const task of job?.tasks || []) for (const camera of task.sequence?.cameras || []) {
    const sequenceName = camera.sequenceName || camera.name, state = entries.get(cameraStateKey(task.taskId, sequenceName));
    if (!state) continue;
    const profile = writeCameraFitState(root, job, task.taskId, sequenceName, state, options);
    if (profile) saved.push(profile);
  }
  return saved;
}

module.exports = {
  CACHE_VERSION, CACHE_FILE, FIT_ALGORITHM_VERSION,
  rendererToken, sequenceToken, fitDescriptor, readCameraFitProfiles,
  cameraFitStatesForJob, writeCameraFitState, writeCameraFitStates
};
