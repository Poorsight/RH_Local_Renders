"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { Worker } = require("node:worker_threads");
const { SheetStore, jobLights } = require("./lib/rig.cjs");
const { ModelStore } = require("./lib/models.cjs");
const { productType, writeBatchJob, groupedMaterials, materialCombinationCount } = require("./lib/jobs.cjs");
const { buildRenderPlan, cameraStateKey, applyCameraHandoff } = require("./lib/render-plan.cjs");
const { siblingBranch, isInBranch } = require("./lib/output-layout.cjs");
const { publishPreviews, previewFileFor } = require("./lib/preview.cjs");
const { checkModel, summarise } = require("./lib/model-check.cjs");
const { inspectObjParts, normalizeObjParts, writeMaterialLibrary } = require("./lib/obj-parts.cjs");
const { modelFingerprint, readCropProfiles, writeCropProfiles, cropProfileFor, cropContextResolutions, forgetCropProfiles, analyzeCalibrationPair, applyCropProfileToCamera, calibrationFiles } = require("./lib/crop.cjs");
const { rendererToken, readCameraFitProfiles, cameraFitStatesForJob, writeCameraFitState } = require("./lib/camera-fit.cjs");
const { buildUnrealLaunch } = require("./lib/unreal.cjs");
const { DEFAULT_ENVIRONMENT, renderEnvironments, resolveRenderEnvironment, environmentForJob, publicRenderEnvironment } = require("./lib/render-environments.cjs");
const { history, expectedRenders } = require("./lib/history.cjs");
const runStats = require("./lib/run-stats.cjs");
const checkCache = require("./lib/check-cache.cjs");
const { availability: postProcessAvailability, isProcessedImage, loadConfig: loadPostProcessConfig, originalFilesForJob, processJob, processedPathFor } = require("./lib/post-process.cjs");

const ROOT = __dirname;
const HOST = "127.0.0.1";
const PORT = Number(process.env.RH_LOCAL_RENDERS_PORT || 5500);
const RENDER_ENVIRONMENTS = renderEnvironments();
const renderEnvironment = value => resolveRenderEnvironment(value, RENDER_ENVIRONMENTS);
const cameraFitRendererToken = environment => rendererToken(environment.project);
const sheet = new SheetStore(ROOT), models = new ModelStore(ROOT);
const RUNTIME_FILES = [
  "server.cjs", "package.json", "data/postprocess.json", "data/sofa-shadow-lut.json", "assets/AdobeRGB1998.icc", "lib/camera-fit.cjs", "lib/crop.cjs", "lib/csv.cjs", "lib/history.cjs", "lib/jobs.cjs", "lib/models.cjs", "lib/post-process.cjs", "lib/render-plan.cjs", "lib/shadow-alpha-worker.cjs",
  "lib/render-environments.cjs", "lib/rig.cjs", "lib/unreal.cjs", "scripts/calibrate-shadow-lut.cjs", "scripts/inspect_fbx.py", "scripts/reprocess-shadow-from-source.cjs"
];
const runtimeSourceToken = () => {
  const hash = crypto.createHash("sha256");
  for (const relative of RUNTIME_FILES) {
    const file = path.join(ROOT, relative);
    hash.update(relative);
    hash.update(fs.existsSync(file) ? fs.readFileSync(file) : "missing");
  }
  return hash.digest("hex").slice(0, 16);
};
const RUNTIME_STARTED_AT = new Date().toISOString();
const RUNTIME_SOURCE_TOKEN = runtimeSourceToken();
const CROP_CONTEXT_VERSION = 3, LEGACY_CROP_CONTEXT_VERSION = 2;
const cropContextHash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 20);
const cropContextDimensions = value => ({
  width: Number(value?.width), depth: Number(value?.depth), height: Number(value?.height)
});
const cropContextTokensFor = ({ input, selection, model, side, fingerprint, camera, rig, shadowConfig }) => {
  const type = productType(input.productType || model.group), scene = type.scene(side);
  const shared = {
    fingerprint, camera, productType: type.key, side,
    dimensions: cropContextDimensions(selection.dimensions || model.dimensions),
    importYaw: Number(selection.importYaw ?? model.importYaw) || 0,
    renderProfile: input.renderProfile || "high",
    resolutions: cropContextResolutions(input.resolutions),
    renderer: cameraFitRendererToken(renderEnvironment(input.renderEnvironment)),
    shadowAlpha: shadowConfig.shadow?.substrateAlpha || null
  };
  return {
    // Version 3 hashes only the scene/camera lights that can affect this crop. Editing an
    // unrelated sheet row no longer makes every saved model recalibrate.
    current: cropContextHash({ version: CROP_CONTEXT_VERSION, ...shared, scene,
      lights: { Fabric: jobLights(rig, scene, camera), Shadow: jobLights(rig, scene, camera, "Shadow") } }),
    // Version 2 used the whole rig. Keep accepting it so verified existing profiles migrate
    // naturally instead of forcing one blanket recalibration after this improvement.
    legacy: cropContextHash({ version: LEGACY_CROP_CONTEXT_VERSION, fingerprint, camera,
      productType: type.key, side, dimensions: shared.dimensions, importYaw: shared.importYaw,
      renderProfile: shared.renderProfile, resolutions: shared.resolutions, renderer: shared.renderer,
      rig, shadowAlpha: shared.shadowAlpha })
  };
};
const cropProfileForContext = (store, fingerprint, camera, tokens) => {
  const saved = cropProfileFor(store, fingerprint, camera);
  if (!saved || ![tokens.current, tokens.legacy].includes(saved.contextToken)) return null;
  return saved.contextToken === tokens.current ? saved : { ...saved, contextToken: tokens.current };
};
const MAX_PHASE_RESTARTS = 3;
let render = { state: "idle", pid: null, jobPath: null, startedAt: null, finishedAt: null, exitCode: null, log: "" };
let child = null, bridge = null, activeRun = null, lastUnrealContactAt = null;
let postProcessPromise = null;
const unrealMaterialCache = new Map();

