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
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, `00000000_F_${phase}.png`), `${phase}:${Date.now()}`);
  fs.appendFileSync(process.env.RH_FAKE_UNREAL_LOG, `${JSON.stringify({ phase, substrateArgument, jobId: job.jobId, keyLight })}\n`);
  await fetch(apiUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event: "job_completed", data: { jobId: job.jobId } }) });
})().catch(error => { console.error(error); process.exitCode = 1; });
