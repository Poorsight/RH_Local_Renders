"use strict";

function buildUnrealLaunch(editor, project, apiUrl) {
  return {
    command: editor,
    args: [
      project,
      "-BatchRender",
      "-NoSplash",
      "-log",
      "-stdout",
      "-FullStdOutLogOutput",
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
