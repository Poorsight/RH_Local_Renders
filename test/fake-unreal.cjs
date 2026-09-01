"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { PNG } = require("pngjs");

(async () => {
  const args = process.argv.slice(2);
  const apiArgument = args.find(argument => argument.includes(":ApiUrl="));
  const substrateArgument = args.find(argument => argument.includes(":r.Substrate="));
  if (!apiArgument || !substrateArgument) throw new Error("Missing BatchRender API or Substrate override");
  const apiUrl = apiArgument.slice(apiArgument.indexOf("=") + 1);
  const response = await fetch(apiUrl), job = await response.json();
  const phase = job._rhLocal?.renderPhase || job.tasks?.[0]?.layers?.[0]?.name || "Unknown", layerName = job.tasks?.[0]?.layers?.[0]?.name || phase;
  const keyLight = job.tasks?.[0]?.sequence?.cameras?.[0]?.lights?.find(light => light.name === "key_lgt");
  const cameras = (job.tasks || []).flatMap(task => (task.sequence?.cameras || []).map((camera, index) => ({ taskId: task.taskId, camera, index })));
  fs.appendFileSync(process.env.RH_FAKE_UNREAL_LOG, `${JSON.stringify({ phase, substrateArgument, jobId: job.jobId, keyLight, taskIds: (job.tasks || []).map(task => task.taskId), cameras: cameras.map(item => item.camera) })}\n`);
  const crashMarker = process.env.RH_FAKE_UNREAL_CRASH_ONCE;
  // Lets a test catch the run mid-flight, which is the only way to exercise a forced stop.
  const stall = Number(process.env.RH_FAKE_UNREAL_STALL || 0);
  if (stall > 0) await new Promise(resolve => setTimeout(resolve, stall));
  const tasks = crashMarker && !fs.existsSync(crashMarker) ? (job.tasks || []).slice(0, 1) : (job.tasks || []);
  for (const task of tasks) {
    const output = task.layers?.[0]?.output?.folder;
    fs.mkdirSync(output, { recursive: true });
    for (const [index, camera] of (task.sequence?.cameras || []).entries()) {
      const outputFile = path.join(output, `00000000_${camera.name}_${layerName}.png`);
      if (job._rhLocal?.cropCalibration) {
        const resolution = camera.LayerResolutions?.[0]?.Resolution || { X: layerName === "Shadow" ? 1500 : 500, Y: 500 }, png = new PNG({ width: resolution.X, height: resolution.Y });
        const top = layerName === "Shadow" ? Math.floor(resolution.Y * 0.53) : Math.floor(resolution.Y * 0.31), bottom = layerName === "Shadow" ? Math.floor(resolution.Y * 0.65) : Math.floor(resolution.Y * 0.63);
        for (let y = top; y <= bottom; y += 1) for (let x = Math.floor(resolution.X * 0.3); x < Math.ceil(resolution.X * 0.7); x += 1) {
          const pixel = ((y * resolution.X + x) << 2);
          if (layerName === "Shadow") {
            // UE 5.6 Substrate + Legacy Composure writes the matte into RGB and clears alpha.
            png.data[pixel] = 255; png.data[pixel + 1] = 255; png.data[pixel + 2] = 255; png.data[pixel + 3] = 0;
          } else png.data[pixel + 3] = 220;
        }
        fs.writeFileSync(outputFile, PNG.sync.write(png));
      } else if (layerName === "Shadow") {
        const png = new PNG({ width: 8, height: 4 });
        for (let y = 1; y < 3; y += 1) for (let x = 2; x < 7; x += 1) {
          const pixel = ((y * png.width + x) << 2);
          png.data[pixel] = 255; png.data[pixel + 1] = 255; png.data[pixel + 2] = 255; png.data[pixel + 3] = 0;
        }
        fs.writeFileSync(outputFile, PNG.sync.write(png));
      } else if (process.env.RH_FAKE_UNREAL_VALID_PNG === "1") {
        const png = new PNG({ width: 8, height: 4 });
        for (let pixel = 3; pixel < png.data.length; pixel += 4) png.data[pixel] = 255;
        fs.writeFileSync(outputFile, PNG.sync.write(png));
      } else fs.writeFileSync(outputFile, `${phase}:${task.taskId}:${camera.name}:${Date.now()}`);
      if (layerName === "Fabric") await fetch(apiUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        event: "sequence_camera_data",
        data: { jobId: job.jobId, taskId: task.taskId, sequenceName: camera.sequenceName, camera: {
          name: camera.name, sequenceName: camera.sequenceName,
          cameraLocation: { X: index + 1, Y: 1650, Z: 120 }, cameraRotation: { Pitch: -3, Yaw: -90, Roll: 0 },
          FocalLength: 140 + index, SensorWidth: 36, SensorHeight: 36, CurrentAperture: 2.8, bCorrectPerspective: false
        } }
      }) });
      await fetch(apiUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event: "render_finished", data: { jobId: job.jobId, taskId: task.taskId, sequenceName: camera.sequenceName } }) });
    }
  }
  if (crashMarker && !fs.existsSync(crashMarker)) { fs.writeFileSync(crashMarker, "crashed"); return; }
  await fetch(apiUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event: "job_completed", data: { jobId: job.jobId } }) });
})().catch(error => { console.error(error); process.exitCode = 1; });
