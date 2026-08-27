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
  // A probe measures the crop at 500px; its camera is not the camera the final frame should
  // use. Handing the probe's focal length to a 5000px frame reframed a sofa enough to cut its
  // arms off -- proven by rendering the identical frame without the handoff, which came out
  // with the 7px margins the padding asks for. The final Fabric phase fits its own frame and
  // reports that state, and Shadow takes it from there, so the two passes still agree.
  finalPhases.forEach(phase => { if (phase.layerName === "Shadow") phase.useCameraHandoff = true; });
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

// A calibration frame has to be shot in the same scene as the render it is measuring for, so
// the sublevels come from the task's own layer rather than from a name written here. A sofa
// calibrated against a sectional's scene would be measured under the wrong lights entirely.
// The probe measures a silhouette against a frame, and the ratio it derives is applied to
// the job's frame -- so the two have to be the same shape. It used to be the stock 500px
// square whatever the job asked for: harmless while a base frame is square, but on a base
// like 5000x2000 the probe would measure the sofa against a square field and hand back a
// ratio that belongs to no frame anyone asked for.
//
// The sensor is the field of view, so it is carried over untouched; only the pixel count is
// scaled down to probe size.
function probeFrame(layerName, camera) {
  const stock = clone(RESOLUTION_PROFILES.low[layerName]);
  const declared = (camera?.LayerResolutions || [])
    .find(frame => String(frame?.Name || "").toLowerCase() === String(layerName).toLowerCase());
  const asked = declared?.Resolution, sensor = declared?.SensorSize;
  if (!(asked?.X > 0) || !(asked?.Y > 0)) return stock;
  const height = Math.max(2, Math.round((asked.Y * stock.Resolution.X) / asked.X / 2) * 2);
  return {
    ...stock,
    Resolution: { X: stock.Resolution.X, Y: height },
    SensorSize: sensor?.X > 0 && sensor?.Y > 0 ? { X: sensor.X, Y: sensor.Y } : stock.SensorSize
  };
}

function calibrationLayer(layerName, outputFolder, sourceLayer, task) {
  // A crop is measured from both layers even when only one was asked for, so the Shadow probe
  // of a Fabric-only job has no layer of its own to copy. Taking the scene from whatever layer
  // the task does have keeps the probe in the product's own scene; a hardcoded fallback sent a
  // sofa to be measured under a sectional's lights.
  const sublevels = sourceLayer?.SubLevels?.length ? [...sourceLayer.SubLevels] : (() => {
    const known = (task?.layers || []).map(layer => layer.SubLevels).find(levels => levels?.length);
    const prefix = String(known?.[0] || "Sectional_Indoor_Background").replace(/_(Background|Shadow|KeyLight)$/, "");
    return layerName === "Fabric" ? [`${prefix}_Background`, `${prefix}_KeyLight`] : [`${prefix}_Shadow`, `${prefix}_KeyLight`];
  })();
  if (layerName === "Fabric") return {
    name: "Fabric", config: "4_k_PathTrace_PNG", SubLevels: sublevels,
    output: { folder: outputFolder, fileNameFormat: "crop_fabric_{camera}", overWrite: true }, doNotRender: false, _rhLocalCropCalibration: true
  };
  return {
    name: "Shadow", config: "4_k_Lumen_PNG_Background_Shadows", SubLevels: sublevels,
    output: { folder: outputFolder, fileNameFormat: "crop_shadow_{camera}", overWrite: true }, doNotRender: false, postProcesses: sourceLayer?.postProcesses ? [...sourceLayer.postProcesses] : ["PostProcess_shadow"], _rhLocalCropCalibration: true
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
        LayerResolutions: [probeFrame(layerName, camera)]
      };
    });
    if (!pendingCameras.length) return null;
    const baseOutput = path.resolve(String((task.layers || []).find(layer => layer.output?.folder)?.output?.folder || ""));
    const outputFolder = siblingBranch(baseOutput, "calibration");
    return { ...task, sequence: { ...(task.sequence || {}), cameras: pendingCameras }, layers: [calibrationLayer(layerName, outputFolder, (task.layers || []).find(layer => layer.name === layerName), task)] };
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
