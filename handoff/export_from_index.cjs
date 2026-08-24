// Regenerate the handoff data files from light-rig-reference.html — the light-rig source of truth.
//
//   node handoff/export_from_index.cjs           # write handoff/{light_rig.json,rig_template.t3d,acceptance_vectors.json}
//   node handoff/export_from_index.cjs --check   # verify committed data matches the reference (used by `npm test`)
//
// Why: HANDOFF_FORMULA.md + light_rig.py are a port target for whoever automates the rig.
// If LIGHT_BASE / VIEWS / TEMPLATE / BUILTIN change in light-rig-reference.html, re-run this so the
// handoff package (and its golden vectors) cannot silently drift from the tool.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const sha256 = s => crypto.createHash("sha256").update(s, "utf8").digest("hex");

/* Pull the pure logic + the UI-side constants out of the standalone light-rig reference. */
function loadLogic() {
  const html = fs.readFileSync(path.join(ROOT, "light-rig-reference.html"), "utf8");
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("light-rig-reference.html: <script> block not found");

  const tmp = path.join(__dirname, "_lightrig.export.tmp.cjs");
  fs.writeFileSync(tmp, m[1]);
  let L;
  try { L = require(tmp); } finally { fs.unlinkSync(tmp); }

  // BUILTIN lives inside the `document` guard, so it is not exported.
  const bm = m[1].match(/const BUILTIN = (\{[\s\S]*?\n {2}\});/);
  if (!bm) throw new Error("light-rig-reference.html: BUILTIN preset table not found");
  const BUILTIN = new Function("return " + bm[1])();

  // Arm-side gating is exported since 272716e (explicit preset.arm, name parsing as fallback).
  if (typeof L.presetArmSide !== "function" || typeof L.armRequiredView !== "function")
    throw new Error("light-rig-reference.html: presetArmSide / armRequiredView are no longer exported");

  return { L, BUILTIN };
}

/* SKU digits out of a preset key ("Koper · U (39250483)" / "…_prod39250483"). */
function skuOf(name, prefix) {
  const m = String(name).match(/\((\d{6,})\)/) || String(prefix || "").match(/prod(\d{6,})/);
  return m ? m[1] : null;
}

