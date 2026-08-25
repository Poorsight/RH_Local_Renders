"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const DEFAULT_CONFIG = {
  canvas: { width: 15000, height: 5000 },
  dpi: 300,
  outputSuffix: "_POST",
  shadow: { color: "#120C06", alphaBoostPercent: { F: 25, FH: 25, TQ: 25 } }
};
const READY_FOLDER_NAME = "_READY_TO_UPLOAD";

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

const isProcessedImage = (file, suffix = DEFAULT_CONFIG.outputSuffix) => new RegExp(`${String(suffix).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.png$`, "i").test(path.basename(file));
const processedPathFor = (file, suffix = DEFAULT_CONFIG.outputSuffix) => path.join(path.dirname(file), `${path.basename(file, path.extname(file))}${suffix}.png`);
const imageLayer = file => /(?:^|_)shadow(?:_|\.)/i.test(path.basename(file)) ? "Shadow" : "Fabric";
const safeDeliverySegment = value => String(value || "model").replace(/[\\/:*?"<>|]/g, "_").replace(/[. ]+$/g, "") || "model";

function loadConfig(root) {
  const file = path.join(root, "data", "postprocess.json");
  if (!fs.existsSync(file)) return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  return {
    ...DEFAULT_CONFIG,
    ...saved,
    canvas: { ...DEFAULT_CONFIG.canvas, ...(saved.canvas || {}) },
    shadow: {
      ...DEFAULT_CONFIG.shadow,
      ...(saved.shadow || {}),
      alphaBoostPercent: { ...DEFAULT_CONFIG.shadow.alphaBoostPercent, ...(saved.shadow?.alphaBoostPercent || {}) }
    }
  };
}

function resolveVips(root) {
  const candidates = [
    process.env.RH_VIPS,
    "C:\\vips\\vips-dev-8.18\\bin\\vips.exe",
    path.join(root, "tools", "vips", "bin", "vips.exe"),
    process.platform === "win32" ? "vips.exe" : "vips"
  ].filter(Boolean);
  return candidates.find(candidate => candidate === "vips" || candidate === "vips.exe" || fs.existsSync(candidate)) || null;
}

function availability(root) {
  const vips = resolveVips(root), profile = path.join(root, "assets", "AdobeRGB1998.icc");
  return { ok: Boolean(vips && fs.existsSync(profile)), vips, profile, error: !vips ? "libvips executable was not found" : !fs.existsSync(profile) ? "AdobeRGB1998.icc is missing" : null };
}

function pngDimensions(file) {
  const header = Buffer.alloc(24), descriptor = fs.openSync(file, "r");
  try { fs.readSync(descriptor, header, 0, header.length, 0); } finally { fs.closeSync(descriptor); }
  if (!header.subarray(0, 8).equals(pngSignature)) throw new Error(`${path.basename(file)} is not a PNG`);
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii"), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function writePngText(file, values) {
  const source = fs.readFileSync(file);
  if (!source.subarray(0, 8).equals(pngSignature)) throw new Error(`${path.basename(file)} is not a PNG`);
  const chunks = [];
  for (const [key, raw] of Object.entries(values)) {
    if (raw == null || raw === "") continue;
    const safeKey = String(key).replace(/[^\x20-\x7e]/g, " ").slice(0, 79), value = String(raw).replace(/[^\x09\x0a\x0d\x20-\xff]/g, "?");
    chunks.push(pngChunk("tEXt", Buffer.concat([Buffer.from(safeKey, "latin1"), Buffer.from([0]), Buffer.from(value, "latin1")])));
  }
  let offset = 8;
  while (offset + 12 <= source.length) {
    const length = source.readUInt32BE(offset), type = source.toString("ascii", offset + 4, offset + 8);
    if (type === "IEND") {
      fs.writeFileSync(file, Buffer.concat([source.subarray(0, offset), ...chunks, source.subarray(offset)]));
      return;
    }
    offset += 12 + length;
  }
  throw new Error(`${path.basename(file)} has no IEND chunk`);
}

function cameraNameFor(file, task) {
  const name = path.basename(file);
  return (task.sequence?.cameras || []).map(camera => camera.name).find(camera => name.includes(`_${camera}_`)) || null;
}

function materialFor(file, task) {
  const match = path.basename(file, path.extname(file)).match(/_Product_(.+)$/i);
  if (match) return match[1];
  return (task.materials || []).flatMap(group => group.list || []).find(Boolean)?.name || "";
}

function metadataFor(file, job, task, config, cameraStates = null) {
  const cameraName = cameraNameFor(file, task), camera = (task.sequence?.cameras || []).find(item => item.name === cameraName) || {};
  const resolution = (camera.LayerResolutions || []).find(item => String(item.Name).toLowerCase() === imageLayer(file).toLowerCase()) || {};
  const stateKey = `${String(task.taskId || "").toLowerCase()}::${String(camera.sequenceName || camera.name || "").toLowerCase()}`;
  const runtimeCamera = cameraStates instanceof Map ? cameraStates.get(stateKey) : cameraStates?.[stateKey] || job._rhLocal?.cameraStates?.[stateKey] || null;
  const cameraLocation = runtimeCamera?.cameraLocation || camera.Actor?.Location || {}, cameraRotation = runtimeCamera?.cameraRotation || camera.Actor?.Rotation || {};
  const meshes = (task.materials || []).flatMap(group => group.meshes || []).join("; ");
  const meshMaterials = (task.materials || []).flatMap(group => (group.meshes || []).map(mesh => `${mesh}=${group.list?.[0]?.name || ""}`)).join("; ");
  const modelPath = task.model?.objPath || "", modelMtime = modelPath && fs.existsSync(modelPath) ? fs.statSync(modelPath).mtime.toISOString() : "";
  const description = [
    "RH render passport",
    `job=${job.jobId || ""}`,
    `product=${task.taskId || ""}`,
    `material=${materialFor(file, task)}`,
    `camera=${cameraName || ""}`,
    `source=${path.basename(file)}`,
    `canvas=${config.canvas.width}x${config.canvas.height}`,
    "profile=AdobeRGB1998"
  ].join(" | ");
  return {
    jobId: job.jobId || "",
    Product: task.taskId || "",
    Material: materialFor(file, task),
    Camera: cameraName || "",
    objPath: modelPath,
    "objPath filemtime": modelMtime,
    "Render File Name": path.basename(file),
    _SID: os.hostname(),
    meshes,
    meshesRaw: meshes,
    meshMaterials,
    "camera.name": camera.sequenceName || camera.name || "",
    "cameraLocation.x": cameraLocation.X ?? cameraLocation.x,
    "cameraLocation.y": cameraLocation.Y ?? cameraLocation.y,
    "cameraLocation.z": cameraLocation.Z ?? cameraLocation.z,
    "cameraRotation.pitch": cameraRotation.Pitch ?? cameraRotation.pitch,
    "cameraRotation.yaw": cameraRotation.Yaw ?? cameraRotation.yaw,
    "cameraRotation.roll": cameraRotation.Roll ?? cameraRotation.roll,
    focalLength: runtimeCamera?.focalLength ?? camera.FocalLength ?? camera.focalLength,
    sensorWidth: runtimeCamera?.sensorWidth ?? resolution.SensorSize?.X,
    sensorHeight: runtimeCamera?.sensorHeight ?? resolution.SensorSize?.Y,
    bCorrectPerspective: runtimeCamera?.correctPerspective ?? camera.correctPerspective,
    PostProcessVersion: "RH_LOCAL_1",
    Description: description
  };
}

function runVips(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve() : reject(new Error(`vips ${args[0]} failed (${code}): ${stderr.trim() || "unknown error"}`)));
  });
}

