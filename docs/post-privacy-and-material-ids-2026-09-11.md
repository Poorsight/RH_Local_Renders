# POST privacy and exported mesh IDs — 2026-09-11

## Scope

Controller branch `codex/current-project`. No Unreal project, plugin, FBX geometry,
lighting, crop, material assets, shadow formula or color conversion changes.
No remote deployment or push.

## Client PNG privacy

- New POST PNGs no longer receive the embedded render passport.
- A chunk allowlist removes inherited text (tEXt/zTXt/iTXt), EXIF, XMP,
  timestamps, unknown ancillary data and trailing bytes.
- IDAT, alpha representation, image dimensions, ICC/color-management chunks
  and pHYs/DPI remain byte-identical during sanitation. No image re-encoding.
- The same policy applies when publishing legacy processed images and when an
  existing up-to-date processed image is reused.
- Runtime source tracking includes the new privacy module.

Migration: `node scripts/clean-post-metadata.cjs --apply`. Without `--apply`,
the command only inventories delivery PNGs under `local/renders` (POST,
_READY_TO_UPLOAD, and legacy *_POST.png). RAW originals are excluded.

All 1,147 existing delivery PNGs were cleaned. Removed metadata totaled
2,681,584 bytes: 1,147 eXIf chunks and 27,318 tEXt chunks. A second inventory
found zero remaining removable chunks. All 1,147 clean-file SHA-256 hashes
and reconstructed-original SHA-256 hashes were verified against the recovery
records. The image/color/DPI chunks are unchanged.

Recovery records: `local/privacy-backups/2026-09-11T01-08-02-049Z/`.
These contain private metadata and must NOT be delivered. Each JSON records
original/clean hashes and removed chunks with offsets, allowing the original
PNG to be reconstructed by inserting those bytes back at their original offsets.
The migration finished cleaning the files, then encountered an ephemeral test
directory removed by the parallel test suite. Independent verification confirmed
all 1,147 files; the walker now tolerates a disappeared directory.

This is a delivery-file privacy policy, not a client-safe version of the web UI.
Internal jobs, logs, model paths and RAW files remain local operational data.

## Numeric component groups

The two Lugano FBXs contain mesh IDs including `UPH_UPH_003`, `Feet_Feet_001`
and `UPH_UPH_LUGANO_MODULAR_ARMLESS_CHAIR_LUXE_10007333_002`.
The inspector only collects MESH objects with vertices; these are not simply
empty transform/dummy nodes. The old UI grouped by the last underscore token,
turning those IDs into material groups `001`, `002`, etc.

`material-id.js` now supplies one shared grouping rule to the UI, job filename
generator, delivery material selector and model checker: ignore trailing numeric duplicate tokens; recognize repeated part
prefixes on numbered exports; otherwise keep the final part word. A genuinely
numeric-only mesh ID stays numeric. Unknown parts are not discarded.

Confirmed in the live browser with both Lugano models:

| Group | Unique source IDs | Models |
| --- | ---: | ---: |
| UPH | 7 | 2 |
| Stitches | 6 | 1 |
| Feet | 7 | 2 |
| Blocker | 1 | 1 |

The jobs retain the exact source component IDs (existing lowercase transport
convention), filtered per model. No mesh is renamed or deleted. Other new-model
parts such as Base, Buttons, Glides and Plastic remain separate.

An in-memory batch built from all 16 newly inspected models retained all 97
per-model source assignments. No job was saved and no Unreal render was launched.
A regression test also covers a model with only numbered UPH IDs (no plain UPH),
which previously failed the Fabric filename generator.

The model-check cache version was incremented. Static deployment manifests
include the shared JS file for future deployment; deployment was not run.

Browser QA: 1440×900 desktop and 390×844 mobile; grouping, retained source IDs,
adding a material variant, and console logs checked. No console warnings/errors;
no horizontal document overflow on mobile. The user's existing setup tab was
not reloaded or edited.

Final verification: `npm test` — 91 passed, 0 failed, 0 skipped;
`npm run build` and `git diff --check` passed. The local service was restarted
only while idle and confirmed `runtime.stale: false` with the updated sources.
