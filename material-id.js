"use strict";

// UI labels only. Jobs must continue addressing the unmodified source mesh IDs.
function materialPartName(id) {
  const source = String(id || "").trim();
  const tokens = source.replace(/\.\d{3}$/, "").split(/[:_]/).filter(Boolean);
  while (tokens.length > 1 && /^\d+$/.test(tokens.at(-1))) tokens.pop();
  const last = tokens.at(-1) || source;
  const word = last.replace(/\d/g, "") || last;
  // Some FBX exports duplicate the part prefix and append a full product name:
  // UPH_UPH_LUGANO_MODULAR_ARMLESS_CHAIR_LUXE_10007333_002.
  // Only trust a repeated prefix, not any UPH/Feet word inside a product name.
  const first = tokens[0]?.replace(/\d/g, "");
  const second = tokens[1]?.replace(/\d/g, "");
  return /[_.]\d+$/.test(source) && first && second && first.toLowerCase() === second.toLowerCase() ? first : word;
}

if (typeof module !== "undefined" && module.exports) module.exports = { materialPartName };
