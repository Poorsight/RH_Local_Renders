"use strict";

// No image re-encoding. Run without --apply for an inventory. Removed chunks are
// backed up outside the delivery tree; their original offsets allow restoration.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { sanitizePng } = require("../lib/png-privacy.cjs");
const root = path.resolve(__dirname, "..", "local", "renders");
const apply = process.argv.includes("--apply");
const backup = path.resolve(__dirname, "..", "local", "privacy-backups", new Date().toISOString().replace(/[:.]/g, "-"));
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const report = { scanned: 0, changed: 0, removedBytes: 0, verified: 0, types: {}, apply };
function walk(folder) {
  let entries;
  try { entries = fs.readdirSync(folder, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) { walk(file); continue; }
    const relative = path.relative(root, file);
    if (!entry.isFile() || !/\.png$/i.test(entry.name) ||
      !relative.split(path.sep).some(part => /^(POST|_READY_TO_UPLOAD)$/i.test(part)) && !/_POST\.png$/i.test(entry.name)) continue;
    const original = fs.readFileSync(file), result = sanitizePng(original);
    report.scanned++;
    if (!result.removed.length) continue;
    report.changed++;
    for (const chunk of result.removed) { report.removedBytes += chunk.bytes.length; report.types[chunk.type] = (report.types[chunk.type] || 0) + 1; }
    if (!apply) continue;
    const stat = fs.statSync(file), backupFile = path.join(backup, `${relative}.json`);
    fs.mkdirSync(path.dirname(backupFile), { recursive: true });
    fs.writeFileSync(backupFile, JSON.stringify({ file: relative, originalHash: hash(original), cleanHash: hash(result.buffer), chunks: result.removed.map(chunk => ({ offset: chunk.offset, type: chunk.type, base64: chunk.bytes.toString("base64") })) }), { flag: "wx" });
    // Atomic replacement after recording recovery data, leaving no private copy in POST.
    const temporary = `${file}.privacy-${process.pid}.tmp`;
    fs.writeFileSync(temporary, result.buffer, { flag: "wx" });
    if (!fs.readFileSync(temporary).equals(result.buffer)) throw new Error("Verification failed");
    fs.renameSync(temporary, file);
    fs.utimesSync(file, stat.atime, stat.mtime);
    const clean = fs.readFileSync(file);
    if (!clean.equals(result.buffer) || sanitizePng(clean).removed.length) throw new Error("Sanitation verification failed");
    // Reassemble the exact original bytes to verify both the backup and retained
    // image/color/DPI bytes. This is stronger than a decoded-pixel comparison.
    let cursor = 0, removedLength = 0;
    const pieces = [];
    for (const chunk of result.removed) {
      const insert = chunk.offset - removedLength;
      pieces.push(clean.subarray(cursor, insert), chunk.bytes);
      cursor = insert; removedLength += chunk.bytes.length;
    }
    pieces.push(clean.subarray(cursor));
    if (!Buffer.concat(pieces).equals(original)) throw new Error("Lossless restoration verification failed");
    report.verified++;
    if (report.verified % 50 === 0) console.log(JSON.stringify({ verified: report.verified }));
  }
}
walk(root);
if (apply && report.changed) {
  fs.writeFileSync(path.join(backup, "summary.json"), JSON.stringify(report, null, 2));
  report.backup = backup;
}
console.log(JSON.stringify(report, null, 2));
