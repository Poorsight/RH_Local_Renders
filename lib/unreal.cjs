"use strict";

function buildUnrealLaunch(editor, project, apiUrl, options = {}) {
  const substrate = options.substrate !== false;
  const nativeShadowDiagnostics = options.nativeShadowDiagnostics === true;
  return {
    command: editor,
    args: [
      project,
      "-BatchRender",
      "-NoSplash",
      "-log",
      "-stdout",
      "-FullStdOutLogOutput",
      ...(nativeShadowDiagnostics ? ["-ExecCmds=r.BatchRender.NativeShadowDiagnostics 1"] : []),
      `-ini:Engine:[/Script/Engine.RendererSettings]:r.Substrate=${substrate ? "True" : "False"}`,
      `-ini:Editor:[/Script/BatchRenderEditor.BatchRenderSettings]:ApiUrl=${apiUrl}`
    ],
    options: {
      shell: false,
      windowsHide: false,
      stdio: ["ignore", "pipe", "pipe"]
    }
  };
}

module.exports = { buildUnrealLaunch };
