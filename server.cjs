"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { SheetStore } = require("./lib/rig.cjs");
const { ModelStore } = require("./lib/models.cjs");
const { writeBatchJob } = require("./lib/jobs.cjs");
const { buildUnrealLaunch } = require("./lib/unreal.cjs");

const ROOT = __dirname;
const HOST = "127.0.0.1";
const PORT = Number(process.env.RH_LOCAL_RENDERS_PORT || 5500);
const UNREAL_EDITOR = process.env.RH_UNREAL_EDITOR || "D:\\Unreal_Engine\\UE_5.6\\Engine\\Binaries\\Win64\\UnrealEditor.exe";
const UNREAL_PROJECT = process.env.RH_UNREAL_PROJECT || "D:\\GitHub\\rh_unreal_2\\rh_unreal_2.uproject";
const sheet = new SheetStore(ROOT), models = new ModelStore(ROOT);
const RUNTIME_FILES = [
  "server.cjs", "package.json", "lib/csv.cjs", "lib/jobs.cjs", "lib/models.cjs",
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
let render = { state: "idle", pid: null, jobPath: null, startedAt: null, finishedAt: null, exitCode: null, log: "" };
let child = null, bridge = null, lastUnrealContactAt = null;

const json = (response, status, body) => { response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); response.end(JSON.stringify(body)); };
const error = (response, status, message) => json(response, status, { error: message });
const body = request => new Promise((resolve, reject) => {
  let raw = ""; request.on("data", chunk => { raw += chunk; if (raw.length > 1_000_000) request.destroy(new Error("Request body too large")); });
  request.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error("Invalid JSON body")); } }); request.on("error", reject);
});
const within = (file, root) => { const relative = path.relative(path.resolve(root), path.resolve(file)); return relative && !relative.startsWith("..") && !path.isAbsolute(relative); };
const contentType = file => ({ ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml" })[path.extname(file).toLowerCase()] || "application/octet-stream";
const sendFile = (response, file) => { if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return error(response, 404, "File not found"); response.writeHead(200, { "Content-Type": contentType(file) }); fs.createReadStream(file).pipe(response); };
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

function finishBridge(state, message) {
  if (!bridge || bridge.completed) return;
  const produced = changedImages(bridge.outputFolder, bridge.before);
  bridge.completed = true;
  render.finishedAt = new Date().toISOString();
  render.state = state === "success" && produced.length > 0 ? "success" : "failed";
  appendRenderLog(`\nBatchRender ${state}: ${message}; changed images: ${produced.length}\n`);
  if (render.state === "success") updateCatalog(bridge.jobPath);
  setTimeout(() => {
    if (child) {
      appendRenderLog("Closing Unreal after the local job event.\n");
      child.kill();
    }
  }, 1500);
}

function scanImages(folder) {
  if (!fs.existsSync(folder)) return [];
  const found = [], stack = [folder];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full); else if (/\.(png|jpe?g|webp)$/i.test(entry.name)) found.push(full);
    }
  }
  return found.sort();
}

