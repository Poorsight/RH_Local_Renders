// Sanity test for the light-rig scaler.
// Extracts the pure logic from light-rig-reference.html and verifies the core invariants
// without needing a browser. Run: `npm test`  (or `node test/sanity.cjs`). Node 18+.

const fs = require("fs");
const path = require("path");

const htmlPath = path.join(__dirname, "..", "light-rig-reference.html");
const html = fs.readFileSync(htmlPath, "utf8");

const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) {
  console.error("FAIL: <script> block not found in light-rig-reference.html");
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

const { REF_DEFAULT, TEMPLATE, VIEWS, computeAll, generateT3D, viewLights,
        rigScale, rigScaleRaw, fitAspectBounds, rbCandidateFiles, rbMatchManifest, presetArmSide, armRequiredView, armBlocksView } = L;

let failed = 0;
function check(name, cond) {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failed++;
}

const tmplLines = TEMPLATE.split("\n").length;
const R0 = REF_DEFAULT;
const gen = (v, mode) => generateT3D(computeAll(R0.W, R0.D, R0.H, mode || "A", false, R0, v));

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
check("legacy model presets are removed from the reference UI",
  /const DEFAULT_PRESET = "Manual dimensions"/.test(html) &&
  /"Manual dimensions": \{ W:453, D:279, H:79 \}/.test(html) &&
  !/KOPER_LEFT_ARM_L_SECTIONAL_prod39250480":\s*\{\s*W:/.test(html));
check("arm side: explicit preset.arm wins over the name",
  presetArmSide({ arm:"R" }, "KOPER_LEFT_ARM_L_SECTIONAL_prod39250480") === "R" &&
  presetArmSide({ arm:"L" }, "no arm hints here") === "L");
check("arm side: inferred from the name when preset.arm is absent",
  presetArmSide({}, "KOPER_LEFT_ARM_L_SECTIONAL_prod39250480") === "L" &&
  presetArmSide({}, "Borgo · Right-Arm L (39250511)") === "R" &&
  presetArmSide({}, "Koper · U (39250483)") === "");
// Key letter == arm side: L -> TQL (sofa −36°), R -> TQR (sofa +36°). Briefly inverted and
// reverted on 2026-08-13 — see armRequiredView in light-rig-reference.html before changing it.
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
check("render candidates: TQR looks for RIGHT_ARM files (suffix follows the arm side)",
  JSON.stringify(rbCandidateFiles("P", "DIR", "TQR")) ===
  JSON.stringify(["DIR/P_RIGHT_ARM.png", "DIR/P_TQ.png", "DIR/P_FH_RIGHT_ARM.png", "DIR/P_FH_TQ.png"]));
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

// 5. The rig scales as a rigid body: one factor for all five lights, no rotation, no shape
// following. These are the invariants that replaced the old per-axis stretch + adaptive aim.
{
  const dims = [[600,300,80], [274.583,355.499,86.860], [312,246,77], [1000,80,30]];

  check("rigScaleRaw is the geometric mean of the three axis ratios",
    Math.abs(rigScaleRaw(R0.W*2, R0.D*2, R0.H*2, R0) - 2) < 1e-12 &&
    Math.abs(rigScaleRaw(R0.W*2, R0.D, R0.H, R0) - Math.cbrt(2)) < 1e-12 &&
    Math.abs(rigScaleRaw(R0.W/2, R0.D, R0.H, R0) - Math.cbrt(0.5)) < 1e-12 &&
    rigScaleRaw(R0.W, R0.D, R0.H, R0) === 1);

  /* The rig is only ever pushed OUT. Anything that fits inside the tuned setup is emitted as
     tuned — measured on the preset catalogue that beats pulling the lights in. */
  check("rigScale clamps at 1: the rig is never pulled in",
    rigScale(R0.W/2, R0.D/2, R0.H/2, R0) === 1 &&
    rigScale(R0.W, R0.D, R0.H, R0) === 1 &&
    rigScale(312, 246, 77, R0) === 1 &&
    rigScale(R0.W*2, R0.D*2, R0.H*2, R0) === 2);
  check("a sofa smaller than the reference reproduces the rig byte-for-byte",
    ["A","B"].every(mode => views.every(v =>
      generateT3D(computeAll(312, 246, 77, mode, false, R0, v)) === gen(v, mode))));

  check("rigScale is invariant to swapping W and D (a mesh rotated 90° gives the same rig)",
    dims.every(([W,D,H]) =>
      Math.abs(rigScale(W, D, H, REF_DEFAULT) - rigScale(D * REF_DEFAULT.W / REF_DEFAULT.D,
                                                         W * REF_DEFAULT.D / REF_DEFAULT.W, H, REF_DEFAULT)) < 1e-12));

  check("the legacy `swap` argument is a no-op",
    dims.every(([W,D,H]) => ["A","B"].every(mode =>
      generateT3D(computeAll(W, D, H, mode, false, REF_DEFAULT, "TQR")) ===
      generateT3D(computeAll(W, D, H, mode, true,  REF_DEFAULT, "TQR")))));

  for (const v of views) {
    const r = computeAll(274.583, 355.499, 86.860, "B", false, REF_DEFAULT, v);
    const src = viewLights(v);
    check(`${v}: pitch/yaw/roll are never recomputed`,
      Object.keys(r).every(n => r[n].pitch === src[n].pitch && r[n].yaw === src[n].yaw &&
                                r[n].sourcePitch === src[n].pitch && r[n].sourceYaw === src[n].yaw));
    const ks = Object.values(r).map(x => x.k);
    check(`${v}: k is identical for all five lights`,
      Math.max(...ks) - Math.min(...ks) === 0 &&
      Math.abs(ks[0] - rigScale(274.583, 355.499, 86.860, REF_DEFAULT)) < 1e-12);
  }

  // Positions are a plain scalar multiple of the source rig on every shot, including the
  // turned ¾ ones — a uniform scale commutes with any rotation, so no sofa frame is needed.
  const maxDelta = (view, W, D, H) => {
    const k = rigScale(W, D, H, REF_DEFAULT);
    const got = computeAll(W, D, H, "A", false, REF_DEFAULT, view), src = viewLights(view);
    return Math.max(...Object.keys(src).flatMap(n => [0,1,2].map(i => Math.abs(got[n].pos[i] - src[n].pos[i] * k))));
  };
  check("positions are exactly source · k on every shot",
    views.every(v => dims.every(([W,D,H]) => maxDelta(v, W, D, H) === 0)));
  check("every shot reproduces its source rig exactly at the reference sofa",
    views.every(v => maxDelta(v, R0.W, R0.D, R0.H) === 0));

  check("AttenuationRadius is gone from the result and never written",
    Object.values(computeAll(600, 300, 80, "A", false, REF_DEFAULT, "F")).every(r => r.atten === undefined) &&
    generateT3D(computeAll(600, 300, 80, "A", false, REF_DEFAULT, "F")).includes("AttenuationRadius=600.000000"));

  check("mode A is an exact similarity: sizes · k, intensity · k²",
    (() => {
      const r = computeAll(600, 300, 80, "A", false, REF_DEFAULT, "F"), src = viewLights("F"), k = r.front_fill_lgt.k;
      return Math.abs(r.front_fill_lgt.w - src.front_fill_lgt.w * k) < 1e-9 &&
             Math.abs(r.front_fill_lgt.intensity - src.front_fill_lgt.I * k * k) < 1e-9;
    })());
  check("mode B keeps source sizes untouched",
    (() => {
      const r = computeAll(600, 300, 80, "B", false, REF_DEFAULT, "F"), src = viewLights("F");
      return r.front_fill_lgt.w === src.front_fill_lgt.w && r.right_bounce_lgt.barn === src.right_bounce_lgt.barn &&
             r.left_rim_lgt.radius === src.left_rim_lgt.radius && r.left_rim_lgt.soft === src.left_rim_lgt.soft;
    })());

  for (const mode of ["A", "B"]) {
    const extreme = computeAll(1000, 80, 30, mode, false, REF_DEFAULT, "TQL");
    check(`extreme valid dimensions stay finite in mode ${mode}`,
      Object.values(extreme).every(r => [
        ...r.pos, r.intensity, r.k, r.p, r.pitch, r.yaw,
        r.type === "rect" ? r.w : r.radius,
      ].every(Number.isFinite)));
  }
}

// 6. The automation handoff package still matches light-rig-reference.html.
{
  const problems = require("../handoff/export_from_index.cjs").check();
  check("handoff/ data files in sync (npm run handoff)", problems.length === 0);
  problems.forEach(p => console.log(`        ${p}`));
}

// 7. The rig still matches the UE scene it was tuned in. This is the only check whose
// reference is external: everything else compares the reference page against itself, so it cannot
// catch a rig that drifted from the scene. handoff/ue_reference/<shot>.t3d are verbatim
// Ctrl+C exports of the five lights (see handoff/verify_scene.cjs).
{
  const { checkExport, REF_DIR } = require("../handoff/verify_scene.cjs");
  for (const v of views) {
    const file = path.join(REF_DIR, `${v}.t3d`);
    if (!fs.existsSync(file)) { check(`ue_reference/${v}.t3d present`, false); continue; }
    const t3d = fs.readFileSync(file, "utf8");

    const forced = checkExport(t3d, v, L);
    check(`${v}: reproduces the UE scene export (${forced.compared} properties)`, forced.diffs.length === 0);
    forced.diffs.slice(0, 8).forEach(d =>
      console.log(`        ${d.label} ${d.field}: scene=${d.scene} package=${d.tool}`));

    // The four shots must stay distinguishable, or verify_scene's auto-detect is meaningless.
    const auto = checkExport(t3d, null, L);
    check(`${v}: shot is unambiguous (auto-detect resolves to ${auto.view})`,
      auto.view === v && auto.diffs.length === 0);
  }
}

if (failed) {
  console.error(`\n${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll checks passed.");
