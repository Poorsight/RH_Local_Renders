# Sectional Light Rig — Scaling Formula (automation handoff)

Everything needed to reproduce the light-rig scaler outside the web tool: the formula, every
constant, the exact T3D output contract, and golden vectors. **A port that passes
`acceptance_vectors.json` is byte-for-byte identical to the tool** — that is the acceptance bar.

| | |
|---|---|
| Tool | https://preview.3dsource.com/dmitriy.derevyanko/light-rig/ (GitHub Pages is not enabled for this repo) |
| Source of truth | `light-rig-reference.html` → `computeAll()` + `generateT3D()` |
| Source revision | `03d9454`, 2026-07-13 |
| This package | `handoff/` (data files are generated from `light-rig-reference.html`; `npm test` fails if they drift) |
| Units | centimetres = Unreal units, degrees for angles |

---

## 1. What the rig is, and what "scaling" means

Five lights (2 × SpotLight, 3 × RectLight) were hand-tuned in Unreal for **one** reference sofa —
`453 × 279 × 79 cm` — in **four** camera shots. For a differently-sized sectional the rig is not
re-tuned; it is *scaled*: the whole rig moves in or out **as one rigid body** by a single factor,
and intensity (plus, optionally, source size) follows from how much further the lights ended up
from the subject. **Nothing is rotated, raised or reshaped** — the angles a lighting artist tuned
are the angles that get written out.

Output is Unreal **T3D** text: 5 actors in folder `Lights`, pasted into the level with `Ctrl + V`.

**In scope:** the 5 lights. **Out of scope:** camera, exposure, sofa placement, materials,
render/file naming.

## 2. Package contents

| File | Role |
|---|---|
| `HANDOFF_FORMULA.md` | this spec |
| `light_rig.json` | all constants: reference sofa, per-light base, per-shot rigs, presets, field map |
| `rig_template.t3d` | the T3D skeleton whose numeric fields get rewritten (LF, **no trailing newline**) |
| `acceptance_vectors.json` | 13 golden cases: expected per-light strings + SHA-256 of the full T3D |
| `light_rig.py` | reference implementation (stdlib only) + CLI + `--selftest` |
| `export_from_index.cjs` | regenerates the three data files from `light-rig-reference.html` |
| `ue_reference/<shot>.t3d` | the rig as exported from the UE scene, one file per shot — the **only** reference in this package that does not come from `light-rig-reference.html` (§11.5) |
| `verify_scene.cjs` | checks a scene export against the package: `npm run verify:scene` |

Regenerate after any change to the rig in `light-rig-reference.html`:

```bash
node handoff/export_from_index.cjs
```

## 3. Coordinate system

- Sofa footprint centred on the origin, **floor at `Z = 0`**, so the sofa occupies
  `X ∈ [−W/2, +W/2]`, `Y ∈ [−D/2, +D/2]`, `Z ∈ [0, H]`.
- World **X ↔ sofa width**, **Y ↔ sofa depth (+Y is the camera / front side)**, **Z ↔ height** —
  **but only on the shots where `sofa_yaw` is 0**, i.e. `F` and `FH`. On the ¾ shots the sofa is
  turned ±36°, so its width axis is 36° away from world X. The axis factors are therefore applied
  in the **sofa's own frame**, not in world axes (§5.2).
- Light positions are absolute world coordinates. In the T3D they sit in `RelativeLocation` of an
  unparented light component, so relative == world.
- Each shot rotates the **sofa**, never the rig. `sofa_yaw`: `F` 0°, `FH` 0°, `TQR` +36° (right-arm),
  `TQL` −36° (left-arm).
  The two ¾ shots are mirror images of each other. `sofa_yaw` is **not** part of the T3D — the T3D
  describes only the lights, which live in world space — so it never affects generated output; it
  documents the composition and drives the plan diagram. Consumers that place the sofa themselves
  read it from `light_rig.json`.

## 4. Inputs

| Input | Type | Default | Meaning |
|---|---|---|---|
| `W`, `D`, `H` | float > 0, cm | — | sofa bounding box: width, depth, height (UPH mesh bounds) |
| `view` | `F` \| `FH` \| `TQR` \| `TQL` | `F` | camera shot; each shot is its own rig |
| `mode` | `A` \| `B` | `B` | source-size model — **B is production** (real fixtures keep their size); A also scales the sizes, an exact similarity transform (§5.5) |
| `swap` | bool | `false` | **no-op**, kept only so existing call sites keep compiling: `k` depends on `W · D`, which a swap does not change (§5.2) |
| `ref` | `{W,D,H}` | `453 × 279 × 79` | the sofa the rig was tuned for; only change if the rig is re-tuned or the reference mesh is re-measured (it was, on 2026-08-24: `274 × 77` → `279 × 79`) |

