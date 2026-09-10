"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { nativeShadowSupport, renderEnvironments } = require("../lib/render-environments.cjs");
const { rendererToken } = require("../lib/camera-fit.cjs");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rh-native-restore-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "test.uproject");
  const write = (name, content) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  const prefix = "Plugins/BatchRender/";
  write("test.uproject", "{}");
  write(prefix + "Source/BatchRenderEditor/Private/ShadowAlphaProcessor.cpp", "native source");
  write(prefix + "Binaries/Win64/UnrealEditor-BatchRender.dll", "runtime");
  write(prefix + "Binaries/Win64/UnrealEditor-BatchRenderEditor.dll", Buffer.from("BatchRender: Shadow alpha %s", "utf16le"));
  const lut = { curves: Object.fromEntries(["F", "P", "TQ", "TQB"].map(camera => [camera, Array.from({ length: 256 }, (_, i) => i)])) };
  write(prefix + "Config/ShadowAlphaLut.json", JSON.stringify(lut));
  write("Content/composure/composure_mat/M_shadow_only.uasset", "material");
  return { project, write, prefix, lut };
}

test("restored branch keeps Substrate ON and never falls back to controller RGB recovery", () => {
  const profile = renderEnvironments({}).ue56;
  assert.equal(profile.substrate, true);
  assert.equal(profile.nativeShadowAlpha, true);
  assert.equal(profile.recoverLegacyShadow, false);
});

test("native shadow capability requires source, compiled support and valid camera LUTs", t => {
  const { project, write, prefix, lut } = fixture(t);
  assert.equal(nativeShadowSupport(project).ready, true);
  write(prefix + "Binaries/Win64/UnrealEditor-BatchRenderEditor.dll", "stock binary");
  assert.equal(nativeShadowSupport(project).ready, false);
  write(prefix + "Binaries/Win64/UnrealEditor-BatchRenderEditor.dll", Buffer.from("BatchRender: Shadow alpha %s", "utf16le"));
  lut.curves.F[10] = 999;
  write(prefix + "Config/ShadowAlphaLut.json", JSON.stringify(lut));
  assert.equal(nativeShadowSupport(project).ready, false);
  write(prefix + "Config/ShadowAlphaLut.json", "invalid JSON");
  assert.equal(nativeShadowSupport(project).ready, false);
});

test("renderer identity invalidates old crop context when native editor, LUT or material changes", t => {
  const { project, write, prefix, lut } = fixture(t);
  const before = rendererToken(project);
  write(prefix + "Binaries/Win64/UnrealEditor-BatchRenderEditor.dll", "new editor");
  const afterEditor = rendererToken(project);
  assert.notEqual(afterEditor, before);
  lut.curves.F[10] = 11;
  write(prefix + "Config/ShadowAlphaLut.json", JSON.stringify(lut));
  const afterLut = rendererToken(project);
  assert.notEqual(afterLut, afterEditor);
  write("Content/composure/composure_mat/M_shadow_only.uasset", "new material");
  assert.notEqual(rendererToken(project), afterLut);
});
