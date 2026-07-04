// Generates Renders/manifest.json — the file list the render board reads
// (see "Server render previews" in ONBOARDING.md). Run it against the Renders
// folder that gets deployed next to index.html, then upload the manifest with it.
//
//   node scripts/gen-render-manifest.cjs [path/to/Renders]     (default: ./Renders)
//   npm run gen:manifest -- path/to/Renders
//
// Output: <renders-dir>/manifest.json = { generated, files:["<material>/<file>.png", …] }
// Paths are relative to the Renders dir, always with forward slashes.

const fs = require("fs");
const path = require("path");

const root = path.resolve(process.argv[2] || "Renders");
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  console.error(`Not a directory: ${root}`);
  process.exit(1);
}

const files = [];
(function walk(dir, rel) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(path.join(dir, e.name), r);
    else if (/\.png$/i.test(e.name)) files.push(r);
  }
})(root, "");
files.sort();

const manifest = { generated: new Date().toISOString(), files };
fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify(manifest, null, 1) + "\n");
console.log(`manifest.json: ${files.length} file(s) in ${root}`);
