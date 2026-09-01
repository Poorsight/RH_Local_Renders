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
const { PRODUCT_TYPES, withResolutionOverrides, buildJob, buildBatchJob, writeJob, CAMERA_YAW, RESOLUTION_PROFILES, groupedMaterials, synchronizeMaterialGroups, materialCombinationCount } = require("../lib/jobs.cjs");
const { ModelStore, sectionalFormFactor } = require("../lib/models.cjs");
const { buildUnrealLaunch } = require("../lib/unreal.cjs");
const { history, expectedRenders } = require("../lib/history.cjs");
const { buildRenderPlan, cameraStateKey, applyCameraHandoff } = require("../lib/render-plan.cjs");
const { analyzeCalibrationPair, applyCropProfile, calibrationFiles } = require("../lib/crop.cjs");
const { cameraFitStatesForJob, writeCameraFitStates } = require("../lib/camera-fit.cjs");
const { inspectObjParts, normalizeObjParts, writeMaterialLibrary } = require("../lib/obj-parts.cjs");
const { applyCropProfileToCamera } = require("../lib/crop.cjs");
const { sublevelPrefix } = require("../lib/rig.cjs");
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
const { siblingBranch, siblingLayerBranch, batchRootOf } = require("../lib/output-layout.cjs");
const { publishPreviews, previewFileFor } = require("../lib/preview.cjs");
const { READY_FOLDER_NAME, availability, isProcessedImage, prepareSubstrateShadow, processImage, processedPathFor, publishReadyToUpload, writePngText } = require("../lib/post-process.cjs");
const { DEFAULT_ENVIRONMENT, normalizeEnvironment, renderEnvironments, resolveRenderEnvironment, environmentForJob, publicRenderEnvironment } = require("../lib/render-environments.cjs");
const runStats = require("../lib/run-stats.cjs");

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

test("each Material ID keeps its own BatchRender variants", () => {
  const groups = groupedMaterials([
    { meshes: ["UPH"], materials: ["A", "B", "C", "D", "E"] },
    { meshes: ["Stitches"], material: "A" }
  ]);
  assert.deepEqual(groups.map(group => group.meshes), [["uph"], ["stitches"]]);
  assert.deepEqual(groups[0].list.map(item => item.name), ["A", "B", "C", "D", "E"]);
  assert.ok(groups.flatMap(group => group.list).every(item => item.ApplyExposure === false && item.postProccessName === "RH_POST_PROCESS"));
  assert.equal(materialCombinationCount(groups), 5);
});

test("identical multi-material lists stay paired across UPH and Stitches", () => {
  const names = ["BLACK", "CARAMEL", "FOG", "BLUE", "INDIGO", "NATURAL", "WHITE"];
  const groups = groupedMaterials([
    { meshes: ["UPH"], materials: names },
    { meshes: ["Stitches"], materials: names },
    { meshes: ["Feet"], material: "WOOD" }
  ]);
  assert.deepEqual(groups.map(group => group.meshes), [["uph", "stitches"], ["feet"]]);
  assert.deepEqual(groups[0].list.map(item => item.name), names);
  assert.equal(materialCombinationCount(groups), 7, "seven paired fabrics must not become 7 × 7 combinations");
});

test("identical single materials share one BatchRender group and one filename token", () => {
  const longUph = "belgian_track_arm_bench_seat_left_arm_return_sofa_luxe_9_47760743_uph";
  const longStitches = "belgian_track_arm_bench_seat_left_arm_return_sofa_luxe_9_47760743_stitches";
  const longFeet = "belgian_track_arm_bench_seat_left_arm_return_sofa_luxe_9_47760743_feet";
  const input = {
    ...baseInput,
    cameras: ["F"],
    materials: [
      { meshes: [longUph], material: "BELGIAN_LINEN_CLASSIC_SAND_V1" },
      { meshes: [longStitches], material: "BELGIAN_LINEN_CLASSIC_SAND_V1" },
      { meshes: [longFeet], material: "UPH_WOOD_BROWN_OAK" }
    ]
  };
  const longModel = { ...model, materialIds: [longUph, longStitches, longFeet] };
  const task = buildJob(input, longModel, rig, "D:\\renders\\single-material").tasks[0];
  assert.deepEqual(task.materials.map(group => group.meshes), [[longUph, longStitches], [longFeet]]);
  assert.equal(task.materials[0].list[0].name, "BELGIAN_LINEN_CLASSIC_SAND_V1");
  assert.equal(task.layers[0].output.fileNameFormat, `00000000_{camera}_Product_{material:${longUph}}_{material:${longFeet}}`);
  assert.equal(materialCombinationCount(task.materials), 1);
});

