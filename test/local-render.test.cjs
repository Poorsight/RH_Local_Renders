"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { parseCsv } = require("../lib/csv.cjs");
const { buildRig, jobLights, rigScale } = require("../lib/rig.cjs");
const { buildJob, buildBatchJob, writeJob, CAMERA_YAW, RESOLUTION_PROFILES, groupedMaterials } = require("../lib/jobs.cjs");
const { ModelStore, sectionalFormFactor } = require("../lib/models.cjs");
const { buildUnrealLaunch } = require("../lib/unreal.cjs");
const { history, expectedRenders } = require("../lib/history.cjs");
const { buildRenderPlan, cameraStateKey, applyCameraHandoff } = require("../lib/render-plan.cjs");

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

test("Shadow overrides main key intensity and cones before the existing size correction", () => {
  for (const scene of ["Sectional_Indoor_R", "Sectional_Indoor_L", "Sectional_Indoor_U"]) for (const camera of ["F", "FH", "TQ"]) {
    const fabric = jobLights(rig, scene, camera, baseInput.dimensions, "B");
    const shadow = jobLights(rig, scene, camera, baseInput.dimensions, "B", "Shadow");
    const fabricKey = fabric.find(light => light.name === "main_key_lgt"), shadowKey = shadow.find(light => light.name === "main_key_lgt");
    assert.equal(fabricKey.intensity, camera === "TQ" ? 60 : 45, `${scene}/${camera} Fabric intensity`);
    assert.equal(fabricKey.InnerConeAngle, -1); assert.equal(fabricKey.OuterConeAngle, -1);
    assert.equal(shadowKey.intensity, 100, `${scene}/${camera} Shadow intensity`);
    assert.equal(shadowKey.InnerConeAngle, 45); assert.equal(shadowKey.OuterConeAngle, 60);
    assert.deepEqual(shadowKey.Location, fabricKey.Location); assert.deepEqual(shadowKey.rotation, fabricKey.rotation);
    for (const fabricLight of fabric.filter(light => light.name !== "main_key_lgt")) {
      const shadowLight = shadow.find(light => light.name === fabricLight.name);
      assert.equal(shadowLight.intensity, fabricLight.intensity); assert.deepEqual(shadowLight.Location, fabricLight.Location);
    }
  }

  const large = { width: 700, depth: 500, height: 300 };
  const fabricKey = jobLights(rig, "Sectional_Indoor_R", "F", large, "B").find(light => light.name === "main_key_lgt");
  const shadowKey = jobLights(rig, "Sectional_Indoor_R", "F", large, "B", "Shadow").find(light => light.name === "main_key_lgt");
  assert.ok(Math.abs((shadowKey.intensity / fabricKey.intensity) - (100 / 45)) < 0.000001, "both base intensities use the same size correction");
});

test("equal material names become one BatchRender material group", () => {
  assert.deepEqual(groupedMaterials([{ meshes: ["UPH"], material: "A" }, { meshes: ["Stitches"], material: "A" }])[0].meshes, ["uph", "stitches"]);
});

