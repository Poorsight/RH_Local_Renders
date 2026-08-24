"use strict";

const PHASE_ORDER = ["Fabric", "Shadow"];

const clone = value => JSON.parse(JSON.stringify(value));

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
      cameras: (task.sequence?.cameras || []).map(camera => ({
        ...camera,
        LayerResolutions: (camera.LayerResolutions || []).filter(layer => String(layer.Name || "").toLowerCase() === expected)
      }))
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

module.exports = { PHASE_ORDER, activeLayerNames, phaseJob, buildRenderPlan };
