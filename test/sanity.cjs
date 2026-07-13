// Sanity test for the light-rig scaler.
// Extracts the pure logic from index.html and verifies the core invariants
// without needing a browser. Run: `npm test`  (or `node test/sanity.cjs`). Node 18+.

const fs = require("fs");
const path = require("path");

const htmlPath = path.join(__dirname, "..", "index.html");
const html = fs.readFileSync(htmlPath, "utf8");

const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) {
  console.error("FAIL: <script> block not found in index.html");
  process.exit(1);
}

const tmp = path.join(__dirname, "_lightrig.tmp.cjs");
fs.writeFileSync(tmp, m[1]);
let L;
try {
  L = require(tmp);
} finally {
  fs.unlinkSync(tmp);
}

const { REF_DEFAULT, TEMPLATE, VIEWS, computeAll, generateT3D,
        scaleAim, fitAspectBounds, rbCandidateFiles, rbMatchManifest, presetArmSide, armRequiredView, armBlocksView } = L;

let failed = 0;
function check(name, cond) {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failed++;
}

const tmplLines = TEMPLATE.split("\n").length;
const gen = (v, mode) => generateT3D(computeAll(453, 274, 77, mode || "A", false, REF_DEFAULT, v));

// 1. F view at reference reproduces the source skeleton byte-for-byte (both modes).
check("identity F / mode A === TEMPLATE", gen("F", "A") === TEMPLATE);
check("identity F / mode B === TEMPLATE", gen("F", "B") === TEMPLATE);

// 2. Every view generates valid, structurally-identical, brand-free T3D.
const views = Object.keys(VIEWS);
check("VIEWS = [F, FH, TQR, TQL]", views.join(",") === "F,FH,TQR,TQL");
check("scene schematic defaults to the two-screen split view",
  /name="diagramview" id="dvBoth" value="both" checked/.test(html) &&
  /id="sceneViews" class="views" data-layout="both"/.test(html));
const fittedWide = fitAspectBounds(-100, 100, -100, 100, 2);
const fittedTall = fitAspectBounds(-200, 200, -50, 50, 1);
check("diagram bounds expand to fill wide/tall viewports without cropping",
  fittedWide.minX === -200 && fittedWide.maxX === 200 && fittedWide.minY === -100 && fittedWide.maxY === 100 &&
  fittedTall.minX === -200 && fittedTall.maxX === 200 && fittedTall.minY === -200 && fittedTall.maxY === 200);
