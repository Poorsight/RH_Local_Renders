"use strict";
const fs = require("node:fs");
const path = require("node:path");
const DEFAULT_RENDER_SETTINGS = Object.freeze({ unrealMode: "headless" });
const settingsPath = root => process.env.RH_RENDER_SETTINGS_FILE || path.join(root, "local", "render-settings.json");
function validateRenderSettings(input) {
  if (!input || !["headless", "windowed"].includes(input.unrealMode)) {
    throw Object.assign(new Error("Unreal mode must be headless or windowed"), { status: 400 });
  }
  return { unrealMode: input.unrealMode };
}
function readRenderSettings(root) {
  try { return validateRenderSettings(JSON.parse(fs.readFileSync(settingsPath(root), "utf8"))); }
  catch (error) { if (error.code === "ENOENT") return { ...DEFAULT_RENDER_SETTINGS }; throw error; }
}
function writeRenderSettings(root, input) {
  const value = validateRenderSettings(input), file = settingsPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
  fs.renameSync(temporary, file);
  return value;
}
module.exports = { DEFAULT_RENDER_SETTINGS, validateRenderSettings, readRenderSettings, writeRenderSettings };
