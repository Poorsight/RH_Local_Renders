"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { NON_RENDER_FOLDERS } = require("./output-layout.cjs");
const { previewFileFor } = require("./preview.cjs");
const { READY_FOLDER_NAME, LEGACY_READY_FOLDER_NAME, isProcessedImage, processedPathFor } = require("./post-process.cjs");

const imagePattern = /\.(png|jpe?g|webp)$/i;

function walk(root, predicate) {
  if (!fs.existsSync(root)) return [];
  const files = [], stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory() && !NON_RENDER_FOLDERS.includes(entry.name)) stack.push(full); else if (!entry.isDirectory() && (!predicate || predicate(full))) files.push(full);
    }
  }
  return files.sort();
}

const within = (file, root) => {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
};

function expectedRenders(task) {
  const cameras = task.sequence?.cameras?.length || 0;
  return (task.layers || []).reduce((total, layer) => {
    if (layer.doNotRender || layer._rhLocalPrefit) return total;
    const variants = String(layer.name).toLowerCase() === "fabric"
      ? (task.materials || []).reduce((product, group) => product * Math.max(group.list?.length || 0, 1), 1)
      : 1;
    return total + cameras * variants;
  }, 0);
}

function pngInfo(file) {
  if (path.extname(file).toLowerCase() !== ".png") return { width: null, height: null, alpha: null };
  try {
    const header = Buffer.alloc(26), descriptor = fs.openSync(file, "r");
    fs.readSync(descriptor, header, 0, header.length, 0); fs.closeSync(descriptor);
    if (header.toString("ascii", 1, 4) !== "PNG") return { width: null, height: null, alpha: null };
    const colorType = header[25];
    return { width: header.readUInt32BE(16), height: header.readUInt32BE(20), alpha: colorType === 4 || colorType === 6 };
  } catch { return { width: null, height: null, alpha: null }; }
}

function renderRecord(file, rendersRoot, cameras, deliveryFile = null, declared = null) {
  const name = path.basename(file), camera = (cameras || []).find(value => name.includes(`_${value}_`)) || null;
  const layer = /(?:^|_)shadow(?:_|\.)/i.test(name) ? "Shadow" : "Fabric", image = pngInfo(file);
  // What this job asked this camera and layer for. The profile's numbers used to stand in
  // for it, so a job rendered at a frame of its own -- 3600 wide, say -- was reported as the
  // wrong size when it was exactly right. The profile is only the fallback for a job that
  // declares nothing.
  const asked = declared?.get(`${camera}|${layer}`) || null;
  const allowed = asked ? [[asked.X, asked.Y]]
    : layer === "Shadow" ? [[1500, 500], [15000, 5000]] : [[500, 500], [5000, 5000]];
  const issues = [];
  if (image.width && image.height && !allowed.some(([width, height]) => image.width === width && image.height <= height && image.height >= Math.ceil(height * 0.2))) issues.push("Unexpected size");
  if (image.alpha === false) issues.push("No alpha channel");
  if (fs.statSync(file).size < 1024) issues.push("Suspiciously small file");
  const legacyProcessed = processedPathFor(file), processedFile = deliveryFile && fs.existsSync(deliveryFile) ? deliveryFile : legacyProcessed;
  const processedInfo = fs.existsSync(processedFile) ? pngInfo(processedFile) : null;
  const processed = processedInfo ? {
    size: fs.statSync(processedFile).size, ...processedInfo,
    issues: [processedInfo.width !== 15000 || processedInfo.height !== 5000 ? "Unexpected delivery size" : null, processedInfo.alpha === false ? "No alpha channel" : null].filter(Boolean),
    url: `/api/renders/file?path=${encodeURIComponent(path.relative(rendersRoot, processedFile))}`
  } : null;
  // The gallery would rather pull a 200 KB proxy than a 30 megapixel frame; the full file
  // stays one click away.
  const proxy = previewFileFor(file);
  return {
    name, camera, layer, size: fs.statSync(file).size, ...image, issues,
    // The same relative form the delete endpoint takes, so the page can remove exactly
    // what it is showing without reverse-engineering a URL.
    file: path.relative(rendersRoot, file),
    url: `/api/renders/file?path=${encodeURIComponent(path.relative(rendersRoot, file))}`,
    previewUrl: fs.existsSync(proxy) ? `/api/renders/file?path=${encodeURIComponent(path.relative(rendersRoot, proxy))}` : null,
    processed
  };
}