const ACCESS_KEY = String(process.env.RH_ACCESS_KEY || "").trim();
const timingEqual = (left, right) => {
  const a = Buffer.from(String(left)), b = Buffer.from(String(right));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
};
const presentedKey = request => {
  const header = String(request.headers?.authorization || "");
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
};
const isLoopback = request => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(String(request.socket?.remoteAddress || ""));
// A tunnel connects to the service over loopback too, so the socket alone proves nothing.
// Cloudflare stamps every request it forwards and a client cannot strip those headers, so
// their absence is what distinguishes somebody sitting at this machine from the internet.
const TUNNEL_HEADERS = ["cf-ray", "cf-connecting-ip", "cf-warp-tag-id", "x-forwarded-for"];
const cameThroughTunnel = request => TUNNEL_HEADERS.some(name => request.headers?.[name]);
const isLocalOperator = request => isLoopback(request) && !cameThroughTunnel(request);
const ALLOWED_ORIGINS = String(process.env.RH_ALLOWED_ORIGINS || "").split(",").map(value => value.trim().replace(/\/+$/, "")).filter(Boolean);
const corsHeaders = origin => {
  if (!origin || !ALLOWED_ORIGINS.length) return {};
  const asked = String(origin).replace(/\/+$/, "");
  if (!ALLOWED_ORIGINS.includes(asked) && !ALLOWED_ORIGINS.includes("*")) return {};
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes("*") ? asked : asked,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "600",
    Vary: "Origin"
  };
};
const json = (response, status, body) => { response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...corsHeaders(response.req?.headers?.origin) }); response.end(JSON.stringify(body)); };
const error = (response, status, message) => json(response, status, { error: message });
const body = request => new Promise((resolve, reject) => {
  let raw = ""; request.on("data", chunk => { raw += chunk; if (raw.length > 1_000_000) request.destroy(new Error("Request body too large")); });
  request.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error("Invalid JSON body")); } }); request.on("error", reject);
});
const within = (file, root) => { const relative = path.relative(path.resolve(root), path.resolve(file)); return relative && !relative.startsWith("..") && !path.isAbsolute(relative); };
const contentType = file => ({ ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml" })[path.extname(file).toLowerCase()] || "application/octet-stream";
const sendFile = (response, file) => { if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return error(response, 404, "File not found"); response.writeHead(200, { "Content-Type": contentType(file), ...corsHeaders(response.req?.headers?.origin) }); fs.createReadStream(file).pipe(response); };
const currentRender = () => ({ ...render, log: render.log.slice(-12000) });
const appendRenderLog = chunk => { render.log = `${render.log}${chunk}`.slice(-50000); };

function imageSnapshot(folder) {
  return new Map(scanImages(folder).map(file => {
    const info = fs.statSync(file); return [file, `${info.size}:${info.mtimeMs}`];
  }));
}

function changedImages(folder, before) {
  return scanImages(folder).filter(file => {
    const info = fs.statSync(file); return before.get(file) !== `${info.size}:${info.mtimeMs}`;
  });
}

const imageLayer = file => /(?:^|_)shadow(?:_|\.)/i.test(path.basename(file)) ? "Shadow" : "Fabric";
const taskLayerExpected = (task, layerName) => {
  const layer = (task.layers || []).find(item => !item.doNotRender && String(item.name || "").toLowerCase() === layerName.toLowerCase());
  if (!layer) return 0;
  const cameras = task.sequence?.cameras?.length || 0;
  const variants = layerName === "Fabric" && !layer._rhLocalPrefit && !layer._rhLocalCropCalibration
    ? materialCombinationCount(task.materials)
    : 1;
  return cameras * variants;
};
const taskOutputFolder = (task, layerName) => path.resolve(String((task.layers || []).find(layer => String(layer.name || "").toLowerCase() === layerName.toLowerCase())?.output?.folder || ""));
const runProducedImages = (run, folder, layerName, calibration = false) => scanImages(folder).filter(file => {
  const isCalibration = isInBranch(file, "calibration");
  return isCalibration === calibration && imageLayer(file) === layerName && run.before.get(file) !== `${fs.statSync(file).size}:${fs.statSync(file).mtimeMs}`;
});
const phaseUsesCalibrationBranch = phase => Boolean(phase?.isCalibration || (phase?.job?.tasks || []).some(task =>
  (task.layers || []).some(layer => layer._rhLocalPrefit)
));

const yieldToStatusRequests = () => new Promise(resolve => setImmediate(resolve));
const prepareSubstrateShadowAsync = (file, config, productType) => new Promise((resolve, reject) => {
  const worker = new Worker(path.join(ROOT, "lib", "shadow-alpha-worker.cjs"), { workerData: { file, config, productType } });
  let settled = false;
  worker.on("message", message => {
    settled = true;
    if (message?.ok) resolve(message.result); else reject(new Error(message?.error || `Shadow worker failed for ${path.basename(file)}`));
  });
  worker.on("error", error => { if (!settled) reject(error); });
  worker.on("exit", code => { if (!settled && code !== 0) reject(new Error(`Shadow worker exited with code ${code} for ${path.basename(file)}`)); });
});

async function prepareShadowPhase(run, phase) {
  if (String(phase?.layerName || "").toLowerCase() !== "shadow") return;
  const modelTypes = new Map((run.job?._rhLocal?.models || []).map(model => [String(model.name || "").toLowerCase(), model.productType]));
  const records = (phase.job?.tasks || []).flatMap(task => {
    const folder = taskOutputFolder(task, "Shadow");
    const productType = String(modelTypes.get(String(task.taskId || "").toLowerCase()) || "").toLowerCase();
    return folder && fs.existsSync(folder) ? runProducedImages(run, folder, "Shadow", Boolean(phase.isCalibration)).map(file => ({ file, productType, taskId: task.taskId })) : [];
  });
  const files = [...new Map(records.map(record => [record.file, record])).values()];
  if (!files.length) return;

  const config = loadPostProcessConfig(ROOT), startedAt = new Date().toISOString();
  render.phase = "Shadow processing"; render.substrate = null; render.currentTask = null; render.currentCamera = null;
  render.message = `Recovering visible alpha for ${files.length} Shadow image${files.length === 1 ? "" : "s"}`;
  render.shadowProcess = { state: "running", completed: 0, total: files.length, startedAt, calibration: Boolean(phase.isCalibration) };
  appendRenderLog(`Starting Shadow alpha recovery for ${files.length} ${phase.isCalibration ? "calibration " : ""}image${files.length === 1 ? "" : "s"}; crop and previews wait for this stage.\n`);
  let converted = 0, skipped = 0;
  await yieldToStatusRequests();
  for (let index = 0; index < files.length; index += 1) {
    const { file, productType, taskId } = files[index], result = await prepareSubstrateShadowAsync(file, config, productType);
    if (result.skipped) skipped += 1; else converted += 1;
    render.currentTask = taskId || path.basename(path.dirname(path.dirname(file)));
    render.currentCamera = path.basename(file).match(/_(TQB|TQ|FH|F|P)_/i)?.[1]?.toUpperCase() || null;
    render.shadowProcess.completed = index + 1;
    render.message = index + 1 >= files.length ? "Finalizing visible Shadow alpha" : `Shadow processing ${index + 1} of ${files.length}`;
    await yieldToStatusRequests();
  }
  render.currentTask = null; render.currentCamera = null;
  render.shadowProcess = { ...render.shadowProcess, state: "success", completed: files.length, converted, skipped, finishedAt: new Date().toISOString() };
  appendRenderLog(`Shadow alpha recovery complete: ${converted} converted, ${skipped} already carried alpha.\n`);
}

function phaseTaskProgress(run, phase) {
  const layerName = phase.layerName || phase.name;
  return (phase?.job?.tasks || []).map(task => {
    const expected = taskLayerExpected(task, layerName), folder = taskOutputFolder(task, layerName);
    const rendered = folder && fs.existsSync(folder) ? runProducedImages(run, folder, layerName, phaseUsesCalibrationBranch(phase)).length : 0;
    const cameraReady = layerName !== "Fabric" || (task.sequence?.cameras || []).every(camera => run.cameraStates.has(cameraStateKey(task.taskId, camera.sequenceName || camera.name)));
    return { name: task.taskId, expected, rendered: Math.min(rendered, expected), complete: expected > 0 && rendered >= expected && cameraReady };
  });
}

function refreshRunProgress() {
  if (!activeRun) return;
  const phases = activeRun.phases.map(phase => [phase.name, new Map(phaseTaskProgress(activeRun, phase).map(item => [item.name, item]))]);
  render.queue = (activeRun.job.tasks || []).map(task => {
    const records = phases.map(([, rows]) => rows.get(task.taskId)).filter(Boolean);
    const expected = records.reduce((sum, item) => sum + item.expected, 0), rendered = records.reduce((sum, item) => sum + item.rendered, 0);
    const state = expected > 0 && rendered >= expected ? "complete" : rendered > 0 ? "partial" : task.taskId === render.currentTask ? "active" : "queued";
    return { name: task.taskId, state, rendered, expected };
  });
  render.rendered = render.queue.reduce((sum, item) => sum + item.rendered, 0);
}

function remainingPhaseJob(run, phase) {
  const remaining = new Set(phaseTaskProgress(run, phase).filter(item => !item.complete).map(item => item.name));
  const job = JSON.parse(JSON.stringify(phase.job));
  job.tasks = (job.tasks || []).filter(task => remaining.has(task.taskId));
  return job;
}

function finishBridge(state, message) {
  if (!bridge || bridge.completed) return;
  const produced = changedImages(bridge.outputFolder, bridge.before);
  bridge.completed = true;
  bridge.success = state === "success" && produced.length > 0;
  appendRenderLog(`\n${bridge.phase.name} phase ${bridge.success ? "completed" : "failed"}: ${message}; changed images: ${produced.length}\n`);
  const processToClose = child;
  setTimeout(() => {
    if (child && child === processToClose) {
      appendRenderLog(`Closing Unreal after ${bridge?.phase?.name || "render"} phase.\n`);
      processToClose.kill();
    }
  }, 1500);
}

function finishRun(state, message) {
  if (!activeRun) return;
  const run = activeRun, produced = changedImages(run.outputFolder, run.before), originals = new Set(originalFilesForJob(run.job).map(file => path.resolve(file))), deliverables = produced.filter(file => originals.has(path.resolve(file))), succeeded = state === "success" && deliverables.length > 0;
  render.pid = null;
  appendRenderLog(`\nRender plan ${succeeded ? "success" : "failed"}: ${message}; changed images: ${produced.length}\n`);
  // Every way a run ends passes through here, so this is where its timing is written down.
  const endedAt = new Date().toISOString();
  const openPhase = run.phases[run.index];
  if (openPhase && openPhase.startedAt && !openPhase.finishedAt) openPhase.finishedAt = endedAt;
  try {
    runStats.recordRun(ROOT, {
      jobId: run.job?.jobId || path.basename(run.jobPath || "", ".job.json"),
      jobPath: run.jobPath, job: run.job, startedAt: render.startedAt, finishedAt: endedAt,
      state: succeeded ? "success" : "failed", phases: run.phases
    });
  } catch (statsError) { appendRenderLog("Could not record run timing: " + statsError.message + "\n"); }
  activeRun = null; bridge = null;
  if (!succeeded) {
    render.state = "failed"; render.finishedAt = new Date().toISOString();
    return;
  }
  if (run.cameraStates.size) {
    run.job._rhLocal = { ...(run.job._rhLocal || {}), cameraStates: Object.fromEntries(run.cameraStates), cameraFitRendererToken: cameraFitRendererToken(run.environment) };
    fs.writeFileSync(run.jobPath, `${JSON.stringify(run.job, null, 2)}\n`, "utf8");
  }
  updateCatalog(run.jobPath);
  startPostProcessing(run.job, run.jobPath, deliverables, { automatic: true, cameraStates: run.cameraStates, environment: run.environment });
}

function startPostProcessing(job, jobPath, files, options = {}) {
  if (postProcessPromise) throw new Error("Post-processing is already running");
  if (!files.length) throw new Error("No original PNG files were found for post-processing");
  const environment = options.environment || environmentForJob(job, RENDER_ENVIRONMENTS);
  const startedAt = new Date().toISOString(), phaseCount = Math.max(Number(render.phaseCount) || 0, 1) + (options.automatic ? 1 : 0);
  render.state = "running"; render.pid = null; render.jobPath = jobPath; render.finishedAt = null; render.phase = "Post-processing";
  render.phaseIndex = phaseCount; render.phaseCount = phaseCount; render.substrate = null; render.currentTask = null; render.currentCamera = null;
  render.message = `Preparing ${files.length} delivery image${files.length === 1 ? "" : "s"}`;
  const proxies = publishPreviews(files);
  render.postProcess = { state: "running", completed: 0, total: files.length, startedAt, automatic: Boolean(options.automatic), previews: proxies };
  appendRenderLog(`Starting post-process for ${files.length} normalized RAW PNG${files.length === 1 ? "" : "s"}: transparent 15000x5000 canvas, AdobeRGB1998, 300 DPI, and Shadow delivery treatment.\n`);
  appendRenderLog(`Previews from normalized RAW: ${proxies.created} created, ${proxies.skipped} already current${proxies.failed.length ? `, ${proxies.failed.length} failed` : ""}.\n`);
  let readyToUpload = null;
  postProcessPromise = processJob(ROOT, job, {
    files,
    cameraStates: options.cameraStates,
    prepareShadow: environment.recoverLegacyShadow,
    onDelivery: delivery => { readyToUpload = delivery; },
    onProgress: progress => {
      render.currentTask = progress.task; render.currentCamera = path.basename(progress.file).match(/_(F|FH|TQ)_/)?.[1] || null;
      render.postProcess.completed = progress.completed;
      render.message = progress.completed >= progress.total ? "Finalizing delivery images" : `Post-processing ${progress.completed + 1} of ${progress.total}`;
    }
  }).then(results => {
    const created = results.filter(result => !result.skipped).length, skipped = results.length - created;
    render.state = "success"; render.finishedAt = new Date().toISOString(); render.currentTask = null; render.currentCamera = null;
    render.message = `${created} processed image${created === 1 ? "" : "s"} ready${skipped ? ` · ${skipped} already current` : ""} · POST folder ready`;
    render.postProcess = { ...render.postProcess, state: "success", completed: results.length, created, skipped, readyToUpload, finishedAt: render.finishedAt };
    appendRenderLog(`Post-process complete: ${created} created, ${skipped} already current. Delivery files are isolated in ${readyToUpload?.folder || "POST"} (${readyToUpload?.files || 0} files).\n`);
    updateCatalog(jobPath);
  }).catch(postError => {
    render.state = options.automatic ? "success" : "failed"; render.finishedAt = new Date().toISOString(); render.currentTask = null; render.currentCamera = null;
    render.message = `Render files are safe, but post-process failed: ${postError.message}`;
    render.postProcess = { ...render.postProcess, state: "failed", error: postError.message, finishedAt: render.finishedAt };
    appendRenderLog(`Post-process failed without changing originals: ${postError.stack || postError.message}\n`);
  }).finally(() => { postProcessPromise = null; });
  return postProcessPromise;
}

function finalizeCropCalibration(run) {
  const records = [], profiles = new Map();
  for (const task of run.job.tasks || []) {
    const baseOutput = path.resolve(String((task.layers || []).find(layer => layer.output?.folder)?.output?.folder || ""));
    const folder = siblingBranch(baseOutput, "calibration");
    for (const camera of task.sequence?.cameras || []) {
      if (camera._rhLocalCrop?.status !== "pending") continue;
      const files = calibrationFiles(folder, camera.name), fingerprint = camera._rhLocalCrop.fingerprint;
      if (!files.fabric || !files.shadow) throw new Error(`Crop calibration pair is incomplete for ${task.taskId}/${camera.name}`);
      const profile = { ...analyzeCalibrationPair(files.fabric, files.shadow), fingerprint, camera: camera.name, contextToken: camera._rhLocalCrop.contextToken || null, modelName: task.taskId, modelPath: task.model?.objPath || "" };
      records.push(profile); profiles.set(`${task.taskId}::${camera.name}`, profile);
    }
  }
  if (!records.length) return;
  const apply = job => {
    for (const task of job.tasks || []) task.sequence.cameras = (task.sequence?.cameras || []).map(camera => {
      const profile = profiles.get(`${task.taskId}::${camera.name}`);
      return profile ? applyCropProfileToCamera(camera, profile) : camera;
    });
  };
  apply(run.job);
  for (const phase of run.phases) if (!phase.isCalibration) apply(phase.job);
  writeCropProfiles(ROOT, records);
  const ratios = records.map(record => record.cropRatio), saved = Math.round((1 - ratios.reduce((sum, value) => sum + value, 0) / ratios.length) * 100);
  appendRenderLog(`Saved ${records.length} crop profile${records.length === 1 ? "" : "s"}; average vertical pixel saving ${saved}%. Final Fabric/Shadow phases now use symmetric SensorSize.Y cropping.\n`);
  fs.writeFileSync(run.jobPath, `${JSON.stringify(run.job, null, 2)}\n`, "utf8");
}

async function advancePhaseOrFinish(message) {
  if (!activeRun) return;
  const run = activeRun, phase = run.phases[run.index], remaining = phaseTaskProgress(run, phase).filter(item => !item.complete);
  if (run.environment.recoverLegacyShadow && String(phase?.layerName || "").toLowerCase() === "shadow" && remaining.length === 0) {
    try { await prepareShadowPhase(run, phase); }
    catch (shadowError) { return finishRun("failed", `Shadow processing failed: ${shadowError.message}`); }
  }
  if (activeRun !== run) return;
  refreshRunProgress();
  const afterProcessing = phaseTaskProgress(run, phase).filter(item => !item.complete);
  if (afterProcessing.length) return restartRenderPhase(`${message}; ${afterProcessing.length} incomplete model${afterProcessing.length === 1 ? "" : "s"}`);
  if (phase.finalizesCrop) {
    try { finalizeCropCalibration(activeRun); }
    catch (calibrationError) { return finishRun("failed", calibrationError.message); }
  }
  phase.finishedAt = phase.finishedAt || new Date().toISOString();
  if (activeRun.index + 1 < activeRun.phases.length) {
    activeRun.index += 1; render.pid = null; render.phase = `Preparing ${activeRun.phases[activeRun.index].name}`; render.phaseIndex = activeRun.index + 1; render.substrate = null; render.currentTask = null;
    appendRenderLog(`${phase.name} is complete. Restarting Unreal for ${activeRun.phases[activeRun.index].name} with Substrate ${activeRun.phases[activeRun.index].substrate ? "ON" : "OFF"}.\n`);
    setTimeout(startRenderPhase, 300);
  } else finishRun("success", `${activeRun.phases.length} phase${activeRun.phases.length === 1 ? "" : "s"} completed`);
}

function restartRenderPhase(reason) {
  if (!activeRun) return;
  const phase = activeRun.phases[activeRun.index], used = activeRun.phaseRestarts.get(phase.name) || 0;
  const maxPhaseRestarts = activeRun.maxPhaseRestarts ?? MAX_PHASE_RESTARTS;
  refreshRunProgress();
  if (used >= maxPhaseRestarts) return finishRun("failed", `${phase.name} stopped after ${used} automatic restarts: ${reason}`);
  activeRun.phaseRestarts.set(phase.name, used + 1); render.pid = null; render.phase = `Restarting ${phase.name}`; render.autoRestarts = (render.autoRestarts || 0) + 1; render.message = `Unreal exited · resuming incomplete models (${used + 1}/${MAX_PHASE_RESTARTS})`;
  appendRenderLog(`\nUnreal interruption: ${reason}. Automatic ${phase.name} resume ${used + 1}/${maxPhaseRestarts}; completed models stay skipped.\n`);
  setTimeout(startRenderPhase, 2500);
}

function startRenderPhase() {
  if (!activeRun) return;
  // The production BatchRender plugin appends `&Substrate=...` unconditionally. Give it an
  // existing query string so the suffix stays a query parameter instead of becoming part of
  // the pathname (`/api/unreal&Substrate=true`), which the local bridge cannot route.
  const phase = activeRun.phases[activeRun.index], apiUrl = `http://${HOST}:${PORT}/api/unreal?source=local`;
  // Stamped once, not on every automatic restart, so a retry does not reset the clock on
  // work the phase has already done.
  if (!phase.startedAt) {
    phase.startedAt = new Date().toISOString();
    phase.frames = Object.values(runStats.frameCounts(phase.job)).reduce((total, count) => total + count, 0);
  }
  let phaseJob = remainingPhaseJob(activeRun, phase);
  if (!phaseJob.tasks.length) return advancePhaseOrFinish(`${phase.name} already complete`);
  // A calibration probe must fit its own exact frame. Reusing a parent-job camera here made
  // the 500px Fabric probe carry a 5000px state and inflated sofa crop heights by up to 50%.
  if (phase.useCameraHandoff) {
    const handoff = applyCameraHandoff(phaseJob, activeRun.cameraStates);
    if (phase.useCameraHandoff && handoff.missing.length) return finishRun("failed", `Fabric camera handoff missing for ${handoff.missing.join(", ")}`);
    phaseJob = handoff.job;
    if (handoff.applied.length) {
      appendRenderLog(`Applied ${handoff.applied.length} camera state${handoff.applied.length === 1 ? "" : "s"} from Fabric handoff to ${phase.name}; fit disabled for inherited views.\n`);
    }
  }
  bridge = { job: phaseJob, jobPath: activeRun.jobPath, outputFolder: activeRun.outputFolder, before: imageSnapshot(activeRun.outputFolder), delivered: false, completed: false, success: false, phase, exitHandled: false };
  const environment = activeRun.environment;
  const nativeShadowDiagnostics = environment.id === "ue58" && activeRun.job?._rhLocal?.nativeShadowDiagnostics === true;
  const phaseBridge = bridge, launch = buildUnrealLaunch(environment.editor, environment.project, apiUrl, { substrate: phase.substrate, nativeShadowDiagnostics });
  appendRenderLog(`\nStarting ${phase.name} phase ${activeRun.index + 1}/${activeRun.phases.length} in ${environment.label}; ${phaseJob.tasks.length} incomplete model${phaseJob.tasks.length === 1 ? "" : "s"}; Substrate ${phase.substrate ? "ON" : "OFF"}.\n${launch.command}\n${launch.args.join(" ")}\n`);
  child = spawn(launch.command, launch.args, launch.options);
  const phaseProcess = child;
  render.pid = child.pid; render.phase = phase.name; render.phaseIndex = activeRun.index + 1; render.phaseCount = activeRun.phases.length; render.substrate = phase.substrate;
  child.stdout.on("data", appendRenderLog); child.stderr.on("data", appendRenderLog);
  child.on("error", launchError => {
    if (phaseBridge.exitHandled) return; phaseBridge.exitHandled = true;
    appendRenderLog(`\n${launchError.message}\n`);
    if (child === phaseProcess) child = null;
    if (bridge === phaseBridge) bridge = null;
    restartRenderPhase(`${phase.name} could not start`);
  });
  child.on("exit", code => {
    if (phaseBridge.exitHandled) return; phaseBridge.exitHandled = true;
    render.exitCode = code;
    if (child === phaseProcess) child = null;
    if (bridge === phaseBridge) bridge = null;
    if (!activeRun) return;
    if (!phaseBridge.completed) return advancePhaseOrFinish(`${phase.name} exited before job_completed`);
    if (!phaseBridge.success) return restartRenderPhase(`${phase.name} did not produce render files`);
    advancePhaseOrFinish(`${phase.name} job_completed`);
  });
}

function scanImages(folder) {
  if (!fs.existsSync(folder)) return [];
  const found = [], stack = [folder];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full); else if (/\.(png|jpe?g|webp)$/i.test(entry.name) && !isProcessedImage(full)) found.push(full);
    }
  }
  return found.sort();
}

