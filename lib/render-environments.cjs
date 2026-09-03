"use strict";

const fs = require("node:fs");

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
      recoverLegacyShadow: true,
      description: "Production · Legacy Composure shadow recovery"
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
    description: profile.description
  };
}

module.exports = {
  DEFAULT_ENVIRONMENT,
  normalizeEnvironment,
  renderEnvironments,
  resolveRenderEnvironment,
  environmentForJob,
  publicRenderEnvironment
};
