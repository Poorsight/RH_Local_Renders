# Sectional Light Rig — Scaling Formula (automation handoff)

Everything needed to reproduce the light-rig scaler outside the web tool: the formula, every
constant, the exact T3D output contract, and golden vectors. **A port that passes
`acceptance_vectors.json` is byte-for-byte identical to the tool** — that is the acceptance bar.

| | |
|---|---|
| Tool | https://preview.3dsource.com/dmitriy.derevyanko/light-rig/ (GitHub Pages is not enabled for this repo) |
| Source of truth | `index.html` → `computeAll()` + `generateT3D()` |
| Source revision | `03d9454`, 2026-07-13 |
| This package | `handoff/` (data files are generated from `index.html`; `npm test` fails if they drift) |
| Units | centimetres = Unreal units, degrees for angles |

---

## 1. What the rig is, and what "scaling" means

Five lights (2 × SpotLight, 3 × RectLight) were hand-tuned in Unreal for **one** reference sofa —
`453 × 274 × 77 cm` — in **four** camera shots. For a differently-sized sectional the rig is not
re-tuned; it is *scaled*: positions move proportionally to the sofa, intensity / source size /
attenuation follow from how much further each light ended up from the subject, and each light's
**aim (pitch/yaw) is re-derived** so it still points at the same relative area of the sofa.

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
| `export_from_index.cjs` | regenerates the three data files from `index.html` |
| `ue_reference/<shot>.t3d` | the rig as exported from the UE scene, one file per shot — the **only** reference in this package that does not come from `index.html` (§11.5) |
| `verify_scene.cjs` | checks a scene export against the package: `npm run verify:scene` |

Regenerate after any change to the rig in `index.html`:

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
| `mode` | `A` \| `B` | `A` | intensity model — **A is production**, B is analysis (§5.5) |
| `swap` | bool | `false` | sofa stands rotated 90°: `W` feeds world Y and `D` feeds world X. Still part of the `computeAll` API, but its UI checkbox was removed from the tool — leave it `false` unless you know you need it |
| `ref` | `{W,D,H}` | `453 × 274 × 77` | the sofa the rig was tuned for; only change if the rig is re-tuned |

Unknown `view` falls back to `F`. `W = D = H = ref` reproduces the source rig exactly (§11).

## 5. The formula

Applied **per light**, independently. Symbols: `p₀ = (x, y, z)` source position from the shot,
`I₀` source intensity, `R` effective source radius.

### 5.1 Axis scales

```
sX = (swap ? D : W) / ref.W        # 453
sY = (swap ? W : D) / ref.D        # 274
sZ =  H / ref.H                    #  77
```

### 5.2 Position — per-axis, in the sofa's frame

`sX` and `sY` are factors along the sofa's **width** and **depth**, which coincide with world X and
Y only while the sofa is not turned. Un-rotate into the sofa's frame, scale, rotate back:

```
θ  = sofa_yaw of the shot          # 0 for F and FH, +36 for TQR, −36 for TQL
p₁ = Rz(θ) · diag(sX, sY, sZ) · Rz(−θ) · p₀

Rz(t):  x' = x·cos t − y·sin t
        y' = x·sin t + y·cos t
        z' = z
```

**Collapse to the plain multiply whenever the two frames coincide** — treat `θ` as 0 when
`|sX − sY| < 1e−12`. A rotation about Z commutes with `diag(s, s, sZ)`, so the result is identical
either way, and taking the short path keeps it *bit*-identical. Combined with `θ = 0` on `F`/`FH`,
this is what holds the identity invariant and every `F`/`FH` vector byte-stable.

So the transform reduces to `p₁ = (x·sX, y·sY, z·sZ)` for: any `F` or `FH` shot, any sofa whose
width and depth scale equally, and the reference sofa itself. It differs only for a
**non-proportional sofa on a ¾ shot** — which is precisely the case the plain multiply got wrong.

> Applied to the whole rig, including `front_fill`, which sits on the camera axis at `x = 0` and
> therefore moves off it once the sofa is turned. The five lights were tuned around the sofa as one
> unit, so they scale with it as one unit. If the fill is ever meant to stay locked to the camera
> axis instead, that is a deliberate exception and must be written down here — do not introduce it
> silently.

### 5.3 Distance ratio `k` — per light, from the origin

```
d₀ = ‖p₀‖ = √(x² + y² + z²)
d₁ = ‖p₁‖
k  = d₁ / d₀
```

`k` is *not* a global factor: a light in front of the sofa grows with depth, a side light with
width. This is the whole point — one scalar per light, derived from how far it moved.

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

### 5.6 Aim — adapted `pitch` / `yaw`

An Unreal light aims along its **local +X**, so `pitch`/`yaw` are a direction vector. Under
non-uniform scaling (a sofa that is relatively wider or deeper than the reference) the same angles
would no longer point at the same part of the sofa, so the direction vector is scaled by the same
axis factors and the angles are read back:

```
v      = (cos(pitch)·cos(yaw),  cos(pitch)·sin(yaw),  sin(pitch))
v′     = Rz(θ) · diag(sX, sY, sZ) · Rz(−θ) · v    # same sofa frame as §5.2, same θ
pitch′ = atan2(v′.z, hypot(v′.x, v′.y))          # degrees
yaw′   = atan2(v′.y, v′.x)                        # degrees
```