test("render history discovers saved jobs and their disk renders", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rh-history-"));
  const jobsRoot = path.join(temp, "local", "jobs", "generated"), output = path.join(temp, "local", "renders", "TEST_prod1");
  fs.mkdirSync(jobsRoot, { recursive: true }); fs.mkdirSync(output, { recursive: true });
  const input = { ...baseInput, cameras: ["F"], layers: ["Fabric"] };
  const job = buildJob(input, { ...model, materialIds: ["UPH", "Stitches", "Feet"] }, rig, output);
  const jobPath = path.join(jobsRoot, "TEST_prod1.job.json"), image = path.join(output, "00000000_F_Product_uph.png");
  try {
    fs.writeFileSync(jobPath, JSON.stringify(job)); fs.writeFileSync(image, "png");
    assert.equal(expectedRenders(job.tasks[0]), 1);
    const [saved] = history(temp);
    assert.equal(saved.id, "TEST_prod1"); assert.equal(saved.modelCount, 1); assert.equal(saved.renderCount, 1); assert.equal(saved.expectedRenders, 1); assert.equal(saved.state, "complete");
    assert.deepEqual(saved.models[0].dimensions, baseInput.dimensions); assert.equal(saved.models[0].renders[0].camera, "F");
    assert.match(saved.jobUrl, /^\/api\/jobs\/file\?path=/); assert.match(saved.models[0].renders[0].url, /^\/api\/renders\/file\?path=/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("single-model jobs keep unique JSON and output folders", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rh-saved-jobs-")), current = { ...model, materialIds: ["UPH", "Stitches", "Feet"] };
  try {
    const first = writeJob(temp, baseInput, current, rig), second = writeJob(temp, baseInput, current, rig);
    assert.notEqual(first.jobPath, second.jobPath); assert.notEqual(first.outputFolder, second.outputFolder);
    assert.ok(fs.existsSync(first.jobPath)); assert.ok(fs.existsSync(second.jobPath));
    assert.notEqual(first.job.jobId, second.job.jobId); assert.match(first.job.jobId, /^TEST_prod1_\d+/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
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
    assert.equal(inspected.side, "R"); assert.equal(inspected.importYaw, 90); assert.equal(inspected.offsetUniformScale, 2.54);
    assert.deepEqual(inspected.materialIds, ["UPH", "Stitches", "Feet"]);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("all -X backrest models use the verified positive Unreal camera yaw", () => {
  const metadata = JSON.parse(fs.readFileSync(path.join(root, "data", "models.json"), "utf8"));
  const rotated = new Set(["prod9690053", "prod24560660", "prod9910052", "prod24560673"]);
  for (const [name, record] of Object.entries(metadata.models)) {
    const product = name.match(/prod\d+$/)?.[0];
    assert.equal(record.yaw, rotated.has(product) ? 90 : 0, name);
  }
  const analyzer = fs.readFileSync(path.join(root, "scripts", "inspect_fbx.py"), "utf8");
  assert.match(analyzer, /yaw_by_back = \{"\+Y": 0, "-X": 90, "\+X": -90, "-Y": 180\}/);
  assert.doesNotMatch(analyzer, /if unit_name == "inches exported as cm":\s*yaw_by_back/);
});

test("a new FBX is analyzed once and persisted in ignored local metadata", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rh-local-renders-new-"));
  const modelsRoot = path.join(temp, "models"), localMetadataPath = path.join(temp, "model-metadata.json"), name = "NEW_LEFT_ARM_L_SECTIONAL_prod123";
  fs.mkdirSync(modelsRoot); fs.writeFileSync(path.join(modelsRoot, `${name}.fbx`), "fixture");
  const analyzed = { side: "LEFT_ARM", dimensions: [300, 250, 80], yaw: 0, scale: 1, materialIds: ["UPH", "Feet"], meshObjects: 2, warning: "" };
  try {
    const first = await new ModelStore(root, { modelsRoot, localMetadataPath, analyzeModel: async () => analyzed }).inspect(name);
    assert.equal(first.newlyAnalyzed, true); assert.equal(first.metadataSource, "local");
    assert.equal(first.side, "L"); assert.deepEqual(first.materialIds, ["UPH", "Feet"]); assert.ok(fs.existsSync(localMetadataPath));
    const second = await new ModelStore(root, { modelsRoot, localMetadataPath, analyzeModel: async () => { throw new Error("should use cache"); } }).inspect(name);
    assert.equal(second.newlyAnalyzed, false); assert.deepEqual(second.dimensions, { width: 300, depth: 250, height: 80 });
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("sectional form factors normalize filenames and metadata to exact L/R/U values", () => {
  const metadata = JSON.parse(fs.readFileSync(path.join(root, "data", "models.json"), "utf8"));
  for (const [name, record] of Object.entries(metadata.models)) {
    const expected = name.includes("RIGHT_ARM") ? "R" : "L";
    assert.equal(sectionalFormFactor(name, record.side), expected, name);
  }
  assert.equal(sectionalFormFactor("MODULAR_U_SECTIONAL_prod1"), "U");
  assert.equal(sectionalFormFactor("MODULAR_RIGHT_ARM_U_SECTIONAL_prod1"), "U");
  assert.equal(sectionalFormFactor("AMBIGUOUS_SECTIONAL_prod2", "U_SHAPE"), "U");
  assert.equal(sectionalFormFactor("AMBIGUOUS_SECTIONAL_prod3"), "UNKNOWN");
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
  assert.equal(job.tasks[0].layers[0].output.fileNameFormat, "00000000_{camera}_Product_{material:first_123_uph}");
  assert.equal(job.tasks[1].layers[0].output.fileNameFormat, "00000000_{camera}_Product_{material:second_456_uph1}");
});

test("every Fabric filename material token resolves to an exact mesh in its task", () => {
  const metadata = JSON.parse(fs.readFileSync(path.join(root, "data", "models.json"), "utf8"));
  for (const [name, record] of Object.entries(metadata.models)) {
    const ids = metadata.profiles[record.ids];
    const current = { ...model, name, path: `D:\\models\\${name}.fbx`, materialIds: ids };
    const materials = [{ meshes: ids.filter(id => /UPH\d*$/i.test(id)), material: "FABRIC_A" }];
    const job = buildJob({ ...baseInput, materials }, current, rig, `D:\\renders\\${name}`);
    const token = job.tasks[0].layers[0].output.fileNameFormat.match(/\{material:([^}]+)\}/)[1];
    assert.ok(job.tasks[0].materials.some(group => group.meshes.includes(token)), `${name}: ${token}`);
  }
});

test("Fabric and Shadow become ordered Unreal phases with the required Substrate state", () => {
  const job = buildJob({ ...baseInput, layers: ["Fabric", "Shadow"] }, { ...model, materialIds: ["UPH", "Stitches", "Feet"] }, rig, "D:\\renders\\phases");
  const original = JSON.stringify(job), plan = buildRenderPlan(job);
  assert.deepEqual(plan.map(phase => [phase.name, phase.substrate]), [["Fabric", true], ["Shadow", false]]);
  assert.deepEqual(plan[0].job.tasks[0].layers.map(layer => layer.name), ["Fabric"]);
  assert.deepEqual(plan[1].job.tasks[0].layers.map(layer => layer.name), ["Shadow"]);
  assert.ok(plan[0].job.tasks[0].sequence.cameras.every(camera => camera.LayerResolutions.length === 1 && camera.LayerResolutions[0].Name === "Fabric"));
  assert.ok(plan[1].job.tasks[0].sequence.cameras.every(camera => camera.LayerResolutions.length === 1 && camera.LayerResolutions[0].Name === "Shadow"));
  const parentCamera = job.tasks[0].sequence.cameras[0], fabricCamera = plan[0].job.tasks[0].sequence.cameras[0], shadowCamera = plan[1].job.tasks[0].sequence.cameras[0];
  assert.equal(parentCamera._rhLocalShadowLights.find(light => light.name === "main_key_lgt").intensity, 100);
  assert.equal(fabricCamera.lights.find(light => light.name === "main_key_lgt").intensity, 45);
  assert.equal(shadowCamera.lights.find(light => light.name === "main_key_lgt").intensity, 100);
  assert.equal(shadowCamera.lights.find(light => light.name === "main_key_lgt").InnerConeAngle, 45);
  assert.equal(shadowCamera.lights.find(light => light.name === "main_key_lgt").OuterConeAngle, 60);
  assert.ok(!("_rhLocalShadowLights" in fabricCamera)); assert.ok(!("_rhLocalShadowLights" in shadowCamera));
  assert.equal(plan[0].job.jobId, `${job.jobId}__fabric`); assert.equal(plan[1].job.jobId, `${job.jobId}__shadow`);
  assert.equal(JSON.stringify(job), original, "the saved parent job stays unchanged");
});

test("Low and High profiles preserve the 1:3 Fabric-to-Shadow pixel grid", () => {
  assert.deepEqual(RESOLUTION_PROFILES.high.Fabric.Resolution, { X: 5000, Y: 5000 });
  assert.deepEqual(RESOLUTION_PROFILES.high.Shadow.Resolution, { X: 15000, Y: 5000 });
  assert.deepEqual(RESOLUTION_PROFILES.low.Fabric.Resolution, { X: 500, Y: 500 });
  assert.deepEqual(RESOLUTION_PROFILES.low.Shadow.Resolution, { X: 1500, Y: 500 });
  for (const profile of ["low", "high"]) {
    const job = buildJob({ ...baseInput, renderProfile: profile, layers: ["Fabric", "Shadow"] }, { ...model, materialIds: ["UPH", "Stitches", "Feet"] }, rig, `D:\\renders\\${profile}`);
    const [fabric, shadow] = job.tasks[0].sequence.cameras[0].LayerResolutions;
    assert.equal(shadow.Resolution.X, fabric.Resolution.X * 3);
    assert.equal(shadow.Resolution.Y, fabric.Resolution.Y);
    assert.equal(shadow.SensorSize.X, fabric.SensorSize.X * 3);
    assert.equal(shadow.SensorSize.Y, fabric.SensorSize.Y);
    assert.equal(job._rhLocal.renderProfile, profile);
  }
});

test("Shadow receives the exact Fabric transform and focal length with fit disabled", () => {
  const job = buildJob({ ...baseInput, layers: ["Fabric", "Shadow"] }, { ...model, materialIds: ["UPH", "Stitches", "Feet"] }, rig, "D:\\renders\\handoff");
  const shadow = buildRenderPlan(job)[1].job, states = new Map();
  for (const camera of shadow.tasks[0].sequence.cameras) states.set(cameraStateKey(model.name, camera.sequenceName), {
    cameraLocation: { X: 7, Y: 1650, Z: 120 }, cameraRotation: { Pitch: -3, Yaw: -90, Roll: 0 }, focalLength: 155.25
  });
  const handoff = applyCameraHandoff(shadow, states);
  assert.deepEqual(handoff.missing, []); assert.equal(handoff.applied.length, 3);
  for (const camera of handoff.job.tasks[0].sequence.cameras) {
    assert.equal(camera.fit, "none"); assert.equal(camera.Camera.OverrideLocation, true); assert.equal(camera.Camera.OverrideRotation, true);
    assert.equal(camera.Camera.OverrideFocalLength, true); assert.equal(camera.Camera.FocalLength, 155.25);
    assert.deepEqual(camera.LayerResolutions[0].SensorSize, { X: 108, Y: 36 });
  }
});

test("a Shadow-only request inserts a low-res Fabric camera prefit before Shadow", () => {
  const job = buildJob({ ...baseInput, layers: ["Shadow"], renderProfile: "high" }, { ...model, materialIds: ["UPH", "Stitches", "Feet"] }, rig, "D:\\renders\\shadow-only");
  const [fabric, shadow] = job.tasks[0].sequence.cameras[0].LayerResolutions;
  assert.deepEqual(fabric.Resolution, { X: 500, Y: 500 });
  assert.deepEqual(shadow.Resolution, { X: 15000, Y: 5000 });
  assert.equal(job.tasks[0].layers[0]._rhLocalPrefit, true);
  assert.equal(job._rhLocal.cameraPrefit, true);
  assert.deepEqual(buildRenderPlan(job).map(phase => phase.name), ["Fabric", "Shadow"]);
});

test("local render service completes Fabric before restarting for Substrate-off Shadow", async () => {
  const suffix = `${process.pid}_${Date.now()}`, port = 56000 + process.pid % 5000;
  const jobsRoot = path.join(root, "local", "jobs", "generated"), output = path.join(root, "local", "renders", `test_phases_${suffix}`);
  const jobPath = path.join(jobsRoot, `test_phases_${suffix}.job.json`), fakeLog = path.join(os.tmpdir(), `rh-fake-unreal-${suffix}.log`);
  fs.mkdirSync(jobsRoot, { recursive: true }); fs.mkdirSync(output, { recursive: true });
  const job = buildJob({ ...baseInput, layers: ["Fabric", "Shadow"] }, { ...model, materialIds: ["UPH", "Stitches", "Feet"] }, rig, output);
  job.jobId = `test_phases_${suffix}`; job._rhLocal.outputFolder = `${output}${path.sep}`;
  fs.writeFileSync(jobPath, JSON.stringify(job));
  const service = spawn(process.execPath, [path.join(root, "server.cjs")], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, RH_LOCAL_RENDERS_PORT: String(port), RH_UNREAL_EDITOR: process.execPath, RH_UNREAL_PROJECT: path.join(root, "test", "fake-unreal.cjs"), RH_FAKE_UNREAL_LOG: fakeLog }
  });
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const statusUrl = `http://127.0.0.1:${port}/api/status`;
  try {
    let online = false;
    for (let attempt = 0; attempt < 50 && !online; attempt++) { try { online = (await fetch(statusUrl)).ok; } catch {} if (!online) await sleep(50); }
    assert.equal(online, true, "test render service should start");
    const launch = await fetch(`http://127.0.0.1:${port}/api/renders`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobPath }) });
    assert.equal(launch.status, 202);
    let status;
    for (let attempt = 0; attempt < 150; attempt++) {
      status = await (await fetch(`http://127.0.0.1:${port}/api/renders/status`)).json();
      if (status.state !== "running") break;
      await sleep(50);
    }
    assert.equal(status.state, "success", status.log);
    const launches = fs.readFileSync(fakeLog, "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.deepEqual(launches.map(item => item.phase), ["Fabric", "Shadow"]);
    assert.match(launches[0].substrateArgument, /r\.Substrate=True$/); assert.match(launches[1].substrateArgument, /r\.Substrate=False$/);
    assert.equal(launches[0].keyLight.intensity, 45); assert.equal(launches[0].keyLight.InnerConeAngle, -1); assert.equal(launches[0].keyLight.OuterConeAngle, -1);
    assert.equal(launches[1].keyLight.intensity, 100); assert.equal(launches[1].keyLight.InnerConeAngle, 45); assert.equal(launches[1].keyLight.OuterConeAngle, 60);
    assert.ok(launches[1].cameras.every(camera => camera.fit === "none"));
    assert.deepEqual(launches[1].cameras.map(camera => camera.Camera.FocalLength), [140, 141, 142]);
    assert.ok(launches[1].cameras.every(camera => camera.Camera.OverrideLocation && camera.Camera.OverrideRotation && camera.Camera.OverrideFocalLength));
    assert.match(status.log, /Fabric is complete\. Restarting Unreal for Shadow with Substrate OFF/);
    assert.match(status.log, /Applied 3 Fabric camera states to Shadow; fit disabled/);
  } finally {
    service.kill();
    fs.rmSync(jobPath, { force: true }); fs.rmSync(output, { recursive: true, force: true }); fs.rmSync(fakeLog, { force: true });
  }
});

test("local render service automatically resumes after an Unreal crash and skips completed models", async () => {
  const suffix = `${process.pid}_${Date.now()}`, port = 57000 + process.pid % 4000;
  const jobsRoot = path.join(root, "local", "jobs", "generated"), output = path.join(root, "local", "renders", `test_resume_${suffix}`);
  const jobPath = path.join(jobsRoot, `test_resume_${suffix}.job.json`), fakeLog = path.join(os.tmpdir(), `rh-fake-resume-${suffix}.log`), crashMarker = path.join(os.tmpdir(), `rh-fake-resume-${suffix}.crashed`);
  fs.mkdirSync(jobsRoot, { recursive: true }); fs.mkdirSync(output, { recursive: true });
  const second = { ...model, name: "TEST_SECOND_prod2", path: "D:\\models\\TEST_SECOND_prod2.fbx" };
  const job = buildBatchJob([
    { model, input: { ...baseInput, layers: ["Fabric", "Shadow"] } },
    { model: second, input: { ...baseInput, layers: ["Fabric", "Shadow"] } }
  ], rig, output, `test_resume_${suffix}`);
  fs.writeFileSync(jobPath, JSON.stringify(job));
  const service = spawn(process.execPath, [path.join(root, "server.cjs")], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, RH_LOCAL_RENDERS_PORT: String(port), RH_UNREAL_EDITOR: process.execPath, RH_UNREAL_PROJECT: path.join(root, "test", "fake-unreal.cjs"), RH_FAKE_UNREAL_LOG: fakeLog, RH_FAKE_UNREAL_CRASH_ONCE: crashMarker }
  });
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  try {
    let online = false;
    for (let attempt = 0; attempt < 50 && !online; attempt++) { try { online = (await fetch(`http://127.0.0.1:${port}/api/status`)).ok; } catch {} if (!online) await sleep(50); }
    assert.equal(online, true);
    const launch = await fetch(`http://127.0.0.1:${port}/api/renders`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobPath }) });
    assert.equal(launch.status, 202);
    let status;
    for (let attempt = 0; attempt < 300; attempt++) {
      status = await (await fetch(`http://127.0.0.1:${port}/api/renders/status`)).json();
      if (status.state !== "running") break;
      await sleep(50);
    }
    assert.equal(status.state, "success", status.log);
    assert.equal(status.autoRestarts, 1);
    assert.ok(status.queue.every(item => item.state === "complete" && item.rendered === item.expected));
    const launches = fs.readFileSync(fakeLog, "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.deepEqual(launches.map(item => item.phase), ["Fabric", "Fabric", "Shadow"]);
    assert.deepEqual(launches[1].taskIds, [second.name]);
    assert.match(status.log, /Automatic Fabric resume 1\/3; completed models stay skipped/);
  } finally {
    service.kill();
    fs.rmSync(jobPath, { force: true }); fs.rmSync(output, { recursive: true, force: true }); fs.rmSync(fakeLog, { force: true }); fs.rmSync(crashMarker, { force: true });
  }
});

