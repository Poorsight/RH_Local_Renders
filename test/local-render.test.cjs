"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { PNG } = require("pngjs");
const { parseCsv } = require("../lib/csv.cjs");
const { buildRig, jobLights } = require("../lib/rig.cjs");
const { buildJob, buildBatchJob, writeJob, CAMERA_YAW, RESOLUTION_PROFILES, groupedMaterials } = require("../lib/jobs.cjs");
const { ModelStore, sectionalFormFactor } = require("../lib/models.cjs");
const { buildUnrealLaunch } = require("../lib/unreal.cjs");
const { history, expectedRenders } = require("../lib/history.cjs");
const { buildRenderPlan, cameraStateKey, applyCameraHandoff } = require("../lib/render-plan.cjs");
const { analyzeCalibrationPair, applyCropProfile } = require("../lib/crop.cjs");
const { cameraFitStatesForJob, writeCameraFitStates } = require("../lib/camera-fit.cjs");
const { inspectObjParts, normalizeObjParts, writeMaterialLibrary } = require("../lib/obj-parts.cjs");
const net = require("node:net");
// Ports were derived from the process id across overlapping ranges, so two servers in one
// run could pick the same one. Ask the system for a free port instead.
const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.unref();
  probe.on("error", reject);
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});
const { checkModel, summarise, unrealScaleFor } = require("../lib/model-check.cjs");
const { siblingBranch, batchRootOf } = require("../lib/output-layout.cjs");
const { publishPreviews, previewFileFor } = require("../lib/preview.cjs");
const { READY_FOLDER_NAME, availability, isProcessedImage, processImage, processedPathFor, publishReadyToUpload, writePngText } = require("../lib/post-process.cjs");

const root = path.join(__dirname, "..");
const rows = parseCsv(fs.readFileSync(path.join(root, "data", "sectionals-indoor.csv"), "utf8"));
const rig = buildRig(rows);
const model = { name: "TEST_prod1", path: "D:\\models\\TEST_prod1.fbx", offsetUniformScale: 1 };
const baseInput = {
  side: "R", dimensions: { width: 343, depth: 307, height: 79 }, importYaw: 0,
  cameras: ["F", "FH", "TQ"], layers: ["Fabric"], materials: [{ meshes: ["UPH", "Stitches"], material: "FABRIC_A" }, { meshes: ["Feet"], material: "WOOD_A" }]
};

test("CSV parser preserves quoted comma-separated scene prefixes", () => {
  const parsed = parseCsv('a,b\n1,"R, U"\n'); assert.deepEqual(parsed, [{ a: "1", b: "R, U" }]);
});