// A uasset names the classes it holds, so a material can be told from everything else that
// shares the extension. Class names are matched whole: MaterialFunction is not a Material,
// and a static mesh mentions Material only because it points at one.
const MATERIAL_CLASSES = ["MaterialInstanceConstant", "Material"];
// Texture2D is deliberately absent: a master material references its textures, and excluding
// on it threw away M_RH_MASTER_V3/V5/V6. A texture asset carries no material class of its own,
// so it is left out by not matching rather than by being pushed out.
const NOT_A_MATERIAL = ["StaticMesh", "SkeletalMesh", "World", "LevelSequence", "SoundWave", "AnimSequence"];
const holdsClass = (buffer, className) => buffer.includes(`\x00${className}\x00`, 0, "latin1");

function isMaterialAsset(file) {
  let head;
  try { head = fs.readFileSync(file); } catch { return false; }
  const window = head.subarray(0, 400_000);
  if (NOT_A_MATERIAL.some(className => holdsClass(window, className))) return false;
  return MATERIAL_CLASSES.some(className => holdsClass(window, className));
}

// Every folder named RH, wherever it sits: the fabrics live under Content/RH while the legs
// and plastics live under Content/3D_Source/Materials/RH, and both are in use.
function rhFolders(root) {
  const found = [], stack = [root].filter(fs.existsSync);
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = path.join(current, entry.name);
      if (entry.name.toUpperCase() === "RH") found.push(full); else stack.push(full);
    }
  }
  return found;
}

