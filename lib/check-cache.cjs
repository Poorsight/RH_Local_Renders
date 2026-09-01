"use strict";

const fs = require("fs");
const path = require("path");

// Bump this whenever check semantics change. A verdict is only reusable when both the
// source file and the checker that produced it are unchanged.
const CHECK_VERSION = 2;

/*
  Checking a model that has never been seen runs Blender, so a verdict is worth keeping.
  It is keyed on the file's own identity -- size and modification time -- rather than on
  its name, because the interesting case is a file being replaced under a name that stays
  the same. A replaced file gets a new mtime and usually a new size, so its stored verdict
  stops matching and it is checked again.

  Keyed by path, not by name: two folders may hold a model of the same name, and it is the
  file that was checked.
*/

const cacheFile = root => process.env.RH_CHECK_CACHE_FILE || path.join(root, "local", "cache", "model-checks.json");
const keyFor = file => path.resolve(String(file || "")).toLowerCase();

// Size and mtime together. Either alone is too easy to collide with: a re-export can keep
// the size, and a copy can keep the mtime.
function fingerprint(file) {
  try {
    const info = fs.statSync(file);
    return `${CHECK_VERSION}:${info.size}:${Math.round(info.mtimeMs)}`;
  } catch { return null; }
}

function read(root) {
  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFile(root), "utf8"));
    return parsed && typeof parsed.entries === "object" && parsed.entries ? parsed.entries : {};
  } catch { return {}; }
}

function write(root, entries) {
  const file = cacheFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ entries }, null, 2)}\n`, "utf8");
}

// The stored verdict for a file, or null when there is none or the file has moved on.
function lookup(entries, file) {
  const entry = entries[keyFor(file)];
  if (!entry?.row) return null;
  const current = fingerprint(file);
  if (!current || current !== entry.fingerprint) return null;
  return { ...entry.row, checkedAt: entry.checkedAt, fromCache: true };
}

function remember(entries, file, row, when) {
  const current = fingerprint(file);
  if (!current) return entries;
  const { fromCache, checkedAt, ...clean } = row || {};
  entries[keyFor(file)] = { fingerprint: current, checkedAt: when || new Date().toISOString(), row: clean };
  return entries;
}

// A verdict for a file that is gone is dead weight, and a cache that only grows will
// eventually be read on every check.
function prune(entries) {
  let dropped = 0;
  for (const key of Object.keys(entries)) {
    if (!entries[key]?.row || !fs.existsSync(key)) { delete entries[key]; dropped += 1; }
  }
  return dropped;
}

module.exports = { CHECK_VERSION, cacheFile, keyFor, fingerprint, read, write, lookup, remember, prune };