test("fallback sheet pairs a sun with a shadow spot for every Sectionals / Indoor scene and camera", () => {
  for (const scene of ["Sectional_Indoor_R", "Sectional_Indoor_L", "Sectional_Indoor_U"]) for (const camera of ["F", "FH", "TQ"]) {
    assert.deepEqual(Object.keys(rig[scene][camera]).sort(), ["key_lgt", "shadow_key_lgt"], `${scene}/${camera}`);
    // The sun sits in Background and the shadow spot in KeyLight: that split is what lets the
    // Shadow layer drop the sun simply by not loading its sublevel.
    assert.equal(rig[scene][camera].key_lgt.sublevel, "Background", `${scene}/${camera}`);
    assert.equal(rig[scene][camera].shadow_key_lgt.sublevel, "KeyLight", `${scene}/${camera}`);
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

test("job lights come straight from the sheet and no longer answer to the model", () => {
  const source = rig.Sectional_Indoor_R.F.key_lgt;
  const lights = jobLights(rig, "Sectional_Indoor_R", "F");
  assert.deepEqual(lights.map(light => light.name), ["key_lgt", "shadow_key_lgt"]);
  const [sun, spot] = lights;
  assert.equal(sun.LevelName, "Sectional_Indoor_Background");
  assert.deepEqual(sun.Location, { X: source.position[0], Y: source.position[1], Z: source.position[2] });
  assert.deepEqual(sun.rotation, { Pitch: -25.913912, Yaw: -13.933297, Roll: 4.209608 });
  assert.equal(sun.intensity, 2.5);
  assert.equal(sun.InnerConeAngle, -1); assert.equal(sun.OuterConeAngle, -1);
  assert.ok(!("RectSourceWidth" in sun) && !("SourceRadius" in sun), "source geometry is no longer overridden");
  // While Fabric renders, the shadow spot ships at intensity 0 so it cannot touch the product.
  assert.equal(spot.LevelName, "Sectional_Indoor_KeyLight");
  assert.equal(spot.intensity, 0);

  // The rig is a sun: a model ten times the size must produce identical lights.
  const tiny = buildJob({ ...baseInput, dimensions: { width: 100, depth: 80, height: 40 } }, model, rig, "D:\renders\tiny");
  const huge = buildJob({ ...baseInput, dimensions: { width: 900, depth: 700, height: 300 } }, model, rig, "D:\renders\huge");
  assert.deepEqual(huge.tasks[0].sequence.cameras.map(camera => camera.lights),
                   tiny.tasks[0].sequence.cameras.map(camera => camera.lights),
                   "model size must not touch any light");
});

test("each camera keeps its own sun rotation and intensity", () => {
  const expected = {
    Sectional_Indoor_R: {
      F: [2.5, { Pitch: -25.913912, Yaw: -13.933297, Roll: 4.209608 }],
      FH: [2.3, { Pitch: -23.265797, Yaw: -8.445295, Roll: -4.469738 }],
      TQ: [2.3, { Pitch: -45, Yaw: 0, Roll: -5.483881 }]
    },
    Sectional_Indoor_L: {
      // F matches the R side: the sheet once held the FH rotation here, which lit LEFT_ARM fronts wrong.
      F: [2.5, { Pitch: -25.913912, Yaw: -13.933297, Roll: 4.209608 }],
      FH: [2.3, { Pitch: -23.265797, Yaw: -8.445295, Roll: -4.469738 }],
      TQ: [2.3, { Pitch: -45, Yaw: 12, Roll: 0 }]
    }
  };
  expected.Sectional_Indoor_U = expected.Sectional_Indoor_L;
  for (const [scene, cameras] of Object.entries(expected)) for (const [camera, [intensity, rotation]] of Object.entries(cameras)) {
    const sun = jobLights(rig, scene, camera).find(light => light.name === "key_lgt");
    assert.equal(sun.intensity, intensity, `${scene}/${camera} intensity`);
    assert.deepEqual(sun.rotation, rotation, `${scene}/${camera} rotation`);
    assert.deepEqual(sun.Location, { X: 0, Y: 0, Z: 161.417541 }, `${scene}/${camera} location`);
  }
});

test("the Shadow layer fires the spot at 100 with 45/60 cones and leaves the sun behind", () => {
  for (const scene of ["Sectional_Indoor_R", "Sectional_Indoor_L", "Sectional_Indoor_U"]) for (const camera of ["F", "FH", "TQ"]) {
    const fabric = jobLights(rig, scene, camera), shadow = jobLights(rig, scene, camera, "Shadow");
    const pick = (list, name) => list.find(light => light.name === name);
    const dark = pick(fabric, "shadow_key_lgt"), lit = pick(shadow, "shadow_key_lgt");
    assert.equal(dark.intensity, 0, `${scene}/${camera} spot must stay dark for Fabric`);
    assert.equal(lit.intensity, 100, `${scene}/${camera} spot intensity`);
    assert.equal(lit.InnerConeAngle, 45, `${scene}/${camera} inner cone`);
    assert.equal(lit.OuterConeAngle, 60, `${scene}/${camera} outer cone`);
    assert.deepEqual(lit.Location, dark.Location, `${scene}/${camera}: firing the spot must not move it`);
    assert.deepEqual(lit.rotation, dark.rotation, `${scene}/${camera}: firing the spot must not turn it`);
    // The sun is handed over untouched; the Shadow layer simply never loads the sublevel it lives in.
    assert.deepEqual(pick(shadow, "key_lgt"), pick(fabric, "key_lgt"), `${scene}/${camera} sun`);
    assert.equal(pick(shadow, "key_lgt").LevelName, "Sectional_Indoor_Background", `${scene}/${camera} sun level`);
  }

  const shadowLayer = buildJob({ ...baseInput, layers: ["Shadow"] }, model, rig, "D:\renders\shadow")
    .tasks[0].layers.find(layer => layer.name === "Shadow");
  assert.ok(!shadowLayer.SubLevels.includes("Sectional_Indoor_Background"),
            "the Shadow layer must not load the sublevel that holds the sun");

  const header = "active,airtable_categories,environment,sequence_prefix,obj,light_name,light_sublevel_suffix,camera,default_location,default_rotation,shadow_location,shadow_rotation,default_intensity,default_InnerConeAngle,default_OuterConeAngle,shadow_intensity,shadow_InnerConeAngle,shadow_OuterConeAngle,default_x,default_y,default_z,default_pitch,default_yaw,default_roll,shadow_x,shadow_y,shadow_z,shadow_pitch,shadow_yaw,shadow_roll";
  const row = "TRUE,Sectionals,Indoor,Sectional_Indoor_R,,key_lgt,KeyLight,F,,,,,2.5,,,9,45,60,0,0,160,-20,0,0,,,,,,";
  const overridden = buildRig(parseCsv(`${header}
${row}
`));
  const [shadowSun] = jobLights(overridden, "Sectional_Indoor_R", "F", "Shadow");
  const [fabricSun] = jobLights(overridden, "Sectional_Indoor_R", "F");
  assert.equal(fabricSun.intensity, 2.5); assert.equal(fabricSun.InnerConeAngle, -1);
  assert.equal(shadowSun.intensity, 9); assert.equal(shadowSun.InnerConeAngle, 45); assert.equal(shadowSun.OuterConeAngle, 60);
  assert.deepEqual(shadowSun.Location, fabricSun.Location, "an intensity override must not move the light");
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
  const rawFolder = job.tasks[0].layers[0].output.folder;
  fs.mkdirSync(rawFolder, { recursive: true });
  const jobPath = path.join(jobsRoot, "TEST_prod1.job.json"), image = path.join(rawFolder, "00000000_F_Product_uph.png");
  try {
    fs.writeFileSync(jobPath, JSON.stringify(job)); fs.writeFileSync(image, "png"); fs.writeFileSync(processedPathFor(image), "post");
    fs.mkdirSync(path.join(output, READY_FOLDER_NAME, model.name), { recursive: true }); fs.writeFileSync(path.join(output, READY_FOLDER_NAME, model.name, `${model.name}_F.png`), "delivery");
    assert.equal(expectedRenders(job.tasks[0]), 1);
    const [saved] = history(temp);
    assert.equal(saved.id, "TEST_prod1"); assert.equal(saved.modelCount, 1); assert.equal(saved.renderCount, 1); assert.equal(saved.expectedRenders, 1); assert.equal(saved.state, "complete");
    assert.equal(saved.postProcessCount, 1); assert.ok(saved.models[0].renders[0].processed); assert.ok(isProcessedImage(processedPathFor(image)));
    assert.equal(saved.readyToUpload, null, "a loose delivery image without a manifest is not treated as an upload set");
    assert.deepEqual(saved.models[0].dimensions, baseInput.dimensions); assert.equal(saved.models[0].renders[0].camera, "F");
    assert.match(saved.jobUrl, /^\/api\/jobs\/file\?path=/); assert.match(saved.models[0].renders[0].url, /^\/api\/renders\/file\?path=/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("processed renders publish into an isolated ready-to-upload model structure", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rh-ready-upload-")), output = path.join(temp, "batch_test"), current = { ...model, materialIds: ["UPH", "Stitches", "Feet"] };
  const job = buildJob({ ...baseInput, cameras: ["F", "FH", "TQ"], layers: ["Fabric", "Shadow"] }, current, rig, output), task = job.tasks[0];
  fs.mkdirSync(task.layers[0].output.folder, { recursive: true });
  try {
    for (const camera of ["F", "FH", "TQ"]) for (const layer of ["Fabric", "Shadow"]) {
      const source = path.join(task.layers[0].output.folder, layer === "Shadow" ? `00000000_${camera}_Shadow.png` : `00000000_${camera}_Product_FABRIC_A.png`);
      fs.writeFileSync(source, `raw-${camera}-${layer}`); fs.writeFileSync(processedPathFor(source), `post-${camera}-${layer}`);
    }
    const delivery = publishReadyToUpload(job, { root, config: { outputSuffix: "_POST" } });
    assert.equal(READY_FOLDER_NAME, "POST");
    assert.equal(delivery.files, 6); assert.equal(delivery.models, 1); assert.equal(delivery.complete, true);
    const modelFolder = path.join(output, READY_FOLDER_NAME, model.name);
    assert.deepEqual(fs.readdirSync(modelFolder).sort(), [
      `${model.name}_F.png`, `${model.name}_FH.png`, `${model.name}_TQ.png`,
      `${model.name}_F_Shadow.png`, `${model.name}_FH_Shadow.png`, `${model.name}_TQ_Shadow.png`
    ].sort());
    const manifest = JSON.parse(fs.readFileSync(path.join(output, "manifest.json"), "utf8"));
    assert.equal(manifest.fileCount, 6); assert.equal(manifest.complete, true); assert.ok(manifest.files.every(file => !path.isAbsolute(file.source)));
    assert.deepEqual(fs.readdirSync(path.join(output, READY_FOLDER_NAME)), [model.name], "POST holds delivery folders only");
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("every output kind lands in its own branch and previews stay small", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rh-layout-")), batch = path.join(temp, "batch_test");
  const current = { ...model, materialIds: ["UPH", "Stitches", "Feet"] };
  const job = buildBatchJob([{ model: current, input: { ...baseInput, cameras: ["F"], layers: ["Fabric"], cropMode: "optimized", modelFingerprint: "layout" } }], rig, batch, "batch_test");
  const raw = job.tasks[0].layers[0].output.folder;
  assert.equal(path.relative(batch, raw), path.join("raw", model.name), "raw renders live in the raw branch");
  assert.equal(path.relative(batch, siblingBranch(raw, "calibration")).replace(/\$/, ""), path.join("calibration", model.name), "500px probes get their own branch");
  assert.equal(path.relative(batch, siblingBranch(raw, "preview")).replace(/\$/, ""), path.join("preview", model.name), "proxies get their own branch");
  assert.equal(batchRootOf(raw), path.resolve(batch));
  // A pre-split batch has no raw segment, so the old nested folder must still resolve.
  assert.match(siblingBranch(path.join(batch, model.name), "calibration"), /_crop_calibration/);

  const wide = new PNG({ width: 3000, height: 1000 });
  for (let y = 0; y < 1000; y++) for (let x = 0; x < 3000; x++) {
    const index = ((y * 3000) + x) << 2, inside = x > 600 && x < 2400 && y > 200 && y < 800;
    wide.data[index] = 200; wide.data[index + 1] = 120; wide.data[index + 2] = 60; wide.data[index + 3] = inside ? 255 : 0;
  }
  try {
    fs.mkdirSync(raw, { recursive: true });
    const source = path.join(raw, "00000000_F_Product_uph.png");
    fs.writeFileSync(source, PNG.sync.write(wide));
    const result = publishPreviews([source]);
    assert.equal(result.created, 1); assert.deepEqual(result.failed, []);
    const proxy = previewFileFor(source);
    assert.equal(path.relative(batch, proxy), path.join("preview", model.name, "00000000_F_Product_uph.png"));
    const shrunk = PNG.sync.read(fs.readFileSync(proxy));
    assert.equal(shrunk.width, 1200); assert.equal(shrunk.height, 400, "aspect ratio survives the downscale");
    assert.ok(fs.statSync(proxy).size < fs.statSync(source).size, "a proxy must be cheaper than its source");
    // Premultiplied averaging: an interior pixel keeps its colour instead of bleeding to black.
    const middle = ((200 * 1200) + 600) << 2;
    assert.equal(shrunk.data[middle + 3], 255);
    assert.ok(Math.abs(shrunk.data[middle] - 200) <= 2 && Math.abs(shrunk.data[middle + 1] - 120) <= 2, `interior colour drifted: ${shrunk.data[middle]},${shrunk.data[middle + 1]},${shrunk.data[middle + 2]}`);
    assert.equal(publishPreviews([source]).skipped, 1, "an up-to-date proxy is not rebuilt");
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("PNG delivery metadata is inserted without replacing image chunks", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rh-png-meta-")), file = path.join(temp, "sample.png");
  try {
    const png = new PNG({ width: 2, height: 2 }); png.data.fill(255); fs.writeFileSync(file, PNG.sync.write(png));
    const before = fs.readFileSync(file); writePngText(file, { jobId: "batch_test", Camera: "F", Description: "passport" });
    const after = fs.readFileSync(file), textValue = after.toString("latin1");
    assert.ok(after.subarray(0, 8).equals(before.subarray(0, 8))); assert.match(textValue, /jobId\x00batch_test/); assert.match(textValue, /Camera\x00F/); assert.match(textValue, /Description\x00passport/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("post-process creates a delivery PNG beside an untouched original", { skip: !availability(root).ok }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rh-post-test-")), source = path.join(temp, "00000000_F_Product_FABRIC_A.png");
  const png = new PNG({ width: 4, height: 4 });
  for (let index = 0; index < png.data.length; index += 4) { png.data[index] = 180; png.data[index + 1] = 120; png.data[index + 2] = 80; png.data[index + 3] = 255; }
  fs.writeFileSync(source, PNG.sync.write(png));
  const original = fs.readFileSync(source), job = buildJob({ ...baseInput, cameras: ["F"] }, { ...model, materialIds: ["UPH", "Stitches", "Feet"] }, rig, temp), task = job.tasks[0];
  try {
    const result = await processImage(root, source, job, task, { config: { canvas: { width: 12, height: 8 }, dpi: 300, outputSuffix: "_POST", shadow: { color: "#120C06", alphaBoostPercent: { F: 25 } } } });
    assert.equal(result.skipped, false); assert.ok(fs.existsSync(result.output)); assert.deepEqual(fs.readFileSync(source), original);
    const processed = PNG.sync.read(fs.readFileSync(result.output)); assert.equal(processed.width, 12); assert.equal(processed.height, 8);
    assert.match(fs.readFileSync(result.output).toString("latin1"), /PostProcessVersion\x00RH_LOCAL_1/);
    const second = await processImage(root, source, job, task, { config: { canvas: { width: 12, height: 8 }, dpi: 300, outputSuffix: "_POST", shadow: { color: "#120C06", alphaBoostPercent: { F: 25 } } } });
    assert.equal(second.skipped, true); assert.equal(second.reason, "current");
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("Shadow post-process recolors RGB and boosts alpha on the delivery canvas", { skip: !availability(root).ok }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rh-shadow-post-test-")), source = path.join(temp, "00000000_F_Shadow.png");
  const png = new PNG({ width: 2, height: 2 });
  for (let index = 0; index < png.data.length; index += 4) { png.data[index] = 240; png.data[index + 1] = 240; png.data[index + 2] = 240; png.data[index + 3] = 128; }
  fs.writeFileSync(source, PNG.sync.write(png));
  const original = fs.readFileSync(source), job = buildJob({ ...baseInput, cameras: ["F"], layers: ["Shadow"] }, { ...model, materialIds: ["UPH", "Stitches", "Feet"] }, rig, temp), task = job.tasks[0];
  try {
    const result = await processImage(root, source, job, task, { config: { canvas: { width: 6, height: 4 }, dpi: 300, outputSuffix: "_POST", shadow: { color: "#120C06", alphaBoostPercent: { F: 25 } } } });
    const processed = PNG.sync.read(fs.readFileSync(result.output)), center = (1 * processed.width + 2) * 4;
    assert.deepEqual([...processed.data.subarray(center, center + 3)], [18, 12, 6]); assert.ok(processed.data[center + 3] > 128);
    assert.deepEqual(fs.readFileSync(source), original); assert.equal(processed.width, 6); assert.equal(processed.height, 4);
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
  assert.equal(parentCamera._rhLocalShadowLights.find(light => light.name === "key_lgt").intensity, 2.5);
  assert.equal(fabricCamera.lights.find(light => light.name === "key_lgt").intensity, 2.5);
  assert.equal(shadowCamera.lights.find(light => light.name === "key_lgt").intensity, 2.5);
  assert.equal(shadowCamera.lights.find(light => light.name === "key_lgt").InnerConeAngle, -1);
  assert.equal(shadowCamera.lights.find(light => light.name === "key_lgt").OuterConeAngle, -1);
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

test("camera Fit states persist across jobs and invalidate when fit inputs change", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rh-camera-fit-")), modelPath = path.join(temp, "MODEL_prod1.fbx");
  const projectPath = path.join(temp, "rh_unreal_2.uproject"), cacheFile = path.join(temp, "camera-fits.json");
  fs.writeFileSync(modelPath, "fbx-v1"); fs.writeFileSync(projectPath, "{}");
  const previousCache = process.env.RH_CAMERA_FIT_CACHE_FILE;
  process.env.RH_CAMERA_FIT_CACHE_FILE = cacheFile;
  try {
    const currentModel = { ...model, name: "MODEL_prod1", path: modelPath, materialIds: ["UPH", "Stitches", "Feet"] };
    const job = buildJob({ ...baseInput, layers: ["Fabric", "Shadow"] }, currentModel, rig, path.join(temp, "renders"));
    const states = new Map(job.tasks[0].sequence.cameras.map((camera, index) => [cameraStateKey(currentModel.name, camera.sequenceName), {
      cameraLocation: { x: index, y: 1650, z: 120 }, cameraRotation: { pitch: -3, yaw: -90, roll: 0 }, focalLength: 140 + index
    }]));
    assert.equal(writeCameraFitStates(temp, job, states, { projectPath, rendererToken: "renderer-a" }).length, 3);
    const cached = cameraFitStatesForJob(temp, job, { projectPath, rendererToken: "renderer-a" });
    assert.equal(cached.hits, 3); assert.equal(cached.total, 3);
    assert.equal(cached.states.get(cameraStateKey(currentModel.name, job.tasks[0].sequence.cameras[1].sequenceName)).focalLength, 141);

    const changedYaw = JSON.parse(JSON.stringify(job));
    changedYaw.tasks[0].sequence.cameras[0].Actor.Rotation.Yaw += 1;
    assert.equal(cameraFitStatesForJob(temp, changedYaw, { projectPath, rendererToken: "renderer-a" }).hits, 2, "only the changed view is invalidated");
    assert.equal(cameraFitStatesForJob(temp, job, { projectPath, rendererToken: "renderer-b" }).hits, 0, "a rebuilt renderer invalidates old camera states");
    fs.appendFileSync(modelPath, "-changed");
    assert.equal(cameraFitStatesForJob(temp, job, { projectPath, rendererToken: "renderer-a" }).hits, 0, "an updated FBX invalidates every view");
  } finally {
    if (previousCache === undefined) delete process.env.RH_CAMERA_FIT_CACHE_FILE; else process.env.RH_CAMERA_FIT_CACHE_FILE = previousCache;
    fs.rmSync(temp, { recursive: true, force: true });
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

test("optimized crop unions Fabric and Shadow alpha with a symmetric safety margin", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rh-crop-")), fabricFile = path.join(temp, "fabric.png"), shadowFile = path.join(temp, "shadow.png");
  const image = (width, top, bottom) => {
    const png = new PNG({ width, height: 500 });
    for (let y = top; y <= bottom; y += 1) for (let x = Math.floor(width * 0.3); x < Math.ceil(width * 0.7); x += 1) png.data[((y * width + x) << 2) + 3] = 255;
    return PNG.sync.write(png);
  };
  try {
    fs.writeFileSync(fabricFile, image(500, 150, 300)); fs.writeFileSync(shadowFile, image(1500, 270, 320));
    const profile = analyzeCalibrationPair(fabricFile, shadowFile, { margin: 0.05 });
    assert.deepEqual(profile.bounds.union, { top: 125, bottom: 345 });
    assert.equal(profile.bounds.safe.top + profile.bounds.safe.bottom, 499, "safe crop remains centered on the optical axis");
    const fabric = applyCropProfile(RESOLUTION_PROFILES.high.Fabric, profile), shadow = applyCropProfile(RESOLUTION_PROFILES.high.Shadow, profile);
    assert.equal(fabric.Resolution.X, 5000); assert.equal(shadow.Resolution.X, 15000);
    assert.equal(fabric.Resolution.Y, shadow.Resolution.Y); assert.equal(fabric.SensorSize.Y, shadow.SensorSize.Y);
    assert.ok(fabric.Resolution.Y < 5000); assert.equal(shadow.SensorSize.X, 108);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("missing optimized profiles prepend one-time Fabric and Shadow calibration phases", () => {
  const optimized = buildJob({ ...baseInput, cropMode: "optimized", modelFingerprint: "fingerprint", layers: ["Fabric", "Shadow"] }, { ...model, materialIds: ["UPH", "Stitches", "Feet"] }, rig, "D:\\renders\\crop-pending");
  const phases = buildRenderPlan(optimized);
  assert.deepEqual(phases.map(phase => phase.name), ["Crop calibration · Fabric", "Crop calibration · Shadow", "Fabric", "Shadow"]);
  assert.deepEqual(phases[0].job.tasks[0].sequence.cameras[0].LayerResolutions[0].Resolution, { X: 500, Y: 500 });
  assert.deepEqual(phases[1].job.tasks[0].sequence.cameras[0].LayerResolutions[0].Resolution, { X: 1500, Y: 500 });
  assert.equal(phases[2].useCameraHandoff, true); assert.equal(phases[3].useCameraHandoff, true);
});

test("cached optimized profiles crop both final layers without calibration", () => {
  const cropProfile = { cropRatio: 0.5, analyzedAt: "cached" };
  const optimized = buildJob({ ...baseInput, cropMode: "optimized", modelFingerprint: "fingerprint", cropProfiles: { F: cropProfile, FH: cropProfile, TQ: cropProfile }, layers: ["Fabric", "Shadow"] }, { ...model, materialIds: ["UPH", "Stitches", "Feet"] }, rig, "D:\\renders\\crop-ready");
  assert.deepEqual(buildRenderPlan(optimized).map(phase => phase.name), ["Fabric", "Shadow"]);
  const [fabric, shadow] = optimized.tasks[0].sequence.cameras[0].LayerResolutions;
  assert.equal(fabric.Resolution.Y, shadow.Resolution.Y); assert.equal(fabric.SensorSize.Y, shadow.SensorSize.Y);
  assert.equal(fabric.Resolution.X, 5000); assert.equal(shadow.Resolution.X, 15000);
  assert.equal(optimized.tasks[0].sequence.cameras[0]._rhLocalCrop.status, "ready");
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
    for (const launch of launches) {
      assert.equal(launch.keyLight.intensity, 2.5); assert.equal(launch.keyLight.InnerConeAngle, -1); assert.equal(launch.keyLight.OuterConeAngle, -1);
    }
    assert.ok(launches[1].cameras.every(camera => camera.fit === "none"));
    assert.deepEqual(launches[1].cameras.map(camera => camera.Camera.FocalLength), [140, 141, 142]);
    assert.ok(launches[1].cameras.every(camera => camera.Camera.OverrideLocation && camera.Camera.OverrideRotation && camera.Camera.OverrideFocalLength));
    assert.match(status.log, /Fabric is complete\. Restarting Unreal for Shadow with Substrate OFF/);
    assert.match(status.log, /Applied 3 camera states from Fabric handoff to Shadow; fit disabled/);
  } finally {
    service.kill();
    fs.rmSync(jobPath, { force: true }); fs.rmSync(output, { recursive: true, force: true }); fs.rmSync(fakeLog, { force: true });
  }
});

test("local render service calibrates, saves and applies an optimized crop before final layers", async () => {
  const suffix = `${process.pid}_${Date.now()}`, port = 58000 + process.pid % 3000;
  const jobsRoot = path.join(root, "local", "jobs", "generated"), output = path.join(root, "local", "renders", `test_crop_${suffix}`);
  const jobPath = path.join(jobsRoot, `test_crop_${suffix}.job.json`), fakeLog = path.join(os.tmpdir(), `rh-fake-crop-${suffix}.log`), cropCache = path.join(os.tmpdir(), `rh-crop-cache-${suffix}.json`);
  fs.mkdirSync(jobsRoot, { recursive: true }); fs.mkdirSync(output, { recursive: true });
  const job = buildJob({ ...baseInput, cameras: ["F"], layers: ["Fabric", "Shadow"], cropMode: "optimized", modelFingerprint: "test-fingerprint" }, { ...model, materialIds: ["UPH", "Stitches", "Feet"] }, rig, output);
  job.jobId = `test_crop_${suffix}`; job._rhLocal.outputFolder = `${output}${path.sep}`;
  fs.writeFileSync(jobPath, JSON.stringify(job));
  const service = spawn(process.execPath, [path.join(root, "server.cjs")], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, RH_LOCAL_RENDERS_PORT: String(port), RH_UNREAL_EDITOR: process.execPath, RH_UNREAL_PROJECT: path.join(root, "test", "fake-unreal.cjs"), RH_FAKE_UNREAL_LOG: fakeLog, RH_CROP_CACHE_FILE: cropCache }
  });
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  try {
    let online = false;
    for (let attempt = 0; attempt < 50 && !online; attempt++) { try { online = (await fetch(`http://127.0.0.1:${port}/api/status`)).ok; } catch {} if (!online) await sleep(50); }
    assert.equal(online, true);
    const launch = await fetch(`http://127.0.0.1:${port}/api/renders`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobPath }) });
    assert.equal(launch.status, 202);
    let status;
    for (let attempt = 0; attempt < 600; attempt++) {
      status = await (await fetch(`http://127.0.0.1:${port}/api/renders/status`)).json();
      if (status.state !== "running") break;
      await sleep(50);
    }
    assert.equal(status.state, "success", status.log);
    assert.equal(status.rendered, 4); assert.equal(status.totalRenders, 4);
    assert.equal(status.postProcess.total, 2, "calibration frames are not delivery outputs"); assert.equal(status.postProcess.state, "success");
    assert.ok(fs.existsSync(path.join(output, READY_FOLDER_NAME, model.name)), "automatic post-process publishes directly into POST");
    assert.ok(fs.existsSync(path.join(output, "manifest.json")), "the manifest sits beside POST, not inside the delivery");
    assert.equal(fs.readdirSync(path.join(output, READY_FOLDER_NAME)).filter(name => name === "manifest.json").length, 0, "POST carries delivery files only");
    assert.equal(fs.readdirSync(job.tasks[0].layers[0].output.folder).filter(name => /_POST\.png$/i.test(name)).length, 0, "processed copies are not left beside RAW files");
    const launches = fs.readFileSync(fakeLog, "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.deepEqual(launches.map(item => item.phase), ["Crop calibration · Fabric", "Crop calibration · Shadow", "Fabric", "Shadow"]);
    const saved = JSON.parse(fs.readFileSync(jobPath, "utf8")), [fabric, shadow] = saved.tasks[0].sequence.cameras[0].LayerResolutions;
    assert.ok(fabric.Resolution.Y < 5000); assert.equal(fabric.Resolution.Y, shadow.Resolution.Y); assert.equal(fabric.SensorSize.Y, shadow.SensorSize.Y);
    assert.equal(saved.tasks[0].sequence.cameras[0]._rhLocalCrop.status, "ready");
    assert.equal(saved._rhLocal.cameraStates["test_prod1::sectional_indoor_r_f"].focalLength, 140, "the delivery passport can reuse the actual Fabric camera state");
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(cropCache, "utf8")).profiles).length, 1);
    assert.match(status.log, /Saved 1 crop profile; average vertical pixel saving/);
  } finally {
    service.kill();
    fs.rmSync(jobPath, { force: true }); fs.rmSync(output, { recursive: true, force: true }); fs.rmSync(fakeLog, { force: true }); fs.rmSync(cropCache, { force: true });
  }
});

test("local render service automatically resumes after an Unreal crash and skips completed models", async () => {
  const suffix = `${process.pid}_${Date.now()}`, port = await freePort();
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

test("a forced stop kills Unreal, disarms the automatic resume and leaves the service usable", async () => {
  const suffix = `stop_${process.pid}_${Date.now()}`, port = await freePort();
  const jobsRoot = path.join(root, "local", "jobs", "generated"), output = path.join(root, "local", "renders", `test_${suffix}`);
  const jobPath = path.join(jobsRoot, `test_${suffix}.job.json`), fakeLog = path.join(os.tmpdir(), `rh-fake-${suffix}.log`);
  fs.mkdirSync(jobsRoot, { recursive: true }); fs.mkdirSync(output, { recursive: true });
  const job = buildBatchJob([{ model, input: { ...baseInput, layers: ["Fabric"] } }], rig, output, `test_${suffix}`);
  fs.writeFileSync(jobPath, JSON.stringify(job));
  const service = spawn(process.execPath, [path.join(root, "server.cjs")], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, RH_LOCAL_RENDERS_PORT: String(port), RH_UNREAL_EDITOR: process.execPath, RH_UNREAL_PROJECT: path.join(root, "test", "fake-unreal.cjs"), RH_FAKE_UNREAL_LOG: fakeLog, RH_FAKE_UNREAL_STALL: "9000" }
  });
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const status = async () => (await fetch(`http://127.0.0.1:${port}/api/renders/status`)).json();
  try {
    let online = false;
    for (let attempt = 0; attempt < 50 && !online; attempt++) { try { online = (await fetch(`http://127.0.0.1:${port}/api/status`)).ok; } catch {} if (!online) await sleep(50); }
    assert.equal(online, true);

    assert.equal((await fetch(`http://127.0.0.1:${port}/api/renders/stop`, { method: "POST" })).status, 409, "nothing to stop while idle");

    assert.equal((await fetch(`http://127.0.0.1:${port}/api/renders`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobPath }) })).status, 202);
    // Wait until the fake editor has really claimed the job, so the stop hits a live render.
    for (let attempt = 0; attempt < 200 && !fs.existsSync(fakeLog); attempt++) await sleep(50);
    assert.equal(fs.existsSync(fakeLog), true, "Unreal never picked the job up");
    const running = await status();
    assert.equal(running.state, "running");
    assert.ok(running.pid, "a running render must expose the Unreal pid");

    const stopped = await (await fetch(`http://127.0.0.1:${port}/api/renders/stop`, { method: "POST" })).json();
    assert.equal(stopped.state, "stopped");
    assert.equal(stopped.pid, null);
    assert.match(stopped.log, /Forced stop during/);

    // The automatic phase restart must stay disarmed: a stop is a decision, not a crash.
    await sleep(3000);
    const after = await status();
    assert.equal(after.state, "stopped", after.log);
    assert.ok(!after.autoRestarts, `autoRestarts=${after.autoRestarts}`);
    assert.equal(fs.readFileSync(fakeLog, "utf8").trim().split(/\r?\n/).length, 1, "Unreal must not be relaunched");

    // And the service must be free again rather than wedged behind a dead run.
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/renders`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobPath }) })).status, 202);
    await fetch(`http://127.0.0.1:${port}/api/renders/stop`, { method: "POST" });
  } finally {
    service.kill();
    fs.rmSync(jobPath, { force: true }); fs.rmSync(output, { recursive: true, force: true }); fs.rmSync(fakeLog, { force: true });
  }
});

test("deleting from the web drops the renders, their proxies and only the asked-for job", async () => {
  const suffix = `del_${process.pid}_${Date.now()}`, port = await freePort();
  const jobsRoot = path.join(root, "local", "jobs", "generated"), batch = path.join(root, "local", "renders", `test_${suffix}`);
  const jobPath = path.join(jobsRoot, `test_${suffix}.job.json`);
  fs.mkdirSync(jobsRoot, { recursive: true });
  const job = buildBatchJob([{ model: { ...model, materialIds: ["UPH", "Stitches", "Feet"] }, input: { ...baseInput, cameras: ["F"], layers: ["Fabric"] } }], rig, batch, `test_${suffix}`);
  fs.writeFileSync(jobPath, JSON.stringify(job));
  const raw = job.tasks[0].layers[0].output.folder, render = path.join(raw, "00000000_F_Product_uph.png");
  fs.mkdirSync(raw, { recursive: true });
  const tiny = new PNG({ width: 8, height: 8 });
  for (let i = 0; i < tiny.data.length; i += 4) { tiny.data[i] = 180; tiny.data[i + 1] = 120; tiny.data[i + 2] = 90; tiny.data[i + 3] = 255; }
  fs.writeFileSync(render, PNG.sync.write(tiny));
  fs.writeFileSync(processedPathFor(render), "post");
  publishPreviews([render]);
  const proxy = previewFileFor(render);
  const service = spawn(process.execPath, [path.join(root, "server.cjs")], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, RH_LOCAL_RENDERS_PORT: String(port) }
  });
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const post = (bodyValue) => fetch(`http://127.0.0.1:${port}/api/renders/delete`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(bodyValue) });
  try {
    let online = false;
    for (let attempt = 0; attempt < 50 && !online; attempt++) { try { online = (await fetch(`http://127.0.0.1:${port}/api/status`)).ok; } catch {} if (!online) await sleep(50); }
    assert.equal(online, true);

    assert.equal((await post({ file: path.join(root, "server.cjs") })).status, 400, "only files under local/renders may be deleted");
    assert.equal((await post({ jobPath: path.join(root, "package.json") })).status, 400, "only generated job files may be deleted");

    assert.equal(fs.existsSync(proxy), true, "the proxy exists before the delete");
    const single = await (await post({ file: render })).json();
    assert.equal(single.kind, "file");
    // A frame takes its derivatives with it, or the gallery keeps a preview of nothing.
    assert.equal(fs.existsSync(render), false);
    assert.equal(fs.existsSync(proxy), false, "the proxy goes with its frame");
    assert.equal(fs.existsSync(processedPathFor(render)), false, "the processed copy goes with its frame");
    assert.equal((await post({ file: render })).status, 404, "a second delete has nothing to remove");

    const renders = await (await post({ jobPath, keepJob: true })).json();
    assert.equal(renders.kind, "renders");
    assert.equal(fs.existsSync(batch), false, "the whole batch folder goes");
    assert.equal(fs.existsSync(jobPath), true, "keepJob leaves the job behind so it can be run again");

    const whole = await (await post({ jobPath })).json();
    assert.equal(whole.kind, "batch");
    assert.equal(fs.existsSync(jobPath), false);
  } finally {
    service.kill();
    fs.rmSync(jobPath, { force: true }); fs.rmSync(batch, { recursive: true, force: true });
  }
});

test("the service stays same-origin until an origin is allowed, then answers a remote page", async () => {
  const port = await freePort(), remote = "https://preview.3dsource.com";
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const start = env => spawn(process.execPath, [path.join(root, "server.cjs")], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, RH_LOCAL_RENDERS_PORT: String(port), ...env } });
  const waitFor = async () => { for (let attempt = 0; attempt < 60; attempt++) { try { if ((await fetch(`http://127.0.0.1:${port}/api/status`)).ok) return true; } catch {} await sleep(50); } return false; };
  let service = start({});
  try {
    assert.equal(await waitFor(), true);
    const closed = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { Origin: remote } });
    assert.equal(closed.headers.get("access-control-allow-origin"), null, "a service with no allowlist stays local-only");
  } finally { service.kill(); await sleep(300); }

  service = start({ RH_ALLOWED_ORIGINS: `${remote}, http://localhost:4173` });
  try {
    assert.equal(await waitFor(), true);
    const opened = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { Origin: remote } });
    assert.equal(opened.headers.get("access-control-allow-origin"), remote);
    assert.equal(opened.headers.get("vary"), "Origin");
    const preflight = await fetch(`http://127.0.0.1:${port}/api/renders/status`, { method: "OPTIONS", headers: { Origin: remote, "Access-Control-Request-Method": "POST" } });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get("access-control-allow-methods") || "", /POST/);
    const stranger = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { Origin: "https://somewhere.else" } });
    assert.equal(stranger.headers.get("access-control-allow-origin"), null, "an origin outside the allowlist gets nothing");
  } finally { service.kill(); }
});