function buildConstants({ L, BUILTIN }) {
  const { REF_DEFAULT, LIGHT_BASE, VIEWS, presetArmSide, armRequiredView } = L;

  const lights = {};
  for (const [name, b] of Object.entries(LIGHT_BASE)) {
    const o = { type: b.type };
    if (b.type === "rect") { o.w = b.w; o.h = b.h; o.barn = b.barn || 0; }
    else { o.radius = b.radius; o.soft = b.soft != null ? b.soft : null; }
    o.roll = b.roll || 0;
    o.cone = b.cone != null ? b.cone : null;   // documentation / diagram only — never written to T3D
    o.temp = b.temp;                           // documentation / diagram only — never written to T3D
    o.label = b.label;                         // diagram label
    o.color = b.color;                         // diagram color (role)
    lights[name] = o;
  }

  const views = {};
  for (const [key, v] of Object.entries(VIEWS)) {
    views[key] = {
      label: v.label,
      desc: v.desc,
      sofa_yaw: v.rot || 0,
      lights: Object.fromEntries(Object.entries(v.lights).map(([n, l]) => [n, {
        pos: l.pos, I: l.I, pitch: l.pitch, yaw: l.yaw,
      }])),
    };
  }

  const presets = Object.entries(BUILTIN).map(([name, p]) => ({
    name,
    sku: skuOf(name, p.r),
    W: p.W, D: p.D, H: p.H,
    render_prefix: p.r || null,
    arm: presetArmSide(p, name) || null,
    tq_view: armRequiredView(presetArmSide(p, name)) || null,
  }));

  return {
    schema_version: "1.0",
    generated_from: "RH_Local_Renders/light-rig-reference.html (run handoff/export_from_index.cjs to refresh)",
    units: "centimetres; 1 cm = 1 Unreal unit. Angles in degrees.",
    axes: { X: "sofa width", Y: "sofa depth (+Y = front / camera side)", Z: "height (0 = floor)" },
    reference: { W: REF_DEFAULT.W, D: REF_DEFAULT.D, H: REF_DEFAULT.H },
    template_file: "rig_template.t3d",
    float_format: {
      decimals: 6,
      rounding: "round-half-away-from-zero on the exact binary value (JS Number.prototype.toFixed(6))",
      negative_zero: "normalise -0 to 0 before formatting",
    },
    modes: {
      A: "sizes x k, intensity x k^2 (default; strict inverse square)",
      B: "sizes unchanged, intensity x (k^2*d0^2 + R^2)/(d0^2 + R^2)  ~=  intensity x k^p, p = 2*d0^2/(d0^2 + R^2)",
    },
    rig_scale: {
      rule: "the three axis ratios collapse into ONE factor: k = max(1, cbrt(sX * sY * sZ)). Every light gets the same k, positions are p * k, and pitch/yaw/roll are never recomputed.",
      clamp: "k is clamped at 1 - the rig is only ever pushed OUT, never pulled in. A sofa that fits inside the tuned rig is emitted with the rig exactly as built (k = 1). Measured over the 15-preset catalogue that beats scaling down: exposure spread 1.21x static vs 1.26x scaled, and evenness improves the smaller the sofa gets. Above the reference the picture inverts (evenness 1.32x worse at 1.2 scale, 3.47x at 1.5), which is what the clamp lets through.",
      why: [
        "a per-axis stretch gave each light its own k (0.69 to 1.30 on a real sectional), which pulls the balance between the five sources apart",
        "a per-axis stretch also forces pitch/yaw corrections of up to 21 deg, which is what flattened the render",
        "k is invariant to swapping W and D, because sX*sY = W*D/(refW*refD) either way - a mesh authored rotated 90 deg produces the same rig",
      ],
      rotations: "pitch, yaw and roll are passed through verbatim from the shot rig; computeAll still returns sourcePitch / sourceYaw, now always equal to pitch / yaw",
      legacy_swap: "the `swap` argument of computeAll is accepted for API compatibility and has no effect",
    },
    light_order: Object.keys(LIGHT_BASE),
    lights,
    views,
    t3d_fields: {
      rewritten_always: ["RelativeLocation", "RelativeRotation (Pitch/Yaw from `aim`, Roll unchanged)", "Intensity"],
      rewritten_rect: ["SourceWidth", "SourceHeight", "BarnDoorLength"],
      rewritten_spot: ["SourceRadius", "SoftSourceRadius (only when soft != null)"],
      rewritten_optional: [],
      never_touched: [
        "AttenuationRadius (no effect in the path tracer - the template value is passed through)",
        "Temperature", "bUseTemperature", "IntensityUnits", "BarnDoorAngle",
        "InnerConeAngle", "OuterConeAngle", "LightingChannels", "CastRaytracedShadow",
        "SamplesPerPixel", "Mobility", "ActorLabel", "FolderPath", "ExportPath",
        "Archetype", "Class", "the actor/object structure itself",
      ],
      match_rule: "per `Begin Actor … End Actor` block, keyed by ActorLabel; first matching `^<indent><Field>=…` line only",
    },
    validation: {
      scale_magnitude: "warn when k < 0.6 or k > 1.6",
      shape_mismatch: "warn when max(sX,sY,sZ)/min(sX,sY,sZ) > 1.5 - a rigid rig follows the sofa's size but not its shape",
      peak_intensity: "warn when max intensity > 250 cd",
    },
    preset_tq_rule: {
      left_arm_regex: "/(^|[\\s_.-])left[\\s_-]*arm($|[\\s_.-])/i  -> TQL  (sofa -36 deg)",
      right_arm_regex: "/(^|[\\s_.-])right[\\s_-]*arm($|[\\s_.-])/i -> TQR  (sofa +36 deg)",
      note: "F and FH apply to every model; an arm-side model gets exactly one of the two TQ shots. The key letter matches the arm side - there is no cross.",
      warning: "Tell the two TQ rigs apart by their numbers, not by a label on an export: TQR is fill I=8, main_key pitch -18 / yaw 28, right_rim yaw 153 / I=0.6; TQL is fill I=6, main_key pitch -25 / yaw 3, right_rim yaw 166.5 / I=1.0. The mapping was briefly inverted on 2026-08-13 after a mislabelled pair of exports and reverted the same day. CONFLICT STILL OPEN: the render pipeline maps Sectional_Indoor_L -> TQR and Sectional_Indoor_R -> TQL, the opposite of this, and its LUGANO batch of 2026-08-12 was therefore shot from the wrong side.",
      unknown_arm: "An empty arm means the model has no arm side (U / symmetric) or it could not be determined. Do NOT default to a side - names like '6_PIECE_L_SECTIONAL' or '..._U_SECTIONAL' describe the SHAPE, not an arm, and component lists carry LEFT_ARM_CHAIR and RIGHT_ARM_CHAIR modules on both ends of almost every assembly. Either carry the side as explicit data or skip the TQ shot.",
    },
    presets,
  };
}

/* Golden cases: the contract a port has to reproduce byte-for-byte.
   Omitting W/D/H means "the rig reference sofa", so re-measuring the reference cannot
   silently turn an identity case into a scaled one. */
