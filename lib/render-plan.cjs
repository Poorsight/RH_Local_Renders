"use strict";

const path = require("node:path");
const { RESOLUTION_PROFILES } = require("./jobs.cjs");
const { siblingBranch } = require("./output-layout.cjs");

const PHASE_ORDER = ["Fabric", "Shadow"];

const clone = value => JSON.parse(JSON.stringify(value));
const cameraStateKey = (taskId, sequenceName) => `${String(taskId || "").toLowerCase()}::${String(sequenceName || "").toLowerCase()}`;

function activeLayerNames(job) {
  const names = new Set();
  for (const task of job.tasks || []) for (const layer of task.layers || []) {
    if (!layer.doNotRender) names.add(String(layer.name || ""));
  }
  return PHASE_ORDER.filter(expected => [...names].some(name => name.toLowerCase() === expected.toLowerCase()));
}

function phaseJob(job, layerName, index, count) {
  const result = clone(job), expected = layerName.toLowerCase();
  result.jobId = `${job.jobId}__${expected}`;
  result.tasks = (result.tasks || []).map(task => ({
    ...task,
    sequence: {
      ...(task.sequence || {}),
      cameras: (task.sequence?.cameras || []).map(camera => {
        const { _rhLocalShadowLights, ...runtimeCamera } = camera;
        return {
          ...runtimeCamera,
          lights: expected === "shadow" && Array.isArray(_rhLocalShadowLights) ? clone(_rhLocalShadowLights) : runtimeCamera.lights,
          LayerResolutions: (camera.LayerResolutions || []).filter(layer => String(layer.Name || "").toLowerCase() === expected)
        };
      })
    },
    layers: (task.layers || []).filter(layer => !layer.doNotRender && String(layer.name || "").toLowerCase() === expected)
  })).filter(task => task.layers.length);
  result._rhLocal = { ...(result._rhLocal || {}), parentJobId: job.jobId, renderPhase: layerName, phaseIndex: index + 1, phaseCount: count };
  return result;
}

function buildRenderPlan(job) {
  const names = activeLayerNames(job);
  if (!names.length) throw new Error("The job has no supported Fabric or Shadow render layers");
  const finalPhases = names.map((name, index) => ({
    name,
    layerName: name,
    substrate: name !== "Shadow",
    useCameraHandoff: name === "Shadow" && names.includes("Fabric"),
    job: phaseJob(job, name, index, names.length)
  }));
  const pending = (job.tasks || []).some(task => (task.sequence?.cameras || []).some(camera => camera._rhLocalCrop?.status === "pending"));
  if (!pending) return finalPhases;
  finalPhases.forEach(phase => { phase.useCameraHandoff = true; });
  const calibration = ["Fabric", "Shadow"].map((layerName, index) => ({
    name: `Crop calibration · ${layerName}`,
    layerName,
    isCalibration: true,
    substrate: layerName === "Fabric",
    useCameraHandoff: layerName === "Shadow",
    job: calibrationJob(job, layerName, index, 2 + finalPhases.length)
  }));
  return [...calibration, ...finalPhases].map((phase, index, phases) => {
    phase.job._rhLocal = { ...(phase.job._rhLocal || {}), phaseIndex: index + 1, phaseCount: phases.length };
    return phase;
  });
}

function calibrationLayer(layerName, outputFolder) {
  if (layerName === "Fabric") return {
    name: "Fabric", config: "4_k_PathTrace_PNG", SubLevels: ["Sectional_Indoor_Background", "Sectional_Indoor_KeyLight"],
    output: { folder: outputFolder, fileNameFormat: "crop_fabric_{camera}", overWrite: true }, doNotRender: false, _rhLocalCropCalibration: true
  };
  return {
    name: "Shadow", config: "4_k_Lumen_PNG_Background_Shadows", SubLevels: ["Sectional_Indoor_Shadow", "Sectional_Indoor_KeyLight"],
    output: { folder: outputFolder, fileNameFormat: "crop_shadow_{camera}", overWrite: true }, doNotRender: false, postProcesses: ["PostProcess_shadow"], _rhLocalCropCalibration: true
  };
}

function calibrationJob(job, layerName, index, count) {
  const result = clone(job), expected = layerName.toLowerCase();
  result.jobId = `${job.jobId}__crop_${expected}`;
  result.tasks = (result.tasks || []).map(task => {
    const pendingCameras = (task.sequence?.cameras || []).filter(camera => camera._rhLocalCrop?.status === "pending").map(camera => {
      const { _rhLocalShadowLights, ...runtimeCamera } = camera;
      return {
        ...runtimeCamera,
        fit: layerName === "Fabric" ? "horizontalFocalLength" : runtimeCamera.fit,
        lights: layerName === "Shadow" && Array.isArray(_rhLocalShadowLights) ? clone(_rhLocalShadowLights) : runtimeCamera.lights,
        LayerResolutions: [clone(RESOLUTION_PROFILES.low[layerName])]
      };
    });
    if (!pendingCameras.length) return null;
    const baseOutput = path.resolve(String((task.layers || []).find(layer => layer.output?.folder)?.output?.folder || ""));
    const outputFolder = siblingBranch(baseOutput, "calibration");
    return { ...task, sequence: { ...(task.sequence || {}), cameras: pendingCameras }, layers: [calibrationLayer(layerName, outputFolder)] };
  }).filter(Boolean);
  result._rhLocal = { ...(result._rhLocal || {}), parentJobId: job.jobId, renderPhase: `Crop calibration · ${layerName}`, cropCalibration: true, phaseIndex: index + 1, phaseCount: count };
  return result;
}

function applyCameraHandoff(job, cameraStates) {
  const result = clone(job), missing = [], applied = [];
  for (const task of result.tasks || []) for (const camera of task.sequence?.cameras || []) {
    const key = cameraStateKey(task.taskId, camera.sequenceName || camera.name), state = cameraStates?.get?.(key);
    if (!state) { missing.push(`${task.taskId}/${camera.name || camera.sequenceName}`); continue; }
    camera.fit = "none";
    camera.Camera = {
      ...(camera.Camera || {}),
      OverrideLocation: true, Location: clone(state.cameraLocation),
      OverrideRotation: true, Rotation: clone(state.cameraRotation),
      OverrideFocalLength: true, FocalLength: state.focalLength
    };
    applied.push(key);
  }
  result._rhLocal = { ...(result._rhLocal || {}), cameraHandoff: { source: "Fabric", applied: applied.length } };
  return { job: result, missing, applied };
}

module.exports = { PHASE_ORDER, activeLayerNames, phaseJob, buildRenderPlan, calibrationJob, cameraStateKey, applyCameraHandoff };