Unknown `view` falls back to `F`. `W = D = H = ref` reproduces the source rig exactly (§11).

## 5. The formula

Applied **per light**, independently. Symbols: `p₀ = (x, y, z)` source position from the shot,
`I₀` source intensity, `R` effective source radius.

### 5.1 Axis ratios

```
sX = W / ref.W        # 453
sY = D / ref.D        # 279
sZ = H / ref.H        #  79
```

The `swap` input of the reference implementations is accepted for API compatibility only — it has
no effect, see 5.2.

### 5.2 One rig factor `k` — the same for all five lights

```
k = max(1, ∛(sX · sY · sZ))
```

The rig is a **studio setup around** the subject, not geometry glued to its bounding box, so it is
scaled as a **rigid body**: one factor, no per-axis stretch, no rotation. Three consequences, and
they are the reason this replaced the old per-axis transform:

* **The balance between the five sources survives.** A per-axis stretch gave every light its own
  `k` — on a real 274.6 × 355.5 × 86.9 sectional they ranged from 0.690 to 1.297, a factor of 1.9.
  Each source then changed brightness by a different amount and the tuned look fell apart.
* **`pitch` / `yaw` never need correcting.** Multiplying a position by a scalar leaves the direction
  from the light to the subject unchanged. The per-axis stretch forced aim corrections of up to
  21° on that same sectional, which is what flattened the render.
* **Swapping `W` and `D` changes nothing**, because `sX · sY = W · D / (ref.W · ref.D)` either way.
  A mesh authored rotated 90° produces the same rig — an entire class of pipeline bug disappears.

**The clamp at 1 is deliberate: the rig is only ever pushed OUT, never pulled in.** A sofa that
fits inside the tuned rig is emitted with the rig exactly as built. Measured over the 15-preset
catalogue that beats scaling down — exposure spread `1.21×` leaving the rig alone against `1.26×`
scaling it, and evenness *improves* the smaller the sofa gets (`0.92×` the reference error at 0.9
scale, `0.60×` at 0.6), because a smaller subject sits deeper inside the light field. Pulling the
lights in only amplifies the error: the shallow chaises in the catalogue are already 4–6 % hot with
the rig untouched, and their raw factor of 0.85–0.89 would add another 3 %.

Above the reference the picture inverts — a sofa outgrows the light field and its edges fall off
(evenness `1.32×` worse at 1.2 scale, `3.47×` at 1.5) — and that is exactly the case the clamp
lets through. In practice, for the current catalogue (largest model `459 × 276 × 83`, raw factor
`1.017`) the rig is emitted as tuned for every model but one, and that one moves by 1.7 %.

What it cannot do is follow the subject's **shape**: a rigid rig tracks size only. When the
proportions differ a lot from the reference (see 10), that residual is real and is not a bug.

### 5.3 Position — a plain scalar multiple

```
p₁ = (x · k, y · k, z · k)
d₀ = ‖p₀‖ = √(x² + y² + z²)          # still needed for the mode-B intensity
```

No sofa frame, no `Rz(θ)`: a uniform scale commutes with any rotation, so the ¾ shots need no
special handling. At the reference sofa `k = 1` and every position is reproduced exactly — that is
the identity invariant.

> Applied to the whole rig, including `front_fill`. The five lights were tuned around the sofa as
> one unit, so they scale with it as one unit.

### 5.4 Effective source radius `R`

```
spot:  R = SourceRadius
rect:  R = √(SourceWidth · SourceHeight / π)      # disc of equal area
```

### 5.5 Intensity and source size

**Mode A** (default — strict inverse square, shadow character preserved):

```
sizeK     = k
intensity = I₀ · k²
```

**Mode B** (source sizes stay fixed; models the near-field softening of big sources):

```
sizeK     = 1
intensity = I₀ · (k²·d₀² + R²) / (d₀² + R²)      ≈  I₀ · k^p,   p = 2·d₀² / (d₀² + R²)
```

