"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { SheetStore } = require("./lib/rig.cjs");
const { ModelStore } = require("./lib/models.cjs");
const { productType, writeBatchJob } = require("./lib/jobs.cjs");
const { buildRenderPlan, cameraStateKey, applyCameraHandoff } = require("./lib/render-plan.cjs");
const { siblingBranch, isInBranch } = require("./lib/output-layout.cjs");
const { publishPreviews, previewFileFor } = require("./lib/preview.cjs");
const { checkModel, summarise } = require("./lib/model-check.cjs");
const { inspectObjParts, normalizeObjParts, writeMaterialLibrary } = require("./lib/obj-parts.cjs");
const { modelFingerprint, readCropProfiles, writeCropProfiles, cropProfileFor, analyzeCalibrationPair, applyCropProfileToCamera, calibrationFiles } = require("./lib/crop.cjs");
const { rendererToken, readCameraFitProfiles, cameraFitStatesForJob, writeCameraFitState } = require("./lib/camera-fit.cjs");
const { buildUnrealLaunch } = require("./lib/unreal.cjs");
const { history, expectedRenders } = require("./lib/history.cjs");
const { availability: postProcessAvailability, isProcessedImage, originalFilesForJob, processJob, processedPathFor } = require("./lib/post-process.cjs");

const ROOT = __dirname;
const HOST = "127.0.0.1";
const PORT = Number(process.env.RH_LOCAL_RENDERS_PORT || 5500);
const UNREAL_EDITOR = process.env.RH_UNREAL_EDITOR || "D:\\Unreal_Engine\\UE_5.6\\Engine\\Binaries\\Win64\\UnrealEditor.exe";
const UNREAL_PROJECT = process.env.RH_UNREAL_PROJECT || "D:\\GitHub\\rh_unreal_2\\rh_unreal_2.uproject";
const CAMERA_FIT_RENDERER_TOKEN = rendererToken(UNREAL_PROJECT);
const sheet = new SheetStore(ROOT), models = new ModelStore(ROOT);
const RUNTIME_FILES = [
  "server.cjs", "package.json", "data/postprocess.json", "assets/AdobeRGB1998.icc", "lib/camera-fit.cjs", "lib/crop.cjs", "lib/csv.cjs", "lib/history.cjs", "lib/jobs.cjs", "lib/models.cjs", "lib/post-process.cjs", "lib/render-plan.cjs",
  "lib/rig.cjs", "lib/unreal.cjs", "scripts/inspect_fbx.py"
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
const MAX_PHASE_RESTARTS = 3;
let render = { state: "idle", pid: null, jobPath: null, startedAt: null, finishedAt: null, exitCode: null, log: "" };
let child = null, bridge = null, activeRun = null, lastUnrealContactAt = null;
let postProcessPromise = null;
let unrealMaterialCache = null;

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
    ? (task.materials || []).reduce((product, group) => product * Math.max(group.list?.length || 0, 1), 1)
    : 1;
  return cameras * variants;
};
const taskOutputFolder = (task, layerName) => path.resolve(String((task.layers || []).find(layer => String(layer.name || "").toLowerCase() === layerName.toLowerCase())?.output?.folder || ""));
const runProducedImages = (run, folder, layerName, calibration = false) => scanImages(folder).filter(file => {
  const isCalibration = isInBranch(file, "calibration");
  return isCalibration === calibration && imageLayer(file) === layerName && run.before.get(file) !== `${fs.statSync(file).size}:${fs.statSync(file).mtimeMs}`;
});

