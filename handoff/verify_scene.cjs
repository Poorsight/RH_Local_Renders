// Check a light rig exported from the UE scene against this package.
//
//   node handoff/verify_scene.cjs                     # check the bundled handoff/ue_reference/*.t3d
//   node handoff/verify_scene.cjs my_export.t3d       # check one export, shot auto-detected
//   node handoff/verify_scene.cjs --view TQR a.t3d    # force the shot instead of detecting it
//   node handoff/verify_scene.cjs -                   # read the export from stdin
//
// How to produce the input: in the UE viewport select the five lights of one shot and press
// Ctrl+C, then paste into a .t3d file. That text is what this script reads.
//
// What it proves: for that shot, generating at the reference sofa (453 x 274 x 77) reproduces
// every property of the scene rig. This is the direction the package could not be checked in
// before — light_rig.json is generated *from* the tool, so it can never disagree with it; only
// the scene can say whether the tool is right.
//
// Asset paths, `Begin Actor`/`Begin Object` headers and actor ordering are NOT compared: the
// tool ships a neutralised copy of the skeleton and always emits the template's order. Every
// property line inside the actors is compared, including the ones the tool never rewrites
// (Temperature, cone angles, SamplesPerPixel, …) — those would silently drift otherwise.

const fs = require("fs");
const path = require("path");

const VIEWS = ["F", "FH", "TQR", "TQL"];
const REF_DIR = path.join(__dirname, "ue_reference");

/* The rig core: the generated library when this runs inside the standalone handoff
   package, otherwise the logic lifted straight out of index.html in the source repo. */
function loadRig() {
  for (const p of ["../lib/light-rig.global.js", "./light-rig.global.js"]) {
    try { return require(p); } catch (e) { /* not the package layout */ }
  }
  return require("./export_from_index.cjs").loadLogic().L;
}

/* T3D -> { actorLabel: { field: value } }.
   Only property lines (`  Field=value`) are read; `Begin …` / `End …` lines, and with them
   every asset path, are skipped. Location/rotation are expanded into scalar components so a
   diff points at the exact number. First occurrence wins, matching generateT3D's rewrite rule. */
function parseT3D(text) {
  const actors = {};
  for (const block of text.replace(/\r\n/g, "\n").match(/Begin Actor[\s\S]*?End Actor/g) || []) {
    const label = (block.match(/ActorLabel="([^"]+)"/) || [])[1];
    if (!label) continue;
    const fields = {};
    const put = (k, v) => { if (!(k in fields)) fields[k] = v; };
    for (const line of block.split("\n")) {
      const m = line.match(/^\s*([A-Za-z][A-Za-z0-9_]*)=(.*)$/);
      if (!m) continue;
      const [, key, raw] = m;
      const vec = raw.match(/^\((?:X|Pitch)=[^)]*\)$/) ? raw.slice(1, -1).split(",") : null;
      if (vec) for (const part of vec) {
        const [k2, v2] = part.split("=");
        put(`${key}.${k2}`, v2);
      } else put(key, raw);
    }
    actors[label] = fields;
  }
  return actors;
}

/* Numbers compare numerically (so -0.000000 == 0.000000); everything else as text. */
const same = (a, b) => {
  if (a === b) return true;
  const x = Number(a), y = Number(b);
  return Number.isFinite(x) && Number.isFinite(y) && x === y;
};

function diffAgainstView(sceneActors, view, RIG) {
  const ref = RIG.REF_DEFAULT;
  const generated = parseT3D(RIG.generateT3D(RIG.computeAll(ref.W, ref.D, ref.H, "A", false, ref, view)));
  const diffs = [];
  let compared = 0;

  for (const label of Object.keys(generated)) {
    if (!sceneActors[label]) { diffs.push({ label, field: "(actor)", scene: "missing", tool: "present" }); continue; }
  }
  for (const [label, sceneFields] of Object.entries(sceneActors)) {
    const toolFields = generated[label];
    if (!toolFields) { diffs.push({ label, field: "(actor)", scene: "present", tool: "missing" }); continue; }
    for (const [field, sceneVal] of Object.entries(sceneFields)) {
      const toolVal = toolFields[field];
      compared++;
      if (toolVal === undefined) diffs.push({ label, field, scene: sceneVal, tool: "absent" });
      else if (!same(sceneVal, toolVal)) diffs.push({ label, field, scene: sceneVal, tool: toolVal });
    }
    for (const field of Object.keys(toolFields))
      if (!(field in sceneFields)) diffs.push({ label, field, scene: "absent", tool: toolFields[field] });
  }
  return { view, diffs, compared, actors: Object.keys(sceneActors).length };
}

/* With no --view, try all four shots and keep the closest one. An exact hit is unambiguous:
   the four rigs differ in intensities and positions, so only the right shot scores zero. */
function checkExport(text, forcedView, RIG) {
  const scene = parseT3D(text);
  if (!Object.keys(scene).length) return { error: "no `Begin Actor … End Actor` blocks with an ActorLabel" };
  const candidates = (forcedView ? [forcedView] : VIEWS).map(v => diffAgainstView(scene, v, RIG));
  candidates.sort((a, b) => a.diffs.length - b.diffs.length);
  return { ...candidates[0], detected: !forcedView };
}

function report(name, res) {
  console.log(name);
  if (res.error) { console.log("  ERROR  " + res.error); return false; }
  const ok = res.diffs.length === 0;
  const how = res.detected ? (ok ? "detected" : "closest") : "forced";
  console.log(`  shot ${res.view} (${how}) — ${res.actors} actors, ${res.compared} properties compared`);
  if (ok) { console.log("  MATCH — the package reproduces this shot exactly"); return true; }
  console.log(`  ${res.diffs.length} DIFFERENCE(S):`);
  for (const d of res.diffs)
    console.log(`    ${d.label.padEnd(17)} ${d.field.padEnd(24)} scene=${d.scene}  package=${d.tool}`);
  return false;
}

function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(fs.readFileSync(__filename, "utf8").split("\n").slice(0, 15).join("\n").replace(/^\/\/ ?/gm, ""));
    return 0;
  }
  const vi = argv.indexOf("--view");
  let forcedView = null;
  if (vi !== -1) {
    forcedView = String(argv[vi + 1] || "").toUpperCase();
    if (!VIEWS.includes(forcedView)) { console.error(`--view must be one of ${VIEWS.join(", ")}`); return 2; }
    argv.splice(vi, 2);
  }

  const RIG = loadRig();
  const files = argv.filter(a => !a.startsWith("--"));
  let allOk = true;

  if (files.length === 1 && files[0] === "-") {
    const text = fs.readFileSync(0, "utf8");
    allOk = report("(stdin)", checkExport(text, forcedView, RIG));
  } else {
    const list = files.length ? files
      : VIEWS.map(v => path.join(REF_DIR, `${v}.t3d`)).filter(fs.existsSync);
    if (!list.length) { console.error("nothing to check — pass a .t3d file, or keep the exports in handoff/ue_reference/"); return 2; }
    for (const f of list) {
      const rel = path.relative(process.cwd(), f) || f;
      if (!report(rel, checkExport(fs.readFileSync(f, "utf8"), forcedView, RIG))) allOk = false;
      console.log("");
    }
  }
  console.log(allOk ? "OK — scene and package agree." : "FAILED — see the differences above.");
  return allOk ? 0 : 1;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { parseT3D, checkExport, VIEWS, REF_DIR, loadRig };