function unrealMaterials(environment = renderEnvironment(DEFAULT_ENVIRONMENT)) {
  if (unrealMaterialCache.has(environment.id)) return unrealMaterialCache.get(environment.id);
  const projectRoot = path.dirname(environment.project);
  const stack = ["Content", "Plugins"].flatMap(folder => rhFolders(path.join(projectRoot, folder)));
  const records = [];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".uasset") && isMaterialAsset(full)) {
        records.push({ name: path.basename(entry.name, ".uasset"), path: full });
      }
    }
  }
  const sorted = records.sort((left, right) => left.name.localeCompare(right.name));
  unrealMaterialCache.set(environment.id, sorted);
  return sorted;
}

function latestModified(root, extensions) {
  if (!fs.existsSync(root)) return 0;
  let latest = 0, stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (extensions.some(extension => entry.name.toLowerCase().endsWith(extension))) latest = Math.max(latest, fs.statSync(full).mtimeMs);
    }
  }
  return latest;
}

function pluginRuntimeIsCommitted(pluginRoot, files) {
  if (!files.every(file => fs.existsSync(path.join(pluginRoot, file)))) return false;
  const result = spawnSync("git", ["-C", pluginRoot, "diff", "--quiet", "HEAD", "--", ...files], { windowsHide: true });
  return result.status === 0;
}