test("without the key the service still shows everything and refuses only the actions", async () => {
  const port = await freePort(), key = "test-access-key-2eb1";
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const service = spawn(process.execPath, [path.join(root, "server.cjs")], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, RH_LOCAL_RENDERS_PORT: String(port), RH_ACCESS_KEY: key }
  });
  const at = path => `http://127.0.0.1:${port}${path}`;
  const signed = { Authorization: `Bearer ${key}` };
  // This test runs on the machine the service is on, and a request from here is treated as
  // the operator. A tunnel stamp is what makes a call stand in for one from outside.
  const outside = { "CF-Ray": "8f0a1b2c3d4e-FRA" };
  const json = { "Content-Type": "application/json", ...outside };
  try {
    let online = false;
    for (let attempt = 0; attempt < 60 && !online; attempt++) { try { online = (await fetch(at("/api/status"))).ok; } catch {} if (!online) await sleep(50); }
    assert.equal(online, true);

    // Looking is open: a viewer with the address sees the queue, the history and the files.
    for (const path of ["/api/status", "/api/history", "/api/catalog", "/api/materials", "/api/renders/status"]) {
      assert.equal((await fetch(at(path))).status, 200, `${path} must stay readable`);
    }
    assert.notEqual((await fetch(at("/api/renders/file?path=nothing.png"))).status, 401, "renders are readable without a key");
    assert.notEqual((await fetch(at("/api/preflight"), { method: "POST", headers: json, body: "{}" })).status, 401, "preflight only validates, so it stays open");

    // Status must answer with the verdict the gate would give, not a different one.
    const fromOutside = await (await fetch(at("/api/status"), { headers: outside })).json();
    assert.deepEqual(fromOutside.access, { required: true, authorized: false });
    const fromHere = await (await fetch(at("/api/status"))).json();
    assert.deepEqual(fromHere.access, { required: true, authorized: true }, "the operator's own page is not read-only");
    assert.deepEqual((await (await fetch(at("/api/status"), { headers: signed })).json()).access, { required: true, authorized: true });

    // Acting is not: everything that starts work, writes a file or reaches the network.
    for (const path of ["/api/renders", "/api/renders/stop", "/api/renders/delete", "/api/jobs", "/api/postprocess", "/api/sheet/refresh", "/api/models/inspect", "/api/local/open"]) {
      assert.equal((await fetch(at(path), { method: "POST", headers: json, body: "{}" })).status, 401, `${path} must need the key`);
    }
    assert.equal((await fetch(at("/api/renders"), { method: "POST", headers: { ...json, Authorization: "Bearer wrong-key-entirely" }, body: "{}" })).status, 401);
    assert.notEqual((await fetch(at("/api/renders"), { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 401,
      "the same call from this machine, with no tunnel stamp, is the operator");
    // With the key the same call gets through to the endpoint's own validation, not a 401.
    assert.notEqual((await fetch(at("/api/renders"), { method: "POST", headers: { ...json, ...signed }, body: "{}" })).status, 401);

    // The plugin channel cannot present a key, so it is trusted over the loopback interface.
    assert.notEqual((await fetch(at("/api/unreal"))).status, 401);

    assert.equal((await fetch(at("/api/renders/delete"), { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.7" }, body: "{}" })).status, 401,
      "any tunnel stamp puts a caller outside");
  } finally { service.kill(); }
});

test("an OBJ whose parts are only face groups is renamed into meshes an importer can see", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rh-obj-"));
  const source = path.join(temp, "sofa.obj"), target = path.join(temp, "sofa.normalised.obj");
  // The shape the sofa library ships: named face groups, one catch-all material, and a
  // "default" group that interrupts a part half way through.
  fs.writeFileSync(source, [
    "# comment", "mtllib sofa.mtl", "g default",
    "v 0 0 0", "v 1 0 0", "v 0 1 0", "v 1 1 0",
    "s off", "g Feet", "usemtl initialShadingGroup", "f 1/1/1 2/2/2 3/3/3",
    "g default", "f 2/2/2 3/3/3 4/4/4",
    "s 1", "g UPH", "usemtl initialShadingGroup", "f 1/1/1 2/2/2 4/4/4", ""
  ].join("\n"), "utf8");

  const before = await inspectObjParts(source);
  assert.deepEqual(before.namedParts, ["Feet", "UPH"]);
  assert.equal(Object.keys(before.objects).length, 0, "nothing an importer keys a mesh off");
  assert.equal(Object.keys(before.materials).length, 1, "one material across both parts");
  assert.equal(before.needsNormalising, true);

  const result = await normalizeObjParts(source, target);
  assert.deepEqual(result.parts, ["Feet", "UPH"]);
  assert.equal(result.droppedGroups, 2, "both default groups carry no identity");
  assert.equal(result.faces, 3, "every face survives");

  const after = await inspectObjParts(target);
  assert.deepEqual(Object.keys(after.objects).sort(), ["Feet", "UPH"]);
  assert.deepEqual(Object.keys(after.materials).sort(), ["Feet", "UPH"], "each part gets its own material boundary");
  assert.equal(after.needsNormalising, false);

  const text = fs.readFileSync(target, "utf8");
  assert.match(text, /o Feet\ng Feet\nusemtl Feet/, "object, group and material name the same part");
  assert.doesNotMatch(text, /initialShadingGroup/, "the catch-all material would merge the parts back");
  assert.doesNotMatch(text, /^g default$/m, "placeholder groups are gone");
  // Geometry and the lines that carry it must pass through untouched.
  assert.equal((text.match(/^f /gm) || []).length, 3);
  assert.equal((text.match(/^v /gm) || []).length, 4);
  assert.match(text, /^s off$/m);

  const library = writeMaterialLibrary(target, result.parts);
  assert.match(fs.readFileSync(library, "utf8"), /newmtl Feet[\s\S]*newmtl UPH/);
  fs.rmSync(temp, { recursive: true, force: true });
});

test("model checks catch a wrong scale, a missing part and an uncorrected FBX orientation", () => {
  const sofa = { dimensions: [277.2, 106.4, 85.1], yaw: 0, scale: 0.001, materialIds: ["UPH", "Feet"], meshObjects: 2, analysis: { detectedBack: "+Y", unit: "millimetres" } };
  const sectional = { dimensions: { width: 355.5, depth: 274.6, height: 86.9 }, yaw: 90, scale: 1, materialIds: ["UPH", "Stitches", "Feet"], meshObjects: 3, analysis: { detectedBack: "-X", unit: "metres" } };
  const find = (findings, code) => findings.find(item => item.code === code);

  // Models arrive at whatever scale their exporter used, so the factor is measured per model
  // and passed through: a tracked inch model carries 2.54 and renders correctly with it.
  assert.equal(unrealScaleFor(sofa), 0.001);
  assert.equal(unrealScaleFor(sectional), 1);
  assert.equal(unrealScaleFor({ scale: 2.54 }), 2.54, "what the farm sends for an inch export");
  assert.equal(unrealScaleFor({ scale: 0 }), null);

  const sofaFindings = checkModel({ name: "BELLA_TWO_SEAT_SOFA", group: "sofas", format: "obj" }, sofa);
  assert.equal(find(sofaFindings, "scale").level, "ok");
  assert.match(find(sofaFindings, "scale").detail, /millimetres measured/);
  assert.equal(find(sofaFindings, "parts").level, "ok", "a sofa needs upholstery and feet, not stitches");
  assert.equal(find(sofaFindings, "size").level, "ok");

  const sectionalFindings = checkModel({ name: "X_L_SECTIONAL", group: "", format: "fbx" }, sectional);
  assert.equal(summarise(sectionalFindings).errors, 0);
  assert.equal(find(sectionalFindings, "orientation").level, "ok");
  assert.match(find(sectionalFindings, "orientation").detail, /matching import yaw \+90/);

  // A sectional missing its stitches has nowhere to put that material.
  const noStitches = checkModel({ name: "X_L_SECTIONAL", group: "sectionals", format: "fbx" },
    { ...sectional, materialIds: ["UPH", "Feet"] });
  assert.equal(find(noStitches, "missing-parts").level, "error");
  assert.equal(find(noStitches, "missing-parts").repairable, false, "an FBX cannot be repaired by renaming groups");

  // The same gap in an OBJ is usually just names in the wrong place.
  const objGap = checkModel({ name: "SOFA", group: "sofas", format: "obj" }, { ...sofa, materialIds: [] });
  assert.equal(find(objGap, "missing-parts").repairable, true);

  // Units guessed wrong show up as a size no piece of furniture has.
  const tooSmall = checkModel({ name: "SOFA", group: "sofas", format: "obj" }, { ...sofa, dimensions: [2.77, 1.06, 0.85] });
  assert.equal(find(tooSmall, "implausible-size").level, "error");

  // A measured axis implies the correction it needs, so a mismatch is an error and a match
  // is fine — a model that simply needs no turn must not be flagged for not turning.
  const wrongWay = checkModel({ name: "X_L_SECTIONAL", group: "sectionals", format: "fbx" }, { ...sectional, yaw: 0 });
  assert.equal(find(wrongWay, "orientation").level, "error");
  assert.match(find(wrongWay, "orientation").detail, /needs import yaw \+90/);
  const straight = checkModel({ name: "SOFA", group: "sofas", format: "obj" }, sofa);
  assert.equal(find(straight, "orientation").level, "ok", "a backrest already at +Y needs no yaw");
  const untracked = checkModel({ name: "X", group: "", format: "fbx" }, { ...sectional, analysis: null });
  assert.equal(find(untracked, "orientation").level, "info", "tracked metadata carries no measured axis to compare");

  // Trailing digits are an export artefact, not a different part.
  const suffixed = checkModel({ name: "X_L_SECTIONAL", group: "sectionals", format: "fbx" },
    { ...sectional, materialIds: ["UPH1", "Stitches1", "Feet1"] });
  assert.equal(summarise(suffixed).errors, 0, "UPH1 is UPH");
});

test("a sofa job matches the farm's shape: four angles, one layer, its own scene", () => {
  const sofa = { name: "BELLA_TWO_SEAT_SOFA_CLASSIC_9", path: "D:\models\sofas\BELLA.obj", group: "sofas", offsetUniformScale: 0.001, materialIds: ["UPH", "Feet"] };
  const input = {
    productType: "sofas", cameras: ["F", "P", "TQ", "TQB"], layers: ["Fabric"],
    dimensions: { width: 277.2, depth: 106.4, height: 85.1 }, importYaw: 0,
    materials: [{ meshes: ["UPH"], material: "BELGIAN_LINEN_BASKET_WEAVE_SAND_V1" }, { meshes: ["Feet"], material: "UPH_WOOD_BROWN_OAK" }]
  };
  const task = buildJob(input, sofa, rig, "D:\out").tasks[0];

  assert.deepEqual(task.sequence.cameras.map(camera => camera.name), ["F", "P", "TQ", "TQB"], "one angle more than a sectional, and different ones");
  assert.deepEqual(task.layers.map(layer => layer.name), ["Fabric"], "a sofa has no Shadow pass");
  assert.deepEqual(task.layers[0].SubLevels, ["Sofa_Indoor_Background", "Sofa_Indoor_KeyLight"]);

  // A camera angle is the model actor being turned, and an OBJ needs no axis correction
  // where an FBX carries roll -90.
  const yaws = Object.fromEntries(task.sequence.cameras.map(camera => [camera.name, camera.Actor.Rotation.Yaw]));
  assert.deepEqual(yaws, { F: 0, P: 90, TQ: 30, TQB: 150 });
  assert.ok(task.sequence.cameras.every(camera => camera.Actor.Rotation.Roll === 0), "an OBJ exports its axes straight");

  for (const camera of task.sequence.cameras) {
    assert.equal(camera.sequenceName, `Sofa_Indoor_${camera.name}`);
    assert.deepEqual(camera.SceneActors.map(actor => actor.name), ["light_blocker"], "the blocker keeps the key light off the backdrop");
    assert.equal(camera.SceneActors[0].Visibility, false);
    assert.deepEqual(camera.lights.map(light => light.name),
      ["front_fill_lgt", "left_rim_lgt", "main_key_lgt", "right_bounce_lgt", "right_rim_lgt"], `${camera.name} lights`);
    assert.ok(camera.lights.every(light => light.LevelName.startsWith("Sofa_Indoor_")), `${camera.name} lights live in the sofa scene`);
  }
  // The intensities the farm renders with, straight from the sheet.
  const byName = Object.fromEntries(task.sequence.cameras.find(camera => camera.name === "TQB").lights.map(light => [light.name, light.intensity]));
  assert.deepEqual(byName, { front_fill_lgt: 6, left_rim_lgt: 80, main_key_lgt: 15, right_bounce_lgt: 1.5, right_rim_lgt: 1 });

  // Asking for a pass a sofa does not have is refused rather than silently dropped into a job.
  assert.throws(() => buildJob({ ...input, layers: ["Shadow"] }, sofa, rig, "D:\out"), /at least one render layer/);
  assert.throws(() => buildJob({ ...input, cameras: ["FH"] }, sofa, rig, "D:\out"), /F, P, TQ, TQB/);
  // And a sectional keeps its own shape.
  const sectionalTask = buildJob({ ...baseInput, side: "R", importYaw: -90 }, model, rig, "D:\out").tasks[0];
  assert.deepEqual(sectionalTask.layers[0].SubLevels, ["Sectional_Indoor_Background", "Sectional_Indoor_KeyLight"]);
  assert.ok(sectionalTask.sequence.cameras.every(camera => camera.Actor.Rotation.Roll === -90), "an FBX still carries its correction");
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
  const powerShellLauncher = fs.readFileSync(path.join(root, "Launch_RH_Local_Renders.ps1"), "utf8");
  const batch = fs.readFileSync(path.join(root, "Start_RH_Local_Renders.bat"), "utf8");
  const serviceScript = fs.readFileSync(path.join(root, "scripts", "start-local-service.ps1"), "utf8");
  assert.match(launcher, /ShellExecute "powershell\.exe"/);
  assert.match(launcher, /Launch_RH_Local_Renders\.ps1/);
  assert.match(powerShellLauncher, /Get-RHServerState/);
  assert.match(powerShellLauncher, /runtime\.stale/);
  assert.match(powerShellLauncher, /Get-NetTCPConnection/);
  assert.match(powerShellLauncher, /Stop-Process/);
  assert.match(powerShellLauncher, /start-local-service\.ps1/);
  assert.match(powerShellLauncher, /Start-Process \$siteUrl/);
  assert.match(batch, /start-local-service\.ps1/);
  assert.match(batch, /Launch_RH_Local_Renders\.ps1/);
  assert.match(serviceScript, /Start-Process -FilePath \$node\.Source/);
  assert.match(serviceScript, /-WindowStyle Hidden/);
  assert.match(serviceScript, /server-error\.log/);
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

test("every element app.js reaches for by id exists in the markup", () => {
  // Deleting a control and forgetting its reader throws at runtime, which surfaces as a
  // useless "Cannot read properties of null" in the preflight panel.
  const clientSource = fs.readFileSync(path.join(root, "app.js"), "utf8");
  const markup = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const ids = new Set([...clientSource.matchAll(/\$\("([A-Za-z0-9_]+)"\)/g)].map(match => match[1]));
  const present = new Set([...markup.matchAll(/id="([A-Za-z0-9_]+)"/g)].map(match => match[1]));
  const missing = [...ids].filter(id => !present.has(id)).sort();
  assert.deepEqual(missing, [], `app.js reads ids that the page does not have: ${missing.join(", ")}`);
});

test("main page renders the workspace, previews and dropdowns", () => {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const client = fs.readFileSync(path.join(root, "app.js"), "utf8");
  const styles = fs.readFileSync(path.join(root, "app.css"), "utf8");
  assert.doesNotMatch(html, /<iframe/i);
  assert.match(client, /canReachLocalService/);
  assert.match(html, /id="modelDropTarget"/);
  assert.match(html, /id="modelFileInput" type="file" accept="\.fbx" multiple/);
  assert.match(client, /droppedFilePath/);
  assert.match(client, /dropTarget\.addEventListener\("drop"/);
  assert.match(client, /useDroppedModels/);
  assert.match(client, /const normalizedMaterialId = id =>/);
  assert.match(client, /data-material-ids=/);
  assert.match(client, /const renderEta = render =>/);
  assert.match(client, /class="render-queue-name"/);
  assert.match(client, /active: "Rendering", complete: "Complete", partial: "Partial", pending: "Upcoming"/);
  assert.match(styles, /--bronze-strong:/);
  assert.match(styles, /--success-strong:/);
  assert.match(styles, /render-orb-pulse/);
  assert.match(styles, /render-progress-flow/);
  assert.match(styles, /\.render-queue-name/);
  assert.match(styles, /input\[type=checkbox\]:checked,input\[type=radio\]:checked\{background:transparent;box-shadow:var\(--sel-ring\)\}/);
  assert.match(styles, /--sel-ring:inset 0 0 0 1px var\(--accent-edge\)/);
  assert.match(styles, /@keyframes accent-breathe/);
  assert.match(styles, /\.render-preview-card>span\{bottom:auto/);
  assert.match(styles, /\.render-preview-card\.render-combined:hover \.render-preview-media \.render-composite-fabric\{transform:translate\(-50%,-50%\)\}/);
  assert.match(styles, /render-soft-glow/);
  assert.match(styles, /aspect-ratio:3\/1!important/);
  assert.match(styles, /strong,b\{font-weight:500!important\}h1,h2,h3\{font-weight:550!important\}/);
  assert.match(styles, /\.selective-options input:checked\+span/);
  assert.match(styles, /\.render-preview-media/);
  assert.match(html, /id="modelBatch"/);
  assert.match(client, /LOCAL_MODELS_ROOT = "D:\\\\GitHub\\\\RH_Local_Renders\\\\local\\\\models"/);
  assert.match(client, /const metadataModel = query =>/);
  assert.match(client, /const sectionalFormFactor = \(name, side = ""\) =>/);
  assert.match(client, /await loadModelMetadata\(\)/);
  assert.match(html, /id="historyList"/);
  assert.match(html, /id="historyDetail"/);
  assert.match(html, /id="jobDialog"/);
  assert.match(client, /const loadHistory = async/);
  assert.match(client, /data-history-action="rerun"/);
  assert.match(client, />Edit selection<\/button>/);
  assert.match(client, /data-history-action="openReady"/);
  assert.match(client, /const editHistoryJob = async \(batch, options = \{\}\) =>/);
  assert.match(client, /window\.open\(batch\.jobUrl, "_blank"\)/);
  assert.match(client, /rawJsonTab\.opener = null/);
  assert.match(client, /const job = await api\(batch\.jobUrl\)/);
  assert.match(client, /state\.batch = restored/);
  assert.match(client, /importYaw: Number\.isFinite\(\+inspected\.importYaw\)/);
  assert.match(client, /class="history-model-list"/);
  assert.match(client, /openLocal\("showJob"/);
  assert.match(client, /selectHistoryModel/);
  assert.doesNotMatch(client, /render\.processed \|\| render/);
  assert.doesNotMatch(client, /fabric\.processed \|\| fabric/);
  assert.doesNotMatch(client, /batch\.models\.slice\(0, 6\)/);
  assert.match(styles, /\.history-model-list\{max-height:206px;overflow:auto/);
  assert.match(styles, /\.render-preview-media\{background:var\(--preview-bg\)\}/);
  assert.match(html, /<pre id="renderLog" class="render-log"><\/pre>/);
  assert.match(client, /log\.hidden = false;/);
  assert.match(styles, /\.workspace-col-status>\.output-panel\{overflow:visible;flex:1 1 auto/);
  assert.match(styles, /\.workspace-col-status>\.queue-panel\{flex:0 0 auto\}/);
  assert.match(html, /<section class="panel log-panel"[\s\S]*?<pre id="renderLog" class="render-log"><\/pre>/);
  assert.match(styles, /\.log-panel \.render-log\{height:300px/);
  assert.match(styles, /\.render-queue\{[^}]*max-height:min\(34vh,300px\);overflow:auto/);
  assert.doesNotMatch(styles, /box-shadow:box-shadow/);
  // queue rows are spans with data-state, so nothing may style them as divs or by
  // position: span:last-child used to catch the last row in the whole list
  assert.match(client, /<span data-state="\$\{escapeHtml\(itemState\)\}"/);
  assert.match(styles, /\.render-queue>span\{display:grid/);
  assert.match(styles, /\.render-queue>span\[data-state=active\]\{box-shadow:var\(--sel-ring\)\}/);
  assert.doesNotMatch(styles, /\.render-queue>div[.{]/);
  assert.doesNotMatch(styles, /\.render-queue span:last-child/);
  // a long batch scrolls, and the running model is brought into view once per change
  assert.match(client, /state\.queueFocus !== render\.currentTask/);
  assert.match(client, /list\.scrollTop = Math\.max\(0, offset -/);
  assert.match(html, /class="output-fieldsets"/);
  assert.match(html, /workspace-col-status">\s*<section class="panel output-panel"/);
  assert.match(styles, /\[data-material-status\]\[data-state=found\]\{background:var\(--accent-soft\)/);
  assert.match(styles, /\[data-material-status\]\[data-state=missing\]\{background:var\(--danger-soft\)/);
  assert.doesNotMatch(styles, /\.render-preview-media\{background-color:[^}]*linear-gradient/);
  assert.match(html, /Shadow runs in a fresh Unreal process with Substrate disabled/);
  assert.match(html, /name="renderProfile" value="low"/);
  assert.match(html, /name="renderProfile" value="high" checked/);
  assert.match(html, /name="cropMode" value="optimized"/);
  assert.equal((html.match(/data-theme-value=/g) || []).length, 3);
  for (const value of ["light", "system", "dark"]) assert.match(html, new RegExp(`data-theme-value="${value}"`));
  assert.match(client, /allowed = \["light", "system", "dark"\]/);
  assert.match(html, /id="preflight"/);
  assert.match(styles, /\.preflight-checks>span\[data-level=ok\]>b\{color:var\(--accent-ink\)\}/);
  assert.match(styles, /\.preflight-checks>span\[data-level=error\]>b\{color:var\(--danger\)\}/);
  assert.doesNotMatch(styles, /\.preflight-checks>span\.(ok|error)\{/);
  assert.match(styles, /\.output-panel>\.preflight\{flex:1 1 auto\}/);
  assert.match(styles, /\.output-panel>\.preflight>\.preflight-checks\{flex:1 1 0;min-height:132px\}/);
  assert.match(styles, /\.render-status span\{[^}]*overflow-wrap:anywhere\}/);
  // dropdowns are the app's own surface, not a flat OS window
  assert.match(styles, /@supports \(appearance:base-select\)/);
  assert.match(styles, /select:open::picker\(select\)\{opacity:1;transform:none\}/);
  assert.match(styles, /@supports not \(appearance:base-select\)/);
  assert.match(styles, /\.suggest-pop:popover-open\{opacity:1;transform:none\}/);
  assert.match(client, /input\[list\]/);
  assert.match(client, /showPopover\(\)/);
  // one ring slides between the options of a single-choice group
  assert.match(styles, /\.segmented:has\(>label:nth-of-type\(2\)>input:checked\):before/);
  assert.match(styles, /transition:transform \.34s/);
  // switching a control must never change its size
  assert.doesNotMatch(styles, /input:checked\+span\{[^}]*font-weight/);
  assert.doesNotMatch(styles, /input:checked\+span:before\{content/);
  assert.doesNotMatch(html, /id="pipelineBar"/);
  assert.doesNotMatch(client, /stickyGenerate/);
  assert.match(client, /data-history-action="selective"/);
  assert.match(client, /renderProfile: selected\("renderProfile"\)\[0\] \|\| "high"/);
  assert.match(client, /Substrate \$\{render\.substrate \? "ON" : "OFF"\}/);
  assert.doesNotMatch(client, /Open the local dashboard with npm start to resolve full model paths/);
  assert.match(styles, /main\{width:calc\(100% - clamp\([^)]*\)\);max-width:none/);
  assert.match(styles, /\.workspace\{display:grid/);
  assert.match(styles, /\.workspace-col\{display:flex;flex-direction:column/);
  assert.match(html, /class="workspace-col workspace-col-status"/);
});
