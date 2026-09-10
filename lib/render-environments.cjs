"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_ENVIRONMENT = "ue56";

function normalizeEnvironment(value) {
  return DEFAULT_ENVIRONMENT;
}

function renderEnvironments(environment = process.env) {
  return {
    ue56: {
      id: "ue56",
      label: "UE 5.6",
      engineVersion: "5.6",
      beta: false,
      editor: environment.RH_UNREAL_EDITOR_56 || environment.RH_UNREAL_EDITOR || "D:\\Unreal_Engine\\UE_5.6\\Engine\\Binaries\\Win64\\UnrealEditor.exe",
      project: environment.RH_UNREAL_PROJECT_56 || environment.RH_UNREAL_PROJECT || "D:\\GitHub\\rh_unreal_2\\rh_unreal_2.uproject",
      substrate: true,
      recoverLegacyShadow: false,
      nativeShadowAlpha: true,
      description: "Local · Substrate ON · Unreal shadow alpha"
    }
  };
}

function resolveRenderEnvironment(value, profiles = renderEnvironments()) {
  return profiles[normalizeEnvironment(value)] || profiles[DEFAULT_ENVIRONMENT];
}

function environmentForJob(job, profiles = renderEnvironments()) {
  const recorded = job?._rhLocal?.renderEnvironment || job?._rhLocal?.models?.[0]?.renderEnvironment;
  return resolveRenderEnvironment(recorded, profiles);
}

function publicRenderEnvironment(profile) {
  return {
    id: profile.id,
    label: profile.label,
    engineVersion: profile.engineVersion,
    beta: profile.beta,
    editor: profile.editor,
    project: profile.project,
    available: fs.existsSync(profile.editor) && fs.existsSync(profile.project),
    substrate: profile.substrate,
    recoverLegacyShadow: profile.recoverLegacyShadow,
    nativeShadowAlpha: profile.nativeShadowAlpha,
    description: profile.description
  };
}

// Static capability check only; a real render must still verify output and event ordering.
function nativeShadowSupport(project) {
  const plugin = path.join(path.dirname(project), "Plugins", "BatchRender");
  const source = path.join(plugin, "Source", "BatchRenderEditor", "Private", "ShadowAlphaProcessor.cpp");
  const binary = path.join(plugin, "Binaries", "Win64", "UnrealEditor-BatchRenderEditor.dll");
  const calibration = path.join(plugin, "Config", "ShadowAlphaLut.json");
  try {
    if (!fs.existsSync(source)) return { ready: false, detail: "Native Unreal shadow processor is not installed." };
    const curves = JSON.parse(fs.readFileSync(calibration, "utf8")).curves;
    if (!["F", "P", "TQ", "TQB"].every(camera => Array.isArray(curves?.[camera]) && curves[camera].length === 256 && curves[camera].every(value => Number.isInteger(value) && value >= 0 && value <= 255))) {
      return { ready: false, detail: "Native shadow calibration is missing or invalid." };
    }
    if (!fs.readFileSync(binary).includes(Buffer.from("BatchRender: Shadow alpha %s", "utf16le"))) {
      return { ready: false, detail: "Rebuild BatchRenderEditor with the native shadow processor." };
    }
    return { ready: true, detail: "Native shadow processor and LUT are present; Substrate ON, external RGB recovery disabled." };
  } catch {
    return { ready: false, detail: "Native shadow DLL or calibration is missing or unreadable." };
  }
}

module.exports = {
  DEFAULT_ENVIRONMENT,
  normalizeEnvironment,
  renderEnvironments,
  resolveRenderEnvironment,
  environmentForJob,
  publicRenderEnvironment,
  nativeShadowSupport
};
