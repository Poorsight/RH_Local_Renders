"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { parseCsv } = require("../lib/csv.cjs");
const { buildRig, jobLights } = require("../lib/rig.cjs");
const { buildJob, CAMERA_YAW, groupedMaterials } = require("../lib/jobs.cjs");
const { componentId } = require("../lib/models.cjs");
const { buildUnrealLaunch } = require("../lib/unreal.cjs");

const root = path.join(__dirname, "..");
const rows = parseCsv(fs.readFileSync(path.join(root, "data", "sectionals-indoor.csv"), "utf8"));
const rig = buildRig(rows);
const model = { name: "TEST_prod1", path: "D:\\models\\TEST_prod1.fbx", offsetUniformScale: 1 };
const baseInput = {
  side: "R", sourceMode: "B", dimensions: { width: 343, depth: 307, height: 79 }, importYaw: 0,
  cameras: ["F", "FH", "TQ"], layers: ["Fabric"], materials: [{ meshes: ["UPH", "Stitches"], material: "FABRIC_A" }, { meshes: ["Feet"], material: "WOOD_A" }]
};

test("CSV parser preserves quoted comma-separated scene prefixes", () => {
  const parsed = parseCsv('a,b\n1,"R, U"\n'); assert.deepEqual(parsed, [{ a: "1", b: "R, U" }]);
});

test("fallback sheet contains complete Sectionals / Indoor rigs", () => {
  for (const scene of ["Sectional_Indoor_R", "Sectional_Indoor_L", "Sectional_Indoor_U"]) for (const camera of ["F", "FH", "TQ"]) {
    assert.equal(Object.keys(rig[scene][camera]).length, 5, `${scene}/${camera}`);
  }
});

test("sectional actor yaw uses only F/FH/TQ rules from ActorRotations", () => {
  assert.deepEqual(CAMERA_YAW, { R: { F: 0, FH: 0, TQ: -36 }, L: { F: 0, FH: 0, TQ: 36 }, U: { F: 0, FH: 0, TQ: 36 } });
  for (const side of ["R", "L", "U"]) {
    const job = buildJob({ ...baseInput, side, importYaw: -90 }, model, rig, "D:\\renders\\test");
    const cameras = Object.fromEntries(job.tasks[0].sequence.cameras.map(camera => [camera.name, camera.Actor.Rotation.Yaw]));
    assert.deepEqual(cameras, { F: -90, FH: -90, TQ: CAMERA_YAW[side].TQ - 90 });
    assert.ok(!job.tasks[0].sequence.cameras.some(camera => ["P", "TQB"].includes(camera.name)));
  }
});

test("job lights preserve five-light shape and scale positions with one factor", () => {
  const lights = jobLights(rig, "Sectional_Indoor_R", "F", baseInput.dimensions, "B");
  assert.equal(lights.length, 5); assert.deepEqual(lights.map(light => light.name), ["front_fill_lgt", "left_rim_lgt", "main_key_lgt", "right_bounce_lgt", "right_rim_lgt"]);
  assert.ok(lights.every(light => light.LevelName.startsWith("Sectional_Indoor_")));
});

test("equal material names become one BatchRender material group", () => {
  assert.deepEqual(groupedMaterials([{ meshes: ["UPH"], material: "A" }, { meshes: ["Stitches"], material: "A" }])[0].meshes, ["uph", "stitches"]);
});

test("component IDs are read from the suffix of FBX object names", () => {
  assert.equal(componentId("SOFA_PART:UPH"), "UPH"); assert.equal(componentId("SOFA_PART:Feet.001"), "Feet");
});

test("Unreal launch points the stock BatchRender plugin at the local API", () => {
  const apiUrl = "http://127.0.0.1:5500/api/unreal";
  const launch = buildUnrealLaunch("D:\\UE\\UnrealEditor.exe", "D:\\RH\\rh.uproject", apiUrl);
  assert.equal(launch.options.shell, false);
  assert.ok(launch.args.includes("-BatchRender"));
  assert.ok(launch.args.includes(`-ini:Editor:[/Script/BatchRenderEditor.BatchRenderSettings]:ApiUrl=${apiUrl}`));
  assert.ok(!launch.args.some(argument => argument.startsWith("-ExecutePythonScript=")));
  assert.ok(!launch.args.some(argument => argument.startsWith("-BatchRenderJob=")));
});

test("main page renders the light rig natively in the shared workspace", () => {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const client = fs.readFileSync(path.join(root, "app.js"), "utf8");
  assert.match(html, /class="rig-workspace"/);
  assert.match(html, /id="rigPlan"/);
  assert.match(html, /id="rigElevation"/);
  assert.doesNotMatch(html, /<iframe/i);
  assert.match(client, /data\/sectionals-indoor\.csv/);
  assert.match(client, /Math\.max\(1, raw\)/);
  assert.match(client, /canReachLocalService/);
});