test("legacy light-rig project files stay out of the unified project", () => {
  for (const legacy of ["handoff", "light-rig-reference.html", "comments.php", "ONBOARDING.md", ".claude"]) {
    assert.equal(fs.existsSync(path.join(root, legacy)), false, legacy);
  }
  const scripts = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).scripts;
  assert.deepEqual(Object.keys(scripts).sort(), ["build", "start", "test"]);
});

test("desktop launcher replaces a stale hidden server and waits before opening the site", () => {
  const launcher = fs.readFileSync(path.join(root, "Launch_RH_Local_Renders.vbs"), "utf8");
  const batch = fs.readFileSync(path.join(root, "Start_RH_Local_Renders.bat"), "utf8");
  assert.match(launcher, /ServerState\(statusUrl\)/);
  assert.match(launcher, /"""stale"":false/);
  assert.match(launcher, /Get-NetTCPConnection/);
  assert.match(launcher, /Stop-Process/);
  assert.match(launcher, /--no-browser/);
  assert.match(launcher, /shell\.Run siteUrl, 1, False/);
  assert.match(batch, /if \/I "%~1"=="--no-browser" goto start_server/);
});

test("server status exposes a runtime token and stale-source signal", () => {
  const server = fs.readFileSync(path.join(root, "server.cjs"), "utf8");
  assert.match(server, /runtimeSourceToken/);
  assert.match(server, /runtime: \{ startedAt: RUNTIME_STARTED_AT, sourceToken: RUNTIME_SOURCE_TOKEN, stale:/);
  assert.match(server, /pluginRuntimeIsCommitted/);
  assert.match(server, /git", \["-C", pluginRoot, "diff", "--quiet", "HEAD"/);
});

test("Unreal launch points the stock BatchRender plugin at the local API", () => {
  const apiUrl = "http://127.0.0.1:5500/api/unreal";
  const launch = buildUnrealLaunch("D:\\UE\\UnrealEditor.exe", "D:\\RH\\rh.uproject", apiUrl, { substrate: true });
  assert.equal(launch.options.shell, false);
  assert.ok(launch.args.includes("-BatchRender"));
  assert.ok(launch.args.includes("-ini:Engine:[/Script/Engine.RendererSettings]:r.Substrate=True"));
  assert.ok(launch.args.includes(`-ini:Editor:[/Script/BatchRenderEditor.BatchRenderSettings]:ApiUrl=${apiUrl}`));
  assert.ok(!launch.args.some(argument => argument.startsWith("-ExecutePythonScript=")));
  assert.ok(!launch.args.some(argument => argument.startsWith("-BatchRenderJob=")));
  const shadow = buildUnrealLaunch("D:\\UE\\UnrealEditor.exe", "D:\\RH\\rh.uproject", apiUrl, { substrate: false });
  assert.ok(shadow.args.includes("-ini:Engine:[/Script/Engine.RendererSettings]:r.Substrate=False"));
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
  assert.match(client, /render-composite-fabric/);
  assert.match(client, /Fabric over Shadow · alpha preview/);
  assert.match(styles, /--bronze-strong:/);
  assert.match(styles, /\.selective-options input:checked\+span/);
  assert.match(styles, /\.render-preview-media/);
  assert.match(html, /id="modelBatch"/);
  assert.match(client, /LOCAL_MODELS_ROOT = "D:\\\\GitHub\\\\RH_Local_Renders\\\\local\\\\models"/);
  assert.match(client, /const metadataModel = query =>/);
  assert.match(client, /const sectionalFormFactor = \(name, side = ""\) =>/);
  assert.match(client, /await loadModelMetadata\(\)/);
  assert.match(html, /id="historyList"/);
  assert.match(html, /id="historyDetail"/);
  assert.match(html, /id="rigBatchModels"/);
  assert.match(html, /id="rigRenderImages"/);
  assert.match(html, /id="jobDialog"/);
  assert.match(client, /const loadHistory = async/);
  assert.match(client, /data-history-action="rerun"/);
  assert.match(client, /data-history-action="edit"/);
  assert.match(client, /const editHistoryJob = async \(batch, options = \{\}\) =>/);
  assert.match(client, /window\.open\(batch\.jobUrl, "_blank"\)/);
  assert.match(client, /rawJsonTab\.opener = null/);
  assert.match(client, /const job = await api\(batch\.jobUrl\)/);
  assert.match(client, /state\.batch = restored/);
  assert.match(client, /importYaw: Number\.isFinite\(\+inspected\.importYaw\)/);
  assert.match(client, /class="history-model-list"/);
  assert.match(client, /openLocal\("showJob"/);
  assert.match(client, /selectHistoryModel/);
  assert.match(client, /state\.rigBatch/);
  assert.match(client, /const card = render =>/);
  assert.doesNotMatch(client, /batch\.models\.slice\(0, 6\)/);
  assert.match(styles, /\.rig-render-images img\{height:auto;aspect-ratio:auto;object-fit:contain\}/);
  assert.match(styles, /\.history-model-list\{max-height:206px;overflow:auto/);
  assert.match(styles, /\.rig-render-images>a\{background-color:#d7d7d7;background-image:/);
  assert.match(styles, /\.rig-section\{margin-top:52px;padding:22px 22px 34px;background:/);
  assert.match(html, /Shadow runs in a fresh Unreal process with Substrate disabled/);
  assert.match(html, /name="renderProfile" value="low"/);
  assert.match(html, /name="renderProfile" value="high" checked/);
  assert.match(html, /id="preflight"/);
  assert.match(html, /id="pipelineBar"/);
  assert.match(html, /name="rigLayer" value="Shadow"/);
  assert.match(client, /data-history-action="selective"/);
  assert.match(client, /render-camera-group/);
  assert.match(client, /renderProfile: selected\("renderProfile"\)\[0\] \|\| "high"/);
  assert.match(client, /Substrate \$\{render\.substrate \? "ON" : "OFF"\}/);
  assert.doesNotMatch(client, /Open the local dashboard with npm start to resolve full model paths/);
  assert.match(styles, /@media\(min-width:981px\)\{main\{width:calc\(100% - 48px\);max-width:none\}\}/);
});
