"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const ADAPTER_VERSION = "upstream-56-native-shadow-v2";
const SETTINGS_SECTION = "[/Script/BatchRenderEditor.BatchRenderSettings]";
// Upstream d189f23 fixes its own class/asset defaults, but now defaults to its
// test map. Only our project-specific scene and API belong in local overrides.
const SETTINGS = Object.freeze({
  RenderLevel: "/Game/Maps/PathTrace/Composure.Composure"
});
const NATIVE_SOURCES = [
  "Source/BatchRender/Public/BatchRenderLibrary.h",
  "Source/BatchRenderEditor/Public/BatchRenderEditorSubsystem.h",
  "Source/BatchRenderEditor/Public/BatchRenderSettings.h"
];
const DLLS = ["Binaries/Win64/UnrealEditor-BatchRender.dll", "Binaries/Win64/UnrealEditor-BatchRenderEditor.dll"];
const ASSETS = ["Content/Blueprints/AssetsPipeline.uasset", "Content/Blueprints/WBP_RenderEmpty.uasset", "Content/Blueprints/BP_ArchVisCgCaptureCompElement.uasset"];
const fileContains = (file, text) => fs.existsSync(file) && fs.readFileSync(file, "utf8").includes(text);

function inspectAdapter(project, editor) {
  const pluginRoot = path.join(path.dirname(project), "Plugins", "BatchRender");
  const native = fs.existsSync(path.join(pluginRoot, "Source/BatchRenderEditor/Public/BatchRenderManager.h"));
  if (!native) return { native: false, ready: false, pluginRoot };
  const problems = [];
  const renderMap = path.join(path.dirname(project), "Content/Maps/PathTrace/Composure.umap");
  if (!fs.existsSync(renderMap) || fs.readFileSync(renderMap).subarray(0, 40).toString().startsWith("version https://git-lfs")) problems.push("RH Composure render map is missing or not downloaded");
  for (const relative of [...NATIVE_SOURCES, ...ASSETS]) {
    const file = path.join(pluginRoot, relative);
    if (!fs.existsSync(file)) problems.push(`Missing ${relative}`);
    else if (relative.endsWith(".uasset") && fs.readFileSync(file).subarray(0, 40).toString().startsWith("version https://git-lfs")) problems.push(`Git LFS asset not downloaded: ${relative}`);
  }
  for (const [relative, symbol] of [[NATIVE_SOURCES[0], "AddFocalLengthKeyToArchCineCameraInSequence"], [NATIVE_SOURCES[1], "TestJob"], [NATIVE_SOURCES[1], "IsManualTestJob"]]) {
    if (!fileContains(path.join(pluginRoot, relative), symbol)) problems.push(`Unsupported native API: ${symbol}`);
  }
  if (!fileContains(path.join(pluginRoot, NATIVE_SOURCES[2]), 'TEXT("/Script/BatchRenderEditor.BatchRenderManager")')) problems.push("Update upstream 5.6: its native manager default is not configured");
  for (const relative of DLLS) {
    const file = path.join(pluginRoot, relative);
    if (!fs.existsSync(file) || fs.readFileSync(file).subarray(0, 2).toString() !== "MZ") problems.push(`Missing or unhydrated DLL: ${relative}`);
  }
  const pythonPlugin = path.resolve(path.dirname(editor), "../../Plugins/Experimental/PythonScriptPlugin/PythonScriptPlugin.uplugin");
  if (!fs.existsSync(pythonPlugin)) problems.push("The editor Python plugin is not installed");
  try {
    const pluginModules = JSON.parse(fs.readFileSync(path.join(pluginRoot, "Binaries/Win64/UnrealEditor.modules"), "utf8"));
    const editorModules = JSON.parse(fs.readFileSync(path.join(path.dirname(editor), "UnrealEditor.modules"), "utf8"));
    if (!pluginModules.BuildId || pluginModules.BuildId !== editorModules.BuildId) problems.push("Plugin binaries target a different Unreal editor build");
  } catch { problems.push("Cannot verify the plugin/editor build IDs"); }
  const revision = spawnSync("git", ["-C", pluginRoot, "rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true });
  const cleanliness = spawnSync("git", ["-C", pluginRoot, "diff", "--quiet", "HEAD", "--", "Source", ...DLLS], { windowsHide: true });
  if (cleanliness.status !== 0) problems.push("Plugin source/binaries differ from the checked-out commit; verify its build before rendering");
  return { native: true, ready: problems.length === 0, problems, pluginRoot, pythonPlugin,
    version: ADAPTER_VERSION, commit: revision.status === 0 ? revision.stdout.trim() : null,
    runtimeValidated: false };
}

function editorOverrides(apiUrl, settings = SETTINGS) {
  const entries = { ApiUrl: apiUrl, ...settings };
  for (const [key, value] of Object.entries(entries)) {
    if (/[\r\n,"]/u.test(String(value))) throw new Error(`Unsupported character in Unreal setting ${key}`);
  }
  // One switch: UE supports comma-separated overrides within the same ini file.
  return `-ini:Editor:${Object.entries(entries).map(([key, value]) => `${SETTINGS_SECTION}:${key}=${value}`).join(",")}`;
}

function prepareAdapterJob(job) {
  const runtimeJob = JSON.parse(JSON.stringify(job));
  // This tool's Fabric and Shadow phases both run with Substrate ON.
  // Use the upstream native conversion, never external or legacy RGB recovery.
  runtimeJob.shadowAlphaRecovery = true;
  for (const task of runtimeJob.tasks || []) task.shadowAlphaRecovery = true;
  const inherited = [], seen = new Map();
  for (const task of runtimeJob.tasks || []) for (const camera of task.sequence?.cameras || []) {
    const override = camera.Camera;
    if (!override?.OverrideFocalLength) continue;
    const focalLength = Number(override.FocalLength), sequenceName = String(camera.sequenceName || "");
    if (!sequenceName || !Number.isFinite(focalLength) || focalLength <= 0) throw new Error("Inherited camera requires a named sequence and positive finite focal length");
    if (runtimeJob.tasks.length !== 1) throw new Error("Inherited cameras must run one model per Unreal process");
    if (camera.fit !== "none") throw new Error("Inherited camera must disable fit");
    const key = sequenceName.toLowerCase();
    if (seen.has(key) && seen.get(key) !== focalLength) throw new Error(`Conflicting inherited focal lengths for ${sequenceName}`);
    if (!seen.has(key)) inherited.push({ taskId: task.taskId, sequenceName, focalLength });
    seen.set(key, focalLength);
    delete override.OverrideFocalLength;
    delete override.FocalLength;
  }
  return { runtimeJob, inherited };
}

function stageAdapterRun(root, job, options) {
  const { runtimeJob, inherited } = prepareAdapterJob(job);
  const attemptId = options.attemptId || crypto.randomUUID();
  if (!/^[a-zA-Z0-9-]+$/.test(attemptId)) throw new Error("Invalid adapter attempt id");
  const folder = path.join(root, "local", "runtime", "batchrender", attemptId);
  fs.mkdirSync(folder, { recursive: true });
  const jobFile = path.join(folder, "phase.job.json"), manifestFile = path.join(folder, "adapter.json");
  fs.writeFileSync(jobFile, JSON.stringify(runtimeJob, null, 2), { flag: "wx" });
  fs.writeFileSync(manifestFile, JSON.stringify({ version: ADAPTER_VERSION, attemptId, jobId: runtimeJob.jobId,
    apiUrl: options.apiUrl, jobFile, inherited,
    validateResources: runtimeJob._rhLocal?.experiment?.stockPlugin !== true }, null, 2), { flag: "wx" });
  return { attemptId, runtimeJob, inherited, jobFile, manifestFile,
    script: path.join(root, "integration", "batchrender", "upstream-bootstrap.py") };
}

module.exports = { ADAPTER_VERSION, SETTINGS, SETTINGS_SECTION, inspectAdapter, editorOverrides, prepareAdapterJob, stageAdapterRun };
