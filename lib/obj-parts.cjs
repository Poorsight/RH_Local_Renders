"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");

// The sofa library ships OBJ files whose parts are only marked with face groups:
//
//   g Feet
//   usemtl initialShadingGroup
//   ...
//   g default            <- resets the grouping in the middle of the part
//   ...
//   g UPH
//   usemtl initialShadingGroup
//
// Unreal splits an imported OBJ by object and by material, not by face group, and every
// part here shares one shading group — so the whole model arrives as a single mesh and
// there is nothing to assign a material to. The parts are named, they just are not named
// where an importer looks.
//
// Normalising means three things: name each part as an object, give it its own material so
// a material-splitting importer sees a boundary too, and drop the "default" groups that
// carry no identity and only interrupt a part.

const PLACEHOLDER_GROUPS = new Set(["default", "(null)", "none", ""]);

function normalizePartName(value) {
  return String(value || "").trim().replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "");
}

async function normalizeObjParts(sourceFile, targetFile) {
  const input = fs.createReadStream(sourceFile, { encoding: "utf8" });
  const output = fs.createWriteStream(targetFile, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  const parts = [];
  let current = null, droppedGroups = 0, rewrittenMaterials = 0, faces = 0;

  const write = text => {
    if (!output.write(`${text}\n`)) return new Promise(resolve => output.once("drain", resolve));
  };

  for await (const line of lines) {
    const group = /^g\s+(.*)$/.exec(line);
    if (group) {
      const name = normalizePartName(group[1]);
      if (PLACEHOLDER_GROUPS.has(name.toLowerCase())) { droppedGroups++; continue; }
      if (name === current) continue;
      current = name;
      if (!parts.includes(name)) parts.push(name);
      // An object line is what the importer keys a mesh off; the group stays for anything
      // that reads groups, and the material gives a second, independent boundary.
      await write(`o ${name}`);
      await write(`g ${name}`);
      await write(`usemtl ${name}`);
      rewrittenMaterials++;
      continue;
    }
    if (/^usemtl\s+/.test(line)) {
      // The file's own material is a single catch-all; keeping it would merge the parts
      // straight back together.
      if (current) { rewrittenMaterials++; continue; }
      await write(line);
      continue;
    }
    if (/^o\s+/.test(line)) continue; // ours replace them, and duplicates confuse importers
    if (line.startsWith("f ")) faces++;
    await write(line);
  }

  await new Promise((resolve, reject) => { output.end(error => (error ? reject(error) : resolve())); });
  return { parts, droppedGroups, rewrittenMaterials, faces };
}

// Reports what a file looks like without rewriting it, so a model can be checked first.
async function inspectObjParts(sourceFile) {
  const lines = readline.createInterface({ input: fs.createReadStream(sourceFile, { encoding: "utf8" }), crlfDelay: Infinity });
  const groups = new Map(), objects = new Map(), materials = new Map();
  for await (const line of lines) {
    const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);
    let match;
    if ((match = /^g\s+(.*)$/.exec(line))) bump(groups, match[1].trim());
    else if ((match = /^o\s+(.*)$/.exec(line))) bump(objects, match[1].trim());
    else if ((match = /^usemtl\s+(.*)$/.exec(line))) bump(materials, match[1].trim());
  }
  const named = [...groups.keys()].filter(name => !PLACEHOLDER_GROUPS.has(name.toLowerCase()));
  return {
    groups: Object.fromEntries(groups), objects: Object.fromEntries(objects), materials: Object.fromEntries(materials),
    namedParts: named,
    // One material across several named parts is the shape that arrives as a single mesh.
    needsNormalising: named.length > 0 && (objects.size === 0 || materials.size < named.length)
  };
}

function writeMaterialLibrary(objFile, parts) {
  const target = path.join(path.dirname(objFile), `${path.basename(objFile, path.extname(objFile))}.mtl`);
  const body = parts.map(name => `newmtl ${name}\nKd 0.800000 0.800000 0.800000\n`).join("\n");
  fs.writeFileSync(target, `# Written by RH_Local_Renders so each part has a material to bind to.\n\n${body}`, "utf8");
  return target;
}

module.exports = { PLACEHOLDER_GROUPS, normalizePartName, normalizeObjParts, inspectObjParts, writeMaterialLibrary };