check("default Koper preset is 384x305x82, arm L",
  /"KOPER_LEFT_ARM_L_SECTIONAL_prod39250480":\s*\{\s*W:384,\s*D:305,\s*H:82,\s*arm:"L",/.test(html));
check("arm side: explicit preset.arm wins over the name",
  presetArmSide({ arm:"R" }, "KOPER_LEFT_ARM_L_SECTIONAL_prod39250480") === "R" &&
  presetArmSide({ arm:"L" }, "no arm hints here") === "L");
check("arm side: inferred from the name when preset.arm is absent",
  presetArmSide({}, "KOPER_LEFT_ARM_L_SECTIONAL_prod39250480") === "L" &&
  presetArmSide({}, "Borgo · Right-Arm L (39250511)") === "R" &&
  presetArmSide({}, "Koper · U (39250483)") === "");
check("armRequiredView: L -> TQL, R -> TQR, none -> ''",
  armRequiredView("L") === "TQL" && armRequiredView("R") === "TQR" && armRequiredView("") === "");
check("arm gating blocks only the opposite TQ view (F/FH stay open)",
  armBlocksView("L", "TQR") === true  && armBlocksView("L", "TQL") === false &&
  armBlocksView("R", "TQL") === true  && armBlocksView("R", "TQR") === false &&
  armBlocksView("L", "F")   === false && armBlocksView("L", "FH")  === false &&
  armBlocksView("",  "TQR") === false);
check("render candidates: prefix variants x view suffixes, probe-priority order",
  JSON.stringify(rbCandidateFiles("P", "DIR", "TQL")) ===
  JSON.stringify(["DIR/P_LEFT_ARM.png", "DIR/P_TQ.png", "DIR/P_FH_LEFT_ARM.png", "DIR/P_FH_TQ.png"]));
const mf = ["MAT_A/PFX_F.png", "MAT_A/PFX_TQ.png", "MAT_B/PFX_FH_F.png", "MAT_B/OTHER_F.png"];
check("manifest match: exact + _FH variant, materials discovered from the list",
  JSON.stringify(rbMatchManifest(mf, "PFX", "F")) ===
  JSON.stringify({ MAT_A: ["MAT_A/PFX_F.png"], MAT_B: ["MAT_B/PFX_FH_F.png"] }));
check("manifest match: TQ fallback suffix, no false positives",
  JSON.stringify(rbMatchManifest(mf, "PFX", "TQR")) ===
  JSON.stringify({ MAT_A: ["MAT_A/PFX_TQ.png"] }) &&
  JSON.stringify(rbMatchManifest(mf, "OTHER", "TQR")) === "{}");
for (const v of views) {
  const out = gen(v);
  const actors = (out.match(/Begin Actor/g) || []).length;
  check(`${v}: 5 actors, same line count, no brand`,
    actors === 5 && out.split("\n").length === tmplLines && !/RH/.test(out) && !/3dsource/i.test(out));
}

// 3. Per-view rotations are written correctly (key + right_rim differ per shot).
const has = (v, s) => gen(v).includes(s);
check("F   key Yaw=-11, right_rim Yaw=180", has("F","Yaw=-11.000000") && has("F","Yaw=180.000000"));
check("FH  right_rim Yaw=157.218750",        has("FH","Yaw=157.218750"));
check("TQR key Pitch=-18, Yaw=28; rim Yaw=153", has("TQR","Pitch=-18.000000") && has("TQR","Yaw=28.000000") && has("TQR","Yaw=153.000000"));
check("TQL key Yaw=3; rim Yaw=166.5",        has("TQL","Yaw=3.000000") && has("TQL","Yaw=166.500000"));

// 4. Scaling still works (F, scaled): output changes, structure preserved.
const scaled = gen("F"); // ref
const big = generateT3D(computeAll(600, 300, 80, "A", false, REF_DEFAULT, "F"));
check("scaled F (600x300x80) differs from reference", big !== scaled);
check("scaled F keeps 5 actors + line count",
  (big.match(/Begin Actor/g) || []).length === 5 && big.split("\n").length === tmplLines);

// 5. Aim follows non-uniform sofa proportions, but uniform scaling is rotation-stable.
const uniformAim = scaleAim(-25, -11, 2, 2, 2);
const wideAim = scaleAim(0, 45, 2, 1, 1);
const tallAim = scaleAim(45, 0, 1, 1, 2);
check("uniform scaling preserves pitch/yaw exactly",
  uniformAim.pitch === -25 && uniformAim.yaw === -11);
check("non-uniform XY scaling adapts yaw",
  Math.abs(wideAim.pitch) < 1e-12 && Math.abs(wideAim.yaw - 26.565051) < 1e-5);
check("non-uniform Z scaling adapts pitch",
  Math.abs(tallAim.pitch - 63.434949) < 1e-5 && Math.abs(tallAim.yaw) < 1e-12);
const adapted = computeAll(600, 300, 80, "A", false, REF_DEFAULT, "F");
check("scaled rig exposes source aim and corrects the main key",
  adapted.main_key_lgt.sourceYaw === -11 && adapted.main_key_lgt.sourcePitch === -25 &&
  adapted.main_key_lgt.yaw !== -11 && adapted.main_key_lgt.pitch !== -25);
for (const mode of ["A", "B"]) {
  const extreme = computeAll(1000, 80, 30, mode, false, REF_DEFAULT, "TQL");
  check(`extreme valid dimensions stay finite in mode ${mode}`,
    Object.values(extreme).every(r => [
      ...r.pos, r.intensity, r.k, r.p, r.pitch, r.yaw,
      ...(r.atten == null ? [] : [r.atten]),
      r.type === "rect" ? r.w : r.radius,
    ].every(Number.isFinite)));
}

if (failed) {
  console.error(`\n${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll checks passed.");