test("Multiply makes selected Material IDs independent while the default refuses accidental products", () => {
  const names = ["BLACK", "WHITE"];
  const independent = groupedMaterials([
    { meshes: ["UPH"], materials: names },
    { meshes: ["Stitches"], materials: names, multiply: true }
  ]);
  assert.deepEqual(independent.map(group => group.meshes), [["uph"], ["stitches"]]);
  assert.equal(materialCombinationCount(independent), 4);
  assert.throws(() => groupedMaterials([
    { meshes: ["UPH"], materials: ["FABRIC_A", "FABRIC_B"] },
    { meshes: ["Stitches"], materials: ["THREAD_A", "THREAD_B"] }
  ]), /Linked material lists differ/);
  // A legacy saved job had no explicit mode. It keeps working, while identical lists are
  // still safely collapsed when such a job is resumed.
  assert.equal(materialCombinationCount(synchronizeMaterialGroups([
    { meshes: ["UPH"], list: names.map(name => ({ name })) },
    { meshes: ["Stitches"], list: ["THREAD_A", "THREAD_B"].map(name => ({ name })) }
  ])), 4);
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
    assert.equal(saved.models[0].renders[0].material, "FABRIC_A");
    assert.deepEqual(saved.models[0].renders[0].materials, ["FABRIC_A", "WOOD_A"]);
    assert.match(saved.jobUrl, /^\/api\/jobs\/file\?path=/); assert.match(saved.models[0].renders[0].url, /^\/api\/renders\/file\?path=/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("processed renders publish into an isolated ready-to-upload model structure", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rh-ready-upload-")), output = path.join(temp, "batch_test"), current = { ...model, materialIds: ["UPH", "Stitches", "Feet"] };
  const job = buildJob({ ...baseInput, cameras: ["F", "FH", "TQ"], layers: ["Fabric", "Shadow"] }, current, rig, output), task = job.tasks[0];
  fs.mkdirSync(task.layers[0].output.folder, { recursive: true });
  try {
    fs.mkdirSync(task.layers[1].output.folder, { recursive: true });
    for (const camera of ["F", "FH", "TQ"]) for (const layer of ["Fabric", "Shadow"]) {
      const source = path.join(task.layers[layer === "Shadow" ? 1 : 0].output.folder, layer === "Shadow" ? `00000000_${camera}_Shadow.png` : `00000000_${camera}_Product_FABRIC_A.png`);
      fs.writeFileSync(source, `raw-${camera}-${layer}`); fs.writeFileSync(processedPathFor(source), `post-${camera}-${layer}`);
    }
    const delivery = publishReadyToUpload(job, { root, config: { outputSuffix: "_POST" } });
    assert.equal(READY_FOLDER_NAME, "POST");
    assert.equal(delivery.files, 6); assert.equal(delivery.models, 1); assert.equal(delivery.complete, true);
    const modelFolder = path.join(output, READY_FOLDER_NAME, model.name);
    assert.deepEqual(fs.readdirSync(modelFolder).sort(), ["materials", "shadows"]);
    assert.deepEqual(fs.readdirSync(path.join(modelFolder, "materials")).sort(), [`${model.name}_F.png`, `${model.name}_FH.png`, `${model.name}_TQ.png`].sort());
    assert.deepEqual(fs.readdirSync(path.join(modelFolder, "shadows")).sort(), [`${model.name}_F_Shadow.png`, `${model.name}_FH_Shadow.png`, `${model.name}_TQ_Shadow.png`].sort());
    const manifest = JSON.parse(fs.readFileSync(path.join(output, "manifest.json"), "utf8"));
    assert.equal(manifest.fileCount, 6); assert.equal(manifest.complete, true); assert.ok(manifest.files.every(file => !path.isAbsolute(file.source)));
    assert.deepEqual(fs.readdirSync(path.join(output, READY_FOLDER_NAME)), [model.name], "POST holds delivery folders only");
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("delivery keeps every Fabric variant beside one shared Shadow", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rh-material-variants-")), current = { ...model, materialIds: ["UPH", "Stitches", "Feet"] };
  const materials = [{ meshes: ["UPH"], materials: ["FABRIC_RED", "FABRIC_BLUE"] }, { meshes: ["Stitches"], material: "THREAD" }, { meshes: ["Feet"], material: "WOOD" }];
  const job = buildJob({ ...baseInput, cameras: ["F"], layers: ["Fabric", "Shadow"], materials }, current, rig, temp), task = job.tasks[0];
  try {
    for (const layer of task.layers) fs.mkdirSync(layer.output.folder, { recursive: true });
    const sources = [
      path.join(task.layers[0].output.folder, "00000000_F_Product_FABRIC_RED_THREAD_WOOD.png"),
      path.join(task.layers[0].output.folder, "00000000_F_Product_FABRIC_BLUE_THREAD_WOOD.png"),
      path.join(task.layers[1].output.folder, "00000000_F_Shadow.png")
    ];
    for (const source of sources) { fs.writeFileSync(source, "raw"); fs.writeFileSync(processedPathFor(source), "post"); }
    const delivery = publishReadyToUpload(job, { root, config: { outputSuffix: "_POST" } });
    const materialFolder = path.join(delivery.folder, model.name, "materials"), shadowFolder = path.join(delivery.folder, model.name, "shadows");
    assert.deepEqual(fs.readdirSync(materialFolder).sort(), [`${model.name}_F_FABRIC_BLUE__THREAD__WOOD.png`, `${model.name}_F_FABRIC_RED__THREAD__WOOD.png`].sort());
    assert.deepEqual(fs.readdirSync(shadowFolder), [`${model.name}_F_Shadow.png`]);
    const manifest = JSON.parse(fs.readFileSync(path.join(temp, "manifest.json"), "utf8"));
    assert.deepEqual(manifest.files.filter(file => file.layer === "Fabric").map(file => file.material).sort(), ["FABRIC_BLUE", "FABRIC_RED"]);
    assert.deepEqual(manifest.files.find(file => file.layer === "Shadow").materials, []);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("history maps a top-level delivery manifest back to RAW renders", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rh-history-post-"));
  const jobsRoot = path.join(temp, "local", "jobs", "generated"), output = path.join(temp, "local", "renders", "batch_post");
  const current = { ...model, materialIds: ["UPH", "Stitches", "Feet"] };
  const job = buildJob({ ...baseInput, cameras: ["F"], layers: ["Fabric"] }, current, rig, output), raw = job.tasks[0].layers[0].output.folder;
  const source = path.join(raw, "00000000_F_Product_FABRIC_A.png"), deliveryFolder = path.join(output, READY_FOLDER_NAME, model.name), delivery = path.join(deliveryFolder, `${model.name}_F.png`);
  fs.mkdirSync(jobsRoot, { recursive: true }); fs.mkdirSync(raw, { recursive: true }); fs.mkdirSync(deliveryFolder, { recursive: true });
  try {
    fs.writeFileSync(path.join(jobsRoot, "batch_post.job.json"), JSON.stringify({ ...job, jobId: "batch_post" }));
    fs.writeFileSync(source, Buffer.alloc(2048)); fs.writeFileSync(delivery, Buffer.alloc(2048));
    fs.writeFileSync(path.join(output, "manifest.json"), JSON.stringify({ version: 2, complete: true, fileCount: 1, modelCount: 1,
      files: [{ model: model.name, camera: "F", layer: "Fabric", file: `${model.name}/${model.name}_F.png`, source: path.relative(output, source).replace(/\\/g, "/") }] }));
    const [saved] = history(temp);
    assert.equal(saved.postProcessCount, 1); assert.equal(saved.readyToUpload.files, 1); assert.equal(saved.readyToUpload.complete, true);
    assert.ok(saved.models[0].renders[0].processed, "the manifest source must resolve to its POST delivery");
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("every output kind lands in its own branch and previews stay small", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rh-layout-")), batch = path.join(temp, "batch_test");
  const current = { ...model, materialIds: ["UPH", "Stitches", "Feet"] };
  const job = buildBatchJob([{ model: current, input: { ...baseInput, cameras: ["F"], layers: ["Fabric"], cropMode: "optimized", modelFingerprint: "layout" } }], rig, batch, "batch_test");
  const raw = job.tasks[0].layers[0].output.folder;
  assert.equal(path.relative(batch, raw), path.join("raw", model.name, "materials"), "Fabric variants live in the material branch");
  assert.equal(path.relative(batch, siblingBranch(raw, "calibration")).replace(/\$/, ""), path.join("calibration", model.name, "materials"), "500px probes get their own branch");
  assert.equal(path.relative(batch, siblingLayerBranch(raw, "calibration", "Fabric")).replace(/\$/, ""), path.join("calibration", model.name, "materials"));
  assert.equal(path.relative(batch, siblingLayerBranch(raw, "calibration", "Shadow")).replace(/\$/, ""), path.join("calibration", model.name, "shadows"));
  assert.equal(path.relative(batch, siblingBranch(raw, "preview")).replace(/\$/, ""), path.join("preview", model.name, "materials"), "proxies preserve the layer branch");
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
    assert.equal(path.relative(batch, proxy), path.join("preview", model.name, "materials", "00000000_F_Product_uph.png"));
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

test("Substrate Shadow RGB is converted to calibrated black RGBA before downstream work", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rh-shadow-alpha-")), file = path.join(temp, "00000000_F_Shadow.png");
  const png = new PNG({ width: 3, height: 1 });
  for (let x = 0; x < 3; x += 1) {
    const value = [0, 128, 255][x], index = x << 2;
    png.data[index] = value; png.data[index + 1] = value; png.data[index + 2] = value; png.data[index + 3] = 0;
  }
  fs.writeFileSync(file, PNG.sync.write(png));
  try {
    const original = fs.readFileSync(file);
    const referenceCurve = [[0, 0], [1, 2], [255, 228]];
    const result = prepareSubstrateShadow(file, { config: { shadow: { substrateAlpha: { inputBlack: 0, gamma: 0.159453125, inputWhite: 255, referenceCurve } } } });
    assert.equal(result.skipped, false); assert.equal(result.maxAlpha, 228);
    assert.deepEqual(fs.readFileSync(result.sourceBackup), original, "the hidden high-resolution RGB source stays recoverable");
    const converted = PNG.sync.read(fs.readFileSync(file));
    assert.deepEqual([...converted.data.subarray(0, 3)], [0, 0, 0]); assert.equal(converted.data[3], 0);
    assert.deepEqual([...converted.data.subarray(4, 7)], [0, 0, 0]);
    const levelsMiddle = Math.round(255 * Math.pow(128 / 255, 1 / 0.159453125));
    assert.equal(converted.data[7], Math.round(2 + (228 - 2) * ((levelsMiddle - 1) / 254)));
    assert.deepEqual([...converted.data.subarray(8, 12)], [0, 0, 0, 228]);
    const bytes = fs.readFileSync(file), second = prepareSubstrateShadow(file);
    assert.equal(second.skipped, true); assert.equal(second.reason, "alpha already present"); assert.deepEqual(fs.readFileSync(file), bytes);
    const recalibrated = prepareSubstrateShadow(file, { config: { shadow: { substrateAlpha: { referenceCurve: [[0, 0], [228, 200], [255, 220]] } } }, recalibrateExistingAlpha: true });
    assert.equal(recalibrated.recalibrated, true); assert.equal(PNG.sync.read(fs.readFileSync(file)).data[11], 200);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("constant opaque Legacy Shadow alpha is recovered from RGB instead of being skipped", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rh-shadow-opaque-alpha-")), file = path.join(temp, "00000000_F_Shadow.png");
  const png = new PNG({ width: 3, height: 1 }), lut = Array.from({ length: 256 }, (_, value) => value);
  for (let x = 0; x < 3; x += 1) {
    const value = [0, 128, 255][x], index = x << 2;
    png.data[index] = value; png.data[index + 1] = value; png.data[index + 2] = value; png.data[index + 3] = 255;
  }
  fs.writeFileSync(file, PNG.sync.write(png));
  try {
    const result = prepareSubstrateShadow(file, { config: { shadow: { substrateAlpha: { directLumaLut: { F: lut } } } } });
    assert.equal(result.skipped, false); assert.equal(result.calibration.mode, "direct-luma-lut");
    const converted = PNG.sync.read(fs.readFileSync(file));
    assert.deepEqual([...converted.data], [0, 0, 0, 0, 0, 0, 0, 128, 0, 0, 0, 255]);
    assert.match(result.sourceBackup, /\.substrate-rgb\.bak$/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("camera Shadow LUTs are the primary conversion for every product type", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rh-camera-shadow-lut-"));
  const lut = Array.from({ length: 256 }, (_, value) => Math.round(value / 2));
  try {
    for (const [productType, camera] of [["sofas", "F"], ["sectionals", "TQ"], ["chairs", "P"]]) {
      const file = path.join(temp, `00000000_${camera}_Shadow.png`);
      const png = new PNG({ width: 1, height: 1 }); png.data[0] = 128; png.data[1] = 128; png.data[2] = 128; png.data[3] = 0;
      fs.writeFileSync(file, PNG.sync.write(png));
      const result = prepareSubstrateShadow(file, { productType, config: { shadow: { substrateAlpha: { directLumaLut: { F: lut, P: lut, TQ: lut, TQB: lut } } } } });
      assert.equal(result.calibration.mode, "direct-luma-lut"); assert.equal(result.calibration.camera, camera);
      assert.equal(result.calibration.productType, productType); assert.equal(PNG.sync.read(fs.readFileSync(file)).data[3], 64);
    }
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("render environments keep production UE 5.6 and beta UE 5.8 isolated", () => {
  const profiles = renderEnvironments({
    RH_UNREAL_EDITOR_56: "D:\\UE56\\UnrealEditor.exe",
    RH_UNREAL_PROJECT_56: "D:\\RH56\\rh.uproject",
    RH_UNREAL_EDITOR_58: "D:\\UE58\\UnrealEditor.exe",
    RH_UNREAL_PROJECT_58: "D:\\RH58\\rh.uproject"
  });
  assert.equal(DEFAULT_ENVIRONMENT, "ue56");
  assert.equal(normalizeEnvironment("UE-5.8"), "ue58");
  assert.equal(normalizeEnvironment("beta"), "ue58");
  assert.equal(normalizeEnvironment("unknown"), "ue56");
  assert.equal(resolveRenderEnvironment("ue58", profiles).project, "D:\\RH58\\rh.uproject");
  assert.equal(resolveRenderEnvironment("ue56", profiles).editor, "D:\\UE56\\UnrealEditor.exe");
  assert.equal(profiles.ue56.recoverLegacyShadow, true);
  assert.equal(profiles.ue58.recoverLegacyShadow, false);
  assert.equal(profiles.ue58.beta, true);
  assert.equal(publicRenderEnvironment(profiles.ue58).id, "ue58");
});

test("generated and saved jobs stay pinned to their selected render environment", () => {
  const current = { ...model, materialIds: ["UPH", "Stitches", "Feet"] };
  const single = buildJob({ ...baseInput, renderEnvironment: "ue58" }, current, rig, "D:\\renders\\ue58");
  const batch = buildBatchJob([
    { model: current, input: { ...baseInput, renderEnvironment: "ue58" } },
    { model: { ...current, name: "TEST_prod2" }, input: { ...baseInput, renderEnvironment: "ue58" } }
  ], rig, "D:\\renders\\ue58-batch", "ue58_batch");
  assert.equal(single._rhLocal.renderEnvironment, "ue58");
  assert.equal(single._rhLocal.models, undefined);
  assert.equal(single.tasks[0]._rhLocal, undefined);
  assert.equal(environmentForJob(single, renderEnvironments()).id, "ue58");
  assert.equal(batch._rhLocal.renderEnvironment, "ue58");
  assert.ok(batch._rhLocal.models.every(item => item.renderEnvironment === "ue58"));
  assert.equal(environmentForJob({ _rhLocal: {} }, renderEnvironments()).id, "ue56");
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
  const alpha = [128, 64, 192, 128];
  for (let index = 0; index < png.data.length; index += 4) { png.data[index] = 240; png.data[index + 1] = 240; png.data[index + 2] = 240; png.data[index + 3] = alpha[index >> 2]; }
  fs.writeFileSync(source, PNG.sync.write(png));
  const original = fs.readFileSync(source), job = buildJob({ ...baseInput, cameras: ["F"], layers: ["Shadow"] }, { ...model, materialIds: ["UPH", "Stitches", "Feet"] }, rig, temp), task = job.tasks[0];
  try {
    const result = await processImage(root, source, job, task, { config: { canvas: { width: 6, height: 4 }, dpi: 300, outputSuffix: "_POST", shadow: { color: "#120C06", alphaBoostPercent: { F: 25 } } } });
    const processed = PNG.sync.read(fs.readFileSync(result.output)), center = (1 * processed.width + 2) * 4;
    assert.deepEqual([...processed.data.subarray(center, center + 3)], [18, 12, 6]); assert.ok(processed.data[center + 3] > 128);
    assert.deepEqual(fs.readFileSync(source), original); assert.equal(processed.width, 6); assert.equal(processed.height, 4);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("a recovered camera-LUT matte still receives the configured delivery boost", { skip: !availability(root).ok }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rh-shadow-lut-post-test-")), source = path.join(temp, "00000000_F_Shadow.png");
  const png = new PNG({ width: 2, height: 2 });
  for (let index = 0; index < png.data.length; index += 4) {
    const value = 10 + (index >> 2);
    png.data[index] = value; png.data[index + 1] = value; png.data[index + 2] = value; png.data[index + 3] = 0;
  }
  fs.writeFileSync(source, PNG.sync.write(png));
  const job = buildJob({ ...baseInput, cameras: ["F"], layers: ["Shadow"] }, { ...model, materialIds: ["UPH", "Stitches", "Feet"] }, rig, temp), task = job.tasks[0];
  const directLumaLut = { F: Array.from({ length: 256 }, (_, value) => value) };
  try {
    const config = { canvas: { width: 6, height: 4 }, dpi: 300, outputSuffix: "_POST", shadow: { color: "#120C06", alphaBoostPercent: { F: 100 }, substrateAlpha: { directLumaLut } } };
    prepareSubstrateShadow(source, { config, task, productType: "sectionals" });
    const result = await processImage(root, source, job, task, { force: true, config });
    const output = PNG.sync.read(fs.readFileSync(result.output));
    const alphas = [...output.data].filter((_, index) => index % 4 === 3);
    assert.equal(Math.max(...alphas), 25);
    assert.deepEqual(alphas.filter(value => value > 0).sort((a, b) => a - b), [19, 21, 23, 25]);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("UE 5.8 delivery preserves native Shadow alpha without creating a legacy recovery backup", { skip: !availability(root).ok }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rh-native-shadow-post-test-")), source = path.join(temp, "00000000_F_Shadow.png");
  const png = new PNG({ width: 2, height: 2 });
  for (let index = 0; index < png.data.length; index += 4) { png.data[index] = 0; png.data[index + 1] = 0; png.data[index + 2] = 0; png.data[index + 3] = index === 0 ? 64 : 192; }
  fs.writeFileSync(source, PNG.sync.write(png));
  const originalAlpha = [...PNG.sync.read(fs.readFileSync(source)).data].filter((_, index) => index % 4 === 3);
  const job = buildJob({ ...baseInput, renderEnvironment: "ue58", cameras: ["F"], layers: ["Shadow"] }, { ...model, materialIds: ["UPH", "Stitches", "Feet"] }, rig, temp), task = job.tasks[0];
  try {
    const result = await processImage(root, source, job, task, { prepareShadow: false, config: { canvas: { width: 6, height: 4 }, dpi: 300, outputSuffix: "_POST", shadow: { color: "#120C06", alphaBoostPercent: { F: 0 } } } });
    assert.equal(result.skipped, false);
    assert.equal(fs.existsSync(`${source}.substrate-rgb.bak`), false);
    assert.deepEqual([...PNG.sync.read(fs.readFileSync(source)).data].filter((_, index) => index % 4 === 3), originalAlpha);
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

test("Fabric and Shadow become ordered Unreal phases with Substrate always enabled", () => {
  const job = buildJob({ ...baseInput, layers: ["Fabric", "Shadow"] }, { ...model, materialIds: ["UPH", "Stitches", "Feet"] }, rig, "D:\\renders\\phases");
  const original = JSON.stringify(job), plan = buildRenderPlan(job);
  assert.deepEqual(plan.map(phase => [phase.name, phase.substrate]), [["Fabric", true], ["Shadow", true]]);
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

test("five Fabric materials render in sequence while Shadow and crop probes render once", () => {
  const materials = [
    { meshes: ["UPH"], materials: ["FAB_A", "FAB_B", "FAB_C", "FAB_D", "FAB_E"] },
    { meshes: ["Stitches"], material: "THREAD" },
    { meshes: ["Feet"], material: "WOOD" }
  ];
  const job = buildJob({ ...baseInput, cameras: ["F", "TQ"], layers: ["Fabric", "Shadow"], cropMode: "optimized", modelFingerprint: "five-materials", materials }, { ...model, materialIds: ["UPH", "Stitches", "Feet"] }, rig, "D:\\renders\\five-materials");
  const task = job.tasks[0], plan = buildRenderPlan(job);
  assert.deepEqual(task.materials.map(group => group.list.length), [5, 1, 1]);
  assert.match(task.layers.find(layer => layer.name === "Fabric").output.fileNameFormat, /\{material:uph\}.*\{material:stitches\}.*\{material:feet\}/);
  assert.match(task.layers.find(layer => layer.name === "Fabric").output.folder, /raw[\\/]TEST_prod1[\\/]materials[\\/]$/);
  assert.match(task.layers.find(layer => layer.name === "Shadow").output.folder, /raw[\\/]TEST_prod1[\\/]shadows[\\/]$/);
  assert.equal(expectedRenders(task), 12, "two cameras produce five fabrics and one shadow each");
  assert.deepEqual(runStats.frameCounts(job), { Fabric: 10, Shadow: 2 });
  assert.deepEqual(plan.find(phase => phase.name === "Fabric").job.tasks[0].materials.map(group => group.list.length), [5, 1, 1]);
  assert.match(plan.find(phase => phase.name === "Crop calibration · Fabric").job.tasks[0].layers[0].output.fileNameFormat, /crop_fabric_\{camera\}_Product_\{material:uph\}/);
  assert.match(plan.find(phase => phase.name === "Crop calibration · Fabric").job.tasks[0].layers[0].output.folder, /calibration[\\/]TEST_prod1[\\/]materials[\\/]$/);
  assert.match(plan.find(phase => phase.name === "Crop calibration · Shadow").job.tasks[0].layers[0].output.folder, /calibration[\\/]TEST_prod1[\\/]shadows[\\/]$/);
  assert.ok(plan.filter(phase => phase.isCalibration).every(phase => phase.job.tasks.every(item => item.materials.every(group => group.list.length === 1))), "calibration uses one representative material only");
});

test("every Shadow calibration phase also keeps Substrate enabled", () => {
  const optimized = buildJob({ ...baseInput, layers: ["Fabric", "Shadow"], cropMode: "optimized", modelFingerprint: "substrate-test" }, { ...model, materialIds: ["UPH", "Stitches", "Feet"] }, rig, "D:\\renders\\substrate-shadow-crop");
  assert.ok(buildRenderPlan(optimized).filter(phase => phase.layerName === "Shadow").every(phase => phase.substrate === true));
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
  assert.notEqual(phases[2].useCameraHandoff, true,
    "the final Fabric fits its own frame -- a probe's focal length reframed a sofa enough to cut its arms");
  assert.equal(phases[3].useCameraHandoff, true, "Shadow must line up with the Fabric it is composited against");
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

test("local render service completes Fabric before restarting for Substrate-on Shadow", async () => {
  const suffix = `${process.pid}_${Date.now()}`, port = 56000 + process.pid % 5000;
  const jobsRoot = path.join(root, "local", "jobs", "generated"), output = path.join(root, "local", "renders", `test_phases_${suffix}`);
  const jobPath = path.join(jobsRoot, `test_phases_${suffix}.job.json`), fakeLog = path.join(os.tmpdir(), `rh-fake-unreal-${suffix}.log`);
  fs.mkdirSync(jobsRoot, { recursive: true }); fs.mkdirSync(output, { recursive: true });
  const job = buildJob({ ...baseInput, layers: ["Fabric", "Shadow"] }, { ...model, materialIds: ["UPH", "Stitches", "Feet"] }, rig, output);
  job.jobId = `test_phases_${suffix}`; job._rhLocal.outputFolder = `${output}${path.sep}`;
  fs.writeFileSync(jobPath, JSON.stringify(job));
  const service = spawn(process.execPath, [path.join(root, "server.cjs")], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, RH_LOCAL_RENDERS_PORT: String(port), RH_UNREAL_EDITOR: process.execPath, RH_UNREAL_PROJECT: path.join(root, "test", "fake-unreal.cjs"), RH_FAKE_UNREAL_LOG: fakeLog, RH_RUN_STATS_FILE: path.join(path.dirname(fakeLog), "run-stats.json"), RH_CHECK_CACHE_FILE: path.join(path.dirname(fakeLog), "model-checks.json") }
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
    assert.match(launches[0].substrateArgument, /r\.Substrate=True$/); assert.match(launches[1].substrateArgument, /r\.Substrate=True$/);
    for (const launch of launches) {
      assert.equal(launch.keyLight.intensity, 2.5); assert.equal(launch.keyLight.InnerConeAngle, -1); assert.equal(launch.keyLight.OuterConeAngle, -1);
    }
    assert.ok(launches[1].cameras.every(camera => camera.fit === "none"));
    assert.deepEqual(launches[1].cameras.map(camera => camera.Camera.FocalLength), [140, 141, 142]);
    assert.ok(launches[1].cameras.every(camera => camera.Camera.OverrideLocation && camera.Camera.OverrideRotation && camera.Camera.OverrideFocalLength));
    assert.match(status.log, /Fabric is complete\. Restarting Unreal for Shadow with Substrate ON/);
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
    env: { ...process.env, RH_LOCAL_RENDERS_PORT: String(port), RH_UNREAL_EDITOR: process.execPath, RH_UNREAL_PROJECT: path.join(root, "test", "fake-unreal.cjs"), RH_FAKE_UNREAL_LOG: fakeLog, RH_CROP_CACHE_FILE: cropCache, RH_RUN_STATS_FILE: path.join(path.dirname(fakeLog), "run-stats.json"), RH_CHECK_CACHE_FILE: path.join(path.dirname(fakeLog), "model-checks.json") }
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
    assert.match(status.log, /Starting Shadow alpha recovery for 1 calibration image; crop and previews wait for this stage/);
    const calibrationShadow = calibrationFiles(siblingBranch(job.tasks[0].layers[0].output.folder, "calibration"), "F").shadow;
    const normalized = PNG.sync.read(fs.readFileSync(calibrationShadow));
    assert.ok([...normalized.data].some((value, index) => index % 4 === 3 && value > 0), "crop sees recovered Shadow alpha");
    assert.ok([...normalized.data].every((value, index) => index % 4 === 3 || value === 0), "recovered Shadow RGB is black");
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
    env: { ...process.env, RH_LOCAL_RENDERS_PORT: String(port), RH_UNREAL_EDITOR: process.execPath, RH_UNREAL_PROJECT: path.join(root, "test", "fake-unreal.cjs"), RH_FAKE_UNREAL_LOG: fakeLog, RH_FAKE_UNREAL_CRASH_ONCE: crashMarker, RH_RUN_STATS_FILE: path.join(path.dirname(fakeLog), "run-stats.json"), RH_CHECK_CACHE_FILE: path.join(path.dirname(fakeLog), "model-checks.json") }
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
    assert.deepEqual(launches.map(item => item.phase), ["Fabric", "Fabric", "Shadow", "Shadow"],
      "Shadow inherits a camera, so it runs one model per launch; Fabric twice is the crash and its resume");
    assert.deepEqual(launches.slice(2).map(item => item.taskIds), [[model.name], [second.name]],
      "each Shadow launch carries exactly one model, in job order");
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
    env: { ...process.env, RH_LOCAL_RENDERS_PORT: String(port), RH_UNREAL_EDITOR: process.execPath, RH_UNREAL_PROJECT: path.join(root, "test", "fake-unreal.cjs"), RH_FAKE_UNREAL_LOG: fakeLog, RH_FAKE_UNREAL_STALL: "9000", RH_RUN_STATS_FILE: path.join(path.dirname(fakeLog), "run-stats.json"), RH_CHECK_CACHE_FILE: path.join(path.dirname(fakeLog), "model-checks.json") }
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
  const start = env => {
    const inherited = { ...process.env, RH_LOCAL_RENDERS_PORT: String(port) };
    delete inherited.RH_ALLOWED_ORIGINS;
    return spawn(process.execPath, [path.join(root, "server.cjs")], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...inherited, ...env } });
  };
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
    for (const path of ["/api/renders", "/api/renders/stop", "/api/renders/delete", "/api/jobs", "/api/postprocess", "/api/sheet/refresh", "/api/materials/refresh", "/api/models/inspect", "/api/local/open"]) {
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
  // Settled by a render: an OBJ at the measured factor came out 22 pixels wide, and at a
  // hundred times that it filled the frame. Unreal's OBJ importer reads no unit header and
  // treats the numbers as centimetres; its FBX importer normalises the model itself.
  assert.equal(unrealScaleFor(sofa, "obj"), 0.1);
  assert.equal(unrealScaleFor(sectional, "fbx"), 1);
  assert.equal(unrealScaleFor({ scale: 2.54 }, "fbx"), 2.54, "what the farm sends for an inch export");
  assert.equal(unrealScaleFor({ scale: 0.0254 }, "obj"), 2.54, "an inch OBJ lands on the same number by conversion");
  assert.equal(unrealScaleFor({ scale: 0 }, "obj"), null);

  const sofaFindings = checkModel({ name: "BELLA_TWO_SEAT_SOFA", group: "sofas", format: "obj" }, sofa);
  assert.equal(find(sofaFindings, "scale").level, "ok");
  assert.match(find(sofaFindings, "scale").detail, /offsetUniformScale 0\.1/);
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

  // Some FBX exports keep the whole source mesh name in every Material ID. Assignment
  // already groups these by their final token, so the checker must not call the same
  // renderable parts missing and extra at the same time.
  const prefixed = checkModel({ name: "X_L_SECTIONAL", group: "sectionals", format: "fbx" }, {
    ...sectional,
    materialIds: [
      "belgian_track_arm_two_seat_left_arm_sofa_luxe_8_10094415_uph",
      "belgian_track_arm_two_seat_left_arm_sofa_luxe_8_10094415_stitches",
      "belgian_track_arm_two_seat_left_arm_sofa_luxe_8_10094415_feet"
    ]
  });
  assert.equal(summarise(prefixed).errors, 0, "long exporter names still expose UPH, Stitches and Feet");
  assert.equal(find(prefixed, "missing-parts"), undefined);
  assert.equal(find(prefixed, "extra-parts"), undefined);
  assert.match(find(prefixed, "parts").detail, /uph, stitches, feet/);
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
  assert.deepEqual(task.layers.map(layer => layer.name), ["Fabric"], "only what was asked for");
  assert.deepEqual(task.layers[0].SubLevels, ["Sofa_Indoor_Background", "Sofa_Indoor_KeyLight"]);
  // The scene carries a Shadow sublevel with its post-process volume, so the pass is available
  // and lands in the sofa's own levels rather than a sectional's.
  const withShadow = buildJob({ ...input, layers: ["Fabric", "Shadow"] }, sofa, rig, "D:\out").tasks[0];
  assert.deepEqual(withShadow.layers.map(layer => layer.name), ["Fabric", "Shadow"]);
  assert.deepEqual(withShadow.layers[1].SubLevels, ["Sofa_Indoor_Shadow", "Sofa_Indoor_KeyLight"]);
  assert.deepEqual(withShadow.layers[1].postProcesses, ["PostProcess_shadow"]);

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

  // An angle a sofa is never shot from is refused rather than silently dropped into a job.
  assert.throws(() => buildJob({ ...input, cameras: ["FH"] }, sofa, rig, "D:\out"), /F, P, TQ, TQB/);
  // And a sectional keeps its own shape.
  const sectionalTask = buildJob({ ...baseInput, side: "R", importYaw: -90 }, model, rig, "D:\out").tasks[0];
  assert.deepEqual(sectionalTask.layers[0].SubLevels, ["Sectional_Indoor_Background", "Sectional_Indoor_KeyLight"]);
  assert.ok(sectionalTask.sequence.cameras.every(camera => camera.Actor.Rotation.Roll === -90), "an FBX still carries its correction");
});

test("the frame a render starts from can be set from the page and lands in the job", () => {
  const base = { ...baseInput, cameras: ["F"], layers: ["Fabric", "Shadow"], renderProfile: "high" };
  const frameOf = (task, layer) => task.sequence.cameras[0].LayerResolutions.find(item => item.Name === layer);

  // Nothing asked for: the profile decides, as before.
  const plain = frameOf(buildJob(base, model, rig, "D:\out").tasks[0], "Fabric");
  assert.deepEqual(plain.Resolution, { X: 5000, Y: 5000 });
  assert.deepEqual(plain.SensorSize, { X: 36, Y: 36 });

  // A bigger sensor is a lens change, and both layers can be set independently.
  const asked = buildJob({ ...base, resolutions: {
    Fabric: { Resolution: { X: 4000, Y: 4000 }, SensorSize: { X: 60, Y: 60 } },
    Shadow: { Resolution: { X: 12000, Y: 4000 }, SensorSize: { X: 180, Y: 60 } }
  } }, model, rig, "D:\out").tasks[0];
  assert.deepEqual(frameOf(asked, "Fabric").Resolution, { X: 4000, Y: 4000 });
  assert.deepEqual(frameOf(asked, "Fabric").SensorSize, { X: 60, Y: 60 });
  assert.deepEqual(frameOf(asked, "Shadow").Resolution, { X: 12000, Y: 4000 });
  assert.deepEqual(frameOf(asked, "Shadow").SensorSize, { X: 180, Y: 60 });

  // A half-filled or nonsense field must not turn a frame into NaN or zero.
  const partial = withResolutionOverrides(RESOLUTION_PROFILES.high, {
    Fabric: { Resolution: { X: 4000 }, SensorSize: { Y: "" } },
    Shadow: { Resolution: { X: -1, Y: 0 }, SensorSize: { X: "wide" } }
  });
  assert.deepEqual(partial.Fabric.Resolution, { X: 4000, Y: 5000 }, "the missing half keeps the profile");
  assert.deepEqual(partial.Fabric.SensorSize, { X: 36, Y: 36 });
  assert.deepEqual(partial.Shadow.Resolution, { X: 15000, Y: 5000 }, "a negative or zero frame is refused");
  assert.deepEqual(partial.Shadow.SensorSize, { X: 108, Y: 36 });
  // Pixels are whole numbers; a sensor is not.
  assert.equal(withResolutionOverrides(RESOLUTION_PROFILES.low, { Fabric: { Resolution: { Y: 640.7 } } }).Fabric.Resolution.Y, 641);
  assert.equal(withResolutionOverrides(RESOLUTION_PROFILES.low, { Fabric: { SensorSize: { Y: 15.408 } } }).Fabric.SensorSize.Y, 15.408);
  assert.deepEqual(withResolutionOverrides(RESOLUTION_PROFILES.low, null), RESOLUTION_PROFILES.low);
});

test("the Unreal material list holds materials from RH folders and nothing else", () => {
  const source = fs.readFileSync(path.join(root, "server.cjs"), "utf8");
  // Only folders named RH are walked, wherever they sit: the fabrics are under Content/RH
  // while the legs and plastics are under Content/3D_Source/Materials/RH.
  assert.match(source, /entry\.name\.toUpperCase\(\) === "RH"/);
  assert.match(source, /rhFolders\(path\.join\(projectRoot, folder\)\)/);
  assert.match(source, /isMaterialAsset\(full\)/);

  // Class names are matched whole, so MaterialFunction is not a Material.
  assert.match(source, /\\x00\$\{className\}\\x00/);
  // A master material references its textures, so Texture2D must not exclude it.
  assert.doesNotMatch(source, /NOT_A_MATERIAL = \[[^\]]*Texture2D/);
  assert.match(source, /NOT_A_MATERIAL = \["StaticMesh"/);
  assert.match(source, /MATERIAL_CLASSES = \["MaterialInstanceConstant", "Material"\]/);
});

test("the drop target reacts to the attribute the script actually sets", () => {
  const styles = fs.readFileSync(path.join(root, "app.css"), "utf8");
  const client = fs.readFileSync(path.join(root, "app.js"), "utf8");
  // The script marks the target with data-dragging, and the rule looked for a class nothing
  // ever set — so the overlay was styled, positioned, and never once seen.
  assert.match(client, /dropTarget\.dataset\.dragging = "true"/);
  assert.match(styles, /\.model-drop-target\[data-dragging\] \.model-drop-overlay\{opacity:1/);
  assert.doesNotMatch(styles, /\.model-drop-target\.dragover/, "the class it used to look for");
  assert.match(styles, /\.model-drop-target\[data-dragging\]>input\{box-shadow:var\(--sel-gleam\)\}/);
});

test("every product, side, camera, layer, profile and crop combination builds a coherent job", () => {
  const MODELS = {
    sectionals: { name: "X_L_SECTIONAL", path: "D:\\m\\sectionals\\x.fbx", group: "sectionals", offsetUniformScale: 1, materialIds: ["UPH", "Stitches", "Feet"] },
    sofas: { name: "BELLA_SOFA", path: "D:\\m\\sofas\\b.obj", group: "sofas", offsetUniformScale: 0.1, materialIds: ["UPH", "Feet"] }
  };
  const MATERIALS = {
    sectionals: [{ meshes: ["UPH", "Stitches"], material: "FAB" }, { meshes: ["Feet"], material: "WOOD" }],
    sofas: [{ meshes: ["UPH"], material: "FAB" }, { meshes: ["Feet"], material: "WOOD" }]
  };
  const YAW = {
    sectionals: { R: { F: 0, FH: 0, TQ: -36 }, L: { F: 0, FH: 0, TQ: 36 }, U: { F: 0, FH: 0, TQ: 36 } },
    sofas: { R: { F: 0, P: 90, TQ: 30, TQB: 150 } }
  };
  const subsets = list => list.reduce((acc, item) => acc.concat(acc.map(set => [...set, item])), [[]]).filter(set => set.length);
  const problems = [];
  let built = 0;

  for (const type of ["sectionals", "sofas"]) {
    const descriptor = PRODUCT_TYPES[type];
    for (const side of type === "sectionals" ? ["R", "L", "U"] : ["R"]) {
      for (const cameras of subsets(descriptor.cameras)) for (const layers of subsets(["Fabric", "Shadow"])) {
        for (const profile of ["low", "high"]) for (const crop of ["full", "optimized"]) {
          const input = { productType: type, side, cameras, layers, renderProfile: profile, cropMode: crop,
            dimensions: { width: 300, depth: 120, height: 85 }, importYaw: 0, materials: MATERIALS[type], modelFingerprint: "fp" };
          const task = buildJob(input, MODELS[type], rig, "D:\\out").tasks[0];
          built++;
          const scene = descriptor.scene(side), prefix = sublevelPrefix(scene);
          const note = message => problems.push(`${type}/${side} ${cameras}/${layers} ${profile}/${crop}: ${message}`);

          for (const layer of task.layers) {
            const expected = layer.name === "Fabric" ? [`${prefix}_Background`, `${prefix}_KeyLight`] : [`${prefix}_Shadow`, `${prefix}_KeyLight`];
            if (layer.SubLevels.join() !== expected.join()) note(`${layer.name} sublevels ${layer.SubLevels}`);
          }
          for (const camera of task.sequence.cameras) {
            if (camera.Actor.Rotation.Yaw !== YAW[type][side][camera.name]) note(`${camera.name} yaw ${camera.Actor.Rotation.Yaw}`);
            if (camera.Actor.Rotation.Roll !== descriptor.actorRoll) note(`${camera.name} roll ${camera.Actor.Rotation.Roll}`);
            if (camera.sequenceName !== `${scene}_${camera.name}`) note(`${camera.name} sequence ${camera.sequenceName}`);
            if (!camera.lights?.length) note(`${camera.name} has no lights`);
            for (const light of camera.lights) if (!light.LevelName.startsWith(`${prefix}_`)) note(`${camera.name} light ${light.name} in ${light.LevelName}`);
            if ((camera.SceneActors || []).map(a => a.name).join() !== descriptor.sceneActors().map(a => a.name).join()) note(`${camera.name} scene actors`);
            for (const frame of camera.LayerResolutions) {
              const pixels = frame.Resolution.X / frame.Resolution.Y, sensor = frame.SensorSize.X / frame.SensorSize.Y;
              if (Math.abs(pixels - sensor) > 0.001) note(`${camera.name}/${frame.Name} aspect ${pixels.toFixed(3)} vs ${sensor.toFixed(3)}`);
            }
          }

          const plan = buildRenderPlan({ jobId: "j", tasks: [task], _rhLocal: { outputFolder: "D:\\out\\" } });
          const names = plan.map(phase => phase.name);
          if ((crop === "optimized") !== names.some(name => name.startsWith("Crop calibration"))) note(`phases ${names}`);
          const fabricAt = names.indexOf("Fabric"), shadowAt = names.indexOf("Shadow");
          if (fabricAt >= 0 && shadowAt >= 0 && fabricAt > shadowAt) note(`Shadow before Fabric: ${names}`);
          for (const phase of plan) for (const phaseTask of phase.job.tasks) for (const layer of phaseTask.layers) {
            if (!layer.SubLevels.every(level => level.startsWith(`${prefix}_`))) note(`${phase.name}/${layer.name} in ${layer.SubLevels}`);
          }
        }
      }
    }
  }
  assert.equal(built, 432, "the matrix size is part of what is being asserted");
  assert.deepEqual(problems.slice(0, 5), [], `${problems.length} incoherent jobs`);
});

test("a Fabric-only optimized job measures its crop in its own scene", () => {
  // The crop is measured from both layers even when one was asked for, so the Shadow probe of
  // a Fabric-only job has no layer to copy its scene from. It used to fall back to a
  // sectional's, measuring a sofa under the wrong lights and applying that to every render.
  const sofa = { name: "BELLA_SOFA", path: "D:\\m\\sofas\\b.obj", group: "sofas", offsetUniformScale: 0.1, materialIds: ["UPH", "Feet"] };
  const task = buildJob({ productType: "sofas", cameras: ["F"], layers: ["Fabric"], cropMode: "optimized", modelFingerprint: "fp",
    dimensions: { width: 277, depth: 106, height: 85 },
    materials: [{ meshes: ["UPH"], material: "FAB" }, { meshes: ["Feet"], material: "WOOD" }] }, sofa, rig, "D:\\out").tasks[0];
  const plan = buildRenderPlan({ jobId: "j", tasks: [task], _rhLocal: { outputFolder: "D:\\out\\" } });
  const shadowProbe = plan.find(phase => phase.name === "Crop calibration · Shadow");
  assert.ok(shadowProbe, "a Fabric-only job still probes the shadow");
  assert.deepEqual(shadowProbe.job.tasks[0].layers[0].SubLevels, ["Sofa_Indoor_Shadow", "Sofa_Indoor_KeyLight"]);
  assert.ok(plan.every(phase => phase.job.tasks.every(item => item.layers.every(layer =>
    layer.SubLevels.every(level => level.startsWith("Sofa_Indoor_"))))), "no phase strays into another product's scene");
});

test("a crop keeps a frame's proportions, whatever they were, and stays within reach", () => {
  // A base whose pixels and sensor disagree is a lens mistake the crop must not silently
  // change: it scales both by the same effective ratio and leaves the skew as found.
  const skewed = withResolutionOverrides(RESOLUTION_PROFILES.high, { Fabric: { Resolution: { X: 5000, Y: 2000 }, SensorSize: { X: 36, Y: 36 } } });
  assert.deepEqual(skewed.Fabric.Resolution, { X: 5000, Y: 2000 });
  assert.deepEqual(skewed.Fabric.SensorSize, { X: 36, Y: 36 }, "a skewed base is passed through, not corrected");

  const outcomes = [1, 0.5, 0.42, 0.2, 0.05, 3].map(cropRatio => {
    const frame = applyCropProfileToCamera({ LayerResolutions: [JSON.parse(JSON.stringify(skewed.Fabric))] }, { cropRatio }).LayerResolutions[0];
    return { cropRatio, height: frame.Resolution.Y, sensorY: frame.SensorSize.Y };
  });
  for (const item of outcomes) {
    assert.equal(item.sensorY, Number((36 * (item.height / 2000)).toFixed(6)), `ratio ${item.cropRatio}: sensor follows pixels`);
    assert.ok(Number.isInteger(item.height) && item.height > 0, `ratio ${item.cropRatio} height ${item.height}`);
    assert.ok(item.height <= 2000, `ratio ${item.cropRatio} cannot grow the frame`);
  }
  // Out-of-range ratios are clamped rather than trusted: 3 cannot enlarge, 0.05 cannot vanish.
  assert.equal(outcomes.find(item => item.cropRatio === 3).height, 2000);
  assert.equal(outcomes.find(item => item.cropRatio === 0.05).height, outcomes.find(item => item.cropRatio === 0.2).height);
});

test("crossing the product types is refused where it matters and honest where it is not", () => {
  const sofa = { name: "BELLA_SOFA", path: "D:\\m\\sofas\\b.obj", group: "sofas", offsetUniformScale: 0.1, materialIds: ["UPH", "Feet"] };
  const sectional = { name: "X_L_SECTIONAL", path: "D:\\m\\sectionals\\x.fbx", group: "sectionals", offsetUniformScale: 1, materialIds: ["UPH", "Stitches", "Feet"] };
  const base = { dimensions: { width: 300, depth: 120, height: 85 }, layers: ["Fabric"], renderProfile: "low", cropMode: "full" };
  const mats = [{ meshes: ["UPH"], material: "FAB" }, { meshes: ["Feet"], material: "WOOD" }];

  // A camera the type is never shot from is refused outright.
  assert.throws(() => buildJob({ ...base, productType: "sofas", cameras: ["FH"], materials: mats }, sofa, rig, "D:\\out"), /F, P, TQ, TQB/);
  assert.throws(() => buildJob({ ...base, productType: "sectionals", side: "R", cameras: ["TQB"], materials: mats }, sectional, rig, "D:\\out"), /F, FH, TQ/);

  // The type drives the job, so a crossed model builds — with the chosen type's scene and the
  // model's own scale. Preflight is what stops it, by comparing the two.
  const crossed = buildJob({ ...base, productType: "sectionals", side: "R", cameras: ["F"], materials: mats }, sofa, rig, "D:\\out").tasks[0];
  assert.deepEqual(crossed.layers[0].SubLevels, ["Sectional_Indoor_Background", "Sectional_Indoor_KeyLight"]);
  assert.equal(crossed.sequence.cameras[0].Actor.Rotation.Roll, -90, "the type decides the axis correction");
  assert.equal(crossed.model.offsetUniformScale, 0.1, "the model keeps the scale it was measured at");
});

test("no closed popover is left standing in the layout", () => {
  // Twice now a popover has swallowed clicks meant for what was behind it. The UA hides
  // a closed one with [popover]:not(:popover-open){display:none}, and any author-level
  // display at all beats that -- so a dismissed panel stayed laid out at opacity 0, an
  // invisible fixed box of cursor:pointer rows over the controls beneath it. Measured on
  // the real page before the fix: 423x321, sixteen children, pointer cursor.
  const styles = fs.readFileSync(path.join(root, "app.css"), "utf8");
  const rule = selector => {
    const at = styles.indexOf(`\n${selector}{`);
    return at < 0 ? null : styles.slice(at + selector.length + 2, styles.indexOf("}", at));
  };
  // Every popover on the page announces itself by having a :popover-open rule.
  const popovers = [...new Set([...styles.matchAll(/(^|[\s,])(\.[a-z0-9-]+|#[A-Za-z0-9_-]+):popover-open/gm)]
    .map(match => match[2]))];
  assert.ok(popovers.length >= 4, `expected the page's popovers, found ${popovers.join(", ")}`);

  for (const selector of popovers) {
    const base = rule(selector);
    assert.ok(base, `${selector} has a :popover-open rule but no base rule`);
    const display = /(?:^|;)display:([^;]+)/.exec(base);
    assert.ok(display, `${selector} sets no display, so the UA's display:none stands -- fine, but say so here`);
    assert.equal(display[1].trim(), "none",
      `${selector} declares display:${display[1].trim()} in its base rule, which overrides the UA rule that hides a closed popover`);
    assert.match(rule(`${selector}:popover-open`) || "", /display:/,
      `${selector} is hidden when closed but never turned back on when open`);
  }

  // And while one fades out its display is still the open value, by design, so the fade
  // must not be clickable either.
  assert.match(styles, /\[popover\]:not\(:popover-open\)\{pointer-events:none\}/);
});

test("run timing is kept per phase, and prices a job that has never run", () => {
  const stats = require("../lib/run-stats.cjs");
  const job = { tasks: [
    { sequence: { cameras: [{ name: "F" }, { name: "TQ" }] }, layers: [{ name: "Fabric" }, { name: "Shadow" }] },
    { sequence: { cameras: [{ name: "F" }, { name: "TQ" }] }, layers: [{ name: "Fabric" }, { name: "Shadow" }, { name: "Fabric", _rhLocalPrefit: true }] }
  ] };
  assert.deepEqual(stats.frameCounts(job), { Fabric: 4, Shadow: 4 }, "a prefit layer hands a camera over, it does not render");

  // A Fabric frame and a Shadow frame are different work -- separate Unreal processes, one
  // with Substrate and one without -- so they are measured apart rather than averaged.
  const runs = [{
    jobId: "a", seconds: 600, frames: { Fabric: 4, Shadow: 4 },
    phases: [
      { name: "Crop calibration · Fabric", layer: "Fabric", calibration: true, frames: 4, seconds: 40 },
      { name: "Fabric", layer: "Fabric", calibration: false, frames: 4, seconds: 400 },
      { name: "Shadow", layer: "Shadow", calibration: false, frames: 4, seconds: 160 }
    ]
  }];
  const summary = stats.summarise(runs);
  assert.equal(summary.perFrame.Fabric.seconds, 100, "400s over four frames");
  assert.equal(summary.perFrame.Shadow.seconds, 40, "and the calibration probe is left out of both");

  // Pricing a job is then its own frame count against those rates.
  const estimate = stats.estimateFor(job, summary);
  assert.equal(estimate.seconds, 4 * 100 + 4 * 40);
  assert.deepEqual(estimate.frames, { Fabric: 4, Shadow: 4 });

  // A layer nobody has ever rendered is reported as unmeasured, not guessed at.
  const partial = stats.summarise([{ phases: [{ layer: "Fabric", calibration: false, frames: 2, seconds: 100 }] }]);
  assert.deepEqual(stats.estimateFor(job, partial).unmeasuredLayers, ["Shadow"]);
  assert.equal(stats.estimateFor(job, { perFrame: {} }), null, "with nothing measured there is no estimate to give");

  // The suite drives the real server against the real tree, and its stubbed renders finish
  // in milliseconds. Folded into the averages they priced an hours-long job at seconds, so
  // the file has to be redirectable and every spawn here has to redirect it.
  const previous = process.env.RH_RUN_STATS_FILE;
  try {
    process.env.RH_RUN_STATS_FILE = path.join(root, "test", "unused-run-stats.json");
    assert.equal(stats.statsFile(root), process.env.RH_RUN_STATS_FILE);
    delete process.env.RH_RUN_STATS_FILE;
    assert.equal(stats.statsFile(root), path.join(root, "local", "cache", "run-stats.json"));
  } finally {
    if (previous === undefined) delete process.env.RH_RUN_STATS_FILE; else process.env.RH_RUN_STATS_FILE = previous;
  }
  const suite = fs.readFileSync(__filename, "utf8");
  const spawns = "RH_FAKE_UNREAL" + "_LOG: fakeLog", guards = "RH_RUN_STATS" + "_FILE: path.join";
  assert.equal(suite.split(spawns).length, suite.split(guards).length,
               "every spawned service must point its run log somewhere disposable");
});

test("the page reads a job's own cameras, product type and check verdicts", () => {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const client = fs.readFileSync(path.join(root, "app.js"), "utf8");
  const styles = fs.readFileSync(path.join(root, "app.css"), "utf8");
  const historyLib = fs.readFileSync(path.join(root, "lib", "history.cjs"), "utf8");
  const jobs = fs.readFileSync(path.join(root, "lib", "jobs.cjs"), "utf8");

  // Selective render used to offer F, FH, TQ whatever the job was built for, and "Edit
  // selection" then restored those onto a sofa.
  assert.match(historyLib, /cameras: \[\.\.\.new Set\(\(job\.tasks \|\| \[\]\)/);
  assert.match(client, /batch\.cameras\?\.length \? batch\.cameras/);
  assert.match(client, /batch\.layers\?\.length \? batch\.layers/);

  // The model type is written into the job and put back when one is loaded for editing.
  assert.match(jobs, /productType: type\.key/);
  assert.match(client, /const productTypeOfJob =/);
  assert.match(client, /\$\("category"\)\.value = jobProductType; applyProductType\(\)/);

  // A model wears its verdict in the list, and the batch heading says how many want looking
  // at -- a problem below the fold has to announce itself.
  assert.match(html, /id="checkJump"/);
  assert.match(client, /const checkStateOf = name =>/);
  assert.match(styles, /\.batch-model\[data-check=error\]:before\{background:var\(--danger\)\}/);
  assert.match(client, /\$\("checkJump"\)\.addEventListener/);

  // The close control is not a delete. Wearing that class subscribed it to the page's
  // delete interception, which consumed the click before the button ever saw it.
  assert.match(html, /id="closeModelCheck" class="panel-close"/);
  assert.match(html, /id="closeModelCheck"[^>]*><svg /, "a drawn cross centres itself; the glyph did not");
  assert.doesNotMatch(styles, /\.quiet-button\{background:transparent/, "a button invisible until hovered cannot be found");
  assert.doesNotMatch(html, /card-delete/, "delete controls are generated where they have a target to name");
});

test("a checked model is not checked again until its file changes", () => {
  const cache = require("../lib/check-cache.cjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-check-"));
  const file = path.join(dir, "model.obj");
  fs.writeFileSync(file, ["g UPH", "v 0 0 0", ""].join(String.fromCharCode(10)), "utf8");

  const row = { name: "model", path: file, format: "obj", errors: 0, warnings: 1, findings: [{ level: "warning", label: "Orientation", detail: "x" }] };
  let entries = cache.remember({}, file, row, "2026-01-01T00:00:00.000Z");
  const hit = cache.lookup(entries, file);
  assert.equal(hit.warnings, 1);
  assert.equal(hit.fromCache, true, "the page is told the verdict came from store");
  assert.equal(hit.checkedAt, "2026-01-01T00:00:00.000Z");

  // Verdicts made by an older checker must not survive a semantic fix merely because
  // the FBX/OBJ itself stayed byte-for-byte identical.
  const currentFingerprint = cache.fingerprint(file);
  const legacyFingerprint = currentFingerprint.split(":").slice(1).join(":");
  const legacy = { [cache.keyFor(file)]: { fingerprint: legacyFingerprint, checkedAt: hit.checkedAt, row } };
  assert.equal(cache.lookup(legacy, file), null, "a cache entry without the checker version is stale");

  // Case and separators must not decide whether a verdict is found again.
  assert.ok(cache.lookup(entries, file.toUpperCase()) || cache.keyFor(file) === cache.keyFor(file.toUpperCase()));

  // A replaced file is a different file, whatever its name. Size alone would miss a
  // same-length re-export, so the mtime is part of the fingerprint.
  const before = cache.fingerprint(file);
  fs.writeFileSync(file, ["g UPH", "v 1 1 1", ""].join(String.fromCharCode(10)), "utf8");
  fs.utimesSync(file, new Date(), new Date(Date.now() + 4000));
  assert.notEqual(cache.fingerprint(file), before);
  assert.equal(cache.lookup(entries, file), null, "a changed file has no verdict until it is checked again");

  // A verdict for a file that has gone is dead weight.
  entries = cache.remember(entries, file, row);
  fs.rmSync(file);
  assert.equal(cache.prune(entries), 1);
  assert.deepEqual(entries, {});

  // The store is redirectable, so the suite cannot write into the one a person reads.
  const previous = process.env.RH_CHECK_CACHE_FILE;
  try {
    process.env.RH_CHECK_CACHE_FILE = path.join(dir, "checks.json");
    assert.equal(cache.cacheFile(root), process.env.RH_CHECK_CACHE_FILE);
    delete process.env.RH_CHECK_CACHE_FILE;
    assert.equal(cache.cacheFile(root), path.join(root, "local", "cache", "model-checks.json"));
  } finally {
    if (previous === undefined) delete process.env.RH_CHECK_CACHE_FILE; else process.env.RH_CHECK_CACHE_FILE = previous;
  }
  const suite = fs.readFileSync(__filename, "utf8");
  const spawns = "RH_FAKE_UNREAL" + "_LOG: fakeLog", guards = "RH_CHECK_CACHE" + "_FILE: path.join";
  assert.equal(suite.split(spawns).length, suite.split(guards).length,
               "every spawned service must point its check store somewhere disposable");

  // And the page shows what is already known without asking for work.
  const client = fs.readFileSync(path.join(root, "app.js"), "utf8");
  assert.match(client, /await api\("\/api\/models\/checks"\)/);
  const service = fs.readFileSync(path.join(root, "server.cjs"), "utf8");
  assert.match(service, /request\.method === "GET" && url\.pathname === "\/api\/models\/checks"/,
    "a keyless reader has to be able to see verdicts already earned");
  assert.match(client, /const loadCachedChecks = async/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a render is measured against the frame its job asked for, not the profile's", () => {
  const { history } = require("../lib/history.cjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-size-"));
  const jobs = path.join(dir, "local", "jobs", "generated");
  const out = path.join(dir, "local", "renders", "batch_1");
  const raw = path.join(out, "raw", "SOFA");
  fs.mkdirSync(jobs, { recursive: true });
  fs.mkdirSync(raw, { recursive: true });

  // Enough of a PNG for the header reader: signature, then IHDR with width, height and a
  // colour type that carries alpha. Padded past the "suspiciously small" floor.
  const png = (width, height) => {
    const buffer = Buffer.alloc(2048);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
    buffer.writeUInt32BE(width, 16);
    buffer.writeUInt32BE(height, 20);
    buffer[25] = 6;                       // truecolour with alpha
    return buffer;
  };
  // A job given a frame of its own, then cropped: 3600 wide, trimmed to 1528 tall.
  const asked = { Fabric: { X: 3600, Y: 1528 }, Shadow: { X: 10800, Y: 1528 } };
  fs.writeFileSync(path.join(raw, "00000000_F_Fabric.png"), png(asked.Fabric.X, asked.Fabric.Y));
  fs.writeFileSync(path.join(raw, "00000000_F_Shadow.png"), png(asked.Shadow.X, asked.Shadow.Y));

  const job = {
    jobId: "batch_1",
    _rhLocal: { outputFolder: out + path.sep, models: [{ name: "SOFA", outputFolder: raw }] },
    tasks: [{
      taskId: "SOFA",
      sequence: { cameras: [{ name: "F", LayerResolutions: [
        { Name: "Fabric", Resolution: asked.Fabric, SensorSize: { X: 36, Y: 15.28 } },
        { Name: "Shadow", Resolution: asked.Shadow, SensorSize: { X: 108, Y: 15.28 } }
      ] }] },
      layers: [{ name: "Fabric", output: { folder: raw } }, { name: "Shadow", output: { folder: raw } }]
    }]
  };
  fs.writeFileSync(path.join(jobs, "batch_1.job.json"), JSON.stringify(job, null, 2));

  const renders = history(dir)[0].models[0].renders;
  assert.equal(renders.length, 2);
  for (const render of renders) {
    assert.deepEqual(render.issues, [],
      `${render.layer} at ${render.width}x${render.height} is exactly what the job asked for`);
  }

  // And a frame that genuinely is not what was asked for is still caught.
  fs.writeFileSync(path.join(raw, "00000000_F_Fabric.png"), png(2000, 1528));
  const wrong = history(dir)[0].models[0].renders.find(render => render.layer === "Fabric");
  assert.deepEqual(wrong.issues, ["Unexpected size"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a job carries the frame it was given, and reopens with it", () => {
  const { buildJob } = require("../lib/jobs.cjs");
  const model = { name: "SOFA", path: "D:\m\sofas\s.obj", group: "sofas", offsetUniformScale: 0.1, materialIds: ["UPH", "Feet"] };
  const asked = {
    Fabric: { Resolution: { X: 3600, Y: 3600 }, SensorSize: { X: 36, Y: 36 } },
    Shadow: { Resolution: { X: 10800, Y: 3600 }, SensorSize: { X: 108, Y: 36 } }
  };
  const job = buildJob({ productType: "sofas", cameras: ["F"], layers: ["Fabric", "Shadow"], renderProfile: "high",
    cropMode: "optimized", dimensions: { width: 277, depth: 106, height: 85 }, resolutions: asked,
    materials: [{ meshes: ["UPH"], material: "FAB" }, { meshes: ["Feet"], material: "WOOD" }] }, model, rig, "D:\out");

  // The crop rewrites LayerResolutions in place, so the frame a person typed has to be kept
  // apart from them or reopening the job would offer the cropped numbers as the base.
  assert.deepEqual(job._rhLocal.baseFrame.Fabric.Resolution, { X: 3600, Y: 3600 });
  assert.deepEqual(job._rhLocal.baseFrame.Shadow.Resolution, { X: 10800, Y: 3600 });

  const client = fs.readFileSync(path.join(root, "app.js"), "utf8");
  assert.match(client, /const applyFrameSize = frame =>/);
  assert.match(client, /applyFrameSize\(job\._rhLocal\?\.baseFrame \|\| metadataRows\[0\]\?\.baseFrame\)/);
  // It has to land after the profile switch, which fills the fields from the profile.
  const styles = fs.readFileSync(path.join(root, "app.css"), "utf8");
  assert.ok(client.indexOf("applyFrameSize(job._rhLocal") > client.indexOf('input[name="renderProfile"]:checked'),
            "the profile fills the fields, so a recorded frame goes in after it");
  // A flagged render was the one preview that got its lift back, because that rule outweighed
  // the one taking the shadow off every preview.
  assert.doesNotMatch(styles, /render-preview-card\.render-warning\{box-shadow:var\(--bevel\),var\(--lift-sm\)/);
  assert.match(styles, /\.render-preview-card\.render-warning>small\{color:var\(--danger\)/);
});

test("the crop probe measures in the shape of the frame it will be applied to", () => {
  const sofa = { name: "SOFA", path: "D:\m\sofas\s.obj", group: "sofas", offsetUniformScale: 0.1, materialIds: ["UPH", "Feet"] };
  const mats = [{ meshes: ["UPH"], material: "FAB" }, { meshes: ["Feet"], material: "WOOD" }];
  const probesFor = resolutions => {
    const job = buildJob({ productType: "sofas", cameras: ["F"], layers: ["Fabric", "Shadow"], renderProfile: "high",
      cropMode: "optimized", dimensions: { width: 277, depth: 106, height: 85 }, resolutions, materials: mats },
      sofa, rig, "D:\out");
    const plan = buildRenderPlan({ ...job, _rhLocal: { ...job._rhLocal, outputFolder: "D:\out\\" } });
    return Object.fromEntries(plan.filter(phase => phase.name.startsWith("Crop calibration"))
      .map(phase => [phase.layerName || phase.name, phase.job.tasks[0].sequence.cameras[0].LayerResolutions[0]]));
  };

  // A square base is what the stock profile already was, so nothing moves.
  const square = probesFor({ Fabric: { Resolution: { X: 3600, Y: 3600 }, SensorSize: { X: 36, Y: 36 } },
                             Shadow: { Resolution: { X: 10800, Y: 3600 }, SensorSize: { X: 108, Y: 36 } } });
  assert.deepEqual(square.Fabric.Resolution, { X: 500, Y: 500 });
  assert.deepEqual(square.Fabric.SensorSize, { X: 36, Y: 36 });
  assert.deepEqual(square.Shadow.Resolution, { X: 1500, Y: 500 });

  // A frame that is not square used to be probed against a square field, so the ratio it
  // derived belonged to no frame anyone asked for. The sensor is the field of view and
  // carries over untouched; only the pixel count comes down to probe size.
  const wide = probesFor({ Fabric: { Resolution: { X: 5000, Y: 2000 }, SensorSize: { X: 36, Y: 14.4 } },
                           Shadow: { Resolution: { X: 15000, Y: 2000 }, SensorSize: { X: 108, Y: 14.4 } } });
  assert.deepEqual(wide.Fabric.Resolution, { X: 500, Y: 200 }, "the probe keeps the frame's shape");
  assert.deepEqual(wide.Fabric.SensorSize, { X: 36, Y: 14.4 }, "and its field of view");
  assert.deepEqual(wide.Shadow.Resolution, { X: 1500, Y: 200 });
  for (const frame of Object.values(wide)) {
    assert.equal(frame.Resolution.Y % 2, 0, "an odd probe height would not halve cleanly");
    assert.ok(Math.abs((frame.Resolution.X / frame.Resolution.Y) - (frame.SensorSize.X / frame.SensorSize.Y)) < 0.001,
              "pixels and sensor stay in step, or the probe image stretches");
  }
});

test("Launch render launches what is on screen, and only a resume says it is one", () => {
  const client = fs.readFileSync(path.join(root, "app.js"), "utf8");

  // Loading a saved job for editing clears the generated path, so gating Launch on that path
  // alone left the button dead until Generate was pressed -- while Run again would launch the
  // file on disk and ignore the edits just made.
  assert.match(client, /\$\("launchRender"\)\.disabled = !state\.jobPath && !ready;/);
  assert.match(client, /if \(!state\.jobPath && !resuming\) \{/,
    "with nothing generated, Launch generates on the way");

  // The click listener used to hand launch() the event, which is truthy, so every manual
  // launch told the server it was resuming -- and on a resume the server skips the
  // before-snapshot and counts files already on disk as freshly produced.
  assert.match(client, /addEventListener\("click", \(\) => launch\(\)\)/);
  assert.doesNotMatch(client, /addEventListener\("click", launch\)/);
  assert.match(client, /const resuming = resume === true;/, "a flag is read as a flag");
  assert.match(client, /jobPath: state\.jobPath, resume: resuming/);
  assert.doesNotMatch(client, /jobPath: state\.jobPath, resume \}/);

  // And a job that has never run should not offer to run it "again".
  assert.match(client, /batch\.renderCount \? "Run again" : "Run this job"/);
});

test("a saved crop can be dropped, and preflight counts every camera the type has", () => {
  const crop = require("../lib/crop.cjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-crops-"));
  const store = path.join(dir, "crop-profiles.json");
  const previous = process.env.RH_CROP_CACHE_FILE;
  try {
    const frame = {
      Fabric: { Resolution: { X: 5000, Y: 5000 }, SensorSize: { X: 36, Y: 36 } },
      Shadow: { Resolution: { X: 15000, Y: 5000 }, SensorSize: { X: 108, Y: 36 } }
    };
    assert.deepEqual(crop.cropContextResolutions({
      Shadow: { Name: "Shadow", SensorSize: { Y: "36", X: "108" }, Resolution: { Y: "5000", X: "15000" } },
      Fabric: { Name: "Fabric", SensorSize: { Y: "36", X: "36" }, Resolution: { Y: "5000", X: "5000" } }
    }), frame, "display fields, key order and numeric strings do not invalidate the same frame");
    process.env.RH_CROP_CACHE_FILE = store;
    crop.writeCropProfiles(dir, [
      { fingerprint: "aaa", camera: "F",   contextToken: "frame-a", cropRatio: 0.4, modelName: "SOFA_A", analyzedAt: "2026-01-01T00:00:00.000Z" },
      { fingerprint: "aaa", camera: "TQB", cropRatio: 0.5, modelName: "SOFA_A", analyzedAt: "2026-01-02T00:00:00.000Z" },
      { fingerprint: "bbb", camera: "F",   cropRatio: 0.6, modelName: "SOFA_B", analyzedAt: "2026-01-03T00:00:00.000Z" }
    ]);
    assert.equal(Object.keys(crop.readCropProfiles(dir).profiles).length, 3);
    assert.equal(crop.cropProfileFor(crop.readCropProfiles(dir), "aaa", "F", "frame-a").cropRatio, 0.4);
    assert.equal(crop.cropProfileFor(crop.readCropProfiles(dir), "aaa", "F", "another-frame"), null, "a crop measured for another frame is never reused");

    // One camera of one model, named.
    const one = crop.forgetCropProfiles(dir, { fingerprints: ["aaa"], cameras: ["f"] });
    assert.deepEqual(one.map(entry => [entry.modelName, entry.camera]), [["SOFA_A", "F"]], "case in a camera name is not identity");
    assert.equal(crop.readCropProfiles(dir).profiles["aaa:F"], undefined);
    assert.ok(crop.readCropProfiles(dir).profiles["aaa:TQB"], "its other cameras are left alone");

    // Every camera of a model, when no camera is named.
    assert.equal(crop.forgetCropProfiles(dir, { fingerprints: ["aaa"] }).length, 1);
    assert.ok(crop.readCropProfiles(dir).profiles["bbb:F"], "another model is left alone");

    // Asking for a model with nothing saved drops nothing rather than everything.
    assert.deepEqual(crop.forgetCropProfiles(dir, { fingerprints: ["ccc"] }), []);
    assert.equal(Object.keys(crop.readCropProfiles(dir).profiles).length, 1);
    assert.equal(crop.forgetCropProfiles(dir, { all: true }).length, 1);
    assert.deepEqual(crop.readCropProfiles(dir).profiles, {});
  } finally {
    if (previous === undefined) delete process.env.RH_CROP_CACHE_FILE; else process.env.RH_CROP_CACHE_FILE = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const service = fs.readFileSync(path.join(root, "server.cjs"), "utf8");
  const client = fs.readFileSync(path.join(root, "app.js"), "utf8");
  // Preflight filtered the chosen cameras against a sectional's list, hardcoded, so a sofa job
  // silently lost P and TQB: the Cameras check read "F - TQ" with four chosen and the expected
  // render count came out at half.
  assert.match(service, /previewType\.cameras\.includes\(value\)/);
  assert.doesNotMatch(service, /input\.cameras\.filter\(value => \["F", "FH", "TQ"\]/);
  // A reused crop renders no probe, so preflight has to say so or the missing probe file looks
  // like a fault.
  assert.match(service, /reuse a crop saved earlier/);
  assert.match(service, /url\.pathname === "\/api\/crops\/forget"/);
  assert.match(service, /A render is running; its crops are still being written/);
  assert.match(client, /const remeasureCrops = async/);
  // Every camera of the models in hand, never only the ticked ones: leaving one camera's crop
  // behind is a trap, since ticking that camera later would still measure from the old one.
  assert.match(client, /models: state\.batch\.map\(model => model\.path\) \}\) \}\);/);
  assert.doesNotMatch(client, /models: state\.batch\.map\(model => model\.path\), cameras:/);
  // And the waiting panel says what is outstanding rather than repeating "add models".
  assert.match(client, /const outstanding = \(\) =>/);
  assert.match(client, /Assign a material to \$\{blank\.join\(", "\)\}/);
});

test("a probe's camera never frames a final render", () => {
  // Every sofa in a batch shares one sequence name, and the plugin applies a camera override
  // per sequence rather than per task -- so one model's fitted focal length framed all of
  // them. Measured on seven sofas: task one carried 182.5mm, and each other sofa came out
  // showing own_focal / 182.5 of its width, 0.55 to 0.76, arms cut off. Sectionals hide the
  // same fault because every one of them fits to 160-164mm, so the swap changes nothing.
  const sofa = { name: "SOFA", path: "D:\m\sofas\s.obj", group: "sofas", offsetUniformScale: 0.1, materialIds: ["UPH", "Feet"] };
  const job = buildJob({ productType: "sofas", cameras: ["F"], layers: ["Fabric", "Shadow"], renderProfile: "high",
    cropMode: "optimized", dimensions: { width: 277, depth: 106, height: 85 }, modelFingerprint: "fp",
    materials: [{ meshes: ["UPH"], material: "FAB" }, { meshes: ["Feet"], material: "WOOD" }] }, sofa, rig, "D:\out");
  const phases = buildRenderPlan({ ...job, _rhLocal: { ...job._rhLocal, outputFolder: "D:\out\\" } });
  const byName = Object.fromEntries(phases.map(phase => [phase.name, phase]));

  assert.notEqual(byName.Fabric.useCameraHandoff, true, "the final Fabric fits the frame it will actually render");
  assert.equal(byName.Shadow.useCameraHandoff, true, "Shadow still inherits, or it will not line up with Fabric");
  assert.equal(byName["Crop calibration · Fabric"].useCameraHandoff, false, "the first probe has nothing to inherit");
  assert.equal(byName["Crop calibration · Shadow"].useCameraHandoff, true);

  // A fit is only valid for the frame it was measured on, so the frame is part of its identity:
  // a focal length taken from a 500px probe must never be handed to a 5000px frame.
  const { fitDescriptor } = require("../lib/camera-fit.cjs");
  const task = job.tasks[0], camera = task.sequence.cameras[0];
  const probe = JSON.parse(JSON.stringify(camera));
  probe.LayerResolutions = [{ Name: "Fabric", Resolution: { X: 500, Y: 500 }, SensorSize: { X: 36, Y: 36 } }];
  const options = { rendererToken: "token", projectPath: "D:\p\project.uproject" };
  const full = fitDescriptor({ ...task, model: { ...task.model, objPath: __filename } }, camera, options);
  const small = fitDescriptor({ ...task, model: { ...task.model, objPath: __filename } }, probe, options);
  assert.ok(full && small, "a descriptor needs a model file that exists");
  assert.notEqual(full.signature, small.signature, "two frames are two different fits");
  assert.deepEqual(small.inputs.frame, [{ name: "Fabric", resolution: { X: 500, Y: 500 }, sensor: { X: 36, Y: 36 } }]);

  // And only a probe may inherit a saved fit at all.
  const service = fs.readFileSync(path.join(root, "server.cjs"), "utf8");
  assert.doesNotMatch(service, /canApplyPersistentFits|cachedCameraStateKeys/, "a Fabric calibration probe must always fit its own frame");
  assert.match(service, /writeCameraFitState\(ROOT, bridge\.job/, "camera state is keyed by the phase that actually measured it");
});

test("a phase that inherits a camera renders one model at a time, whatever the product", () => {
  // The renderer applies a camera override per sequence, not per task, and every model of one
  // product shares a sequence name. So a phase that inherits a camera has to be given a single
  // model, or one model's framing frames them all. The rule is not product-specific: sectionals
  // hid it only because every one of them fits to between 160 and 164mm.
  const mats = [{ meshes: ["UPH"], material: "FAB" }, { meshes: ["Feet"], material: "WOOD" }];
  const planFor = (group, count, layers, cropMode) => {
    const entries = Array.from({ length: count }, (unused, index) => ({
      model: { name: `${group}_${index}`, path: `D:\m\${group}\${index}.obj`, group,
               offsetUniformScale: 1, materialIds: ["UPH", "Stitches", "Feet"] },
      input: { productType: group, side: "R", cameras: ["F"], layers, renderProfile: "high",
               cropMode, dimensions: { width: 300, depth: 120, height: 85 }, materials: mats,
               modelFingerprint: `fp${index}` }
    }));
    const job = buildBatchJob(entries, rig, "D:\out", "batch");
    job._rhLocal.outputFolder = "D:\out\\";
    return buildRenderPlan(job);
  };

  for (const group of ["sofas", "sectionals"]) {
    const plan = planFor(group, 3, ["Fabric", "Shadow"], "optimized");
    for (const phase of plan) {
      if (phase.useCameraHandoff) {
        assert.equal(phase.job.tasks.length, 1, `${group}: ${phase.name} inherits a camera, so it takes one model`);
      } else {
        assert.equal(phase.job.tasks.length, 3, `${group}: ${phase.name} fits its own frame, so all models ride together`);
      }
    }
    // Three models: one Fabric probe, three Shadow probes, one Fabric, three Shadow.
    assert.equal(plan.length, 8, `${group}: eight phases`);
    assert.deepEqual(plan.map(phase => phase.job._rhLocal.phaseIndex), [1, 2, 3, 4, 5, 6, 7, 8], "numbering follows the split");
    assert.ok(plan.every(phase => phase.job._rhLocal.phaseCount === 8));
    // Each model appears exactly once per layer, so the work does not grow, only the launches.
    for (const layer of ["Fabric", "Shadow"]) {
      const taskIds = plan.filter(phase => phase.name === layer).flatMap(phase => phase.job.tasks.map(task => task.taskId));
      assert.equal(new Set(taskIds).size, 3, `${group}: every model renders ${layer} once`);
      assert.equal(taskIds.length, 3);
    }
  }

  // Full frame has no probes, and only Shadow inherits.
  const full = planFor("sofas", 3, ["Fabric", "Shadow"], "full");
  assert.deepEqual(full.map(phase => phase.name), ["Fabric", "Shadow", "Shadow", "Shadow"]);
  // A single model needs no splitting at all.
  assert.equal(planFor("sofas", 1, ["Fabric", "Shadow"], "optimized").length, 4);
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
  assert.match(powerShellLauncher, /local\\server\.pid/);
  assert.match(powerShellLauncher, /belongsToThisService/);
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
  assert.ok(!shadow.args.some(argument => argument.startsWith("-ExecCmds=")));
  const diagnostic = buildUnrealLaunch("D:\\UE\\UnrealEditor.exe", "D:\\RH\\rh.uproject", apiUrl, { substrate: false, nativeShadowDiagnostics: true });
  assert.ok(diagnostic.args.includes("-ExecCmds=r.BatchRender.NativeShadowDiagnostics 1"));
});

test("the local BatchRender URL includes a query before the plugin appends Substrate", () => {
  const server = fs.readFileSync(path.join(root, "server.cjs"), "utf8");
  assert.match(server, /\/api\/unreal\?source=local/);
});

test("a camera prefit is counted from its isolated calibration branch", () => {
  const server = fs.readFileSync(path.join(root, "server.cjs"), "utf8");
  assert.match(server, /phaseUsesCalibrationBranch\(phase\)/);
  assert.match(server, /layer\._rhLocalPrefit/);
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

test("dense information blocks share one accessible focus view", () => {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const client = fs.readFileSync(path.join(root, "app.js"), "utf8");
  const styles = fs.readFileSync(path.join(root, "app.css"), "utf8");
  assert.match(html, /<dialog id="focusDialog"[^>]*aria-labelledby="focusDialogTitle"/);
  assert.match(html, /id="closeFocusDialog"[^>]*aria-label="Close focus view"/);
  for (const source of ["#modelBatch", "#modelCheck", "#materialsPanel", "#outputPanel", "#queuePanel", "#logPanel", "#historyWorkspace"]) {
    assert.ok(html.includes(`data-focus-source="${source}"`), `${source} has no focus-view trigger`);
  }
  assert.match(client, /showModal\(\)/);
  assert.match(client, /focusView\.source/);
  assert.match(client, /focusView\.trigger/);
  assert.match(styles, /\.focus-dialog\{[^}]*height:min\(92vh,980px\)/);
  assert.match(styles, /\.focus-dialog\[data-focus-kind=log\] #renderLog/);
  assert.match(styles, /\.focus-dialog\[data-focus-kind=history\] \.history-workspace/);
});

test("interface controls do not trigger accidental text selection", () => {
  const styles = fs.readFileSync(path.join(root, "app.css"), "utf8");
  assert.match(styles, /button,select,option,label,legend,[\s\S]*?-webkit-user-select:none;user-select:none/);
  assert.match(styles, /input:not\(\[type=checkbox\]\):not\(\[type=radio\]\):not\(\[type=range\]\),textarea,pre,code\{[\s\S]*?user-select:text/);
  assert.match(styles, /\.render-queue>span/);
  assert.match(styles, /\.render-preview-card/);
});

test("main page renders the workspace, previews and dropdowns", () => {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const client = fs.readFileSync(path.join(root, "app.js"), "utf8");
  const styles = fs.readFileSync(path.join(root, "app.css"), "utf8");
  assert.doesNotMatch(html, /<iframe/i);
  assert.match(client, /canReachLocalService/);
  assert.match(html, /id="modelDropTarget"/);
  assert.match(html, /id="refreshMaterials"[^>]*>Refresh materials<\/button>/);
  assert.match(client, /\/api\/materials\/refresh\?environment=/);
  assert.match(client, /data-material-multiply/);
  assert.match(styles, /\.material-multiply/);
  assert.match(html, /id="modelPath"[^>]*data-suggest-action="inspect-model"/);
  assert.match(client, /input\.dataset\.suggestAction === "inspect-model"\) inspect\(\)/);
  assert.match(html, /id="renderEnvironmentSwitcher"/);
  assert.match(html, /data-render-environment="ue56"/);
  assert.match(html, /data-render-environment="ue58"/);
  assert.match(client, /renderEnvironment: state\.renderEnvironment/);
  assert.match(client, /\/api\/materials\?environment=/);
  assert.match(client, /chooseRenderEnvironment\(batch\.renderEnvironment/);
  assert.match(styles, /\.render-environment-switcher/);
  assert.match(styles, /\.material-remove:before,\.material-remove:after\{[^}]*left:50%;top:50%/);
  assert.match(html, /id="modelFileInput" type="file" accept="\.fbx,\.obj" multiple/);
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
  assert.match(client, /data-material-carousel/);
  assert.match(client, /scrollGalleryMaterials/);
  assert.match(styles, /scroll-snap-type:x mandatory/);
  assert.match(styles, /\.render-material-carousel\{[^}]*gap:0[^}]*scrollbar-width:none/);
  assert.match(client, /data-gallery-material-select/);
  assert.match(client, /data-gallery-page/);
  assert.match(client, /data-gallery-scrubber/);
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
  assert.match(html, /<div class="runtime-workspace">[\s\S]*?<section class="panel queue-panel"[\s\S]*?<section class="panel log-panel"/);
  assert.match(styles, /\.runtime-workspace\{display:grid;grid-template-columns:minmax\(0,1fr\)/);
  assert.match(styles, /\.runtime-workspace\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\);height:587px\}/);
  assert.match(html, /<section class="panel log-panel"[\s\S]*?<pre id="renderLog" class="render-log"><\/pre>/);
  assert.match(styles, /\.runtime-workspace \.render-log\{height:300px/);
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
  assert.doesNotMatch(html, /shadowSubstrate|Shadow Substrate/);
  assert.match(html, /id="shadowPipelineNote"/);
  assert.match(client, /UE 5\.8 uses the native Composite shadow alpha/);
  assert.match(client, /button\[data-render-environment\]/);
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
  assert.match(styles, /\.suggest-pop:popover-open\{display:flex;opacity:1;transform:none\}/);
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
  assert.doesNotMatch(client, /shadowSubstrate|rhShadowSubstrate/);
  assert.match(client, /render\.phase === "Shadow processing"/);
  assert.match(client, /shadows processed/);
  assert.match(client, /Substrate \$\{render\.substrate \? "ON" : "OFF"\}/);
  assert.doesNotMatch(client, /Open the local dashboard with npm start to resolve full model paths/);
  assert.match(styles, /main\{width:calc\(100% - clamp\([^)]*\)\);max-width:none/);
  assert.match(styles, /\.workspace\{display:grid/);
  assert.match(styles, /\.workspace-col\{display:flex;flex-direction:column/);
  assert.match(html, /class="workspace-col workspace-col-status"/);
});
