"use strict";

const path = require("node:path");
const { RESOLUTION_PROFILES, synchronizeMaterialGroups, fabricFileNameFormat } = require("./jobs.cjs");
const { siblingLayerBranch } = require("./output-layout.cjs");

const PHASE_ORDER = ["Fabric", "Shadow"];

const clone = value => JSON.parse(JSON.stringify(value));
const cameraStateKey = (taskId, sequenceName) => `${String(taskId || "").toLowerCase()}::${String(sequenceName || "").toLowerCase()}`;
const representativeMaterials = materials => synchronizeMaterialGroups(materials).map(group => ({ ...group, list: (group.list || []).slice(0, 1) }));

function activeLayerNames(job) {
  const names = new Set();
  for (const task of job.tasks || []) for (const layer of task.layers || []) {
    if (!layer.doNotRender) names.add(String(layer.name || ""));
  }
  return PHASE_ORDER.filter(expected => [...names].some(name => name.toLowerCase() === expected.toLowerCase()));
}

function phaseJob(job, layerName) {
  const result = clone(job), expected = layerName.toLowerCase();
  result.jobId = `${job.jobId}__${expected}`;
  result.tasks = (result.tasks || []).map(task => {
    const layers = (task.layers || []).filter(layer => !layer.doNotRender && String(layer.name || "").toLowerCase() === expected);
    const prefit = layers.length > 0 && layers.every(layer => layer._rhLocalPrefit);
    const materials = prefit ? representativeMaterials(task.materials) : synchronizeMaterialGroups(task.materials);
    const runtimeLayers = layers.map(layer => expected === "fabric" && !layer._rhLocalPrefit
      ? { ...layer, output: { ...(layer.output || {}), fileNameFormat: fabricFileNameFormat(materials) } }
      : layer);
    return {
    ...task, materials,
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
    layers: runtimeLayers
  }; }).filter(task => task.layers.length);
  result._rhLocal = { ...(result._rhLocal || {}), parentJobId: job.jobId, renderPhase: layerName };
  return result;
}

// A camera handed to a phase is applied by the renderer per sequence, not per task, so a phase
// that inherits one renders a single model at a time. Otherwise one model's framing frames them
// all -- invisible while a product line is uniform, since every sectional here fits to between
// 160 and 164mm, and ruinous the moment it is not: seven sofas spanning 100 to 182mm each came
// out showing own_focal / 182.5 of their width, arms cut off. The rule holds for every product,
// because the next line of sectionals may vary as widely.
function splitInheritingPhase(phase) {
  const tasks = phase.job?.tasks || [];
  if (!phase.useCameraHandoff || tasks.length < 2) return [phase];
  return tasks.map(task => ({ ...phase, job: { ...phase.job, tasks: [task] } }));
}

function numberPhases(phases) {
  return phases.map((phase, index) => {
    phase.job._rhLocal = { ...(phase.job._rhLocal || {}), phaseIndex: index + 1, phaseCount: phases.length };
    return phase;
  });
}

function buildRenderPlan(job) {
  const names = activeLayerNames(job);
  if (!names.length) throw new Error("The job has no supported Fabric or Shadow render layers");
  const pending = (job.tasks || []).some(task => (task.sequence?.cameras || []).some(camera => camera._rhLocalCrop?.status === "pending"));
  const phases = [];
  if (pending) {
    for (const layerName of PHASE_ORDER) {
      phases.push({
        name: `Crop calibration · ${layerName}`, layerName, isCalibration: true,
        substrate: true,
        // Nothing can fit a camera to a shadow, so the shadow probe inherits the fabric
        // probe's camera -- and therefore renders one model at a time, like any inheriting phase.
        useCameraHandoff: layerName === "Shadow",
        job: calibrationJob(job, layerName)
      });
    }
  }
  for (const name of names) {
    phases.push({
      name, layerName: name, substrate: true,
      // A probe measures the crop at 500px; its camera is not the camera the final frame should
      // use, so the final Fabric fits its own frame and reports that state. Shadow inherits from
      // that final Fabric rather than from the probe.
      useCameraHandoff: name === "Shadow" && (pending || names.includes("Fabric")),
      job: phaseJob(job, name)
    });
  }
  const plan = numberPhases(phases.flatMap(splitInheritingPhase));
  // Splitting the shadow probe means there are now several of them, and the crop is measured
  // from the union of both layers -- so it can only be worked out once the last model's pair
  // exists. The plan marks that phase rather than making the runner count phases itself.
  const lastProbe = plan.reduce((last, phase, index) =>
    phase.isCalibration && phase.layerName === "Shadow" ? index : last, -1);
  if (lastProbe >= 0) plan[lastProbe].finalizesCrop = true;
  return plan;
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
    // BatchRender applies a material only when its filename format asks for that material.
    // Without the placeholders the event reported material:"" and the probe kept the model's
    // imported/default surface instead of the first selected variant.
    output: { folder: outputFolder, fileNameFormat: fabricFileNameFormat(representativeMaterials(task.materials)).replace(/^00000000_/, "crop_fabric_"), overWrite: true }, doNotRender: false, _rhLocalCropCalibration: true
  };
  return {
    name: "Shadow", config: "4_k_Lumen_PNG_Background_Shadows", SubLevels: sublevels,
    output: { folder: outputFolder, fileNameFormat: "crop_shadow_{camera}", overWrite: true }, doNotRender: false, postProcesses: sourceLayer?.postProcesses ? [...sourceLayer.postProcesses] : ["PostProcess_shadow"], _rhLocalCropCalibration: true
  };
}

function calibrationJob(job, layerName) {
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
    const outputFolder = siblingLayerBranch(baseOutput, "calibration", layerName);
    return { ...task, materials: representativeMaterials(task.materials), sequence: { ...(task.sequence || {}), cameras: pendingCameras }, layers: [calibrationLayer(layerName, outputFolder, (task.layers || []).find(layer => layer.name === layerName), task)] };
  }).filter(Boolean);
  result._rhLocal = { ...(result._rhLocal || {}), parentJobId: job.jobId, renderPhase: `Crop calibration · ${layerName}`, cropCalibration: true };
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
