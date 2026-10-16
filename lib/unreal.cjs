"use strict";

const { editorOverrides } = require("./batchrender-adapter.cjs");

function buildUnrealLaunch(editor, project, apiUrl, options = {}) {
  const substrate = options.substrate !== false;
  // The app chooses its default at run creation. Unspecified stays compatible with
  // diagnostic callers that already append their own explicit offscreen flags.
  const headless = options.headless === true;
  return {
    command: editor,
    args: [
      project,
      ...(options.adapter ? ["-EnablePlugins=PythonScriptPlugin", `-ExecutePythonScript=${options.adapter.script}`] : ["-BatchRender"]),
      "-NoSplash",
      ...(headless ? ["-RenderOffScreen", "-unattended"] : []),
      "-log",
      "-stdout",
      "-FullStdOutLogOutput",
      `-ini:Engine:[/Script/Engine.RendererSettings]:r.Substrate=${substrate ? "True" : "False"}`,
      options.adapter ? editorOverrides(apiUrl) : `-ini:Editor:[/Script/BatchRenderEditor.BatchRenderSettings]:ApiUrl=${apiUrl}`
    ],
    options: {
      shell: false,
      windowsHide: headless,
      stdio: ["ignore", "pipe", "pipe"],
      ...(options.adapter ? { env: { ...process.env, RH_BATCHRENDER_ADAPTER_MANIFEST: options.adapter.manifestFile } } : {})
    }
  };
}

module.exports = { buildUnrealLaunch };