const vipsFileList = files => files.map(file => String(file).replace(/\\/g, "/")).join(" ");

function safeRemoveTemp(folder) {
  const tempRoot = path.resolve(os.tmpdir()), resolved = path.resolve(folder), relative = path.relative(tempRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !path.basename(resolved).startsWith("rh-post-")) throw new Error(`Refusing to remove unsafe temp path: ${resolved}`);
  fs.rmSync(resolved, { recursive: true, force: true });
}

async function processImage(root, file, job, task, options = {}) {
  const config = options.config || loadConfig(root), tools = options.tools || availability(root);
  if (!tools.ok) throw new Error(tools.error || "Post-process tools are unavailable");
  if (path.extname(file).toLowerCase() !== ".png" || isProcessedImage(file, config.outputSuffix)) return { file, skipped: true, reason: "not an original PNG" };
  const output = processedPathFor(file, config.outputSuffix), inputInfo = fs.statSync(file);
  if (!options.force && fs.existsSync(output) && fs.statSync(output).size > 0 && fs.statSync(output).mtimeMs >= inputInfo.mtimeMs - 1500) return { file, output, skipped: true, reason: "current" };
  const dimensions = pngDimensions(file), width = Number(config.canvas.width), height = Number(config.canvas.height);
  if (dimensions.width > width || dimensions.height > height) throw new Error(`${path.basename(file)} is ${dimensions.width}x${dimensions.height}, larger than the ${width}x${height} delivery canvas`);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rh-post-")), base = path.join(temp, "base.v"), prepared = path.join(temp, "prepared.v"), resolved = path.join(temp, "resolved.v"), encoded = path.join(temp, "encoded.png");
  const left = Math.floor((width - dimensions.width) / 2), top = Math.floor((height - dimensions.height) / 2), layer = imageLayer(file);
  try {
    await runVips(tools.vips, ["embed", file, base, String(left), String(top), String(width), String(height), "--extend", "background", "--background", "0 0 0 0"]);
    if (layer === "Shadow") {
      const alpha = path.join(temp, "alpha.v"), solid = path.join(temp, "solid.v"), color = path.join(temp, "color.v"), recoloredRaw = path.join(temp, "recolored-raw.v"), recolored = path.join(temp, "recolored.v"), rgb = path.join(temp, "rgb.v"), boostedAlpha = path.join(temp, "boosted-alpha.v"), overlayRaw = path.join(temp, "overlay-raw.v"), overlay = path.join(temp, "overlay.v");
      const camera = cameraNameFor(file, task), boost = Math.max(0, Number(config.shadow.alphaBoostPercent[camera] ?? 0)) / 100;
      const hex = String(config.shadow.color || "#120C06").replace(/^#/, ""), channels = [0, 2, 4].map(offset => parseInt(hex.slice(offset, offset + 2), 16));
      await runVips(tools.vips, ["extract_band", base, alpha, "3"]);
      await runVips(tools.vips, ["black", solid, String(width), String(height), "--bands", "3"]);
      await runVips(tools.vips, ["linear", solid, color, "1 1 1", channels.join(" ")]);
      await runVips(tools.vips, ["bandjoin", vipsFileList([color, alpha]), recoloredRaw]);
      await runVips(tools.vips, ["copy", recoloredRaw, recolored, "--interpretation", "srgb"]);
      if (boost > 0) {
        await runVips(tools.vips, ["extract_band", recolored, rgb, "0", "--n", "3"]);
        await runVips(tools.vips, ["linear", alpha, boostedAlpha, String(boost), "0", "--uchar"]);
        await runVips(tools.vips, ["bandjoin", vipsFileList([rgb, boostedAlpha]), overlayRaw]);
        await runVips(tools.vips, ["copy", overlayRaw, overlay, "--interpretation", "srgb"]);
        await runVips(tools.vips, ["composite", vipsFileList([recolored, overlay]), prepared, "2"]);
      } else await runVips(tools.vips, ["copy", recolored, prepared]);
    } else await runVips(tools.vips, ["icc_transform", base, prepared, tools.profile, "--embedded", "--intent", "relative", "--black-point-compensation"]);
    const pixelsPerMillimetre = Number(config.dpi) / 25.4;
    await runVips(tools.vips, ["copy", prepared, resolved, "--xres", String(pixelsPerMillimetre), "--yres", String(pixelsPerMillimetre)]);
    await runVips(tools.vips, ["pngsave", resolved, encoded, "--keep", "all", "--profile", tools.profile]);
    writePngText(encoded, metadataFor(file, job, task, config, options.cameraStates));
    const atomic = `${output}.${process.pid}.${Date.now()}.tmp.png`;
    fs.copyFileSync(encoded, atomic);
    if (fs.existsSync(output)) fs.rmSync(output, { force: true });
    fs.renameSync(atomic, output);
    fs.utimesSync(output, inputInfo.atime, inputInfo.mtime);
    return { file, output, layer, camera: cameraNameFor(file, task), skipped: false };
  } finally { safeRemoveTemp(temp); }
}

function originalFilesForJob(job) {
  const files = [];
  for (const task of job.tasks || []) {
    const folders = new Set((task.layers || []).filter(layer => !layer._rhLocalPrefit && !layer._rhLocalCropCalibration).map(layer => path.resolve(String(layer.output?.folder || ""))).filter(Boolean));
    for (const folder of folders) {
      if (!fs.existsSync(folder)) continue;
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        const file = path.join(folder, entry.name);
        if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".png" && !isProcessedImage(file)) files.push(file);
      }
    }
  }
  return [...new Set(files)].sort();
}

