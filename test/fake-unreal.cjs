"use strict";

const fs = require("node:fs");
const path = require("node:path");

(async () => {
  const args = process.argv.slice(2);
  const apiArgument = args.find(argument => argument.includes(":ApiUrl="));
  const substrateArgument = args.find(argument => argument.includes(":r.Substrate="));
  if (!apiArgument || !substrateArgument) throw new Error("Missing BatchRender API or Substrate override");
  const apiUrl = apiArgument.slice(apiArgument.indexOf("=") + 1);
  const response = await fetch(apiUrl), job = await response.json();
  const phase = job._rhLocal?.renderPhase || job.tasks?.[0]?.layers?.[0]?.name || "Unknown";
  const output = job.tasks?.[0]?.layers?.[0]?.output?.folder;
  const keyLight = job.tasks?.[0]?.sequence?.cameras?.[0]?.lights?.find(light => light.name === "main_key_lgt");
  const cameras = (job.tasks || []).flatMap(task => (task.sequence?.cameras || []).map((camera, index) => ({ taskId: task.taskId, camera, index })));
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, `00000000_F_${phase}.png`), `${phase}:${Date.now()}`);
  fs.appendFileSync(process.env.RH_FAKE_UNREAL_LOG, `${JSON.stringify({ phase, substrateArgument, jobId: job.jobId, keyLight, cameras: cameras.map(item => item.camera) })}\n`);
  if (phase === "Fabric") for (const { taskId, camera, index } of cameras) {
    await fetch(apiUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      event: "sequence_camera_data",
      data: { jobId: job.jobId, taskId, sequenceName: camera.sequenceName, camera: {
        name: camera.name, sequenceName: camera.sequenceName,
        cameraLocation: { X: index + 1, Y: 1650, Z: 120 }, cameraRotation: { Pitch: -3, Yaw: -90, Roll: 0 },
        FocalLength: 140 + index, SensorWidth: 36, SensorHeight: 36, CurrentAperture: 2.8, bCorrectPerspective: false
      } }
    }) });
  }
  await fetch(apiUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event: "job_completed", data: { jobId: job.jobId } }) });
})().catch(error => { console.error(error); process.exitCode = 1; });
