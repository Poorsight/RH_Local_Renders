# Physical shape versus render routing

Scope: local controller branch `codex/current-project`. No Unreal project, plugin,
lighting table, crop or shadow-processing changes. No remote deployment.

## Result on the current 16 FBX models

| Model | Product ID | Physical form | Auto render logic |
| --- | --- | --- | --- |
| BELLA | 30390100 | Straight | U |
| BLAKE | 34641089 | L-shape, right | R |
| CHELSEA | 34640355 | Straight | U |
| CLOUD | 9740013 | U | U |
| COPENHAGEN | 36850041 | U, curved | U |
| CORTONA | 35350279 | U | U |
| DARIO | 32200323 | U | U |
| ISOLA | 32820190 | U, curved | U |
| LENNON | 35930039 | Straight | U |
| LUGANO corner wedge | 37600006 | L-shape, left | L |
| LUGANO slipcovered | 20810167 | U | U |
| MADDOX | 20190026 | U | U |
| MAXWELL | 9340020 | U | U |
| MODENA high deck | 36570021 | L-shape, right | R |
| MODENA U | 9350060 | U | U |
| MONCEAU | 34950081 | L-shape, left | L |

Totals: 9 U, 3 Straight, 2 right, 2 left. Render routing: 12 U, 2 R, 2 L.
Before the change, ISOLA and the three straight models were UNKNOWN. All other
classifications are unchanged. Dimensions, yaw and exact source mesh IDs were
compared against the preceding metadata and are unchanged for all 16 files.

## Implementation

- `scripts/inspect_fbx.py` keeps the current mesh-only world-space point sampling.
  It finds the backrest, then measures the occupied top-down front contour.
- Contour variation is compared with the sofa's actual depth before normalizing
  it to 0–1. A flat front (variation <= 10% of depth, width/depth >= 1.10,
  >= 90% populated lateral bins) is Straight. Missing sampled bins are interpolated.
  R/L/U inference requires >= 15% depth variation, so small padding differences
  cannot be magnified into a full chaise.
- If no straight backrest wall is found, four axis-aligned openings are tested.
  Exactly one must be deep (>= 30%), symmetric (absolute asymmetry <= 0.08),
  recessed in the centre (notch >= 0.50), wider than deep (>= 1.10) and sufficiently
  sampled (>= 90%). This recognizes ISOLA's curved U and infers its back as +Y.
  Ambiguous or degenerate footprints remain UNKNOWN.
- Existing explicit U / RIGHT_ARM / LEFT_ARM filename hints retain their priority.
  `L_SECTIONAL` alone does not mean a left-handed sofa. `SOFA` alone does not
  force Straight. No product IDs or family names are hardcoded in the detector.
- `formFactor` stores physical shape (`STRAIGHT`, `U`, `R`, `L`, `UNKNOWN`).
  Existing `side` remains the engine routing field. Straight maps to side U;
  no new scene or plugin protocol value is introduced.
- For this Sectionals batch, Straight uses `Sectional_Indoor_U`, F/FH/TQ yaw
  0/0/+36 plus import yaw, and the same U light data and layer settings.
  It is NOT moved to the separate Sofas product pipeline.
- Cards and the model-information popup identify Straight separately. Job-local
  metadata and history retain the physical form independently of render side.
  Manual R/L/U selection still overrides routing for the whole batch.
- Inspector cache version is now 2 and check-cache version 4. Local measurements
  produced by an older inspector are reanalyzed on inspection, even when the FBX
  fingerprint is unchanged. Tracked legacy metadata is not rewritten.

## Verification

- Reimported the actual 16 FBX files through the site's `/api/models/inspect`.
- Compared dimensions, yaw and every original material ID with prior records.
- Constructed a 16-task job in memory and checked per-model camera yaws.
- Compared entire generated task payloads for Straight and U: identical when
  all other inputs match; only local physical-shape metadata differs.
- Auto preflight has zero form-factor errors for this batch. Diagnostic materials
  were intentionally empty; this is not a claim that every material is assigned.
- `npm run build`: passed. `npm test`: 93 passed, zero failed.
- `python test/form-factor.test.py`: five test methods, including rotation and
  scale variations, left/right preservation, curved U, padding and unknown cases.
- Browser/Playwright checks: model inspection, mixed Straight/U cards and model
  popup at 1440x1000 and 390x844; no horizontal page overflow or console errors.

Ignored diagnostic evidence: `local/validation/2026-09-11/form-factor-api-v2.json`
and `form-factor-results-v2.json`. No actual Unreal render was saved or started
for this change. These are geometric and job-generation checks, not rendered
image comparisons. The detector remains a conservative heuristic, not a promise
that every possible future sofa can be classified automatically.