function taskForFile(job, file) {
  const resolved = path.resolve(file);
  return (job.tasks || []).find(task => (task.layers || []).some(layer => {
    const folder = path.resolve(String(layer.output?.folder || "")), relative = folder ? path.relative(folder, resolved) : "";
    return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
  })) || null;
}

function publishReadyToUpload(job, options = {}) {
  const config = options.config || loadConfig(options.root || path.join(__dirname, ".."));
  const configuredOutput = String(job._rhLocal?.outputFolder || "").trim();
  if (!configuredOutput) throw new Error("Job has no output folder for ready-to-upload images");
  const outputRoot = path.resolve(configuredOutput);
  if (outputRoot === path.parse(outputRoot).root) throw new Error("Job has no safe output folder for ready-to-upload images");
  const records = originalFilesForJob(job).map(file => {
    const task = taskForFile(job, file), processed = processedPathFor(file, config.outputSuffix);
    if (!task || !fs.existsSync(processed) || fs.statSync(processed).size <= 0) return null;
    const model = safeDeliverySegment(task.taskId), camera = cameraNameFor(file, task), layer = imageLayer(file);
    if (!camera) throw new Error(`Cannot determine delivery camera for ${path.basename(file)}`);
    return { file, processed, model, camera, layer, material: materialFor(file, task) };
  }).filter(Boolean);
  if (!records.length) return { folder: path.join(outputRoot, READY_FOLDER_NAME), files: 0, models: 0, complete: false };

  const collisionCounts = new Map();
  for (const record of records) {
    const key = `${record.model.toLowerCase()}::${record.camera.toLowerCase()}::${record.layer.toLowerCase()}`;
    collisionCounts.set(key, (collisionCounts.get(key) || 0) + 1);
  }
  const usedNames = new Set();
  for (const record of records) {
    const key = `${record.model.toLowerCase()}::${record.camera.toLowerCase()}::${record.layer.toLowerCase()}`;
    const layerSuffix = record.layer === "Shadow" ? "_Shadow" : "";
    const materialSuffix = record.layer === "Fabric" && collisionCounts.get(key) > 1 ? `_${safeDeliverySegment(record.material)}` : "";
    let name = `${record.model}_${record.camera}${materialSuffix}${layerSuffix}.png`, serial = 2;
    while (usedNames.has(`${record.model.toLowerCase()}::${name.toLowerCase()}`)) name = `${record.model}_${record.camera}${materialSuffix}_${serial++}${layerSuffix}.png`;
    usedNames.add(`${record.model.toLowerCase()}::${name.toLowerCase()}`); record.name = name;
  }

  fs.mkdirSync(outputRoot, { recursive: true });
  const readyRoot = path.join(outputRoot, READY_FOLDER_NAME), staging = path.join(outputRoot, `.${READY_FOLDER_NAME}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.mkdirSync(staging, { recursive: true });
    for (const record of records) {
      const modelFolder = path.join(staging, record.model), destination = path.join(modelFolder, record.name), info = fs.statSync(record.processed);
      fs.mkdirSync(modelFolder, { recursive: true }); fs.copyFileSync(record.processed, destination); fs.utimesSync(destination, info.atime, info.mtime);
      record.destination = `${record.model}/${record.name}`;
    }
    const expected = originalFilesForJob(job).length, models = [...new Set(records.map(record => record.model))];
    const manifest = {
      version: 1, jobId: job.jobId || "", generatedAt: new Date().toISOString(), complete: records.length === expected,
      modelCount: models.length, fileCount: records.length, expectedFileCount: expected,
      naming: "<model>/<model>_<camera>[_<material>][_Shadow].png",
      files: records.map(record => ({ model: record.model, camera: record.camera, layer: record.layer, material: record.material, file: record.destination, source: path.relative(outputRoot, record.processed).replace(/\\/g, "/") }))
    };
    fs.writeFileSync(path.join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    if (fs.existsSync(readyRoot)) fs.rmSync(readyRoot, { recursive: true, force: true });
    fs.renameSync(staging, readyRoot);
    return { folder: readyRoot, files: records.length, models: models.length, complete: manifest.complete, manifest: path.join(readyRoot, "manifest.json") };
  } catch (error) {
    if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

async function processJob(root, job, options = {}) {
  const files = options.files || originalFilesForJob(job), results = [];
  for (let index = 0; index < files.length; index++) {
    const file = files[index], task = taskForFile(job, file);
    if (!task) throw new Error(`No job task owns ${file}`);
    options.onProgress?.({ index, completed: index, total: files.length, file, task: task.taskId });
    results.push(await processImage(root, file, job, task, options));
    options.onProgress?.({ index, completed: index + 1, total: files.length, file, task: task.taskId, result: results.at(-1) });
  }
  options.onDelivery?.(publishReadyToUpload(job, { root, config: options.config }));
  return results;
}

module.exports = {
  DEFAULT_CONFIG, READY_FOLDER_NAME, availability, imageLayer, isProcessedImage, loadConfig, metadataFor, originalFilesForJob,
  pngDimensions, processImage, processJob, processedPathFor, publishReadyToUpload, resolveVips, taskForFile, writePngText
};
