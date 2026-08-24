"use strict";

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
  return names.map((name, index) => ({
    name,
    substrate: name !== "Shadow",
    job: phaseJob(job, name, index, names.length)
  }));
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

module.exports = { PHASE_ORDER, activeLayerNames, phaseJob, buildRenderPlan, cameraStateKey, applyCameraHandoff };