`p` is diagnostic only (the UI shows it). For a sharp source (`R ≪ d₀`) `p → 2`; for the big
fill (`R ≈ 282`, `d₀ ≈ 698`) `p ≈ 1.72`, which is why "pure inverse square" looks wrong on it.

Sizes then scale by `sizeK`:

```
rect:  SourceWidth·sizeK,  SourceHeight·sizeK,  BarnDoorLength·sizeK
spot:  SourceRadius·sizeK, SoftSourceRadius·sizeK   (skip when the light has no soft radius)
```

### 5.6 Rotations — not touched

`Pitch`, `Yaw` and `Roll` are copied verbatim from the shot rig. There is no aim transform any
more: with a single scale factor the direction from a light to the subject is unchanged, so
re-deriving the angles could only introduce error. `compute_all` still returns
`sourcePitch` / `sourceYaw` for API compatibility; they are now always equal to `pitch` / `yaw`.

> Revisions between `10d1383` and this one re-derived `pitch`/`yaw` from a per-axis-scaled aim
> vector (`scale_aim`). That function is gone. Older ports and notes describing it are obsolete.

### 5.7 Attenuation radius — not written

`AttenuationRadius` is left at whatever the template carries (600 on `right_bounce_lgt` and
`right_rim_lgt`, the UE class default of 1000 on the other three). It has no effect in the path
tracer, which is the only renderer this rig is used with, so scaling it was pure noise.

### 5.8 Never scaled

`Roll`, `Temperature`, cone angles, `BarnDoorAngle`, `IntensityUnits`, shadow/sample settings,
asset paths, actor labels, folder — **and `Pitch`/`Yaw`/`Roll`** (§5.6) and `AttenuationRadius`
(§5.7). Between revisions `10d1383` and this one `Pitch`/`Yaw` *were* transformed; that is no
longer the case.

### 5.9 Pseudocode

```
k = max(1, cbrt((W/ref.W) * (D/ref.D) * (H/ref.H)))              # §5.2 — one factor, all lights
for name, L in merge(LIGHT_BASE, VIEWS[view].lights):
    x, y, z = L.pos
    pos  = (x*k, y*k, z*k)
    d0   = hypot3(x, y, z)
    R    = L.type == "spot" ? L.radius : sqrt(L.w * L.h / PI)
    if mode == "A":  I = L.I * k*k;                             sizeK = k
    else:            I = L.I * (k*k*d0*d0 + R*R)/(d0*d0 + R*R);  sizeK = 1
    emit(name, pos, I, sizes * sizeK, L.pitch, L.yaw, L.roll)    # rotations verbatim
```

### 5.10 Worked examples

**A sofa that fits inside the rig — the clamp fires.** Koper 39250480, `384 × 305 × 82`:

```
sX = 384/453 = 0.847682119   sY = 305/279 = 1.093189964   sZ = 82/79 = 1.037974684
raw = ∛(sX · sY · sZ) = 0.987124217
k   = max(1, raw)      = 1.000000000        <- clamped
```

Output is the shot's rig **byte for byte**, in both modes. Every preset in the catalogue except
`Koper · U (39250483)` behaves this way, so a port that forgets the clamp fails immediately and
loudly — which is the point.

**A sofa that outgrows the rig — the clamp lets it through.** `550 × 300 × 85`, shot `TQL`:

```
sX = 550/453 = 1.214128035   sY = 300/279 = 1.075268817   sZ = 85/79 = 1.075949367
k  = ∛(sX · sY · sZ) = 1.119930634            # > 1, so no clamp; same k for all five lights

main_key_lgt   p₀ = (−474, −19, 168)   I₀ = 60   R = 52.479965
               p₁ = p₀ · k = (−530.847121, −21.278682, 188.148347)      # 62 cm further out
               rotations: pitch −25, yaw 3, roll 0 — unchanged
  mode B:      Intensity = 75.090572   SourceRadius = 52.479965 (untouched)   p = 1.978485
  mode A:      Intensity = 75.254678   SourceRadius = 58.773920 (· k)

front_fill_lgt p₁ = (0, 779.471722, 58.236393)                              # 84 cm further out
  mode B:      Intensity = 7.311257    SourceWidth = SourceHeight = 500 (untouched)
  mode A:      Intensity = 7.525468    SourceWidth = SourceHeight = 559.965317
```

