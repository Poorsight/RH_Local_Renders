"use strict";

const { editorOverrides } = require("./batchrender-adapter.cjs");

function buildUnrealLaunch(editor, project, apiUrl, options = {}) {
  const substrate = options.substrate !== false;
  return {
    command: editor,
    args: [
      project,
      ...(options.adapter ? ["-EnablePlugins=PythonScriptPlugin", `-ExecutePythonScript=${options.adapter.script}`] : ["-BatchRender"]),
      "-NoSplash",
      "-log",
      "-stdout",
      "-FullStdOutLogOutput",
      `-ini:Engine:[/Script/Engine.RendererSettings]:r.Substrate=${substrate ? "True" : "False"}`,
      options.adapter ? editorOverrides(apiUrl) : `-ini:Editor:[/Script/BatchRenderEditor.BatchRenderSettings]:ApiUrl=${apiUrl}`
    ],
    options: {
      shell: false,
      windowsHide: false,
      stdio: ["ignore", "pipe", "pipe"],
      ...(options.adapter ? { env: { ...process.env, RH_BATCHRENDER_ADAPTER_MANIFEST: options.adapter.manifestFile } } : {})
    }
  };
}

module.exports = { buildUnrealLaunch };
