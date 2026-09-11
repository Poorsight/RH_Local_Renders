"use strict";

// Only image/color/resolution chunks belong in a client PNG. Drop all text,
// EXIF, XMP, timestamps and unknown ancillary chunks, without decoding IDAT.
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const KEEP = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS", "cHRM", "gAMA", "iCCP", "sBIT", "sRGB", "bKGD", "hIST", "pHYs", "sPLT", "cICP", "mDCV", "cLLI"]);

function sanitizePng(source) {
  if (!source.subarray(0, 8).equals(SIGNATURE)) throw new Error("Invalid PNG signature");
  const kept = [source.subarray(0, 8)], removed = [];
  let offset = 8, ended = false;
  while (offset + 12 <= source.length) {
    const length = source.readUInt32BE(offset), end = offset + length + 12;
    if (end > source.length) throw new Error("Truncated PNG chunk");
    const type = source.toString("ascii", offset + 4, offset + 8);
    if (!KEEP.has(type) && /^[A-Z]/.test(type)) throw new Error(`Unsupported critical PNG chunk: ${type}`);
    const bytes = source.subarray(offset, end);
    if (KEEP.has(type)) kept.push(bytes); else removed.push({ offset, type, bytes });
    offset = end;
    if (type === "IEND") { ended = true; break; }
  }
  if (!ended) throw new Error("PNG has no IEND chunk");
  if (offset < source.length) removed.push({ offset, type: "trailing", bytes: source.subarray(offset) });
  return { buffer: removed.length ? Buffer.concat(kept) : source, removed };
}

module.exports = { sanitizePng };
