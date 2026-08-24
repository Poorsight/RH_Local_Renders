"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { SheetStore } = require("./lib/rig.cjs");
const { ModelStore } = require("./lib/models.cjs");
const { writeJob } = require("./lib/jobs.cjs");

const ROOT = __dirname;
const HOST = "127.0.0.1";
const PORT = Number(process.env.RH_LOCAL_RENDERS_PORT || 5500);
const UNREAL_EDITOR = process.env.RH_UNREAL_EDITOR || "D:\\Unreal_Engine\\UE_5.6\\Engine\\Binaries\\Win64\\UnrealEditor.exe";
const UNREAL_PROJECT = process.env.RH_UNREAL_PROJECT || "D:\\GitHub\\rh_unreal_2\\rh_unreal_2.uproject";
const sheet = new SheetStore(ROOT), models = new ModelStore(ROOT);
let render = { state: "idle", pid: null, jobPath: null, startedAt: null, finishedAt: null, exitCode: null, log: "" };
let child = null;

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
    const job = JSON.parse(fs.readFileSync(jobPath, "utf8")), task = job.tasks[0], metadata = job._rhLocal || {};
    const images = scanImages(metadata.outputFolder); if (!images.length) return;
    const catalogPath = path.join(ROOT, "local", "catalog.json");
    const catalog = fs.existsSync(catalogPath) ? JSON.parse(fs.readFileSync(catalogPath, "utf8")) : { models: [] };
    const entry = { name: task.taskId, modelPath: task.model.objPath, dimensions: metadata.dimensions, side: metadata.side, renders: images, updatedAt: new Date().toISOString() };
    const index = catalog.models.findIndex(item => item.modelPath === entry.modelPath); if (index >= 0) catalog.models[index] = entry; else catalog.models.unshift(entry);
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
  if (request.method === "GET" && url.pathname === "/api/status") return json(response, 200, {
    project: "RH_Local_Renders", models: models.list(), sheet: sheet.status(),
    unreal: { editor: UNREAL_EDITOR, project: UNREAL_PROJECT, available: fs.existsSync(UNREAL_EDITOR) && fs.existsSync(UNREAL_PROJECT) }, render: currentRender()
  });
  if (request.method === "POST" && url.pathname === "/api/models/inspect") return json(response, 200, models.inspect((await body(request)).modelPath));
  if (request.method === "POST" && url.pathname === "/api/sheet/refresh") return json(response, 200, await sheet.refresh());
  if (request.method === "POST" && url.pathname === "/api/jobs") {
    const input = await body(request), model = models.inspect(input.modelPath), result = writeJob(ROOT, input, model, sheet.rig());
    return json(response, 201, { jobPath: result.jobPath, outputFolder: result.outputFolder, cameraCount: result.job.tasks[0].sequence.cameras.length, lightSource: sheet.source });
  }
  if (request.method === "POST" && url.pathname === "/api/renders") {
    if (child && render.state === "running") return error(response, 409, "A render is already running");
    const input = await body(request), jobPath = path.resolve(String(input.jobPath || "")), jobsRoot = path.join(ROOT, "local", "jobs", "generated");
    if (!within(jobPath, jobsRoot) || !fs.existsSync(jobPath)) return error(response, 400, "Only generated local job files can be launched");
    if (!fs.existsSync(UNREAL_EDITOR) || !fs.existsSync(UNREAL_PROJECT)) return error(response, 503, "Unreal Editor 5.6 or rh_unreal_2.uproject was not found");
    const args = [UNREAL_PROJECT, "-BatchRender", `-BatchRenderJob=${jobPath}`, "-BatchRenderExitOnComplete", "-log", "-stdout", "-FullStdOutLogOutput"];
    child = spawn(UNREAL_EDITOR, args, { shell: false, windowsHide: false, stdio: ["ignore", "pipe", "pipe"] });
    render = { state: "running", pid: child.pid, jobPath, startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, log: `Launching ${UNREAL_EDITOR}\n${args.join(" ")}\n` };
    const append = chunk => { render.log = `${render.log}${chunk}`.slice(-50000); }; child.stdout.on("data", append); child.stderr.on("data", append);
    child.on("error", launchError => { append(`\n${launchError.message}`); render.state = "failed"; render.finishedAt = new Date().toISOString(); child = null; });
    child.on("exit", code => { render.exitCode = code; render.finishedAt = new Date().toISOString(); render.state = code === 0 ? "success" : "failed"; if (code === 0) updateCatalog(jobPath); child = null; });
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
