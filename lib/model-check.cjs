"use strict";

const path = require("path");

// What a piece of upholstery may plausibly measure, in centimetres. Anything outside this
// is a unit mistake rather than an unusual product: a three metre tall sofa does not exist,
// and neither does a six centimetre one.
const SIZE_LIMITS = { width: [40, 700], depth: [40, 400], height: [30, 160] };

// Parts the render needs to be able to address. Extra parts are fine — a model may carry
// glides or a slipcover — but a missing one means a material has nowhere to go.
const REQUIRED_PARTS = {
  sectionals: ["uph", "stitches", "feet"],
  sofas: ["uph", "feet"],
  default: ["uph", "feet"]
};

// The inspector measures how many metres a raw unit is worth. What Unreal needs on top of
// that depends on the format, and a render settled it: an OBJ at the measured factor came out
// 22 pixels wide, and at a hundred times that it filled the frame.
//
// Unreal's FBX importer reads the unit header and normalises the model itself, so the factor
// passes through — a tracked inch export carries 2.54 and renders correctly, which is also
// what the farm sends. Its OBJ importer has no header to read and treats the numbers as
// centimetres, so a millimetre model has to be told.
const METRES_TO_CENTIMETRES = 100;

const partKey = value => String(value || "").trim().toLowerCase().replace(/\d+$/, "");

function productType(model) {
  const group = String(model.group || "").toLowerCase();
  if (group) return group;
  return /sectional/i.test(model.name || "") ? "sectionals" : "default";
}

// One place decides the factor a job carries, so a model of any scale is handled by measuring
// it rather than by assuming what its exporter did.
function unrealScaleFor(record, format) {
  const factor = Number(record.scale);
  if (!Number.isFinite(factor) || factor <= 0) return null;
  if (String(format || "").toLowerCase() !== "obj") return factor;
  return Number((factor * METRES_TO_CENTIMETRES).toPrecision(6));
}

function checkModel(model, record) {
  const findings = [];
  const add = (level, code, label, detail) => findings.push({ level, code, label, detail });
  const type = productType(model);
  const format = String(model.format || path.extname(model.path || "").slice(1)).toLowerCase();

  // 1. Geometry arrived at all.
  const meshes = Number(record.meshObjects || 0);
  if (!meshes) add("error", "no-meshes", "No meshes", "The importer found no mesh objects, so nothing can be rendered.");

  // 2. Size, which is really a unit check.
  // Dimensions arrive as a measured triple from the inspector and as a named object once
  // a model is tracked, and a check has to read both.
  const raw = record.dimensions || {};
  const named = Array.isArray(raw)
    ? { width: Number(raw[0]), depth: Number(raw[1]), height: Number(raw[2]) }
    : { width: Number(raw.width), depth: Number(raw.depth), height: Number(raw.height) };
  const { width, depth, height } = named;
  const offenders = Object.entries(SIZE_LIMITS)
    .filter(([axis, [low, high]]) => Number.isFinite(named[axis]) && (named[axis] < low || named[axis] > high))
    .map(([axis, [low, high]]) => `${axis} ${named[axis]} cm is outside ${low}–${high}`);
  if (offenders.length) {
    add("error", "implausible-size", "Size looks wrong",
      `${offenders.join("; ")}. Read as ${record.analysis?.unit || "unknown units"} — most likely the units were guessed wrong.`);
  } else if (Number.isFinite(width)) {
    add("ok", "size", "Size", `${width} × ${depth} × ${height} cm, read as ${record.analysis?.unit || "unknown units"}.`);
  }

  // 3. The scale the job will hand to Unreal, which is not the one Blender measured with.
  const scale = unrealScaleFor(record, format);
  if (scale === null) {
    add("error", "no-scale", "No scale", "The inspector produced no unit factor, so the model would import at raw size.");
  } else {
    const converted = format === "obj" ? ` (measured ${record.scale} to metres, ${METRES_TO_CENTIMETRES}× for an OBJ)` : "";
    add("ok", "scale", "Scale", `${record.analysis?.unit || "units"} measured; job sends offsetUniformScale ${scale}${converted}.`);
  }

  // 4. Parts, matched loosely: a trailing digit is an export artefact, not a different part.
  const present = new Set((record.materialIds || []).map(partKey));
  const required = REQUIRED_PARTS[type] || REQUIRED_PARTS.default;
  const missing = required.filter(part => !present.has(part));
  if (missing.length) {
    // An OBJ that names its parts only as face groups reads as having none, and that is
    // repairable in place; a model that genuinely lacks a part is not.
    const repairable = format === "obj";
    findings.push({
      level: "error", code: "missing-parts", label: "Missing parts", repairable,
      detail: `${missing.join(", ")} not found among ${[...present].join(", ") || "no named parts"}. A material assigned to a missing part renders nothing.` +
        (repairable ? " An OBJ can often be repaired: its parts may be face groups the importer does not read." : "")
    });
  } else {
    add("ok", "parts", "Parts", `${[...present].join(", ")}.`);
  }
  if (present.size && [...present].some(part => !required.includes(part))) {
    const extra = [...present].filter(part => !required.includes(part));
    add("info", "extra-parts", "Extra parts", `${extra.join(", ")} — assign a material or they render with the importer default.`);
  }

  // 5. Orientation. A camera angle here is the model actor being turned, not the camera
  //    moving, so this yaw lands on the actor. Exports from this library point the backrest
  //    at different axes, and each axis needs a particular correction — so the check is
  //    whether the applied yaw matches the axis that was measured, not whether one exists.
  const yaw = Number(record.yaw || 0), back = record.analysis?.detectedBack || "";
  const expected = { "+Y": 0, "-X": 90, "-Y": 180, "+X": -90 }[back];
  if (!back) {
    add("info", "orientation", "Orientation",
      `Import yaw ${yaw > 0 ? "+" : ""}${yaw} from tracked metadata; the backrest axis was not re-measured.`);
  } else if (expected === undefined) {
    add("warning", "orientation", "Orientation", `Backrest measured at ${back}, which is not an axis this pipeline knows how to correct.`);
  } else if (yaw !== expected) {
    add("error", "orientation", "Orientation",
      `Backrest at ${back} needs import yaw ${expected > 0 ? "+" : ""}${expected}, but the model carries ${yaw > 0 ? "+" : ""}${yaw}. The render would face the wrong way.`);
  } else {
    add("ok", "orientation", "Orientation", `Backrest at ${back} with the matching import yaw ${yaw > 0 ? "+" : ""}${yaw}.`);
  }

  return findings;
}

function summarise(findings) {
  return {
    errors: findings.filter(item => item.level === "error").length,
    warnings: findings.filter(item => item.level === "warning").length,
    ok: findings.filter(item => item.level === "ok").length
  };
}

module.exports = { SIZE_LIMITS, REQUIRED_PARTS, METRES_TO_CENTIMETRES, partKey, productType, unrealScaleFor, checkModel, summarise };