Note the fill stays on `x = 0` — a uniform scale cannot move it off the camera axis. Full expected
output for both cases: `acceptance_vectors.json` → `clamped-F-A` and `xl-TQL-B`.

Invariance vectors worth pinning in a port: `raw` at the reference is exactly `1`;
`raw(2·ref.W, 2·ref.D, 2·ref.H) = 2`; `raw(ref.W/2, ref.D, ref.H) = ∛0.5` while `k` for the same
input is exactly `1`; and swapping `W` with `D` (rescaled by `ref.W/ref.D`) leaves `raw` bit-identical.

## 6. Constants

### 6.1 Per-light base — shared by all four shots

| light | class | source size | soft | barn | roll | outer cone † | temp K † |
|---|---|---|---|---|---|---|---|
| `front_fill_lgt` | RectLight | 500 × 500 | — | 0 | 0 | — | 6500 |
| `left_rim_lgt` | SpotLight | radius 256 | 25 | — | 0.382830 | 90 | 6500 |
| `main_key_lgt` | SpotLight | radius 52.479965 | — | — | 0 | 37 | 6500 |
| `right_bounce_lgt` | RectLight | 256 × 256 | — | 25 | 0 | — | 6000 |
| `right_rim_lgt` | RectLight | 91.440002 × 60.900002 | — | 0 | 0 | — | 6000 |

† documentation only — cone angles and temperature live in the template and are never rewritten.
`main_key_lgt` also has `InnerConeAngle = 1` in the template.

### 6.2 Per-shot rigs

Only these four fields change between shots. Everything else comes from §6.1. `pitch`/`yaw` here are
the **source** angles — the values that go through §5.6 before being written.

**`F` · Front** — sofa yaw 0°

| light | position | I₀ | pitch | yaw |
|---|---|---|---|---|
| `front_fill_lgt` | (0, 696, 52) | 6.0 | 4 | −90 |
| `left_rim_lgt` | (−508, −200, 242.441086) | 50.0 | −43 | 4 |
| `main_key_lgt` | (−445, 130, 232.610977) | 45.0 | −25 | −11 |
| `right_bounce_lgt` | (372, 240, 150) | 0.5 | 0 | −140 |
| `right_rim_lgt` | (349, 91, 63) | 0.3 | 0 | 180 |

**`FH` · Front-high** — sofa yaw 0°; camera raised, intensities re-tuned

| light | position | I₀ | pitch | yaw |
|---|---|---|---|---|
| `front_fill_lgt` | (0, 696, 52) | 4.0 | 4 | −90 |
| `left_rim_lgt` | (−508, −200, 242.441086) | 60.0 | −43 | 4 |
| `main_key_lgt` | (−414, 130, 232.610977) | 45.0 | −25 | −11 |
| `right_bounce_lgt` | (283, 323, 150) | 0.5 | 0 | −140 |
| `right_rim_lgt` | (245, −73, 230) | 1.0 | 0 | 157.21875 |

**`TQR` · ¾ right-arm** — sofa yaw **+36°**

| light | position | I₀ | pitch | yaw |
|---|---|---|---|---|
| `front_fill_lgt` | (0, 696, 52) | 8.0 | 4 | −90 |
| `left_rim_lgt` | (−433, −190, 242.441071) | 50.0 | −43 | 4 |
| `main_key_lgt` | (−474, −19, 168) | 60.0 | −18 | 28 |
| `right_bounce_lgt` | (283, 323, 150) | 0.5 | 0 | −140 |
| `right_rim_lgt` | (385, 63, 56) | 0.6 | 0 | 153 |

**`TQL` · ¾ left-arm** — sofa yaw **−36°**

| light | position | I₀ | pitch | yaw |
|---|---|---|---|---|
| `front_fill_lgt` | (0, 696, 52) | 6.0 | 4 | −90 |
| `left_rim_lgt` | (−433, −190, 242.441071) | 50.0 | −43 | 4 |
| `main_key_lgt` | (−474, −19, 168) | 60.0 | −25 | 3 |
| `right_bounce_lgt` | (283, 323, 150) | 0.5 | 0 | −140 |
| `right_rim_lgt` | (385, 63, 56) | 1.0 | 0 | 166.5 |

> Note the `left_rim_lgt` Z: `242.441086` in `F`/`FH` but `242.441071` in `TQR`/`TQL`. Not a typo —
> copy the values verbatim. `light_rig.json` is the machine-readable copy of these tables.