const CASES = [
  { id: "identity-F-A",      view: "F",   mode: "A", swap: false },
  { id: "identity-F-B",      view: "F",   mode: "B", swap: false },
  { id: "ref-FH-A",          view: "FH",  mode: "A", swap: false },
  { id: "ref-TQR-A",         view: "TQR", mode: "A", swap: false },
  { id: "ref-TQL-A",         view: "TQL", mode: "A", swap: false },
  { id: "koper39250480-F-A", view: "F",   mode: "A", swap: false, W: 384, D: 305, H: 82 },
  { id: "koper39250480-TQL-A", view: "TQL", mode: "A", swap: false, W: 384, D: 305, H: 82 },
  { id: "borgo39250511-TQR-B", view: "TQR", mode: "B", swap: false, W: 381, D: 310, H: 80 },
  { id: "borgo39250513-FH-B",  view: "FH",  mode: "B", swap: false, W: 453, D: 280, H: 80 },
  { id: "masson39250419-F-A-swap", view: "F", mode: "A", swap: true, W: 312, D: 246, H: 77 },
  { id: "big-F-A",           view: "F",   mode: "A", swap: false, W: 600, D: 300, H: 80 },
  { id: "xl-TQL-B",          view: "TQL", mode: "B", swap: false, W: 600, D: 340, H: 95 },
  { id: "clamped-F-A",       view: "F",   mode: "A", swap: false, W: 312, D: 246, H: 77 },
  { id: "small-TQR-A",       view: "TQR", mode: "A", swap: false, W: 200, D: 150, H: 60 },
  { id: "custom-ref-F-A",    view: "F",   mode: "A", swap: false, W: 453, D: 279, H: 79, ref: { W: 400, D: 250, H: 75 } },
];

function buildVectors({ L }) {
  const { REF_DEFAULT, TEMPLATE, computeAll, generateT3D, fmt } = L;

  const cases = CASES.map(c => {
    const ref = c.ref || REF_DEFAULT;
    const W = c.W != null ? c.W : ref.W, D = c.D != null ? c.D : ref.D, H = c.H != null ? c.H : ref.H;
    const res = computeAll(W, D, H, c.mode, c.swap, ref, c.view);
    const t3d = generateT3D(res);

    const lights = {};
    for (const [name, r] of Object.entries(res)) {
      const o = {
        location: r.pos.map(fmt),
        rotation: [fmt(r.pitch), fmt(r.yaw), fmt(r.roll)],                  // what the T3D gets
        source_rotation: [fmt(r.sourcePitch), fmt(r.sourceYaw), fmt(r.roll)], // always equal to `rotation` now
        intensity: fmt(r.intensity),
        k: r.k.toFixed(9),
      };
      if (r.type === "rect") { o.source_width = fmt(r.w); o.source_height = fmt(r.h); o.barn_door_length = fmt(r.barn); }
      else { o.source_radius = fmt(r.radius); if (r.soft != null) o.soft_source_radius = fmt(r.soft); }
      lights[name] = o;
    }

    return {
      id: c.id, view: c.view, mode: c.mode, swap: c.swap,
      input: { W, D, H },
      ref: { W: ref.W, D: ref.D, H: ref.H },
      t3d_sha256: sha256(t3d),
      lights,
    };
  });

  return {
    schema_version: "1.0",
    generated_from: "RH_Local_Renders/light-rig-reference.html (run handoff/export_from_index.cjs to refresh)",
    note: [
      "Every value is the string that must appear in the generated T3D (6 decimals).",
      "t3d_sha256 = SHA-256 of the full T3D text, LF line endings, no trailing newline.",
      "rotation = [Pitch, Yaw, Roll] as written; source_rotation = the same before aim scaling.",
      "k is informational (distance ratio, 9 decimals).",
    ],
    template_sha256: sha256(TEMPLATE),
    cases,
  };
}

function build() {
  const ctx = loadLogic();
  return {
    "light_rig.json": JSON.stringify(buildConstants(ctx), null, 2) + "\n",
    "acceptance_vectors.json": JSON.stringify(buildVectors(ctx), null, 2) + "\n",
    "rig_template.t3d": ctx.L.TEMPLATE,   // exact bytes, LF, no trailing newline
  };
}

/* --check compares against what is on disk (newline-insensitive: git may check out CRLF). */
function check() {
  const want = build();
  const problems = [];
  for (const [file, text] of Object.entries(want)) {
    const p = path.join(__dirname, file);
    if (!fs.existsSync(p)) { problems.push(`${file}: missing`); continue; }
    const have = fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
    if (have !== text.replace(/\r\n/g, "\n")) problems.push(`${file}: stale — re-run node handoff/export_from_index.cjs`);
  }
  return problems;
}

function write() {
  const out = build();
  for (const [file, text] of Object.entries(out)) {
    fs.writeFileSync(path.join(__dirname, file), text);
    console.log(`wrote handoff/${file}  (${text.length} bytes)`);
  }
}

if (require.main === module) {
  if (process.argv.includes("--check")) {
    const problems = check();
    if (problems.length) { console.error(problems.map(p => `FAIL  ${p}`).join("\n")); process.exit(1); }
    console.log("handoff data files are in sync with light-rig-reference.html");
  } else {
    write();
  }
}

module.exports = { build, check, loadLogic, CASES };