function updateCatalog(jobPath) {
  try {
    const job = JSON.parse(fs.readFileSync(jobPath, "utf8")), metadata = job._rhLocal || {};
    const catalogPath = path.join(ROOT, "local", "catalog.json");
    const catalog = fs.existsSync(catalogPath) ? JSON.parse(fs.readFileSync(catalogPath, "utf8")) : { models: [] };
    const records = metadata.models || [metadata];
    for (const record of records) {
      const images = scanImages(record.outputFolder); if (!images.length) continue;
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

async function api(request, response, url) {
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
    if (bridge && eventName === "render_finished") render.rendered = Number(render.rendered || 0) + 1;
    if (bridge && eventName === "job_completed" && (!data.jobId || data.jobId === bridge.job.jobId)) finishBridge("success", `job ${data.jobId || bridge.job.jobId} completed`);
    if (bridge && eventName === "error" && (!data.jobId || data.jobId === bridge.job.jobId)) finishBridge("failed", data.error || "plugin reported an error");
    return json(response, 200, { ok: true });
  }
  if (request.method === "GET" && url.pathname === "/api/status") return json(response, 200, {
    project: "RH_Local_Renders", models: models.list(), sheet: sheet.status(),
    unreal: { editor: UNREAL_EDITOR, project: UNREAL_PROJECT, available: fs.existsSync(UNREAL_EDITOR) && fs.existsSync(UNREAL_PROJECT), lastContactAt: lastUnrealContactAt }, render: currentRender(),
    runtime: { startedAt: RUNTIME_STARTED_AT, sourceToken: RUNTIME_SOURCE_TOKEN, stale: RUNTIME_SOURCE_TOKEN !== runtimeSourceToken() }
  });
  if (request.method === "POST" && url.pathname === "/api/models/inspect") return json(response, 200, await models.inspect((await body(request)).modelPath));
  if (request.method === "POST" && url.pathname === "/api/sheet/refresh") return json(response, 200, await sheet.refresh());
  if (request.method === "POST" && url.pathname === "/api/jobs") {
    const input = await body(request), selections = input.models?.length ? input.models : [{ modelPath: input.modelPath, dimensions: input.dimensions, importYaw: input.importYaw }];
    const entries = [];
    for (const selection of selections) {
      const model = await models.inspect(selection.modelPath);
      const side = input.side === "auto" || !input.side ? model.side : String(input.side).toUpperCase();
      if (!["R", "L", "U"].includes(side)) throw new Error(`Could not determine L, R, or U form factor for ${model.name}`);
      entries.push({ model, input: { ...input, ...selection, side, dimensions: selection.dimensions || model.dimensions, importYaw: selection.importYaw ?? model.importYaw } });
    }
    const result = writeBatchJob(ROOT, entries, sheet.rig());
    const cameraCount = result.job.tasks.reduce((total, task) => total + task.sequence.cameras.length, 0);
    return json(response, 201, { jobPath: result.jobPath, outputFolder: result.outputFolder, modelCount: result.job.tasks.length, cameraCount, lightSource: sheet.source });
  }
  if (request.method === "POST" && url.pathname === "/api/renders") {
    if (child) return error(response, 409, render.state === "running" ? "A render is already running" : "Unreal Editor is still closing");
    const input = await body(request), jobPath = path.resolve(String(input.jobPath || "")), jobsRoot = path.join(ROOT, "local", "jobs", "generated");
    if (!within(jobPath, jobsRoot) || !fs.existsSync(jobPath)) return error(response, 400, "Only generated local job files can be launched");
    if (!fs.existsSync(UNREAL_EDITOR) || !fs.existsSync(UNREAL_PROJECT)) return error(response, 503, "Unreal Editor 5.6 or rh_unreal_2.uproject was not found");
    const job = JSON.parse(fs.readFileSync(jobPath, "utf8"));
    const rendersRoot = path.join(ROOT, "local", "renders"), outputFolder = path.resolve(String(job._rhLocal?.outputFolder || ""));
    if (!within(outputFolder, rendersRoot)) return error(response, 400, "Job output must stay inside RH_Local_Renders/local/renders");
    const apiUrl = `http://${HOST}:${PORT}/api/unreal`;
    bridge = { job, jobPath, outputFolder, before: imageSnapshot(outputFolder), delivered: false, completed: false };
    const launch = buildUnrealLaunch(UNREAL_EDITOR, UNREAL_PROJECT, apiUrl);
    child = spawn(launch.command, launch.args, launch.options);
    render = { state: "running", pid: child.pid, jobPath, startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, rendered: 0, log: `Launching ${UNREAL_EDITOR}\n${launch.args.join(" ")}\nLocal BatchRender API: ${apiUrl}\n` };
    child.stdout.on("data", appendRenderLog); child.stderr.on("data", appendRenderLog);
    child.on("error", launchError => { appendRenderLog(`\n${launchError.message}`); render.state = "failed"; render.finishedAt = new Date().toISOString(); child = null; bridge = null; });
    child.on("exit", code => {
      render.exitCode = code;
      if (render.state === "running") { render.state = "failed"; render.finishedAt = new Date().toISOString(); appendRenderLog("\nUnreal exited before job_completed.\n"); }
      child = null; bridge = null;
    });
    return json(response, 202, currentRender());
  }
  if (request.method === "GET" && url.pathname === "/api/renders/status") return json(response, 200, currentRender());
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