async function preflight(input) {
  const selectedEnvironment = renderEnvironment(input.renderEnvironment);
  const selections = input.models?.length ? input.models : input.modelPath ? [{ modelPath: input.modelPath }] : [];
  const checks = [], inspected = [];
  if (!selections.length) checks.push({ id: "models", level: "error", label: "Models", detail: "Add at least one model." });
  for (const selection of selections) {
    try {
      const model = await models.inspect(selection.modelPath), side = input.side === "auto" || !input.side ? model.side : String(input.side).toUpperCase();
      inspected.push(model);
      // The chosen type drives the job. Where a model sits says what it is, so a model from
      // another type's folder would be rendered with the wrong cameras, lights and scene.
      const chosen = String(input.productType || model.group || "sectionals").toLowerCase();
      const implied = String(model.group || "sectionals").toLowerCase();
      if (chosen !== implied) {
        checks.push({ id: `model:${model.name}:type`, level: "error", label: model.name,
          detail: `Model type is ${chosen}, but this model is filed under ${implied}. It would render with the wrong cameras and lights.` });
      }
      const needsSide = productType(chosen).requiresSide;
      if (!fs.existsSync(model.path)) checks.push({ id: `model:${model.name}`, level: "error", label: model.name, detail: "Model file is missing." });
      else if (needsSide && !["R", "L", "U"].includes(side)) checks.push({ id: `model:${model.name}`, level: "error", label: model.name, detail: "L/R/U form factor could not be determined." });
    } catch (modelError) { checks.push({ id: `model:${selection.modelPath}`, level: "error", label: path.basename(String(selection.modelPath || "Model")), detail: modelError.message }); }
  }
  if (inspected.length) checks.push({ id: "models", level: "ok", label: "Models", detail: `${inspected.length} FBX file${inspected.length === 1 ? "" : "s"} found; dimensions and form factors are ready.` });
  const previewType = productType(String(input.productType || inspected[0]?.group || "sectionals").toLowerCase());
  const cameras = Array.isArray(input.cameras) ? input.cameras.filter(value => previewType.cameras.includes(value)) : [];
  const layers = Array.isArray(input.layers) ? input.layers.filter(value => ["Fabric", "Shadow"].includes(value)) : [];
  checks.push(cameras.length ? { id: "cameras", level: "ok", label: "Cameras", detail: cameras.join(" · ") } : { id: "cameras", level: "error", label: "Cameras", detail: "Select at least one camera." });
  const shadowOnly = layers.includes("Shadow") && !layers.includes("Fabric");
  checks.push(layers.length ? { id: "layers", level: "ok", label: "Layers", detail: shadowOnly ? "Shadow · automatic 500×500 Fabric camera prefit" : layers.join(" → ") } : { id: "layers", level: "error", label: "Layers", detail: "Select at least one layer." });
  let cropCalibrations = 0, staleCrops = 0;
  const reusedCrops = [];
  if (String(input.cropMode || "full").toLowerCase() === "optimized" && inspected.length && cameras.length) {
    const cropStore = readCropProfiles(ROOT), rig = sheet.rig(), shadowConfig = loadPostProcessConfig(ROOT);
    // Saying only how many pairs will be measured leaves the other half silent, so a camera
    // that quietly reuses a crop measured days ago looks like a missing calibration render.
    for (const model of inspected) {
      const selection = selections.find(item => path.resolve(String(item.modelPath || "")).toLowerCase() === path.resolve(model.path).toLowerCase()) || {};
      const side = input.side === "auto" || !input.side ? model.side : String(input.side).toUpperCase();
      const fingerprint = modelFingerprint(model.path);
      for (const camera of cameras) {
        const saved = cropProfileFor(cropStore, fingerprint, camera);
        const tokens = cropContextTokensFor({ input, selection, model, side, fingerprint, camera, rig, shadowConfig });
        const profile = cropProfileForContext(cropStore, fingerprint, camera, tokens);
        if (saved && !profile) staleCrops += 1;
        if (profile) reusedCrops.push(profile); else cropCalibrations += 1;
      }
    }
    const dates = reusedCrops.map(profile => profile?.analyzedAt).filter(Boolean).sort();
    const when = dates.length ? new Date(dates[0]).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "";
    const reusedNote = reusedCrops.length
      ? ` ${reusedCrops.length} pair${reusedCrops.length === 1 ? "" : "s"} reuse a crop saved earlier${when ? `, oldest ${when}` : ""} and render no probe.`
      : "";
    checks.push(cropCalibrations
      ? { id: "crop", level: "warning", label: "Optimized crop",
          detail: `${cropCalibrations} model/camera pair${cropCalibrations === 1 ? "" : "s"} will run one-time 500px Fabric + Shadow calibration before final renders.${staleCrops ? ` ${staleCrops} saved crop${staleCrops === 1 ? "" : "s"} did not match the current model, frame, light, or renderer context.` : ""}${reusedNote}` }
      : { id: "crop", level: "ok", label: "Optimized crop",
          detail: `Every selected model/camera pair has a saved safe crop profile${when ? `, oldest ${when}` : ""}. No calibration will run.` });
  } else checks.push({ id: "crop", level: "ok", label: "Frame crop", detail: "Full frame · original resolution and sensor aspect." });
  const assets = unrealMaterials(selectedEnvironment), assetNames = new Map(assets.map(asset => [asset.name.toLowerCase(), asset]));
  const assigned = Array.isArray(input.materials) ? input.materials : [];
  const assignedNames = assigned.flatMap(row => Array.isArray(row.materials) ? row.materials : [row.material]).map(value => String(value || "").trim());
  let materialVariants = 0;
  if (!assigned.length || assignedNames.some(name => !name)) checks.push({ id: "materials", level: "error", label: "Materials", detail: "Complete every material assignment." });
  else {
    const missing = assignedNames.filter(name => !assetNames.has(name.toLowerCase()));
    materialVariants = materialCombinationCount(groupedMaterials(assigned));
    checks.push(missing.length ? { id: "materials", level: "error", label: "Materials", detail: `Not found in Unreal: ${missing.join(", ")}` } : { id: "materials", level: "ok", label: "Materials", detail: `${assignedNames.length} material selection${assignedNames.length === 1 ? "" : "s"} found · ${materialVariants} Fabric variant${materialVariants === 1 ? "" : "s"} per camera.` });
  }
  // "auto" means the side comes from the model, so the scene has to be built from the side
  // that was actually resolved rather than from the word in the form.
  const resolvedSide = ["R", "L", "U"].includes(String(input.side).toUpperCase())
    ? String(input.side).toUpperCase()
    : String(inspected[0]?.side || "R").toUpperCase();
  const lightScene = productType(input.productType).scene(resolvedSide);
  const sceneRows = Object.keys(sheet.rig()[lightScene] || {}).length;
  checks.push(sheet.status().rows
    ? sceneRows
      ? { id: "lights", level: sheet.status().source === "live" ? "ok" : "warning", label: "Light data", detail: `${sceneRows} camera${sceneRows === 1 ? "" : "s"} lit for ${lightScene} · ${sheet.status().rows} rows · ${sheet.status().source}` }
      : { id: "lights", level: "error", label: "Light data", detail: `The sheet has no lights for ${lightScene}.` }
    : { id: "lights", level: "error", label: "Light data", detail: "No light rows are available." });
  const pluginRoot = path.join(path.dirname(selectedEnvironment.project), "Plugins", "BatchRender"), markerFile = path.join(pluginRoot, "Source", "BatchRenderEditor", "Public", "JobModel.h");
  const bridgeSource = fs.existsSync(markerFile) && fs.readFileSync(markerFile, "utf8").includes("CameraFocalHandoffVersion");
  const sourceTime = latestModified(path.join(pluginRoot, "Source"), [".h", ".cpp"]), binaryRelative = [path.join("Binaries", "Win64", "UnrealEditor-BatchRender.dll"), path.join("Binaries", "Win64", "UnrealEditor-BatchRenderEditor.dll")], binaryFiles = binaryRelative.map(file => path.join(pluginRoot, file));
  const runtimeRelative = [path.join("Source", "BatchRenderEditor", "Public", "JobModel.h"), path.join("Source", "BatchRenderEditor", "Private", "JobModel.cpp"), path.join("Source", "BatchRender", "Private", "BatchRender.cpp"), ...binaryRelative];
  const binariesCurrent = pluginRuntimeIsCommitted(pluginRoot, runtimeRelative) || binaryFiles.every(file => fs.existsSync(file) && fs.statSync(file).mtimeMs >= sourceTime);
  const bridgeReady = bridgeSource && binariesCurrent;
  const bridgeDetail = !bridgeSource ? "BatchRender camera handoff is not installed." : !binariesCurrent ? "BatchRender camera handoff must be rebuilt." : `${selectedEnvironment.label}, project, and Fabric camera handoff are ready.`;
  checks.push(fs.existsSync(selectedEnvironment.editor) && fs.existsSync(selectedEnvironment.project) ? { id: "unreal", level: bridgeReady ? "ok" : "error", label: selectedEnvironment.label, detail: bridgeDetail } : { id: "unreal", level: "error", label: selectedEnvironment.label, detail: "Editor or project file is missing." });
  try { fs.accessSync(path.join(ROOT, "local", "renders"), fs.constants.W_OK); checks.push({ id: "output", level: "ok", label: "Output", detail: "Local render folder is writable." }); }
  catch { checks.push({ id: "output", level: "error", label: "Output", detail: "Local render folder is not writable." }); }
  const post = postProcessAvailability(ROOT);
  checks.push(post.ok ? { id: "postprocess", level: "ok", label: "Post-process", detail: selectedEnvironment.recoverLegacyShadow ? "Legacy Shadow recovery, libvips, and AdobeRGB1998 are ready; originals will be preserved." : "Native 5.8 Shadow alpha will pass directly to delivery; libvips and AdobeRGB1998 are ready." } : { id: "postprocess", level: "error", label: "Post-process", detail: post.error });
  const expectedPerCamera = (layers.includes("Fabric") ? Math.max(materialVariants, 1) : 0) + (layers.includes("Shadow") ? 1 : 0);
  const expected = inspected.length * cameras.length * expectedPerCamera;
  return { ok: !checks.some(check => check.level === "error"), checks, counts: { models: inspected.length, cameras: cameras.length, layers: layers.length, materialVariants, expectedRenders: expected, cropCalibrations }, materials: assets.length, renderEnvironment: publicRenderEnvironment(selectedEnvironment) };
}

function updateCatalog(jobPath) {
  try {
    const job = JSON.parse(fs.readFileSync(jobPath, "utf8")), metadata = job._rhLocal || {};
    const catalogPath = path.join(ROOT, "local", "catalog.json");
    const catalog = fs.existsSync(catalogPath) ? JSON.parse(fs.readFileSync(catalogPath, "utf8")) : { models: [] };
    const records = metadata.models || [metadata];
    for (const record of records) {
      const images = scanImages(record.outputFolder).filter(file => !file.split(path.sep).includes("_camera_prefit")); if (!images.length) continue;
      const entry = { name: record.name || path.basename(record.modelPath, path.extname(record.modelPath)), modelPath: record.modelPath, dimensions: record.dimensions, side: record.side, renders: images, updatedAt: new Date().toISOString() };
      const index = catalog.models.findIndex(item => item.modelPath === entry.modelPath); if (index >= 0) catalog.models[index] = entry; else catalog.models.unshift(entry);
    }
    fs.writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  } catch (catalogError) { render.log += `\nCatalog update failed: ${catalogError.message}`; }
}

function readCatalog() {
  const catalogPath = path.join(ROOT, "local", "catalog.json"), empty = { models: [] };
  if (!fs.existsSync(catalogPath)) return empty;
  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  return { models: (catalog.models || []).map(model => ({ ...model, previewUrl: model.renders?.[0] ? `/api/renders/file?path=${encodeURIComponent(path.relative(path.join(ROOT, "local", "renders"), model.renders[0]))}` : null })) };
}

