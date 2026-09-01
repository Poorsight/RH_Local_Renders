# RH Substrate Shadow post-process handoff

Prepared: 2026-08-28

## What this package solves

UE 5.6 Substrate + Legacy Composure writes the useful shadow matte into an 8-bit RGB signal while the PNG alpha is empty. The first stage restores a usable RGBA shadow before any preview or crop measurement. The second stage creates the delivery image.

The required order is:

1. Unreal finishes a Shadow PNG.
2. Recover alpha from the hidden RGB signal with `prepareSubstrateShadow`.
3. Only now generate previews and calculate the Fabric + Shadow crop union.
4. Create the final delivery image with `processImage`/`processJob`.

Changing this order recreates the original failure: the crop sees an empty Shadow alpha and ignores the shadow silhouette.

## Exact processing

### Stage A — hidden RGB to RGBA

Implemented in `lib/post-process.cjs`, function `prepareSubstrateShadow`.

- Accepts only Shadow PNG files.
- If meaningful alpha already exists, leaves the file byte-for-byte unchanged. This keeps old non-Substrate renders compatible.
- Otherwise calculates Rec.709 luminance from RGB.
- Every product type uses the camera-specific 256-entry monotonic LUTs from `data/sofa-shadow-lut.json` for `F`, `P`, `TQ`, and `TQB`.
- Cameras without a calibrated LUT, currently `FH`, use the calibrated Levels transform and reference curve from `data/postprocess.json`.
- Rewrites the frame as black RGB plus recovered alpha.
- Saves the exact input as `<file>.substrate-rgb.bak` before replacement.
- Writes through a temporary PNG and atomic rename.

The camera LUT was fitted on regular sofas against high-resolution approved Legacy Composure references using leave-one-model-out validation, and is now the main conversion for all product types. Recorded cross-validation MAE is about 1.81 alpha levels out of 255. The final seven-sofa comparison measured about 1.79/255 MAE, mean alpha ratio 0.99936, and less than 0.4% non-zero-area difference.

### Stage B — delivery

Implemented in `processImage`/`processJob` in `lib/post-process.cjs`.

- Centers the source on a transparent 15000 x 5000 canvas.
- Colors Shadow RGB as `#120C06`.
- Applies the configured camera alpha boost (currently 25% for `F`, `FH`, and `TQ`; cameras absent from the map receive no boost).
- Writes Adobe RGB (1998), 300 DPI, and the render passport metadata.
- Publishes files into `POST/<model>/` through a staging directory and atomic folder replacement.
- Leaves RAW originals in place.

Note: the camera-specific LUT already supplies the calibrated matte before the delivery boost. Do not silently merge Stage A and the delivery boost into a single curve; they serve different compatibility points.

## Runtime dependencies

- Node.js 18 or newer.
- npm package `pngjs` 7.x.
- libvips 8.x for delivery processing. Set `RH_VIPS` to the executable when it is not on `PATH`.
- `assets/AdobeRGB1998.icc`.

Stage A needs only Node.js and `pngjs`. libvips and the ICC profile are required by Stage B.

## Integration points on the farm

Call Stage A immediately after each Shadow render is complete and before:

- preview generation;
- crop/trim analysis;
- any check based on alpha bounds;
- final delivery processing.

The current local runner performs Stage A after an entire Shadow phase completes, shows its own progress state, and only then finalizes crop calibration or advances to POST. A farm may process each file as it arrives, but the crop calculation must wait until both the Fabric and converted Shadow members of a camera pair exist.

Preserve camera tokens in the filename. LUT selection depends on the camera name (`F`, `P`, `TQ`, `TQB`) and no longer depends on product type. If the farm renames files before Stage A, pass the original task/camera metadata or keep the camera token recognizable.

## Recommended deployment checks

1. Run `npm install`, then `npm run smoke`. The included smoke test creates a temporary hidden-RGB Shadow, verifies black RGB + non-zero alpha, verifies the source backup, and verifies that a second pass is idempotently skipped.
2. Run `node --check` on every included `.cjs` file.
3. Confirm `availability(root).ok` before accepting a job that needs delivery processing.
4. Test one copied production Shadow PNG. Confirm RGB is all zero, alpha has non-zero pixels, and a `.substrate-rgb.bak` file exists.
5. Confirm the crop union is calculated from the converted Shadow, not the backup or original empty-alpha PNG.
6. Confirm a rerun is idempotent: a valid-alpha Shadow is skipped unless explicit recalibration is requested.
7. Keep backup files out of render scanners and upload manifests.
8. Do not delete source backups until the calibrated result has passed production comparison.

## Recovery and recalibration

`scripts/reprocess-shadow-from-source.cjs` restores every `.substrate-rgb.bak` below a batch and reapplies the current LUT. It validates that targets stay inside the requested batch.

`scripts/calibrate-shadow-lut.cjs` builds camera LUT candidates from a new high-resolution source batch and an approved reference batch. Calibration data contains local input paths in its generated report; review/sanitize reports before sharing outside the farm.
