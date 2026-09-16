"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { prepareAdapterJob, stageAdapterRun, editorOverrides, SETTINGS } = require("../lib/batchrender-adapter.cjs");
const { buildUnrealLaunch } = require("../lib/unreal.cjs");
const { rendererToken } = require("../lib/camera-fit.cjs");

const inheritedJob = () => ({ jobId: "job__shadow", tasks: [{ taskId: "model-A", sequence: { cameras: [{
  name: "F", sequenceName: "Sectional_Indoor_L_F", fit: "none", Camera: {
    OverrideLocation: true, Location: { X: 1, Y: 2, Z: 3 }, OverrideRotation: true,
    Rotation: { Pitch: -3, Yaw: -90, Roll: 0 }, OverrideFocalLength: true, FocalLength: 164.25
  }, LayerResolutions: [{ Name: "Shadow", SensorSize: { X: 108, Y: 24 }, Resolution: { X: 15000, Y: 3334 } }] }] } }] });

test("upstream camera handoff is staged separately without changing input, sensor or transform", () => {
  const job = inheritedJob(), before = JSON.stringify(job), result = prepareAdapterJob(job);
  assert.equal(JSON.stringify(job), before);
  assert.equal(result.runtimeJob.shadowAlphaRecovery, true);
  assert.equal(result.runtimeJob.tasks[0].shadowAlphaRecovery, true);
  assert.deepEqual(result.inherited, [{ taskId: "model-A", sequenceName: "Sectional_Indoor_L_F", focalLength: 164.25 }]);
  const original = job.tasks[0].sequence.cameras[0], runtime = result.runtimeJob.tasks[0].sequence.cameras[0];
  assert.ok(!("FocalLength" in runtime.Camera) && !("OverrideFocalLength" in runtime.Camera));
  assert.deepEqual(runtime.Camera.Location, original.Camera.Location);
  assert.deepEqual(runtime.Camera.Rotation, original.Camera.Rotation);
  assert.deepEqual(runtime.LayerResolutions, original.LayerResolutions);
});

test("handoff refuses mixed models, invalid focal length and fitting an inherited camera", () => {
  const job = inheritedJob(); job.tasks.push({ ...job.tasks[0], taskId: "model-B" });
  assert.throws(() => prepareAdapterJob(job), /one model/);
  for (const value of [0, -1, "NaN", null]) {
    const invalid = inheritedJob(); invalid.tasks[0].sequence.cameras[0].Camera.FocalLength = value;
    assert.throws(() => prepareAdapterJob(invalid), /positive finite/);
  }
  const fitting = inheritedJob(); fitting.tasks[0].sequence.cameras[0].fit = "horizontalFocalLength";
  assert.throws(() => prepareAdapterJob(fitting), /disable fit/);
});

test("process-only overrides use the RH scene and leave upstream class defaults alone", () => {
  const override = editorOverrides("http://127.0.0.1:5500/api/unreal?source=local&attempt=a");
  assert.equal((override.match(/-ini:Editor:/g) || []).length, 1);
  assert.ok(override.includes("RenderLevel=/Game/Maps/PathTrace/Composure.Composure"));
  assert.ok(!override.includes("Test_ComposureMain"));
  assert.ok(!override.includes("BatchRenderManagerClass="));
  assert.ok(!override.includes("BP_BatchRenderManager"));
  for (const value of Object.values(SETTINGS)) assert.ok(override.includes(value));
  assert.throws(() => editorOverrides("http://localhost/path,Other=bad"), /Unsupported character/);
});

test("native launch uses one-shot TestJob bootstrap instead of racing GET dispatch", () => {
  const adapter = { script: "D:/Tool With Spaces/integration/batchrender/upstream-bootstrap.py", manifestFile: "D:/Tool With Spaces/local/runtime/adapter.json" };
  const launch = buildUnrealLaunch("UnrealEditor.exe", "project.uproject", "http://127.0.0.1:5500/api/unreal?source=local&attempt=test", { adapter });
  assert.ok(!launch.args.includes("-BatchRender"));
  assert.ok(launch.args.includes("-EnablePlugins=PythonScriptPlugin"));
  assert.ok(launch.args.includes(`-ExecutePythonScript=${adapter.script}`));
  assert.equal(launch.options.shell, false);
  assert.equal(launch.options.env.RH_BATCHRENDER_ADAPTER_MANIFEST, adapter.manifestFile);
  assert.ok(!launch.args.some(arg => arg.includes("ShadowAlphaProcessor") || arg.includes("ShadowAlphaLut")));
});

test("staged files are isolated per attempt and cannot overwrite another attempt", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rh-upstream-adapter-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const run = stageAdapterRun(root, inheritedJob(), { attemptId: "attempt-a", apiUrl: "http://127.0.0.1:5500/api/unreal?attempt=attempt-a" });
  assert.ok(run.jobFile.startsWith(path.join(root, "local", "runtime", "batchrender")));
  const manifest = JSON.parse(fs.readFileSync(run.manifestFile));
  assert.equal(manifest.inherited[0].focalLength, 164.25);
  assert.equal(manifest.validateResources, true);
  const stockJob = inheritedJob(); stockJob._rhLocal = { experiment: { stockPlugin: true } };
  const stock = stageAdapterRun(root, stockJob, { attemptId: "stock-test", apiUrl: manifest.apiUrl });
  assert.equal(JSON.parse(fs.readFileSync(stock.manifestFile)).validateResources, false);
  assert.deepEqual(stock.inherited, run.inherited, "stock experiment still carries the authorized focal override");
  assert.throws(() => stageAdapterRun(root, inheritedJob(), { attemptId: "attempt-a", apiUrl: manifest.apiUrl }), /EEXIST/);
  assert.throws(() => stageAdapterRun(root, inheritedJob(), { attemptId: "../outside", apiUrl: manifest.apiUrl }), /Invalid adapter/);
});