// Looking costs nothing, so every read is open: anyone with the address can watch the
// queue and page through the renders. Doing something needs the key.
//
// The rule is that shape on purpose. Every GET here only reads, every POST either starts
// work, writes a file or reaches out to the network, and preflight is the one POST that
// merely validates a payload.
const OPEN_POSTS = new Set(["/api/preflight"]);
function isAuthorized(request, url) {
  if (url.pathname === "/api/unreal") return isLoopback(request);
  if (request.method === "GET" || OPEN_POSTS.has(url.pathname)) return true;
  // Somebody at this machine already has the run of it; the key exists to guard the way in
  // from outside, not to make the local page ask permission of itself.
  if (isLocalOperator(request)) return true;
  return timingEqual(presentedKey(request), ACCESS_KEY);
}

async function api(request, response, url) {
  if (ACCESS_KEY && !isAuthorized(request, url)) return error(response, 401, "This action needs the access key");
  if (url.pathname === "/api/unreal" && request.method === "GET") {
    lastUnrealContactAt = new Date().toISOString();
    if (!bridge || bridge.delivered) { response.writeHead(204, { "Cache-Control": "no-store" }); response.end(); return; }
    bridge.delivered = true;
    appendRenderLog("BatchRender fetched the queued local job.\n");
    return json(response, 200, bridge.job);
  }
  if (url.pathname === "/api/unreal" && request.method === "POST") {
    lastUnrealContactAt = new Date().toISOString();
    const event = await body(request), eventName = String(event.event || "unknown"), data = event.data || {};
    appendRenderLog(`BatchRender event ${eventName}: ${JSON.stringify(data).slice(0, 4000)}\n`);
    if (bridge) {
      if (data.taskId) {
        render.currentTask = data.taskId;
        refreshRunProgress();
      }
      const sequenceName = data.sequenceName || data.camera?.sequenceName || data.camera?.name || "";
      if (sequenceName) render.currentCamera = String(sequenceName).split("_").pop();
      if (data.message) render.message = data.message;
      if (eventName === "render_finished") refreshRunProgress();
    }
    const matchesJob = bridge && (!data.jobId || data.jobId === bridge.job.jobId || data.jobId === activeRun?.job?.jobId);
    if (matchesJob && bridge?.phase?.layerName === "Fabric" && eventName === "sequence_camera_data") {
      const camera = data.camera || {}, focalLength = Number(camera.FocalLength ?? camera.focalLength);
      const sequenceName = data.sequenceName || camera.sequenceName || camera.name;
      if (data.taskId && sequenceName && camera.cameraLocation && camera.cameraRotation && Number.isFinite(focalLength) && focalLength > 0) {
        const state = {
          cameraLocation: camera.cameraLocation, cameraRotation: camera.cameraRotation, focalLength,
          sensorWidth: Number(camera.SensorWidth ?? camera.sensorWidth), sensorHeight: Number(camera.SensorHeight ?? camera.sensorHeight),
          aperture: Number(camera.CurrentAperture ?? camera.currentAperture), correctPerspective: Boolean(camera.bCorrectPerspective)
        };
        activeRun.cameraStates.set(cameraStateKey(data.taskId, sequenceName), state);
        // Key the state by the phase that actually produced it. Using activeRun.job stored a
        // 500px calibration camera under a 5000px parent signature and poisoned later probes.
        const environment = activeRun?.environment || environmentForJob(bridge.job, RENDER_ENVIRONMENTS);
        const saved = writeCameraFitState(ROOT, bridge.job, data.taskId, sequenceName, state, { projectPath: environment.project, rendererToken: cameraFitRendererToken(environment) });
        if (saved) appendRenderLog(`Saved persistent camera Fit for ${data.taskId}/${String(sequenceName).split("_").pop()}.\n`);
      }
    }
    if (matchesJob && eventName === "job_completed") {
      refreshRunProgress();
      finishBridge("success", `job ${data.jobId || bridge.job.jobId} completed`);
    }
    if (matchesJob && eventName === "error") finishBridge("failed", data.error || "plugin reported an error");
    return json(response, 200, { ok: true });
  }
  if (request.method === "GET" && url.pathname === "/api/status") {
    const defaultEnvironment = renderEnvironment(DEFAULT_ENVIRONMENT), publicEnvironments = Object.values(RENDER_ENVIRONMENTS).map(publicRenderEnvironment);
    return json(response, 200, {
    project: "RH_Local_Renders", models: models.list(), sheet: sheet.status(),
    unreal: { ...publicRenderEnvironment(defaultEnvironment), lastContactAt: lastUnrealContactAt, cameraFitCache: { profiles: Object.keys(readCameraFitProfiles(ROOT).profiles).length, rendererToken: cameraFitRendererToken(defaultEnvironment) } },
    renderEnvironments: publicEnvironments, defaultRenderEnvironment: DEFAULT_ENVIRONMENT, render: currentRender(),
    runtime: { startedAt: RUNTIME_STARTED_AT, sourceToken: RUNTIME_SOURCE_TOKEN, stale: RUNTIME_SOURCE_TOKEN !== runtimeSourceToken() },
    // The same verdict the gate uses, or the page would call itself read-only while acting.
    access: { required: Boolean(ACCESS_KEY), authorized: !ACCESS_KEY || isLocalOperator(request) || timingEqual(presentedKey(request), ACCESS_KEY) }
    });
  }
  if (request.method === "POST" && url.pathname === "/api/models/repair") {
    // Some downloads name their parts where an importer never looks. Rewriting the file puts
    // the names back on objects and materials, in place, keeping the original as .orig.
    const input = await body(request), modelsRoot = models.modelsRoot;
    const wanted = Array.isArray(input.models) && input.models.length ? input.models : models.list().filter(model => model.format === "obj").map(model => model.name);
    const repaired = [];
    for (const name of wanted) {
      try {
        const file = models.resolve(name);
        if (path.extname(file).toLowerCase() !== ".obj") { repaired.push({ name, skipped: "only OBJ files can be repaired" }); continue; }
        if (!within(file, modelsRoot)) { repaired.push({ name, skipped: "outside the models folder" }); continue; }
        const before = await inspectObjParts(file);
        if (!before.needsNormalising) { repaired.push({ name, skipped: "already readable", parts: before.namedParts }); continue; }
        const staging = `${file}.repairing`;
        const result = await normalizeObjParts(file, staging);
        fs.renameSync(file, `${file}.orig`);
        fs.renameSync(staging, file);
        writeMaterialLibrary(file, result.parts);
        // The file changed, so its fingerprint no longer matches and the next inspect
        // re-analyses it without anything having to clear a cache.
        repaired.push({ name, parts: result.parts, droppedGroups: result.droppedGroups, faces: result.faces, keptOriginal: `${path.basename(file)}.orig` });
      } catch (repairError) { repaired.push({ name, error: repairError.message }); }
    }
    return json(response, 200, { repaired: repaired.filter(item => item.parts && !item.skipped).length, models: repaired });
  }
  if (request.method === "GET" && url.pathname === "/api/models/checks") {
    const stored = checkCache.read(ROOT);
    if (checkCache.prune(stored) > 0) checkCache.write(ROOT, stored);
    const rows = models.list()
      .map(model => { const row = checkCache.lookup(stored, model.path); return row ? { ...row, name: model.name } : null; })
      .filter(Boolean);
    return json(response, 200, { checked: rows.length, reused: rows.length, fresh: 0, requested: rows.length,
      failing: rows.filter(row => row.errors).length, warning: rows.filter(row => row.warnings).length, models: rows });
  }
  if (request.method === "POST" && url.pathname === "/api/crops/forget") {
    // A crop measured before a scene or a light moved is measuring the wrong thing. Dropping
    // it is refused mid-render, since the run writes into this same store as it calibrates.
    if (child || activeRun || postProcessPromise) return error(response, 409, "A render is running; its crops are still being written");
    const input = await body(request);
    const paths = Array.isArray(input.models) ? input.models : [];
    const fingerprints = [];
    for (const modelPath of paths) {
      try { fingerprints.push(modelFingerprint((await models.inspect(modelPath)).path)); } catch { /* a model we cannot read has no crop to drop */ }
    }
    const dropped = forgetCropProfiles(ROOT, { fingerprints, cameras: input.cameras, all: Boolean(input.all) });
    return json(response, 200, { dropped: dropped.length, entries: dropped });
  }
  if (request.method === "POST" && url.pathname === "/api/models/check") {
    // Checks every model on disk, or the ones asked for. Inspecting a model that has never
    // been analysed runs Blender, so this is a deliberate action rather than a page load.
    const input = await body(request);
    // A verdict is kept against the file's size and modification time, so a model already
    // checked is answered from store and only a new or replaced file costs a Blender run.
    // `refresh` re-checks everything; `cachedOnly` answers from store and runs nothing, which
    // is what the page asks for when a batch is assembled.
    const catalogue = new Map(models.list().map(model => [model.name, model]));
    const wanted = Array.isArray(input.models) && input.models.length ? input.models : [...catalogue.keys()];
    const stored = checkCache.read(ROOT);
    let touched = checkCache.prune(stored) > 0;
    const refresh = Boolean(input.refresh), cachedOnly = Boolean(input.cachedOnly);
    const results = [];
    let reused = 0, fresh = 0;
    for (const name of wanted) {
      const known = catalogue.get(name);
      const remembered = refresh || !known ? null : checkCache.lookup(stored, known.path);
      if (remembered) { results.push({ ...remembered, name }); reused += 1; continue; }
      if (cachedOnly) continue;
      try {
        const record = await models.inspect(name);
        const findings = checkModel(record, record);
        // Blender splits an OBJ on face groups, so it reads the parts of a file Unreal would
        // merge into one mesh. Asking Blender therefore cannot see this problem at all — the
        // file itself has to be read.
        if (String(record.format).toLowerCase() === "obj" && fs.existsSync(record.path)) {
          const parts = await inspectObjParts(record.path);
          if (parts.needsNormalising) {
            findings.unshift({
              level: "warning", code: "obj-parts-hidden", label: "Parts invisible to Unreal", repairable: true,
              detail: `${parts.namedParts.join(", ") || "the parts"} are marked only as face groups${Object.keys(parts.materials).length < 2 ? " sharing one material" : ""}. Unreal splits an OBJ by object and material, so it would arrive as a single mesh with nothing to assign a material to.`
            });
          } else {
            findings.push({ level: "ok", code: "obj-parts", label: "OBJ parts", detail: `${parts.namedParts.join(", ")} named as objects with their own materials.` });
          }
        }
        const row = { name, path: record.path, group: record.group || "", format: record.format || "", findings, ...summarise(findings) };
        results.push(row); fresh += 1;
        if (row.path) { checkCache.remember(stored, row.path, row); touched = true; }
      } catch (checkError) {
        // A model that cannot be inspected is not remembered: the next attempt should try
        // again rather than repeat the failure from store.
        const findings = [{ level: "error", code: "inspect-failed", label: "Could not inspect", detail: checkError.message }];
        results.push({ name, path: "", group: "", format: "", findings, ...summarise(findings) });
        fresh += 1;
      }
    }
    if (touched) checkCache.write(ROOT, stored);
    const failing = results.filter(item => item.errors).length;
    return json(response, 200, { checked: results.length, requested: wanted.length, reused, fresh, failing,
      warning: results.filter(item => item.warnings).length, models: results });
  }
  if (request.method === "POST" && url.pathname === "/api/models/inspect") return json(response, 200, await models.inspect((await body(request)).modelPath));
  if (request.method === "GET" && url.pathname === "/api/materials") {
    const environment = renderEnvironment(url.searchParams.get("environment"));
    return json(response, 200, { materials: unrealMaterials(environment), renderEnvironment: publicRenderEnvironment(environment) });
  }
  if (request.method === "POST" && url.pathname === "/api/materials/refresh") {
    const environment = renderEnvironment(url.searchParams.get("environment"));
    const previous = unrealMaterialCache.get(environment.id) || null;
    const previousNames = new Set((previous || []).map(asset => asset.path.toLowerCase()));
    unrealMaterialCache.delete(environment.id);
    const materials = unrealMaterials(environment);
    const currentNames = new Set(materials.map(asset => asset.path.toLowerCase()));
    const added = previous ? materials.filter(asset => !previousNames.has(asset.path.toLowerCase())).length : 0;
    const removed = previous ? previous.filter(asset => !currentNames.has(asset.path.toLowerCase())).length : 0;
    return json(response, 200, { materials, count: materials.length, added, removed, renderEnvironment: publicRenderEnvironment(environment) });
  }
  if (request.method === "POST" && url.pathname === "/api/preflight") return json(response, 200, await preflight(await body(request)));
  if (request.method === "POST" && url.pathname === "/api/sheet/refresh") return json(response, 200, await sheet.refresh());
  if (request.method === "POST" && url.pathname === "/api/jobs") {
    const requested = await body(request), input = { ...requested, renderEnvironment: renderEnvironment(requested.renderEnvironment).id };
    const selections = input.models?.length ? input.models : [{ modelPath: input.modelPath, dimensions: input.dimensions, importYaw: input.importYaw }];
    const entries = [], cropStore = readCropProfiles(ROOT), rig = sheet.rig(), shadowConfig = loadPostProcessConfig(ROOT);
    for (const selection of selections) {
      const model = await models.inspect(selection.modelPath);
      const side = input.side === "auto" || !input.side ? model.side : String(input.side).toUpperCase();
      // Only a sectional has handedness; demanding it of a sofa refuses a perfectly good model.
      if (productType(input.productType || model.group).requiresSide && !["R", "L", "U"].includes(side)) {
        throw new Error(`Could not determine L, R, or U form factor for ${model.name}`);
      }
      const fingerprint = modelFingerprint(model.path);
      const tokenPairs = Object.fromEntries((input.cameras || []).map(camera => [camera, cropContextTokensFor({ input, selection, model, side, fingerprint, camera, rig, shadowConfig })]));
      const cropContextTokens = Object.fromEntries(Object.entries(tokenPairs).map(([camera, tokens]) => [camera, tokens.current]));
      const cropProfiles = Object.fromEntries(Object.entries(tokenPairs).map(([camera, tokens]) => [camera, cropProfileForContext(cropStore, fingerprint, camera, tokens)]).filter(([, profile]) => profile));
      entries.push({ model, input: { ...input, ...selection, side, dimensions: selection.dimensions || model.dimensions, importYaw: selection.importYaw ?? model.importYaw, modelFingerprint: fingerprint, cropProfiles, cropContextTokens } });
    }
    const result = writeBatchJob(ROOT, entries, rig);
    const cameraCount = result.job.tasks.reduce((total, task) => total + task.sequence.cameras.length, 0);
    return json(response, 201, { jobPath: result.jobPath, outputFolder: result.outputFolder, modelCount: result.job.tasks.length, cameraCount, lightSource: sheet.source, renderEnvironment: input.renderEnvironment });
  }
  if (request.method === "POST" && url.pathname === "/api/renders") {
    if (child || activeRun || postProcessPromise) return error(response, 409, render.phase === "Post-processing" ? "Post-processing is still running" : render.state === "running" ? "A render is already running" : "Unreal Editor is still closing");
    const input = await body(request), jobPath = path.resolve(String(input.jobPath || "")), jobsRoot = path.join(ROOT, "local", "jobs", "generated");
    if (!within(jobPath, jobsRoot) || !fs.existsSync(jobPath)) return error(response, 400, "Only generated local job files can be launched");
    const job = JSON.parse(fs.readFileSync(jobPath, "utf8"));
    const environment = environmentForJob(job, RENDER_ENVIRONMENTS), fitToken = cameraFitRendererToken(environment);
    if (!fs.existsSync(environment.editor) || !fs.existsSync(environment.project)) return error(response, 503, `${environment.label} or its project was not found`);
    const rendersRoot = path.join(ROOT, "local", "renders"), outputFolder = path.resolve(String(job._rhLocal?.outputFolder || ""));
    if (!within(outputFolder, rendersRoot)) return error(response, 400, "Job output must stay inside RH_Local_Renders/local/renders");
    const phases = buildRenderPlan(job), cachedFits = cameraFitStatesForJob(ROOT, job, { projectPath: environment.project, rendererToken: fitToken });
    const maxPhaseRestarts = job._rhLocal?.disableAutomaticRestarts === true ? 0 : MAX_PHASE_RESTARTS;
    activeRun = { job, jobPath, outputFolder, environment, before: input.resume ? new Map() : imageSnapshot(outputFolder), phases, index: 0, cameraStates: new Map(), phaseRestarts: new Map(), maxPhaseRestarts };
    const queue = (job.tasks || []).map(task => ({ name: task.taskId, state: "queued" }));
    const totalRenders = phases.reduce((total, phase) => total + (phase.job.tasks || []).reduce((phaseTotal, task) => phaseTotal + taskLayerExpected(task, phase.layerName || phase.name), 0), 0);
    const nativeShadowDiagnostics = environment.id === "ue58" && job._rhLocal?.nativeShadowDiagnostics === true;
    render = { state: "running", pid: null, jobPath, startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, rendered: 0, totalRenders, currentTask: null, currentCamera: null, message: input.resume ? "Resuming completed files" : "Queued", queue, phase: null, phaseIndex: 0, phaseCount: phases.length, substrate: null, environment: publicRenderEnvironment(environment), autoRestarts: 0, log: `Queued ${phases.map(phase => phase.name).join(" → ")} render plan for ${environment.label}${input.resume ? " in resume mode" : ""}.\nPersistent camera-fit cache: ${cachedFits.hits}/${cachedFits.total} exact-frame records available for diagnostics; every Fabric phase calculates a fresh Fit.\nShadow alpha: ${environment.recoverLegacyShadow ? "Legacy Composure recovery" : "native Composite output"}.\nNative Shadow diagnostics: ${nativeShadowDiagnostics ? "ON via process-local -ExecCmds" : "OFF"}.\nAutomatic phase restarts: ${maxPhaseRestarts}.\nLocal BatchRender API: http://${HOST}:${PORT}/api/unreal\n` };
    refreshRunProgress();
    startRenderPhase();
    return json(response, 202, currentRender());
  }
  if (request.method === "POST" && url.pathname === "/api/renders/delete") {
    if (child || activeRun || postProcessPromise) return error(response, 409, "Finish or stop the running render before deleting anything");
    const input = await body(request), rendersRoot = path.join(ROOT, "local", "renders"), jobsRoot = path.join(ROOT, "local", "jobs", "generated");
    if (input.file) {
      // Accept the same renders-root-relative form the file URLs hand out, so the page can
      // delete exactly what it just displayed without knowing the absolute layout.
      const asked = String(input.file);
      const file = path.isAbsolute(asked) ? path.resolve(asked) : path.resolve(rendersRoot, asked);
      if (!within(file, rendersRoot)) return error(response, 400, "Only files under local/renders can be deleted");
      if (!fs.existsSync(file)) return error(response, 404, "That render is already gone");
      // The proxy and the processed copy are derived from this frame, so they go with it
      // rather than dangling as previews of nothing.
      const removed = [file, previewFileFor(file), processedPathFor(file)].filter(target => fs.existsSync(target));
      for (const target of removed) fs.rmSync(target, { force: true });
      return json(response, 200, { deleted: removed.map(target => path.relative(rendersRoot, target)), kind: "file" });
    }
    const jobPath = path.resolve(String(input.jobPath || ""));
    if (!within(jobPath, jobsRoot) || !fs.existsSync(jobPath)) return error(response, 400, "Only generated local job files can be deleted");
    let outputFolder = "";
    try { outputFolder = path.resolve(String(JSON.parse(fs.readFileSync(jobPath, "utf8"))._rhLocal?.outputFolder || "")); } catch { outputFolder = ""; }
    const deleted = [];
    if (outputFolder && within(outputFolder, rendersRoot) && fs.existsSync(outputFolder)) {
      fs.rmSync(outputFolder, { recursive: true, force: true });
      deleted.push(path.relative(rendersRoot, outputFolder));
    }
    if (!input.keepJob) { fs.rmSync(jobPath, { force: true }); deleted.push(path.relative(ROOT, jobPath)); }
    updateCatalog(jobPath);
    return json(response, 200, { deleted, kind: input.keepJob ? "renders" : "batch" });
  }
  if (request.method === "POST" && url.pathname === "/api/renders/stop") {
    if (!activeRun && !child) return error(response, 409, postProcessPromise ? "Post-processing cannot be interrupted; it finishes on its own" : "No render is running");
    const doomed = child, stoppedDuring = render.phase || "render";
    // Dropping the run first is what disarms the automatic phase restart: the exit handler
    // bails out on a missing activeRun instead of resuming the phase for another try.
    activeRun = null; bridge = null;
    render.state = "stopped"; render.finishedAt = new Date().toISOString(); render.pid = null;
    render.message = `Stopped by hand during ${stoppedDuring}`;
    appendRenderLog(`
Forced stop during ${stoppedDuring}. Unreal is being killed and the run is abandoned; files already on disk stay, so a resume can skip them.
`);
    if (doomed) {
      doomed.kill();
      // Unreal shrugs off a polite kill often enough that the tree kill is worth keeping as a fallback.
      const pid = doomed.pid;
      setTimeout(() => {
        try { process.kill(pid, 0); } catch { return; }
        appendRenderLog(`Unreal ignored the stop; forcing the process tree down.
`);
        const forced = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
        forced.on("error", () => {});
      }, 4000).unref?.();
      if (child === doomed) child = null;
    }
    return json(response, 200, currentRender());
  }
  if (request.method === "GET" && url.pathname === "/api/renders/status") return json(response, 200, currentRender());
  if (request.method === "POST" && url.pathname === "/api/postprocess") {
    if (child || activeRun || postProcessPromise) return error(response, 409, "A render or post-process operation is already running");
    const input = await body(request), jobPath = path.resolve(String(input.jobPath || "")), jobsRoot = path.join(ROOT, "local", "jobs", "generated");
    if (!within(jobPath, jobsRoot) || !fs.existsSync(jobPath)) return error(response, 400, "Only generated local job files can be post-processed");
    const job = JSON.parse(fs.readFileSync(jobPath, "utf8")), files = originalFilesForJob(job);
    if (!files.length) return error(response, 400, "This job has no original PNG files to post-process");
    render = { state: "running", pid: null, jobPath, startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, rendered: 0, totalRenders: 0, queue: [], phase: null, phaseIndex: 0, phaseCount: 0, substrate: null, autoRestarts: 0, log: "Manual post-process requested from render history.\n" };
    startPostProcessing(job, jobPath, files, { automatic: false, environment: environmentForJob(job, RENDER_ENVIRONMENTS) });
    return json(response, 202, currentRender());
  }
  if (request.method === "GET" && url.pathname === "/api/history") {
    // Timing rides along with the archive: what each job took, and -- from every run so far
    // -- what a frame of each layer costs, so a job that has never run can be estimated.
    const runs = runStats.readRuns(ROOT), summary = runStats.summarise(runs);
    const byJob = new Map(runs.map(run => [run.jobId, run]));
    const batches = history(ROOT, currentRender()).map(batch => {
      const run = byJob.get(batch.id);
      let job = null;
      if (!run) { try { job = JSON.parse(fs.readFileSync(batch.jobPath, "utf8")); } catch { job = null; } }
      return { ...batch,
        timing: run ? { seconds: run.seconds, phases: run.phases, at: run.finishedAt } : null,
        estimate: run ? null : (job ? runStats.estimateFor(job, summary) : null) };
    });
    return json(response, 200, { batches, timing: summary });
  }
  if (request.method === "GET" && url.pathname === "/api/jobs/file") {
    const jobsRoot = path.join(ROOT, "local", "jobs", "generated"), file = path.resolve(jobsRoot, url.searchParams.get("path") || "");
    if (!within(file, jobsRoot) || !file.toLowerCase().endsWith(".job.json")) return error(response, 403, "Job file is outside the generated jobs folder");
    return sendFile(response, file);
  }
  if (request.method === "POST" && url.pathname === "/api/local/open") {
    const input = await body(request), jobsRoot = path.join(ROOT, "local", "jobs", "generated"), rendersRoot = path.join(ROOT, "local", "renders");
    const target = path.resolve(String(input.path || "")), action = String(input.action || "");
    if (action === "showJob") {
      if (!within(target, jobsRoot) || !target.toLowerCase().endsWith(".job.json") || !fs.existsSync(target)) return error(response, 403, "Only generated job files can be shown");
      const explorer = spawn("explorer.exe", ["/select,", target], { detached: true, stdio: "ignore", windowsHide: false }); explorer.on("error", () => {}); explorer.unref();
    } else if (action === "openRenders") {
      if (!within(target, rendersRoot) || !fs.existsSync(target) || !fs.statSync(target).isDirectory()) return error(response, 403, "Only local render folders can be opened");
      const explorer = spawn("explorer.exe", [target], { detached: true, stdio: "ignore", windowsHide: false }); explorer.on("error", () => {}); explorer.unref();
    } else return error(response, 400, "Unknown local open action");
    return json(response, 200, { ok: true });
  }
  if (request.method === "GET" && url.pathname === "/api/catalog") return json(response, 200, readCatalog());
  if (request.method === "GET" && url.pathname === "/api/renders/file") {
    const rendersRoot = path.join(ROOT, "local", "renders"), file = path.resolve(rendersRoot, url.searchParams.get("path") || "");
    if (!within(file, rendersRoot)) return error(response, 403, "Render file is outside the local output folder"); return sendFile(response, file);
  }
  return error(response, 404, "Unknown API route");
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${HOST}:${PORT}`);
    if (request.method === "OPTIONS") { response.writeHead(204, corsHeaders(request.headers.origin)); return response.end(); }
    if (url.pathname.startsWith("/api/")) return await api(request, response, url);
    const publicPath = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    const file = path.resolve(ROOT, publicPath);
    if (!within(file, ROOT) || file.includes(`${path.sep}local${path.sep}`) || file.includes(`${path.sep}.git${path.sep}`)) return error(response, 403, "Forbidden");
    return sendFile(response, file);
  } catch (requestError) { return error(response, 500, requestError.message); }
});

server.listen(PORT, HOST, () => {
  console.log(`RH Local Renders: http://${HOST}:${PORT}`);
  sheet.refresh().then(status => console.log(`Google Sheets live: ${status.rows} rows`)).catch(refreshError => console.warn(`Google Sheets fallback: ${refreshError.message}`));
});
