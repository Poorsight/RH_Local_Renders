"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { parseCsv } = require("../lib/csv.cjs");
const { buildRig, jobLights, rigScale } = require("../lib/rig.cjs");
const { buildJob, buildBatchJob, CAMERA_YAW, groupedMaterials } = require("../lib/jobs.cjs");
const { ModelStore } = require("../lib/models.cjs");
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

test("job lights scale X/Y with one factor and never move in Z", () => {
  const dimensions = { width: 700, depth: 500, height: 300 };
  const lights = jobLights(rig, "Sectional_Indoor_R", "F", dimensions, "B");
  const source = rig.Sectional_Indoor_R.F;
  const k = rigScale(dimensions).value;
  assert.equal(lights.length, 5); assert.deepEqual(lights.map(light => light.name), ["front_fill_lgt", "left_rim_lgt", "main_key_lgt", "right_bounce_lgt", "right_rim_lgt"]);
  assert.ok(lights.every(light => light.LevelName.startsWith("Sectional_Indoor_")));
  for (const light of lights) {
    assert.equal(light.Location.X, Number((source[light.name].position[0] * k).toFixed(6)));
    assert.equal(light.Location.Y, Number((source[light.name].position[1] * k).toFixed(6)));
    assert.equal(light.Location.Z, source[light.name].position[2]);
  }

  const heightOnly = jobLights(rig, "Sectional_Indoor_R", "F", { ...baseInput.dimensions, height: 800 }, "B");
  for (const light of heightOnly) assert.equal(light.Location.Z, source[light.name].position[2]);
});

test("equal material names become one BatchRender material group", () => {
  assert.deepEqual(groupedMaterials([{ meshes: ["UPH"], material: "A" }, { meshes: ["Stitches"], material: "A" }])[0].meshes, ["uph", "stitches"]);
});