test("changing only the editor plugin invalidates camera/crop renderer tokens", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rh-upstream-token-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "test.uproject"), folder = path.join(root, "Plugins", "BatchRender", "Binaries", "Win64");
  fs.mkdirSync(folder, { recursive: true }); fs.writeFileSync(project, "{}");
  fs.writeFileSync(path.join(folder, "UnrealEditor-BatchRender.dll"), "runtime");
  const editor = path.join(folder, "UnrealEditor-BatchRenderEditor.dll"); fs.writeFileSync(editor, "editor-1");
  const before = rendererToken(project); fs.writeFileSync(editor, "editor-2");
  assert.notEqual(rendererToken(project), before);
});

test("the local HTTP bridge ignores stale processes and preserves a late fatal error", async t => {
  const { spawn } = require("node:child_process"), net = require("node:net");
  const { parseCsv } = require("../lib/csv.cjs"), { buildRig } = require("../lib/rig.cjs"), { buildJob } = require("../lib/jobs.cjs");
  const root = path.resolve(__dirname, ".."), rig = buildRig(parseCsv(fs.readFileSync(path.join(root, "data/sectionals-indoor.csv"), "utf8")));
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  for (const lateError of [false, true]) await t.test(lateError ? "error after completed remains a failure" : "stale completion/error cannot affect the job", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rh-bridge-protocol-"));
    const suffix = `${process.pid}_${Date.now()}`, output = path.join(root, "local", "renders", `test_protocol_${suffix}`);
    const jobPath = path.join(root, "local", "jobs", "generated", `test_protocol_${suffix}.job.json`);
    fs.mkdirSync(output, { recursive: true }); fs.mkdirSync(path.dirname(jobPath), { recursive: true });
    const job = buildJob({ side: "R", dimensions: { width: 343, depth: 307, height: 79 }, importYaw: 0,
      cameras: ["F"], layers: ["Fabric"], materials: [{ meshes: ["UPH"], material: "FABRIC_A" }] },
      { name: `PROTOCOL_${suffix}`, path: "D:\\models\\protocol.fbx", offsetUniformScale: 1, materialIds: ["UPH"] }, rig, output);
    job.jobId = `test_protocol_${suffix}`; job._rhLocal.outputFolder = output + path.sep;
    fs.writeFileSync(jobPath, JSON.stringify(job));
    const port = await new Promise(resolve => { const probe = net.createServer(); probe.listen(0, "127.0.0.1", () => { const port = probe.address().port; probe.close(() => resolve(port)); }); });
    const service = spawn(process.execPath, [path.join(root, "server.cjs")], { cwd: root, windowsHide: true, stdio: "ignore", env: {
      ...process.env, RH_LOCAL_RENDERS_PORT: String(port), RH_ACCESS_KEY: "",
      RH_UNREAL_EDITOR: process.execPath, RH_UNREAL_EDITOR_56: process.execPath,
      RH_UNREAL_PROJECT: path.join(root, "test/fake-unreal.cjs"), RH_UNREAL_PROJECT_56: path.join(root, "test/fake-unreal.cjs"),
      RH_FAKE_UNREAL_LOG: path.join(tmp, "fake.log"), RH_FAKE_UNREAL_VALID_PNG: "1", RH_FAKE_UNREAL_STALE_EVENTS: "1",
      RH_FAKE_UNREAL_ERROR_AFTER_COMPLETE: lateError ? "1" : "0",
      RH_JOB_QUEUE_FILE: path.join(tmp, "queue.json"), RH_RUN_STATS_FILE: path.join(tmp, "stats.json"),
      RH_CHECK_CACHE_FILE: path.join(tmp, "checks.json"), RH_CAMERA_FIT_CACHE_FILE: path.join(tmp, "fit.json"), RH_CROP_CACHE_FILE: path.join(tmp, "crop.json")
    } });
    try {
      const at = endpoint => `http://127.0.0.1:${port}${endpoint}`;
      let online = false;
      for (let n = 0; n < 100 && !online; n++) { try { online = (await fetch(at("/api/status"))).ok; } catch {} if (!online) await delay(50); }
      assert.ok(online, "test-only controller starts");
      const launch = await fetch(at("/api/renders"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobPath }) });
      assert.equal(launch.status, 202, await launch.text());
      let status;
      for (let n = 0; n < 300; n++) { status = await (await fetch(at("/api/renders/status"))).json(); if (status.state !== "running") break; await delay(50); }
      assert.equal(status.state, lateError ? "failed" : "success", status.log);
      if (lateError) assert.match(status.log, /late material failure/);
      assert.doesNotMatch(status.log, /stale error must be ignored/);
    } finally {
      service.kill();
      await new Promise(resolve => service.exitCode !== null || service.signalCode !== null ? resolve() : service.once("exit", resolve));
      fs.rmSync(jobPath, { force: true }); fs.rmSync(output, { recursive: true, force: true }); fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