The aim must be scaled in the same frame as the position, or the correction compensates along the
wrong axes. With `θ = 0` this is the plain `(v.x·sX, v.y·sY, v.z·sZ)` it has always been.

**Uniform-scale shortcut (required, not an optimisation):** if
`|sX − sY| < 1e−12` and `|sY − sZ| < 1e−12`, return `pitch`/`yaw` untouched. This is what keeps the
identity invariant byte-exact and keeps proportional sofas rotation-stable.

`roll` never participates. `computeAll` also returns `sourcePitch` / `sourceYaw` — the shot's
original angles — for diagnostics; the T3D always gets the adapted pair.

### 5.7 Attenuation radius

```
AttenuationRadius · k          # only for lights that define one (bounce, right rim)
```

### 5.8 Never scaled

`Roll`, `Temperature`, cone angles, `BarnDoorAngle`, `IntensityUnits`, shadow/sample settings,
asset paths, actor labels, folder. (`Pitch`/`Yaw` *are* transformed — §5.6. Before revision
`10d1383` they were not; older ports and notes may still say "rotations are never scaled".)

### 5.9 Pseudocode

```
theta = abs(sX - sY) < 1e-12 ? 0 : VIEWS[view].sofa_yaw          # §5.2
for name, L in merge(LIGHT_BASE, VIEWS[view].lights):
    x, y, z = L.pos
    loc  = rotZ((x, y, z), -theta)
    pos  = rotZ((loc.x*sX, loc.y*sY, loc.z*sZ), theta)
    d0   = hypot3(x, y, z);  d1 = hypot3(pos)
    k    = d1 / d0
    R    = L.type == "spot" ? L.radius : sqrt(L.w * L.h / PI)
    pitch, yaw = scaleAim(L.pitch, L.yaw, sX, sY, sZ, theta)     # §5.6
    if mode == "A":  I = L.I * k*k;                             sizeK = k
    else:            I = L.I * (k*k*d0*d0 + R*R)/(d0*d0 + R*R);  sizeK = 1
    atten = L.atten == null ? null : L.atten * k
    emit(name, pos, I, atten, sizes * sizeK, pitch, yaw, L.roll)
```

### 5.10 Worked example

`main_key_lgt`, sofa `384 × 305 × 82` (Koper 39250480), shot `TQL`, mode `A`. This sofa is
relatively deeper than the reference (`sX ≠ sY`) and `TQL` turns it −36°, so the sofa frame is
live — a good case to test a port against, because a world-axis implementation gets it wrong:

```
sX = 384/453 = 0.847682119   sY = 305/274 = 1.113138686   sZ = 82/77 = 1.064935065
θ  = −36  (sofa_yaw of TQL; not collapsed to 0 because sX ≠ sY)
p₀ = (−474, −19, 168)        I₀ = 60      R = 52.479965 (SourceRadius)
p₁ = Rz(−36)·diag(sX,sY,sZ)·Rz(36)·p₀ = (−447.671691, −79.241103, 178.909091)
d₀ = 503.250435   d₁ = 488.566841   k = 0.970822492
aim:     pitch −25 → −27.312176      yaw 3 → 10.759179      (roll stays 0)
mode A:  Intensity = 60 · k²   = 56.549779      SourceRadius = 52.479965 · k = 50.948730
mode B:  Intensity = 56.586895  (p = 1.978485 → nearly k², this source is small)
```

The same sofa, `front_fill_lgt`: `p₁ = (87.857541, 710.912286, 55.376623)`, `k = 1.029398098`,
`Intensity = 6.357963`, `SourceWidth = SourceHeight = 514.699049`, aim `pitch 4 → 4.138425`,
`yaw −90 → −97.045132`. Note the fill no longer stays at `x = 0`: once the sofa is turned it
travels with it (§5.2). Full expected output: `acceptance_vectors.json` → `koper39250480-TQL-A`.

Aim sanity vectors (independent of the rig): `scaleAim(0, 45, 2, 1, 1) → yaw 26.565051`,
`scaleAim(45, 0, 1, 1, 2) → pitch 63.434949`, `scaleAim(−25, −11, 2, 2, 2) → (−25, −11)` exactly.

## 6. Constants

### 6.1 Per-light base — shared by all four shots

| light | class | source size | soft | barn | atten | roll | outer cone † | temp K † |
|---|---|---|---|---|---|---|---|---|
| `front_fill_lgt` | RectLight | 500 × 500 | — | 0 | — | 0 | — | 6500 |
| `left_rim_lgt` | SpotLight | radius 256 | 25 | — | — | 0.382830 | 90 | 6500 |
| `main_key_lgt` | SpotLight | radius 52.479965 | — | — | — | 0 | 37 | 6500 |
| `right_bounce_lgt` | RectLight | 256 × 256 | — | 25 | 600 | 0 | — | 6000 |
| `right_rim_lgt` | RectLight | 91.440002 × 60.900002 | — | 0 | 600 | 0 | — | 6000 |

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
| `RelativeRotation=(Pitch=…,Yaw=…,Roll=…)` | adapted aim (§5.6); `Roll` from §6.1, unscaled | always |
| `Intensity=…` | §5.5 | always |
| `SourceWidth=…`, `SourceHeight=…`, `BarnDoorLength=…` | sizes · `sizeK` | rect lights |
| `SourceRadius=…` | radius · `sizeK` | spot lights |
| `SoftSourceRadius=…` | soft · `sizeK` | only `left_rim_lgt` (the only one with a soft radius) |
| `AttenuationRadius=…` | atten · `k` | only `right_bounce_lgt`, `right_rim_lgt` |

