// Regenerate the handoff data files from index.html — the single source of truth.
//
//   node handoff/export_from_index.cjs           # write handoff/{light_rig.json,rig_template.t3d,acceptance_vectors.json}
//   node handoff/export_from_index.cjs --check   # verify the committed files still match index.html (used by `npm test`)
//
// Why: HANDOFF_FORMULA.md + light_rig.py are a port target for whoever automates the rig.
// If LIGHT_BASE / VIEWS / TEMPLATE / BUILTIN change in index.html, re-run this so the
// handoff package (and its golden vectors) cannot silently drift from the tool.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const sha256 = s => crypto.createHash("sha256").update(s, "utf8").digest("hex");

/* Pull the pure logic + the UI-side constants out of index.html. */
function loadLogic() {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("index.html: <script> block not found");

  const tmp = path.join(__dirname, "_lightrig.export.tmp.cjs");
  fs.writeFileSync(tmp, m[1]);
  let L;
  try { L = require(tmp); } finally { fs.unlinkSync(tmp); }

  // BUILTIN lives inside the `document` guard, so it is not exported.
  const bm = m[1].match(/const BUILTIN = (\{[\s\S]*?\n {2}\});/);
  if (!bm) throw new Error("index.html: BUILTIN preset table not found");
  const BUILTIN = new Function("return " + bm[1])();

  // Arm-side gating is exported since 272716e (explicit preset.arm, name parsing as fallback).
  if (typeof L.presetArmSide !== "function" || typeof L.armRequiredView !== "function")
    throw new Error("index.html: presetArmSide / armRequiredView are no longer exported");

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
    o.atten = b.atten != null ? b.atten : null;
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
    generated_from: "light-rig-scaler/index.html (run handoff/export_from_index.cjs to refresh)",
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
    aim: {
      rule: "pitch/yaw are re-derived so each light keeps aiming at the same relative sofa area under non-uniform scaling; roll is never touched",
      steps: [
        "v = (cos(pitch)*cos(yaw), cos(pitch)*sin(yaw), sin(pitch))   # Unreal lights aim along local +X",
        "v' = (v.x*sX, v.y*sY, v.z*sZ)",
        "pitch' = atan2(v'.z, hypot(v'.x, v'.y));  yaw' = atan2(v'.y, v'.x)   # degrees",
      ],
      uniform_shortcut: "if |sX-sY| < 1e-12 and |sY-sZ| < 1e-12, pitch/yaw pass through unchanged (keeps the identity invariant exact)",
      source_fields: "computeAll also returns sourcePitch / sourceYaw = the unscaled shot rotation",
    },
    light_order: Object.keys(LIGHT_BASE),
    lights,
    views,
    t3d_fields: {
      rewritten_always: ["RelativeLocation", "RelativeRotation (Pitch/Yaw from `aim`, Roll unchanged)", "Intensity"],
      rewritten_rect: ["SourceWidth", "SourceHeight", "BarnDoorLength"],
      rewritten_spot: ["SourceRadius", "SoftSourceRadius (only when soft != null)"],
      rewritten_optional: ["AttenuationRadius (only when the light defines atten)"],
      never_touched: [
        "Temperature", "bUseTemperature", "IntensityUnits", "BarnDoorAngle",
        "InnerConeAngle", "OuterConeAngle", "LightingChannels", "CastRaytracedShadow",
        "SamplesPerPixel", "Mobility", "ActorLabel", "FolderPath", "ExportPath",
        "Archetype", "Class", "the actor/object structure itself",
      ],
      match_rule: "per `Begin Actor … End Actor` block, keyed by ActorLabel; first matching `^<indent><Field>=…` line only",
    },
    validation: {
      scale_magnitude: "warn when max(|sX-1|,|sY-1|,|sZ-1|) > 0.5",
      aspect_mismatch: "warn when |(W/D)/(refW/refD) - 1| > 0.25",
      peak_intensity: "warn when max intensity > 250 cd",
    },
    preset_tq_rule: {
      left_arm_regex: "/(^|[\\s_.-])left[\\s_-]*arm($|[\\s_.-])/i  -> TQR  (sofa +30 deg)",
      right_arm_regex: "/(^|[\\s_.-])right[\\s_-]*arm($|[\\s_.-])/i -> TQL  (sofa -60 deg)",
      note: "F and FH apply to every model; an arm-side model gets exactly one of the two TQ shots.",
      warning: "The mapping is CROSSED on purpose: a LEFT-arm sectional is filmed with the rig keyed TQR, a RIGHT-arm one with TQL. The letters in the keys name the rigs, not the arm side. Wired the other way round until 2026-08-13, which produced three-quarter shots from the wrong side; confirmed against the production scene defaults and the render pipeline before flipping. Read tq_view, never the key's letter.",
      unknown_arm: "An empty arm means the model has no arm side (U / symmetric) or it could not be determined. Do NOT default to a side - names like '6_PIECE_L_SECTIONAL' or '..._U_SECTIONAL' describe the SHAPE, not an arm, and component lists carry LEFT_ARM_CHAIR and RIGHT_ARM_CHAIR modules on both ends of almost every assembly. Either carry the side as explicit data or skip the TQ shot.",
    },
    presets,
  };
}