## 7. Output contract — how the T3D is produced

Do **not** generate T3D from scratch. Take `rig_template.t3d` and rewrite only numeric fields, so
the output stays a structurally valid paste and diffs against the source rig stay readable.

Algorithm:

1. Split the template into `Begin Actor … End Actor` blocks (non-greedy, 5 blocks).
2. Read `ActorLabel="…"` from the block — it is the light name and it is unique.
3. In that block, rewrite **the first** matching line per field: `^<indent><Field>=…`
4. Leave every other line untouched, including all whitespace and line count.

| Field | Written from | When |
|---|---|---|
| `RelativeLocation=(X=…,Y=…,Z=…)` | `p₁` | always |
| `RelativeRotation=(Pitch=…,Yaw=…,Roll=…)` | the shot’s tuned angles (§5.6), unchanged | always |
| `Intensity=…` | §5.5 | always |
| `SourceWidth=…`, `SourceHeight=…`, `BarnDoorLength=…` | sizes · `sizeK` | rect lights |
| `SourceRadius=…` | radius · `sizeK` | spot lights |
| `SoftSourceRadius=…` | soft · `sizeK` | only `left_rim_lgt` (the only one with a soft radius) |

Never touched: `AttenuationRadius`, `Temperature`, `bUseTemperature`, `IntensityUnits`, `BarnDoorAngle`,
`InnerConeAngle`, `OuterConeAngle`, `LightingChannels`, `CastRaytracedShadow`, `SamplesPerPixel`,
`Mobility`, `ActorLabel`, `FolderPath`, `ExportPath`, `Archetype`, and the block structure.

### 7.1 Number formatting (this is where ports break)

Every value is written as **fixed 6 decimals**, dot separator, no grouping, matching JavaScript
`Number.prototype.toFixed(6)`: round to nearest on the *exact binary value* of the double, **ties
away from zero**, and `-0` prints as `0.000000`.

Most standard formatters round ties to **even** and disagree: `%.6f` in Python and C `printf`
give `0.007812` where the tool writes `0.007813`. On a 20 000-value fuzz run against
`toFixed(6)`, `%.6f` differed on 97 values; the exact-decimal approach in `light_rig.py`
(`Decimal(x).quantize(…, ROUND_HALF_UP)`) differed on none.

Ties to test your formatter against: `0.0078125 → 0.007813`, `−0.0078125 → −0.007813`,
`3.5390625 → 3.539063`, `1.0000005 → 1.000001`, `1234.5678905 → 1234.567890`, `−1e−7 → −0.000000`,
`−0.0 → 0.000000`. (These are the `_FMT_VECTORS` in `light_rig.py`.)

### 7.2 Text details

- Line endings **LF**, no trailing newline (the file ends with `End Map`).
- Output is exactly 5 `Begin Actor` blocks and the same line count as the template.
- Use invariant/`C` locale — never a comma decimal separator.

## 8. Choosing the shot for a model

`F` and `FH` apply to every model. The ¾ shot depends on which side the sofa's arm is on. Since
revision `272716e` the arm side is an **explicit field on the preset** (`arm: "L" | "R"`), with name
parsing only as a fallback for user-entered presets:

```
arm = preset.arm ∈ {L, R}                        → use it
else infer from the name:
     /(^|[\s_.-])left[\s_-]*arm($|[\s_.-])/i     → L
     /(^|[\s_.-])right[\s_-]*arm($|[\s_.-])/i    → R
     neither / both                              → "" (no arm-specific ¾ shot)

L → TQL  (sofa −36°)        R → TQR  (sofa +36°)
```

The key letter matches the arm side — there is no cross.

> ⚠️ **Identify a rig by its numbers, never by a label written next to an export.** `TQR` is
> `front_fill I=8`, `main_key pitch −18 / yaw 28`, `right_rim yaw 153 / I=0.6`. `TQL` is
> `front_fill I=6`, `main_key pitch −25 / yaw 3`, `right_rim yaw 166.5 / I=1.0`. On 2026-08-13 this
> mapping was inverted on the strength of a mislabelled pair of scene exports and reverted the same
> day once unambiguous ones arrived; if you find a note claiming the mapping is crossed, it is stale.
>
> **Open conflict.** The render pipeline maps `Sectional_Indoor_L → TQR` and
> `Sectional_Indoor_R → TQL` — the opposite of the rule above — and its `LUGANO SLIPCOVERED` batch
> of 2026-08-12 therefore filmed every arm-specific model from the wrong side. One of the two sides
> is wrong; do not align this file to the pipeline until it is settled.

