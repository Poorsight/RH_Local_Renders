"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), vm = require("node:vm");
const { PNG } = require("pngjs");
const { materialPartName } = require("../material-id.js");
const { partKey } = require("../lib/model-check.cjs");
const { sanitizePng } = require("../lib/png-privacy.cjs");
const { writePngText } = require("../lib/post-process.cjs");
const { buildBatchJob } = require("../lib/jobs.cjs");
const { buildRig } = require("../lib/rig.cjs");
const { parseCsv } = require("../lib/csv.cjs");

test("mesh grouping handles numeric export suffixes without dropping numeric mesh IDs", () => {
  const browser = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../material-id.js"), "utf8"), browser);
  const cases = {
    UPH: "UPH", "product_LONG_1009_Stitches2": "Stitches", "scene:Feet.001": "Feet",
    UPH_UPH_003: "UPH", Feet_Feet_001: "Feet", Stitches_Stitches_010: "Stitches",
    UPH_UPH_LUGANO_MODULAR_ARMLESS_CHAIR_LUXE_10007333_002: "UPH",
    Feet_Feet_LUGANO_MODULAR_ARMLESS_CHAIR_LUXE_10007333_001: "Feet",
    Custom_Custom_PRODUCT_123_004: "Custom", product_Piping_003: "Piping",
    product_UPH_BRACKET_001: "BRACKET", Foo_Foo_Bar: "Bar", "001": "001", Blocker: "Blocker"
  };
  for (const [id, expected] of Object.entries(cases)) {
    assert.equal(materialPartName(id), expected, id);
    assert.equal(browser.materialPartName(id), expected);
    assert.equal(partKey(id), expected.toLowerCase());
  }
});

test("normalized groups assign every exact original ID only to its owning model", () => {
  const sets = [["UPH", "UPH_UPH_003", "Feet_Feet_001"], ["UPH_Uph_002", "Stitches_Stitches_010", "Blocker", "001"]];
  const rows = new Map();
  for (const id of sets.flat()) {
    const key = materialPartName(id).toLowerCase();
    if (!rows.has(key)) rows.set(key, { meshes: [], material: `M_${key}` });
    rows.get(key).meshes.push(id);
  }
  const rig = buildRig(parseCsv(fs.readFileSync(path.join(__dirname, "../data/sectionals-indoor.csv"), "utf8")));
  const job = buildBatchJob(sets.map((ids, index) => ({
    model: { name: `TEST_prod${index}`, path: `D:\\models\\test${index}.fbx`, materialIds: ids, offsetUniformScale: 1 },
    input: { side: "R", dimensions: { width: 350, depth: 250, height: 85 }, cameras: ["F"], layers: ["Fabric"], materials: [...rows.values()] }
  })), rig, "D:\\renders\\parts-test", "parts-test");
  job.tasks.forEach((task, index) => assert.deepEqual(task.materials.flatMap(group => group.meshes).sort(), sets[index].map(id => id.toLowerCase()).sort()));
});

test("privacy removes all text, EXIF, unknown metadata and trailing bytes without touching pixels", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "rh-privacy-"));
  try {
    const file = path.join(folder, "sample.png"), png = new PNG({ width: 3, height: 2 });
    png.data.forEach((_, index) => { png.data[index] = index * 11 % 256; });
    fs.writeFileSync(file, PNG.sync.write(png));
    writePngText(file, { _SID: "PRIVATE-PC", objPath: "C:\\Users\\Private\\model.fbx", Author: "Private" });
    const before = fs.readFileSync(file);
    // Chunk lengths are valid; no decoder should ever see the removed metadata.
    const chunk = type => { const b = Buffer.alloc(18); b.writeUInt32BE(6); b.write(type, 4); b.write("secret", 8); return b; };
    const dirty = Buffer.concat([before.subarray(0, -12), ...["zTXt", "iTXt", "eXIf", "tIME", "vpAg"].map(chunk), before.subarray(-12), Buffer.from("private trailing data")]);
    const result = sanitizePng(dirty);
    assert.equal(result.removed.length, 9);
    assert.deepEqual(PNG.sync.read(result.buffer).data, png.data);
    assert.equal(sanitizePng(result.buffer).removed.length, 0);
    assert.doesNotMatch(result.buffer.toString("latin1"), /PRIVATE|Private|secret|private/);
    assert.throws(() => sanitizePng(dirty.subarray(0, 20)), /IEND|Truncated/);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});