function history(root, currentRender = {}) {
  const jobsRoot = path.join(root, "local", "jobs", "generated"), rendersRoot = path.join(root, "local", "renders");
  return walk(jobsRoot, file => file.toLowerCase().endsWith(".job.json")).map(jobPath => {
    try {
      const job = JSON.parse(fs.readFileSync(jobPath, "utf8"));
      const outputFolder = path.resolve(String(job._rhLocal?.outputFolder || job.tasks?.[0]?.layers?.find(layer => layer.output?.folder)?.output?.folder || ""));
      const readyFolder = path.join(outputFolder, READY_FOLDER_NAME), legacyReadyFolder = path.join(outputFolder, LEGACY_READY_FOLDER_NAME);
      const resolvedReadyFolder = fs.existsSync(path.join(readyFolder, "manifest.json")) ? readyFolder : legacyReadyFolder;
      const readyManifest = path.join(resolvedReadyFolder, "manifest.json"), processedBySource = new Map();
      let readyToUpload = null;
      if (fs.existsSync(readyManifest)) {
        try {
          const manifest = JSON.parse(fs.readFileSync(readyManifest, "utf8"));
          for (const record of manifest.files || []) {
            let source = path.resolve(outputFolder, String(record.source || ""));
            if (!fs.existsSync(source) && /_POST\.png$/i.test(source)) source = source.replace(/_POST\.png$/i, ".png");
            const delivery = path.resolve(resolvedReadyFolder, String(record.file || ""));
            if (within(source, outputFolder) && within(delivery, resolvedReadyFolder) && fs.existsSync(delivery)) processedBySource.set(source.toLowerCase(), delivery);
          }
          readyToUpload = { folder: resolvedReadyFolder, files: Number(manifest.fileCount) || 0, models: Number(manifest.modelCount) || 0, complete: Boolean(manifest.complete) };
        } catch { readyToUpload = { folder: resolvedReadyFolder, files: 0, models: 0, complete: false }; }
      }
      const metadataRecords = job._rhLocal?.models || (job._rhLocal?.name ? [job._rhLocal] : []);
      const metadata = new Map(metadataRecords.map(record => [record.name, record]));
      const models = (job.tasks || []).map(task => {
        const record = metadata.get(task.taskId) || {};
        const outputFolder = path.resolve(String(record.outputFolder || task.layers?.find(layer => layer.output?.folder)?.output?.folder || ""));
        const files = within(outputFolder, rendersRoot) ? walk(outputFolder, file => imagePattern.test(file) && !isProcessedImage(file)) : [];
        const cameras = (task.sequence?.cameras || []).map(camera => camera.name);
        const declared = new Map();
        for (const camera of task.sequence?.cameras || []) {
          for (const frame of camera.LayerResolutions || []) {
            if (frame?.Name && frame.Resolution) declared.set(`${camera.name}|${frame.Name}`, frame.Resolution);
          }
        }
        return {
          name: task.taskId, modelPath: record.modelPath || task.model?.objPath || "", dimensions: record.dimensions || null,
          side: record.side || "UNKNOWN", importYaw: Number(record.importYaw) || 0,
          outputFolder, expectedRenders: expectedRenders(task), renders: files.map(file => renderRecord(file, rendersRoot, cameras, processedBySource.get(path.resolve(file).toLowerCase()), declared)),
          state: files.length >= expectedRenders(task) ? "complete" : files.length ? "partial" : "pending"
        };
      });
      const renderCount = models.reduce((total, model) => total + model.renders.length, 0);
      const postProcessCount = models.reduce((total, model) => total + model.renders.filter(render => render.processed).length, 0);
      const expected = models.reduce((total, model) => total + model.expectedRenders, 0);
      const isCurrent = path.resolve(String(currentRender.jobPath || "")) === path.resolve(jobPath);
      const state = expected > 0 && renderCount >= expected ? "complete" : renderCount > 0 ? "partial" : isCurrent ? currentRender.state : "ready";
      const timestamps = models.flatMap(model => model.renders.flatMap(render => [render.url, render.processed?.url].filter(Boolean).map(fileUrl => {
        const file = path.resolve(rendersRoot, decodeURIComponent(fileUrl.split("path=")[1] || ""));
        return fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0;
      })));
      const info = fs.statSync(jobPath), generatedAt = job._rhLocal?.generatedAt || info.birthtime.toISOString();
      return {
        id: job.jobId || path.basename(jobPath, ".job.json"), jobPath, jobUrl: `/api/jobs/file?path=${encodeURIComponent(path.relative(jobsRoot, jobPath))}`,
        generatedAt, updatedAt: new Date(Math.max(info.mtimeMs, ...timestamps, 0)).toISOString(), outputFolder,
        modelCount: models.length, renderCount, postProcessCount, expectedRenders: expected, state, lastRunState: isCurrent ? currentRender.state : null, readyToUpload, models,
        productType: job._rhLocal?.productType || (job._rhLocal?.models || [])[0]?.productType || null,
        cameras: [...new Set((job.tasks || []).flatMap(task => (task.sequence?.cameras || []).map(camera => camera.name)))],
        layers: [...new Set((job.tasks || []).flatMap(task => (task.layers || []).filter(layer => !layer._rhLocalPrefit).map(layer => layer.name)))]
      };
    } catch (error) {
      return { id: path.basename(jobPath, ".job.json"), jobPath, state: "invalid", error: error.message, models: [], modelCount: 0, renderCount: 0, expectedRenders: 0 };
    }
  }).sort((left, right) => String(right.updatedAt || right.generatedAt || "").localeCompare(String(left.updatedAt || left.generatedAt || "")));
}

module.exports = { history, walk, within, expectedRenders };