function phaseTaskProgress(run, phase) {
  const layerName = phase.layerName || phase.name;
  return (phase?.job?.tasks || []).map(task => {
    const expected = taskLayerExpected(task, layerName), folder = taskOutputFolder(task, layerName);
    const rendered = folder && fs.existsSync(folder) ? runProducedImages(run, folder, layerName, Boolean(phase.isCalibration)).length : 0;
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
  activeRun = null; bridge = null;
  if (!succeeded) {
    render.state = "failed"; render.finishedAt = new Date().toISOString();
    return;
  }
  if (run.cameraStates.size) {
    run.job._rhLocal = { ...(run.job._rhLocal || {}), cameraStates: Object.fromEntries(run.cameraStates), cameraFitRendererToken: CAMERA_FIT_RENDERER_TOKEN };
    fs.writeFileSync(run.jobPath, `${JSON.stringify(run.job, null, 2)}\n`, "utf8");
  }
  updateCatalog(run.jobPath);
  startPostProcessing(run.job, run.jobPath, deliverables, { automatic: true, cameraStates: run.cameraStates });
}

function startPostProcessing(job, jobPath, files, options = {}) {
  if (postProcessPromise) throw new Error("Post-processing is already running");
  if (!files.length) throw new Error("No original PNG files were found for post-processing");
  const startedAt = new Date().toISOString(), phaseCount = Math.max(Number(render.phaseCount) || 0, 1) + (options.automatic ? 1 : 0);
  render.state = "running"; render.pid = null; render.jobPath = jobPath; render.finishedAt = null; render.phase = "Post-processing";
  render.phaseIndex = phaseCount; render.phaseCount = phaseCount; render.substrate = null; render.currentTask = null; render.currentCamera = null;
  render.message = `Preparing ${files.length} delivery image${files.length === 1 ? "" : "s"}`;
  render.postProcess = { state: "running", completed: 0, total: files.length, startedAt, automatic: Boolean(options.automatic) };
  appendRenderLog(`Starting post-process for ${files.length} original PNG${files.length === 1 ? "" : "s"}: transparent 15000x5000 canvas, AdobeRGB1998, 300 DPI, and Shadow delivery treatment. Originals stay unchanged.\n`);
  let readyToUpload = null;
  postProcessPromise = processJob(ROOT, job, {
    files,
    cameraStates: options.cameraStates,
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
    appendRenderLog(`Post-process complete: ${created} created, ${skipped} already current. RAW originals stay untouched; processed files are isolated in ${readyToUpload?.folder || "POST"} (${readyToUpload?.files || 0} files).\n`);
    // Proxies for the gallery: small enough to serve over the web, generated from the raw
    // frames the gallery already shows rather than from the 75 Mpx delivery canvases.
    const proxies = publishPreviews(files);
    render.postProcess = { ...render.postProcess, previews: proxies };
    appendRenderLog(`Previews: ${proxies.created} created, ${proxies.skipped} already current${proxies.failed.length ? `, ${proxies.failed.length} failed` : ""}.\n`);
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
      const profile = { ...analyzeCalibrationPair(files.fabric, files.shadow), fingerprint, camera: camera.name, modelName: task.taskId, modelPath: task.model?.objPath || "" };
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

function advancePhaseOrFinish(message) {
  if (!activeRun) return;
  refreshRunProgress();
  const phase = activeRun.phases[activeRun.index], remaining = phaseTaskProgress(activeRun, phase).filter(item => !item.complete);
  if (remaining.length) return restartRenderPhase(`${message}; ${remaining.length} incomplete model${remaining.length === 1 ? "" : "s"}`);
  if (phase.isCalibration && phase.layerName === "Shadow") {
    try { finalizeCropCalibration(activeRun); }
    catch (calibrationError) { return finishRun("failed", calibrationError.message); }
  }
  if (activeRun.index + 1 < activeRun.phases.length) {
    activeRun.index += 1; render.pid = null; render.phase = `Preparing ${activeRun.phases[activeRun.index].name}`; render.phaseIndex = activeRun.index + 1; render.substrate = null; render.currentTask = null;
    appendRenderLog(`${phase.name} is complete. Restarting Unreal for ${activeRun.phases[activeRun.index].name} with Substrate ${activeRun.phases[activeRun.index].substrate ? "ON" : "OFF"}.\n`);
    setTimeout(startRenderPhase, 300);
  } else finishRun("success", `${activeRun.phases.length} phase${activeRun.phases.length === 1 ? "" : "s"} completed`);
}

function restartRenderPhase(reason) {
  if (!activeRun) return;
  const phase = activeRun.phases[activeRun.index], used = activeRun.phaseRestarts.get(phase.name) || 0;
  refreshRunProgress();
  if (used >= MAX_PHASE_RESTARTS) return finishRun("failed", `${phase.name} stopped after ${used} automatic restarts: ${reason}`);
  activeRun.phaseRestarts.set(phase.name, used + 1); render.pid = null; render.phase = `Restarting ${phase.name}`; render.autoRestarts = (render.autoRestarts || 0) + 1; render.message = `Unreal exited · resuming incomplete models (${used + 1}/${MAX_PHASE_RESTARTS})`;
  appendRenderLog(`\nUnreal interruption: ${reason}. Automatic ${phase.name} resume ${used + 1}/${MAX_PHASE_RESTARTS}; completed models stay skipped.\n`);
  setTimeout(startRenderPhase, 2500);
}

function startRenderPhase() {
  if (!activeRun) return;
  const phase = activeRun.phases[activeRun.index], apiUrl = `http://${HOST}:${PORT}/api/unreal`;
  let phaseJob = remainingPhaseJob(activeRun, phase);
  if (!phaseJob.tasks.length) return advancePhaseOrFinish(`${phase.name} already complete`);
  const canApplyPersistentFits = phase.layerName === "Fabric" && activeRun.cachedCameraStateKeys.size > 0;
  if (phase.useCameraHandoff || canApplyPersistentFits) {
    const handoff = applyCameraHandoff(phaseJob, activeRun.cameraStates);
    if (phase.useCameraHandoff && handoff.missing.length) return finishRun("failed", `Fabric camera handoff missing for ${handoff.missing.join(", ")}`);
    phaseJob = handoff.job;
    if (handoff.applied.length) {
      const source = phase.layerName === "Fabric" && canApplyPersistentFits ? "persistent camera-fit cache" : "Fabric handoff";
      appendRenderLog(`Applied ${handoff.applied.length} camera state${handoff.applied.length === 1 ? "" : "s"} from ${source} to ${phase.name}; fit disabled for cached views${handoff.missing.length ? `, ${handoff.missing.length} view${handoff.missing.length === 1 ? "" : "s"} will calculate Fit` : ""}.\n`);
    }
  }
  bridge = { job: phaseJob, jobPath: activeRun.jobPath, outputFolder: activeRun.outputFolder, before: imageSnapshot(activeRun.outputFolder), delivered: false, completed: false, success: false, phase, exitHandled: false };
  const phaseBridge = bridge, launch = buildUnrealLaunch(UNREAL_EDITOR, UNREAL_PROJECT, apiUrl, { substrate: phase.substrate });
  appendRenderLog(`\nStarting ${phase.name} phase ${activeRun.index + 1}/${activeRun.phases.length}; ${phaseJob.tasks.length} incomplete model${phaseJob.tasks.length === 1 ? "" : "s"}; Substrate ${phase.substrate ? "ON" : "OFF"}.\n${launch.command}\n${launch.args.join(" ")}\n`);
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
const holdsClass = (buffer, className) => buffer.includes(` ${className} `, 0, "latin1");

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

function unrealMaterials() {
  if (unrealMaterialCache) return unrealMaterialCache;
  const projectRoot = path.dirname(UNREAL_PROJECT);
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
  unrealMaterialCache = records.sort((left, right) => left.name.localeCompare(right.name));
  return unrealMaterialCache;
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
  const cameras = Array.isArray(input.cameras) ? input.cameras.filter(value => ["F", "FH", "TQ"].includes(value)) : [];
  const layers = Array.isArray(input.layers) ? input.layers.filter(value => ["Fabric", "Shadow"].includes(value)) : [];
  checks.push(cameras.length ? { id: "cameras", level: "ok", label: "Cameras", detail: cameras.join(" · ") } : { id: "cameras", level: "error", label: "Cameras", detail: "Select at least one camera." });
  const shadowOnly = layers.includes("Shadow") && !layers.includes("Fabric");
  checks.push(layers.length ? { id: "layers", level: "ok", label: "Layers", detail: shadowOnly ? "Shadow · automatic 500×500 Fabric camera prefit" : layers.join(" → ") } : { id: "layers", level: "error", label: "Layers", detail: "Select at least one layer." });
  let cropCalibrations = 0;
  if (String(input.cropMode || "full").toLowerCase() === "optimized" && inspected.length && cameras.length) {
    const cropStore = readCropProfiles(ROOT);
    for (const model of inspected) {
      const fingerprint = modelFingerprint(model.path);
      cropCalibrations += cameras.filter(camera => !cropProfileFor(cropStore, fingerprint, camera)).length;
    }
    checks.push(cropCalibrations
      ? { id: "crop", level: "warning", label: "Optimized crop", detail: `${cropCalibrations} model/camera pair${cropCalibrations === 1 ? "" : "s"} will run one-time 500px Fabric + Shadow calibration before final renders.` }
      : { id: "crop", level: "ok", label: "Optimized crop", detail: "Every selected model/camera pair has a saved safe crop profile." });
  } else checks.push({ id: "crop", level: "ok", label: "Frame crop", detail: "Full frame · original resolution and sensor aspect." });
  const assets = unrealMaterials(), assetNames = new Map(assets.map(asset => [asset.name.toLowerCase(), asset]));
  const assigned = Array.isArray(input.materials) ? input.materials : [];
  if (!assigned.length || assigned.some(row => !String(row.material || "").trim())) checks.push({ id: "materials", level: "error", label: "Materials", detail: "Complete every material assignment." });
  else {
    const missing = assigned.map(row => String(row.material).trim()).filter(name => !assetNames.has(name.toLowerCase()));
    checks.push(missing.length ? { id: "materials", level: "error", label: "Materials", detail: `Not found in Unreal: ${missing.join(", ")}` } : { id: "materials", level: "ok", label: "Materials", detail: `${assigned.length} assignment${assigned.length === 1 ? "" : "s"} found in Unreal Content.` });
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
  const pluginRoot = path.join(path.dirname(UNREAL_PROJECT), "Plugins", "BatchRender"), markerFile = path.join(pluginRoot, "Source", "BatchRenderEditor", "Public", "JobModel.h");
  const bridgeSource = fs.existsSync(markerFile) && fs.readFileSync(markerFile, "utf8").includes("CameraFocalHandoffVersion");
  const sourceTime = latestModified(path.join(pluginRoot, "Source"), [".h", ".cpp"]), binaryRelative = [path.join("Binaries", "Win64", "UnrealEditor-BatchRender.dll"), path.join("Binaries", "Win64", "UnrealEditor-BatchRenderEditor.dll")], binaryFiles = binaryRelative.map(file => path.join(pluginRoot, file));
  const runtimeRelative = [path.join("Source", "BatchRenderEditor", "Public", "JobModel.h"), path.join("Source", "BatchRenderEditor", "Private", "JobModel.cpp"), path.join("Source", "BatchRender", "Private", "BatchRender.cpp"), ...binaryRelative];
  const binariesCurrent = pluginRuntimeIsCommitted(pluginRoot, runtimeRelative) || binaryFiles.every(file => fs.existsSync(file) && fs.statSync(file).mtimeMs >= sourceTime);
  const bridgeReady = bridgeSource && binariesCurrent;
  const bridgeDetail = !bridgeSource ? "BatchRender camera handoff is not installed." : !binariesCurrent ? "BatchRender camera handoff must be rebuilt." : "Editor, project, and Fabric camera handoff are ready.";
  checks.push(fs.existsSync(UNREAL_EDITOR) && fs.existsSync(UNREAL_PROJECT) ? { id: "unreal", level: bridgeReady ? "ok" : "error", label: "Unreal", detail: bridgeDetail } : { id: "unreal", level: "error", label: "Unreal", detail: "Editor or project file is missing." });
  try { fs.accessSync(path.join(ROOT, "local", "renders"), fs.constants.W_OK); checks.push({ id: "output", level: "ok", label: "Output", detail: "Local render folder is writable." }); }
  catch { checks.push({ id: "output", level: "error", label: "Output", detail: "Local render folder is not writable." }); }
  const post = postProcessAvailability(ROOT);
  checks.push(post.ok ? { id: "postprocess", level: "ok", label: "Post-process", detail: "libvips and AdobeRGB1998 are ready; originals will be preserved." } : { id: "postprocess", level: "error", label: "Post-process", detail: post.error });
  const expected = inspected.length * cameras.length * layers.length;
  return { ok: !checks.some(check => check.level === "error"), checks, counts: { models: inspected.length, cameras: cameras.length, layers: layers.length, expectedRenders: expected, cropCalibrations }, materials: assets.length };
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
        const saved = writeCameraFitState(ROOT, activeRun.job, data.taskId, sequenceName, state, { projectPath: UNREAL_PROJECT, rendererToken: CAMERA_FIT_RENDERER_TOKEN });
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
  if (request.method === "GET" && url.pathname === "/api/status") return json(response, 200, {
    project: "RH_Local_Renders", models: models.list(), sheet: sheet.status(),
    unreal: { editor: UNREAL_EDITOR, project: UNREAL_PROJECT, available: fs.existsSync(UNREAL_EDITOR) && fs.existsSync(UNREAL_PROJECT), lastContactAt: lastUnrealContactAt, cameraFitCache: { profiles: Object.keys(readCameraFitProfiles(ROOT).profiles).length, rendererToken: CAMERA_FIT_RENDERER_TOKEN } }, render: currentRender(),
    runtime: { startedAt: RUNTIME_STARTED_AT, sourceToken: RUNTIME_SOURCE_TOKEN, stale: RUNTIME_SOURCE_TOKEN !== runtimeSourceToken() },
    // The same verdict the gate uses, or the page would call itself read-only while acting.
    access: { required: Boolean(ACCESS_KEY), authorized: !ACCESS_KEY || isLocalOperator(request) || timingEqual(presentedKey(request), ACCESS_KEY) }
  });
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
  if (request.method === "POST" && url.pathname === "/api/models/check") {
    // Checks every model on disk, or the ones asked for. Inspecting a model that has never
    // been analysed runs Blender, so this is a deliberate action rather than a page load.
    const input = await body(request);
    const wanted = Array.isArray(input.models) && input.models.length ? input.models : models.list().map(model => model.name);
    const results = [];
    for (const name of wanted) {
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
        results.push({ name, path: record.path, group: record.group || "", format: record.format || "", findings, ...summarise(findings) });
      } catch (checkError) {
        const findings = [{ level: "error", code: "inspect-failed", label: "Could not inspect", detail: checkError.message }];
        results.push({ name, path: "", group: "", format: "", findings, ...summarise(findings) });
      }
    }
    const failing = results.filter(item => item.errors).length;
    return json(response, 200, { checked: results.length, failing, warning: results.filter(item => item.warnings).length, models: results });
  }
  if (request.method === "POST" && url.pathname === "/api/models/inspect") return json(response, 200, await models.inspect((await body(request)).modelPath));
  if (request.method === "GET" && url.pathname === "/api/materials") return json(response, 200, { materials: unrealMaterials() });
  if (request.method === "POST" && url.pathname === "/api/preflight") return json(response, 200, await preflight(await body(request)));
  if (request.method === "POST" && url.pathname === "/api/sheet/refresh") return json(response, 200, await sheet.refresh());
  if (request.method === "POST" && url.pathname === "/api/jobs") {
    const input = await body(request), selections = input.models?.length ? input.models : [{ modelPath: input.modelPath, dimensions: input.dimensions, importYaw: input.importYaw }];
    const entries = [], cropStore = readCropProfiles(ROOT);
    for (const selection of selections) {
      const model = await models.inspect(selection.modelPath);
      const side = input.side === "auto" || !input.side ? model.side : String(input.side).toUpperCase();
      // Only a sectional has handedness; demanding it of a sofa refuses a perfectly good model.
      if (productType(input.productType || model.group).requiresSide && !["R", "L", "U"].includes(side)) {
        throw new Error(`Could not determine L, R, or U form factor for ${model.name}`);
      }
      const fingerprint = modelFingerprint(model.path), cropProfiles = Object.fromEntries((input.cameras || []).map(camera => [camera, cropProfileFor(cropStore, fingerprint, camera)]).filter(([, profile]) => profile));
      entries.push({ model, input: { ...input, ...selection, side, dimensions: selection.dimensions || model.dimensions, importYaw: selection.importYaw ?? model.importYaw, modelFingerprint: fingerprint, cropProfiles } });
    }
    const result = writeBatchJob(ROOT, entries, sheet.rig());
    const cameraCount = result.job.tasks.reduce((total, task) => total + task.sequence.cameras.length, 0);
    return json(response, 201, { jobPath: result.jobPath, outputFolder: result.outputFolder, modelCount: result.job.tasks.length, cameraCount, lightSource: sheet.source });
  }
  if (request.method === "POST" && url.pathname === "/api/renders") {
    if (child || activeRun || postProcessPromise) return error(response, 409, render.phase === "Post-processing" ? "Post-processing is still running" : render.state === "running" ? "A render is already running" : "Unreal Editor is still closing");
    const input = await body(request), jobPath = path.resolve(String(input.jobPath || "")), jobsRoot = path.join(ROOT, "local", "jobs", "generated");
    if (!within(jobPath, jobsRoot) || !fs.existsSync(jobPath)) return error(response, 400, "Only generated local job files can be launched");
    if (!fs.existsSync(UNREAL_EDITOR) || !fs.existsSync(UNREAL_PROJECT)) return error(response, 503, "Unreal Editor 5.6 or rh_unreal_2.uproject was not found");
    const job = JSON.parse(fs.readFileSync(jobPath, "utf8"));
    const rendersRoot = path.join(ROOT, "local", "renders"), outputFolder = path.resolve(String(job._rhLocal?.outputFolder || ""));
    if (!within(outputFolder, rendersRoot)) return error(response, 400, "Job output must stay inside RH_Local_Renders/local/renders");
    const phases = buildRenderPlan(job), cachedFits = cameraFitStatesForJob(ROOT, job, { projectPath: UNREAL_PROJECT, rendererToken: CAMERA_FIT_RENDERER_TOKEN });
    activeRun = { job, jobPath, outputFolder, before: input.resume ? new Map() : imageSnapshot(outputFolder), phases, index: 0, cameraStates: cachedFits.states, cachedCameraStateKeys: new Set(cachedFits.states.keys()), phaseRestarts: new Map() };
    const queue = (job.tasks || []).map(task => ({ name: task.taskId, state: "queued" }));
    const totalRenders = phases.reduce((total, phase) => total + (phase.job.tasks || []).reduce((phaseTotal, task) => phaseTotal + taskLayerExpected(task, phase.layerName || phase.name), 0), 0);
    render = { state: "running", pid: null, jobPath, startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, rendered: 0, totalRenders, currentTask: null, currentCamera: null, message: input.resume ? "Resuming completed files" : "Queued", queue, phase: null, phaseIndex: 0, phaseCount: phases.length, substrate: null, autoRestarts: 0, log: `Queued ${phases.map(phase => phase.name).join(" → ")} render plan${input.resume ? " in resume mode" : ""}.\nPersistent camera-fit cache: ${cachedFits.hits}/${cachedFits.total} views ready.\nLocal BatchRender API: http://${HOST}:${PORT}/api/unreal\n` };
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
    startPostProcessing(job, jobPath, files, { automatic: false });
    return json(response, 202, currentRender());
  }
  if (request.method === "GET" && url.pathname === "/api/history") return json(response, 200, { batches: history(ROOT, currentRender()) });
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