**Do not default an unknown arm side to a side.** `""` means either "symmetric, no arm side" or
"could not be determined", and guessing silently produces a wrong-side ¾ that still renders and
still looks plausible. Two traps seen in production: names like `6_PIECE_L_SECTIONAL` or
`8_PIECE_U_SECTIONAL` describe the **shape**, not an arm — the regexes above deliberately do not
match them; and the component list inside the mesh is no help either, because almost every
assembly contains both a `LEFT_ARM_CHAIR` and a `RIGHT_ARM_CHAIR` module (they are the two ends).
If the side is not known, carry it as explicit data or skip the ¾ shot — `F` and `FH` are always safe.

Each preset in `light_rig.json` carries both the resolved `arm` and the resulting `tq_view`.
In the tool this gates only the **render-preview board** (an `L` model shows ¾ renders in `TQ-L`
only); `F`/`FH` are never gated, and the *rig generation itself is never blocked* — any shot can be
generated for any dimensions.

## 9. Generated presets

There are no bundled model presets. `RH_Local_Renders` reads corrected FBX bounds from the
sectional-classifier report and creates `local/catalog.json` only after a successful render has
produced image files. That local catalogue owns the model dimensions, side and render examples.

## 10. Sanity checks (advisory, do not block output)

| Check | Condition | Meaning |
|---|---|---|
| scale magnitude | `max(|sX−1|, |sY−1|, |sZ−1|) > 0.5` | rig stretched >150% — eyeball the look |
| shape mismatch | `max(sX,sY,sZ)/min(sX,sY,sZ) > 1.5` | the rig follows size, not shape — check the far end and the chaise |
| peak intensity | `max(intensity) > 250 cd` | re-check camera exposure |

## 11. Acceptance — proving a port is correct

1. **Identity invariant.** `view=F`, `W×D×H = ref` (453×279×79), either mode → output must equal
   `rig_template.t3d` **byte for byte** (`k = 1` everywhere). If this fails, nothing else matters.
2. **Golden vectors.** For each case in `acceptance_vectors.json`: recompute, compare the
   per-light strings (`location`, `rotation`, `source_rotation`, `intensity`, source sizes,
   already formatted to 6 decimals, so no float comparison) and the SHA-256
   of the full T3D. `template_sha256` pins the skeleton itself. `rotation` vs `source_rotation`
   must always be equal now (§5.6); if they are not, your port still has an aim transform in it.
3. **Invariance vectors.** §5.10: `k = 1` at the reference *exactly*, `k = 2` at double the
   reference, and a `W`↔`D` swap leaving `k` bit-identical.
4. The reference implementation runs all of it:

```bash
python handoff/light_rig.py --selftest
```

Cases cover: identity (modes A and B), all four shots at reference, two presets, mode B, `swap`
(which must now produce output identical to `swap = false`), oversized/undersized sofas, and a
non-default `ref`.

### 11.5 Checking the constants against the UE scene

Everything above proves a *port* matches the *tool*. It cannot prove the tool matches the
**scene** — `light_rig.json` and the golden vectors are generated from `light-rig-reference.html`, so they can
never disagree with it. Only an export from Unreal can settle that, and `ue_reference/` holds one
per shot: select the five lights in the viewport, `Ctrl + C`, save as `.t3d`.

```bash
node handoff/verify_scene.cjs                  # re-check the bundled exports
node handoff/verify_scene.cjs fresh.t3d        # check a new export, shot auto-detected
node handoff/verify_scene.cjs --view TQR a.t3d # or name the shot yourself
```

It generates the rig at the reference sofa for that shot and compares **every property line**
inside the actors — 115 per shot, including the ones the tool never rewrites (`Temperature`,
cone angles, `SamplesPerPixel`, `BarnDoorAngle`, `IntensityUnits`), which would otherwise drift
unnoticed. Asset paths, `Begin Actor` / `Begin Object` headers and actor ordering are skipped:
the package ships a neutralised skeleton and always emits the template's order.

