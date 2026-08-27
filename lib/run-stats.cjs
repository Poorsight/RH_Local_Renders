"use strict";

const fs = require("fs");
const path = require("path");

/*
  How long jobs actually take, kept across restarts so the page can answer two questions:
  how long did this one take, and how long will one that has never run take.

  Timing is kept per phase rather than per job, because a Fabric frame and a Shadow frame
  are not the same work: they run in separate Unreal processes, one with Substrate and one
  without, at different resolutions. Averaging them together would give an estimate that is
  wrong for every job whose mix differs from the average job.

  Calibration phases are recorded but kept out of the per-frame averages -- they render one
  500px probe per model and camera, so folding them in would flatter the final frames.
*/

const MAX_RUNS = 200;
const statsFile = root => path.join(root, "local", "cache", "run-stats.json");

function readRuns(root) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statsFile(root), "utf8"));
    return Array.isArray(parsed.runs) ? parsed.runs : [];
  } catch { return []; }
}

// What a job will render once, per layer: every camera of every model, ignoring the
// prefit layers that exist only to hand a camera over.
function frameCounts(job) {
  const counts = {};
  for (const task of job?.tasks || []) {
    const cameras = (task.sequence?.cameras || []).length;
    for (const layer of task.layers || []) {
      if (layer._rhLocalPrefit) continue;
      counts[layer.name] = (counts[layer.name] || 0) + cameras;
    }
  }
  return counts;
}

const seconds = (from, to) => {
  const value = (Date.parse(to) - Date.parse(from)) / 1000;
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
};

function recordRun(root, { jobId, jobPath, job, startedAt, finishedAt, state, phases }) {
  const total = seconds(startedAt, finishedAt);
  if (!jobId || total === null) return null;
  const entry = {
    jobId, jobPath, startedAt, finishedAt, state, seconds: total,
    frames: frameCounts(job),
    phases: (phases || [])
      .filter(phase => phase.startedAt && phase.finishedAt)
      .map(phase => ({ name: phase.name, layer: phase.layerName || null, calibration: Boolean(phase.isCalibration),
                       frames: Number(phase.frames) || 0, seconds: seconds(phase.startedAt, phase.finishedAt) }))
      .filter(phase => phase.seconds !== null)
  };
  const runs = readRuns(root).filter(run => run.jobId !== jobId).concat(entry).slice(-MAX_RUNS);
  fs.mkdirSync(path.dirname(statsFile(root)), { recursive: true });
  fs.writeFileSync(statsFile(root), `${JSON.stringify({ runs }, null, 2)}\n`, "utf8");
  return entry;
}

// Seconds a single frame of each layer costs, over every run that produced frames of it.
// Weighted by frames, so a long run counts for more than a one-model test.
function summarise(runs) {
  const totals = new Map();
  for (const run of runs || []) {
    for (const phase of run.phases || []) {
      if (phase.calibration || !phase.layer || !phase.frames) continue;
      const carry = totals.get(phase.layer) || { seconds: 0, frames: 0, runs: 0 };
      carry.seconds += phase.seconds; carry.frames += phase.frames; carry.runs += 1;
      totals.set(phase.layer, carry);
    }
  }
  const perFrame = {};
  for (const [layer, carry] of totals) {
    perFrame[layer] = { seconds: Math.round((carry.seconds / carry.frames) * 10) / 10, frames: carry.frames, runs: carry.runs };
  }
  return { perFrame, runs: (runs || []).length };
}

// What a job that has not run yet should cost. Returns null rather than a guess when no
// layer it renders has ever been measured.
function estimateFor(job, summary) {
  const counts = frameCounts(job);
  let total = 0, measured = 0, missing = [];
  for (const [layer, frames] of Object.entries(counts)) {
    const rate = summary?.perFrame?.[layer];
    if (!rate) { missing.push(layer); continue; }
    total += rate.seconds * frames; measured += frames;
  }
  if (!measured) return null;
  return { seconds: Math.round(total), frames: counts, measuredFrames: measured, unmeasuredLayers: missing };
}

module.exports = { readRuns, recordRun, summarise, estimateFor, frameCounts, statsFile, MAX_RUNS };
