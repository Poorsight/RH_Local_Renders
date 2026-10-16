"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { readRenderSettings, writeRenderSettings, validateRenderSettings } = require("../lib/render-settings.cjs");
const { buildUnrealLaunch } = require("../lib/unreal.cjs");
test("launch settings default to headless, persist both modes, and reject invalid input", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rh-launch-settings-"));
  const previous = process.env.RH_RENDER_SETTINGS_FILE;
  process.env.RH_RENDER_SETTINGS_FILE = path.join(root, "settings.json");
  try {
    assert.deepEqual(readRenderSettings(root), { unrealMode: "headless" });
    assert.equal(fs.existsSync(process.env.RH_RENDER_SETTINGS_FILE), false);
    for (const unrealMode of ["windowed", "headless"]) {
      assert.deepEqual(writeRenderSettings(root, { unrealMode }), { unrealMode });
      assert.deepEqual(readRenderSettings(root), { unrealMode });
    }
    for (const input of [null, {}, { unrealMode: true }, { unrealMode: "-ExecCmds=bad" }]) {
      assert.throws(() => validateRenderSettings(input), { status: 400 });
      assert.throws(() => writeRenderSettings(root, input), { status: 400 });
    }
    assert.equal(readRenderSettings(root).unrealMode, "headless");
    fs.writeFileSync(process.env.RH_RENDER_SETTINGS_FILE, "invalid");
    assert.throws(() => readRenderSettings(root));
  } finally {
    if (previous === undefined) delete process.env.RH_RENDER_SETTINGS_FILE; else process.env.RH_RENDER_SETTINGS_FILE = previous;
    // Only this test's explicitly created temporary files, never render/cache data.
    fs.unlinkSync(path.join(root, "settings.json")); fs.rmdirSync(root);
  }
});
test("explicit modes only change window-related launch options", () => {
  const options = { adapter: { script: "bootstrap.py", manifestFile: "manifest.json" }, substrate: true };
  const windowed = buildUnrealLaunch("UnrealEditor.exe", "rh.uproject", "http://127.0.0.1:5500/api/unreal", { ...options, headless: false });
  const headless = buildUnrealLaunch("UnrealEditor.exe", "rh.uproject", "http://127.0.0.1:5500/api/unreal", { ...options, headless: true });
  assert.deepEqual(headless.args.filter(a => !["-RenderOffScreen", "-unattended"].includes(a)), windowed.args);
  assert.equal(headless.args.filter(a => a === "-RenderOffScreen").length, 1);
  assert.equal(headless.options.windowsHide, true); assert.equal(windowed.options.windowsHide, false);
  assert.equal(headless.options.shell, false);
  const diagnostic = buildUnrealLaunch("UnrealEditor.exe", "rh.uproject", "http://127.0.0.1:5500/api/unreal", options);
  assert.deepEqual(diagnostic.args, windowed.args, "Explicit diagnostic flags must not be duplicated");
});
test("mode is frozen at run creation, settings route is behind existing authorization", () => {
  const server = fs.readFileSync(path.join(__dirname, "../server.cjs"), "utf8");
  assert.match(server, /const unrealMode = readRenderSettings\(ROOT\).unrealMode/);
  assert.match(server, /activeRun.unrealMode = unrealMode/);
  assert.match(server, /headless: activeRun.unrealMode === "headless"/);
  assert.ok(server.indexOf('if (ACCESS_KEY && !isAuthorized') < server.indexOf('url.pathname === "/api/settings/render"'));
});