Run this after **any** re-tune in Unreal, before `npm run handoff`. `npm test` runs it over the
bundled exports, so a rig that drifts from the scene fails the suite — as long as the exports are
refreshed together with the rig. Until this existed, only shot `F` was pinned to anything external
(via the skeleton); `FH`, `TQR` and `TQL` were hand-entered and unverified.

## 12. Reference implementation

`light_rig.py` — stdlib only, Python 3.8+, reads the JSON + template from its own directory.
Verified byte-identical to the browser tool on the 13 golden cases plus a 2 007-case randomized
matrix (4 shots × both modes × swap × fractional dimensions × custom `ref`, plus uniform-scale and
extreme-proportion cases that stress the aim math).

```bash
python handoff/light_rig.py --preset 39250480 --view auto -o rig.t3d
python handoff/light_rig.py -W 384 -D 305 -H 82 --view TQL --mode A
python handoff/light_rig.py --preset "Koper · U (39250483)" --view F --emit json
python handoff/light_rig.py --list-presets
```

```python
import light_rig

t3d = light_rig.scale_rig(384, 305, 82, view="TQL")          # paste-ready text
res = light_rig.compute_all(384, 305, 82, view="TQL")         # per-light numbers
p   = light_rig.find_preset("39250480")                        # {'name','sku','W','D','H','arm','tq_view',…}
```

`--view auto` = the preset's arm-side ¾ shot, else `F`. `--emit json` gives per-light numbers for
pipelines that spawn or patch actors instead of pasting T3D; it is authoritative for the *scaled*
fields only — everything static still comes from `rig_template.t3d`.

## 13. Porting gotchas

1. **Number formatting** — §7.1. The single most likely source of a near-miss diff.
2. **First match per actor block, not global replace.** Each actor block mentions its light
   component twice; a global regex would hit the wrong line and `Intensity` would collide across
   actors. Also note `IntensityUnits=` must not be caught by an `Intensity=` pattern.
3. **`k` is per light**, from the distance to the origin — not a single global scale (§5.3).
4. **Pitch/yaw are transformed, roll is not** (§5.6). Two traps: skipping the uniform-scale
   shortcut (then the identity invariant fails on floating-point noise), and forgetting that
   `left_rim_lgt` keeps roll `0.382830` through everything.
5. **Trig must be within 1 ULP.** The aim math uses `cos/sin/atan2/hypot`; do the degree
   conversion as `x·π/180` and `x·180/π` (the same operation order as the tool) rather than a
   pre-multiplied constant. Rounding to 6 decimals absorbs the rest — the Python port matched on
   all 2 007 cross-checked cases — but a bad conversion order shows up as last-digit drift.
6. **UE rotator argument order.** T3D writes `Pitch, Yaw, Roll`; `unreal.Rotator(...)` in Python
   takes `roll, pitch, yaw`. Easy silent swap.
7. **UE property names** = the T3D field names, snake_cased in Python (`SourceWidth` →
   `source_width`, on the *component*, not the actor). Verify against your engine version.
8. **Mode A is production.** Only use B when explicitly asked; it drifts further from the tuned rig.
9. **`swap` is dead** — kept in the signature for compatibility, it cannot change the output because
   `k` depends on `W · D`. Historically it decided which input fed world X vs Y,
   and the tool no longer exposes it in the UI (§4).
10. **Angles in degrees**, positions in cm; no unit conversion anywhere.
11. **LF, no trailing newline** (§7.2). Writing files on Windows: open in binary or disable
    newline translation, or the SHA-256 checks will fail.
12. **Don't re-round inputs.** `W/D/H` go into the math as given; only the *output* is rounded to
    6 decimals.
13. If the UE rig is ever re-tuned, `light-rig-reference.html` changes and this whole package must be
    regenerated (§2) — the constants here are not independent copies to be edited by hand.
    The rig math itself has already changed once this way: `10d1383` added the aim transform.

## 14. Still to be decided by whoever automates this

- **Dimension source.** Presets carry hand-measured UPH bounds (whole cm). Automated bounds
  extraction must match that convention, or numbers will differ slightly from the manual results.
- **Shot list per SKU.** `F` and `FH` for everything; `TQR`/`TQL` by arm side (§8) — confirm that
  matches the shot list the render pipeline actually needs.
- **How the rig lands in the level:** paste the T3D text, or spawn/patch the five actors from
  `--emit json`. Pasting keeps every static setting for free.
- **Camera, exposure, sofa placement and material assignment are not part of this package.**