test("tracked metadata makes all current models self-contained", async () => {
  const metadata = JSON.parse(fs.readFileSync(path.join(root, "data", "models.json"), "utf8"));
  assert.equal(Object.keys(metadata.models).length, 16);
  const name = "BELGIAN_SLIPCOVERED_CLASSIC_SLOPE_ARM_BENCH_SEAT_RIGHT_ARM_L_SECTIONAL_LUXE_prod9910052";
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rh-local-renders-"));
  try {
    fs.writeFileSync(path.join(temp, `${name}.fbx`), "");
    const inspected = await new ModelStore(root, { modelsRoot: temp }).inspect(name);
    assert.deepEqual(inspected.dimensions, { width: 356.3, depth: 274.7, height: 88.6 });
    assert.equal(inspected.side, "RIGHT_ARM"); assert.equal(inspected.importYaw, -90); assert.equal(inspected.offsetUniformScale, 2.54);
    assert.deepEqual(inspected.materialIds, ["UPH", "Stitches", "Feet"]);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("a new FBX is analyzed once and persisted in ignored local metadata", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rh-local-renders-new-"));
  const modelsRoot = path.join(temp, "models"), localMetadataPath = path.join(temp, "model-metadata.json"), name = "NEW_LEFT_ARM_L_SECTIONAL_prod123";
  fs.mkdirSync(modelsRoot); fs.writeFileSync(path.join(modelsRoot, `${name}.fbx`), "fixture");
  const analyzed = { side: "LEFT_ARM", dimensions: [300, 250, 80], yaw: 0, scale: 1, materialIds: ["UPH", "Feet"], meshObjects: 2, warning: "" };
  try {
    const first = await new ModelStore(root, { modelsRoot, localMetadataPath, analyzeModel: async () => analyzed }).inspect(name);
    assert.equal(first.newlyAnalyzed, true); assert.equal(first.metadataSource, "local");
    assert.deepEqual(first.materialIds, ["UPH", "Feet"]); assert.ok(fs.existsSync(localMetadataPath));
    const second = await new ModelStore(root, { modelsRoot, localMetadataPath, analyzeModel: async () => { throw new Error("should use cache"); } }).inspect(name);
    assert.equal(second.newlyAnalyzed, false); assert.deepEqual(second.dimensions, { width: 300, depth: 250, height: 80 });
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("batch jobs keep per-model geometry and apply shared IDs only where present", () => {
  const left = { ...model, name: "LEFT_prod1", materialIds: ["UPH", "Feet"] };
  const right = { ...model, name: "RIGHT_prod2", path: "D:\\models\\RIGHT_prod2.fbx", materialIds: ["UPH", "Stitches"] };
  const materials = [{ meshes: ["UPH"], material: "FABRIC_A" }, { meshes: ["Feet"], material: "WOOD_A" }, { meshes: ["Stitches"], material: "THREAD_A" }];
  const job = buildBatchJob([
    { model: left, input: { ...baseInput, side: "L", dimensions: { width: 300, depth: 250, height: 80 }, materials } },
    { model: right, input: { ...baseInput, side: "R", dimensions: { width: 400, depth: 280, height: 90 }, materials } }
  ], rig, "D:\\renders\\batch", "batch_2_test");
  assert.equal(job.tasks.length, 2); assert.equal(job._rhLocal.models.length, 2);
  assert.deepEqual(job.tasks[0].materials.flatMap(group => group.meshes).sort(), ["feet", "uph"]);
  assert.deepEqual(job.tasks[1].materials.flatMap(group => group.meshes).sort(), ["stitches", "uph"]);
  assert.equal(job.tasks[0].sequence.cameras[2].Actor.Rotation.Yaw, 36);
  assert.equal(job.tasks[1].sequence.cameras[2].Actor.Rotation.Yaw, -36);
});

test("normalized UI groups still filter exact source component IDs per task", () => {
  const first = { ...model, name: "FIRST", materialIds: ["FIRST_123_UPH"] };
  const second = { ...model, name: "SECOND", path: "D:\\models\\SECOND.fbx", materialIds: ["SECOND_456_UPH1"] };
  const materials = [{ meshes: ["FIRST_123_UPH", "SECOND_456_UPH1"], material: "FABRIC_A" }];
  const job = buildBatchJob([
    { model: first, input: { ...baseInput, materials } },
    { model: second, input: { ...baseInput, materials } }
  ], rig, "D:\\renders\\normalized", "normalized_test");
  assert.deepEqual(job.tasks[0].materials[0].meshes, ["first_123_uph"]);
  assert.deepEqual(job.tasks[1].materials[0].meshes, ["second_456_uph1"]);
});

test("legacy light-rig project files stay out of the unified project", () => {
  for (const legacy of ["handoff", "light-rig-reference.html", "comments.php", "ONBOARDING.md", ".claude"]) {
    assert.equal(fs.existsSync(path.join(root, legacy)), false, legacy);
  }
  const scripts = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).scripts;
  assert.deepEqual(Object.keys(scripts).sort(), ["build", "start", "test"]);
});

test("desktop launcher starts one hidden local server and waits before opening the site", () => {
  const launcher = fs.readFileSync(path.join(root, "Launch_RH_Local_Renders.vbs"), "utf8");
  const batch = fs.readFileSync(path.join(root, "Start_RH_Local_Renders.bat"), "utf8");
  assert.match(launcher, /ServerReady\(statusUrl\)/);
  assert.match(launcher, /--no-browser/);
  assert.match(launcher, /shell\.Run siteUrl, 1, False/);
  assert.match(batch, /if \/I "%~1"=="--no-browser" goto start_server/);
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
  const styles = fs.readFileSync(path.join(root, "app.css"), "utf8");
  assert.match(html, /class="rig-workspace"/);
  assert.match(html, /id="rigPlan"/);
  assert.match(html, /id="rigElevation"/);
  assert.match(html, /id="rigWidthRange" class="rig-dimension-slider" type="range"/);
  assert.match(html, /id="rigDepthRange" class="rig-dimension-slider" type="range"/);
  assert.match(html, /id="rigHeightRange" class="rig-dimension-slider" type="range"/);
  assert.doesNotMatch(html, /<iframe/i);
  assert.match(client, /data\/sectionals-indoor\.csv/);
  assert.match(client, /Math\.max\(1, raw\)/);
  assert.match(client, /position: \[x \* scale, y \* scale, z\]/);
  assert.match(client, /canReachLocalService/);
  assert.match(client, /range\.addEventListener\("input"/);
  assert.match(html, /id="modelDropTarget"/);
  assert.match(html, /id="modelFileInput" type="file" accept="\.fbx" multiple/);
  assert.match(client, /droppedFilePath/);
  assert.match(client, /dropTarget\.addEventListener\("drop"/);
  assert.match(client, /useDroppedModels/);
  assert.match(client, /const normalizedMaterialId = id =>/);
  assert.match(client, /data-material-ids=/);
  assert.match(html, /id="modelBatch"/);
  assert.match(client, /LOCAL_MODELS_ROOT = "D:\\\\GitHub\\\\RH_Local_Renders\\\\local\\\\models"/);
  assert.match(client, /const metadataModel = query =>/);
  assert.match(client, /await loadModelMetadata\(\)/);
  assert.doesNotMatch(client, /Open the local dashboard with npm start to resolve full model paths/);
  assert.match(styles, /@media\(min-width:981px\)\{main\{width:calc\(100% - 48px\);max-width:none\}\}/);
});
