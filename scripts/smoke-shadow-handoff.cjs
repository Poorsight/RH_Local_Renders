"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PNG } = require("pngjs");
const { loadConfig, prepareSubstrateShadow } = require("../lib/post-process.cjs");

const root = path.resolve(__dirname, ".."), temp = fs.mkdtempSync(path.join(os.tmpdir(), "rh-shadow-handoff-"));
try {
  const file = path.join(temp, "SMOKE_F_Shadow.png"), image = new PNG({ width: 4, height: 2 });
  for (let index = 0; index < image.data.length; index += 4) {
    // Keep one transparent sample and use a signal that is inside the measured range
    // of the production camera LUT (the calibrated F curve starts above zero at 105).
    const value = index === 0 ? 0 : 160;
    image.data[index] = value;
    image.data[index + 1] = value;
    image.data[index + 2] = value;
    image.data[index + 3] = 0;
  }
  fs.writeFileSync(file, PNG.sync.write(image));

  const converted = prepareSubstrateShadow(file, { config: loadConfig(root), productType: "sectionals" });
  assert.equal(converted.skipped, false);
  assert.ok(converted.maxAlpha > 0);
  assert.ok(fs.existsSync(`${file}.substrate-rgb.bak`));

  const result = PNG.sync.read(fs.readFileSync(file));
  let visible = 0;
  for (let index = 0; index < result.data.length; index += 4) {
    assert.equal(result.data[index], 0);
    assert.equal(result.data[index + 1], 0);
    assert.equal(result.data[index + 2], 0);
    if (result.data[index + 3] > 0) visible += 1;
  }
  assert.ok(visible > 0);

  const second = prepareSubstrateShadow(file, { config: loadConfig(root), productType: "sectionals" });
  assert.equal(second.skipped, true);
  assert.equal(second.reason, "alpha already present");
  console.log(JSON.stringify({ ok: true, visiblePixels: visible, maxAlpha: converted.maxAlpha, idempotent: true }));
} finally {
  const resolved = path.resolve(temp), relative = path.relative(os.tmpdir(), resolved);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative) && path.basename(resolved).startsWith("rh-shadow-handoff-")) {
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