Never touched: `Temperature`, `bUseTemperature`, `IntensityUnits`, `BarnDoorAngle`,
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

## 9. Built-in presets (measured UPH bounds, cm)

| model | SKU | W × D × H | arm | TQ shot |
|---|---|---|---|---|
| KOPER_LEFT_ARM_L_SECTIONAL_prod39250480 | 39250480 | 384 × 305 × 82 | L | TQL |
| Borgo · Double Partial-Back U | 39940015 | 423 × 276 × 80 | — | — |
| Borgo · Partial-Back Chaise-End U | 39940017 | 390 × 276 × 80 | — | — |
| Borgo · Partial-Back U | 39940016 | 390 × 307 × 80 | — | — |
| Borgo · Right-Arm Chaise | 39250509 | 361 × 210 × 80 | R | TQR |
| Borgo · Right-Arm L | 39250511 | 381 × 310 × 80 | R | TQR |
| Borgo · U | 39250513 | 453 × 280 × 80 | — | — |
| Koper · Chaise-End U | 39940020 | 394 × 276 × 83 | — | — |
| Koper · U-Chaise | 39250482 | 403 × 233 × 83 | — | — |
| Koper · U | 39250483 | 459 × 276 × 83 | — | — |
| Masson · Left-Arm 2-Seat Chaise-End U | 40460153 | 453 × 275 × 78 | L | TQL |
| Masson · Right-Arm Chaise-End | 39250417 | 361 × 200 × 78 | R | TQR |
| Masson · Right-Arm L | 39250419 | 312 × 246 × 77 | R | TQR |
| Masson · Right-Arm 2-Seat Chaise-End U | 40460154 | 453 × 275 × 78 | R | TQR |
| Masson · U-Chaise | 39250420 | 447 × 200 × 78 | — | — |
| Masson · U | 39250421 | 434 × 275 × 78 | — | — |
| Onic · Right-Arm L | 39250451 | 343 × 307 × 79 | R | TQR |

Dimensions are the UPH mesh bounds measured in the UE project, rounded to whole cm. If automation
measures bounds itself, round the same way to reproduce these numbers.

## 10. Sanity checks (advisory, do not block output)

| Check | Condition | Meaning |
|---|---|---|
| scale magnitude | `max(|sX−1|, |sY−1|, |sZ−1|) > 0.5` | rig stretched >150% — eyeball the look |
| aspect mismatch | `|(W/D)/(ref.W/ref.D) − 1| > 0.25` | footprint shape differs — check framing |
| peak intensity | `max(intensity) > 250 cd` | re-check camera exposure |

## 11. Acceptance — proving a port is correct

1. **Identity invariant.** `view=F`, `W×D×H = 453×274×77`, either mode → output must equal
   `rig_template.t3d` **byte for byte** (`k = 1` everywhere). If this fails, nothing else matters.
2. **Golden vectors.** For each case in `acceptance_vectors.json`: recompute, compare the
   per-light strings (`location`, `rotation`, `source_rotation`, `intensity`, source sizes,
   `attenuation_radius` — already formatted to 6 decimals, so no float comparison) and the SHA-256
   of the full T3D. `template_sha256` pins the skeleton itself. `rotation` vs `source_rotation`
   isolates aim bugs: if only `rotation` differs, §5.6 is what you got wrong.
3. **Aim vectors.** The three `scaleAim` cases in §5.10 — including that uniform scaling returns
   the input angles *exactly*, not approximately.
4. The reference implementation runs all of it:

```bash
python handoff/light_rig.py --selftest
```

Cases cover: identity (modes A and B), all four shots at reference, two presets, mode B, `swap`,
oversized/undersized sofas, and a non-default `ref`.

### 11.5 Checking the constants against the UE scene

Everything above proves a *port* matches the *tool*. It cannot prove the tool matches the
**scene** — `light_rig.json` and the golden vectors are generated from `index.html`, so they can
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
9. **`swap` describes the sofa, not the shot** — it only decides which input feeds world X vs Y,
   and the tool no longer exposes it in the UI (§4).
10. **Angles in degrees**, positions in cm; no unit conversion anywhere.
11. **LF, no trailing newline** (§7.2). Writing files on Windows: open in binary or disable
    newline translation, or the SHA-256 checks will fail.
12. **Don't re-round inputs.** `W/D/H` go into the math as given; only the *output* is rounded to
    6 decimals.
13. If the UE rig is ever re-tuned, `index.html` changes and this whole package must be
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