/* Golden cases: the contract a port has to reproduce byte-for-byte. */
const CASES = [
  { id: "identity-F-A",      view: "F",   mode: "A", swap: false, W: 453, D: 274, H: 77 },
  { id: "identity-F-B",      view: "F",   mode: "B", swap: false, W: 453, D: 274, H: 77 },
  { id: "ref-FH-A",          view: "FH",  mode: "A", swap: false, W: 453, D: 274, H: 77 },
  { id: "ref-TQR-A",         view: "TQR", mode: "A", swap: false, W: 453, D: 274, H: 77 },
  { id: "ref-TQL-A",         view: "TQL", mode: "A", swap: false, W: 453, D: 274, H: 77 },
  { id: "koper39250480-F-A", view: "F",   mode: "A", swap: false, W: 384, D: 305, H: 82 },
  { id: "koper39250480-TQL-A", view: "TQL", mode: "A", swap: false, W: 384, D: 305, H: 82 },
  { id: "borgo39250511-TQR-B", view: "TQR", mode: "B", swap: false, W: 381, D: 310, H: 80 },
  { id: "borgo39250513-FH-B",  view: "FH",  mode: "B", swap: false, W: 453, D: 280, H: 80 },
  { id: "masson39250419-F-A-swap", view: "F", mode: "A", swap: true, W: 312, D: 246, H: 77 },
  { id: "big-F-A",           view: "F",   mode: "A", swap: false, W: 600, D: 300, H: 80 },
  { id: "small-TQR-A",       view: "TQR", mode: "A", swap: false, W: 200, D: 150, H: 60 },
  { id: "custom-ref-F-A",    view: "F",   mode: "A", swap: false, W: 453, D: 274, H: 77, ref: { W: 400, D: 250, H: 75 } },
];

function buildVectors({ L }) {
  const { REF_DEFAULT, TEMPLATE, computeAll, generateT3D, fmt } = L;

  const cases = CASES.map(c => {
    const ref = c.ref || REF_DEFAULT;
    const res = computeAll(c.W, c.D, c.H, c.mode, c.swap, ref, c.view);
    const t3d = generateT3D(res);

    const lights = {};
    for (const [name, r] of Object.entries(res)) {
      const o = {
        location: r.pos.map(fmt),
        rotation: [fmt(r.pitch), fmt(r.yaw), fmt(r.roll)],                  // what the T3D gets
        source_rotation: [fmt(r.sourcePitch), fmt(r.sourceYaw), fmt(r.roll)], // before aim scaling
        intensity: fmt(r.intensity),
        k: r.k.toFixed(9),
      };
      if (r.type === "rect") { o.source_width = fmt(r.w); o.source_height = fmt(r.h); o.barn_door_length = fmt(r.barn); }
      else { o.source_radius = fmt(r.radius); if (r.soft != null) o.soft_source_radius = fmt(r.soft); }
      if (r.atten != null) o.attenuation_radius = fmt(r.atten);
      lights[name] = o;
    }

    return {
      id: c.id, view: c.view, mode: c.mode, swap: c.swap,
      input: { W: c.W, D: c.D, H: c.H },
      ref: { W: ref.W, D: ref.D, H: ref.H },
      t3d_sha256: sha256(t3d),
      lights,
    };
  });

  return {
    schema_version: "1.0",
    generated_from: "light-rig-scaler/index.html (run handoff/export_from_index.cjs to refresh)",
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
    console.log("handoff data files are in sync with index.html");
  } else {
    write();
  }
}

module.exports = { build, check, loadLogic, CASES };
