"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PNG } = require("pngjs");
const { buildRenderPlan, applyCameraHandoff, cameraStateKey } = require("../lib/render-plan.cjs");
const { imageLayer, siblingLayerBranch } = require("../lib/output-layout.cjs");
const { expectedRenders } = require("../lib/history.cjs");
const { publishReadyToUpload, processedPathFor } = require("../lib/post-process.cjs");

function sample() {
  return { jobId: "bg", tasks: [{ taskId: "SOFA", model: { objPath: "sofa.obj" },
    materials: [{ meshes: ["uph"], list: [{ name: "A" }, { name: "B" }] }],
    sequence: { cameras: [{ name: "F", sequenceName: "Sofa_Indoor_F", fit: "horizontalFocalLength",
      LayerResolutions: ["Fabric", "Background", "Shadow"].map(Name => ({ Name, Resolution: { X: 500, Y: 500 }, SensorSize: { X: 36, Y: 36 } })) }] },
    layers: ["Fabric", "Background", "Shadow"].map(name => ({ name, SubLevels: [name === "Background" ? "POC_Background" : `Sofa_Indoor_${name}`], output: { folder: `D:/renders/raw/SOFA/${name}`, fileNameFormat: "00000000_{camera}_{layer}" } }))
  }] };
}

test("Background is a separate phase with the same inherited camera and one frame per view", () => {
  const job = sample(), before = JSON.stringify(job), plan = buildRenderPlan(job);
  assert.deepEqual(plan.map(p => p.name), ["Fabric", "Background", "Shadow"]);
  assert.deepEqual(plan.map(p => p.useCameraHandoff), [false, true, true]);
  assert.equal(expectedRenders(job.tasks[0]), 4);
  assert.equal(expectedRenders(plan[1].job.tasks[0]), 1);
  assert.deepEqual(plan[1].job.tasks[0].layers[0].SubLevels, ["POC_Background"]);
  assert.deepEqual(plan[1].job.tasks[0].sequence.cameras[0].LayerResolutions.map(x => x.Name), ["Background"]);
  const state = { cameraLocation: { x: 1, y: 2, z: 3 }, cameraRotation: { pitch: -3, yaw: -90, roll: 0 }, focalLength: 177.761 };
  const inherited = applyCameraHandoff(plan[1].job, new Map([[cameraStateKey("SOFA", "Sofa_Indoor_F"), state]]));
  assert.deepEqual(inherited.missing, []);
  assert.equal(inherited.job.tasks[0].sequence.cameras[0].Camera.FocalLength, state.focalLength);
  assert.equal(inherited.job.tasks[0].sequence.cameras[0].fit, "none");
  assert.equal(JSON.stringify(job), before);
});

test("Background inherits per model and derives its frame instead of using preset defaults", () => {
  const job = sample();
  job.tasks.push({ ...structuredClone(job.tasks[0]), taskId: "SOFA2" });
  for (const t of job.tasks) {
    const c = t.sequence.cameras[0];
    c.LayerResolutions = c.LayerResolutions.filter(x => x.Name !== "Background");
    c._rhLocalCrop = { status: "pending" };
  }
  const plan = buildRenderPlan(job);
  assert.ok(plan.filter(p => p.isCalibration).every(p => p.layerName !== "Background"));
  const bg = plan.filter(p => p.layerName === "Background");
  assert.equal(bg.length, 2);
  assert.ok(bg.every(p => p.job.tasks.length === 1));
  assert.deepEqual(bg[0].job.tasks[0].sequence.cameras[0].LayerResolutions,
    [{ Name: "Background", Resolution: { X: 500, Y: 500 }, SensorSize: { X: 36, Y: 36 } }]);
});

test("Background uses the wider Shadow grid or Fabric fallback, never an unrelated filmback", () => {
  const job = sample(), camera = job.tasks[0].sequence.cameras[0];
  camera.LayerResolutions = [
    { Name: "Fabric", Resolution: { X: 5000, Y: 2140 }, SensorSize: { X: 36, Y: 15.408 } },
    { Name: "Shadow", Resolution: { X: 15000, Y: 2140 }, SensorSize: { X: 108, Y: 15.408 } }
  ];
  const frame = () => buildRenderPlan(job)[1].job.tasks[0].sequence.cameras[0].LayerResolutions[0];
  assert.equal(frame().SensorSize.X, 108); assert.equal(frame().Resolution.X, 15000);
  camera.LayerResolutions.push({ Name: "Background", Resolution: { X: 5000, Y: 3200 }, SensorSize: { X: 70, Y: 70 } });
  assert.equal(frame().SensorSize.X, 108); assert.equal(frame().Resolution.X, 15000);
  camera.LayerResolutions.pop();
  camera.LayerResolutions.pop();
  assert.equal(frame().SensorSize.X, 36); assert.equal(frame().Resolution.X, 5000);
  camera.LayerResolutions = [];
  assert.throws(() => buildRenderPlan(job), /Background requires/);
});

test("Background-only jobs are supported without a nonexistent Fabric handoff", () => {
  const job = sample(); job.tasks[0].layers = [job.tasks[0].layers[1]];
  const plan = buildRenderPlan(job);
  assert.equal(plan.length, 1); assert.equal(plan[0].name, "Background");
  assert.equal(plan[0].useCameraHandoff, false);
  assert.equal(imageLayer("00000000_F_Background.png"), "Background");
  assert.equal(imageLayer("00000000_F_Shadow.png"), "Shadow");
  assert.equal(imageLayer("00000000_F_Product_SAND.png"), "Fabric");
  assert.match(siblingLayerBranch("D:/renders/raw/SOFA/backgrounds", "calibration", "Fabric"), /calibration[\\/]SOFA[\\/]materials[\\/]$/);
});

test("Background delivery is separate, not labelled as a fabric, and retains pixels", t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rh-background-test-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const job = sample(); job._rhLocal = { outputFolder: temp };
  const pixels = new PNG({ width: 2, height: 2 }); pixels.data.fill(173);
  for (const layer of job.tasks[0].layers) {
    layer.output.folder = path.join(temp, "raw", "SOFA", layer.name);
    fs.mkdirSync(layer.output.folder, { recursive: true });
    const file = path.join(layer.output.folder, `00000000_F_${layer.name === "Fabric" ? "Product_A" : layer.name}.png`);
    fs.writeFileSync(file, PNG.sync.write(pixels));
    fs.writeFileSync(processedPathFor(file), PNG.sync.write(pixels));
  }
  const delivery = publishReadyToUpload(job, { config: { outputSuffix: "_POST" } });
  assert.equal(delivery.files, 3);
  const bg = path.join(delivery.folder, "SOFA", "backgrounds", "SOFA_F_Background.png");
  assert.deepEqual(PNG.sync.read(fs.readFileSync(bg)).data, pixels.data);
  const manifest = JSON.parse(fs.readFileSync(delivery.manifest));
  const record = manifest.files.find(x => x.layer === "Background");
  assert.ok(record); assert.deepEqual(record.materials, []);
});
