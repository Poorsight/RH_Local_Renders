# Background Holdout: implementation and render validation

## Result

Published plugin branch: `feature/background-holdout`, head `679a8b5` (implementation and rebuilt Win64 binaries: `ab1fa48`). Based on UE 5.6 branch `f65c13e`; no merge to `5.6` or `main`.

Background now supports opt-in `disableEnvironmentHoldout: true` on the layer. Only primitive components in the named streaming sublevels of the PIE world are changed. Product-tagged actors are excluded. Original flags are restored on completion, failure and EndPlay. No scene assets are saved. Defaults remain unchanged.

The local controller runs Fabric → Background → Shadow. Background inherits the product camera for each angle with fitting disabled, and uses Shadow's resolution and sensor size even if an old Background frame is present. Background has its own RAW/POST folder and is not treated as a fabric variant or shadow matte. Its color processing follows the regular color-image route, not shadow-alpha recovery. No new UI controls were added.

## Camera contract

Same angle means the same camera position, rotation and focal length. Background and Shadow also share the same sensor, resolution and crop placement. Never fit to the environment or independently trim Background.

Measured test configuration:

| Parameter | Product | Background / Shadow |
| --- | --- | --- |
| Resolution | 1000 × 1000 | 3000 × 1000 |
| Sensor | 36 × 36 mm | 108 × 36 mm |
| F focal length | 182.4921875 mm | 182.4921875 mm |
| TQ focal length | 180.8758544921875 mm | 180.8758544921875 mm |

The product is placed at x=1000, y=0 on the common canvas, without resampling. For optimized jobs, use their recorded crop placement instead of this full-frame example. Camera transforms and inherited focal values in staged native jobs match exactly between Background and Shadow for both views.

## Render evidence

BELLA_TWO_SEAT_SOFA_CLASSIC_6_10180712; PERFORMANCE_LINEN_WEAVE_SAND_V1; UPH_WOOD_BROWN_OAK. Current tool lights and project scene. Substrate ON. Background uses the product Path Tracer preset and the `Sofa_Indoor_Background` + `Sofa_Indoor_KeyLight` levels. Shadow keeps the existing native pipeline.

All launches went through the local render service API. Control: 6 RAW + 6 POST, 220 s. Override enabled: 6 RAW + 6 POST, 220 s. Product-only repeat: 2 RAW + 2 POST, 70 s. Times include polling granularity, process startup, imports and post-processing; not a production-resolution benchmark.

Background control was fully transparent in both views (zero nonzero-alpha pixels). With the override, all 3,000,000 pixels have nonzero alpha; the background contains the environment without the sofa. Alpha is 251–255, not guaranteed fully opaque at every edge pixel. Runtime logs confirm 5 components in 2 levels changed and restored separately for F and TQ.

| RAW comparison, control vs enabled | F | TQ |
| --- | --- | --- |
| Product mean RGB difference on white, visible area, 0–255 | 1.5125 | 0.7168 |
| Product maximum alpha difference | 0 | 2 |
| Shadow exact RGBA pixels | 99.9989667% | 99.9992333% |
| Shadow changed pixels, out of 3,000,000 | 31 | 23 |
| Shadow maximum alpha difference | 7 | 5 |

The product-only repeat matched control F exactly (100% RGBA). TQ repeat vs control mean RGB difference was 0.4410/255; repeat vs enabled was 0.6220/255. Product rendering occurs before the Background override. No persistent product change or camera mismatch was observed; these runs do not establish bitwise determinism or isolate every source of stochastic variation.

Analytical contact sheets: `local/validation/2026-09-16/background-56/matched-F-comparison.png` and `matched-TQ-comparison.png`. No source-image registration or color adjustment was applied. The displayed composite is a diagnostic alpha-over preview, not a newly specified production compositing workflow.

Full RAW/POST measurements and camera audit are in the same local evidence directory. That directory also retains logs and jobs for local diagnosis; do not publish raw logs containing machine-specific paths.

## Verification and limits

- Native C++ build succeeded; 3 Unreal automation tests passed without test warnings/failures.
- Controller suite: 108 tests passed, including stale Background-frame replacement, handoff, phase splitting and delivery separation.
- Existing project textures and migrated assets were preserved. Project/plugin scene assets were not modified by this feature.
- No 5000-pixel acceptance run, every-model batch, or visual cancellation/failure render test was performed. Cleanup safety is covered by code and native tests; successful per-view restoration is confirmed in real logs.
- Earlier CLOUD tests used an outdated preset/filmback. Their control completed; the enabled test was intentionally stopped after two frames when the camera requirement was clarified. They are excluded from the matched-camera acceptance results.
- Deferred/Lumen Holdout behavior also depends on engine primitive alpha-Holdout support. The outdated Lumen preset showed some environment even without this override; the matched Path Tracer test gives the clear off/on comparison.
- This change exposes the existing environment as-is. It does not redesign environment lighting, remove scene artifacts or guarantee that an arbitrary shadow lighting setup is artistically appropriate for a new background.
