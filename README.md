# Sectional — Light Rig Scaler

A static site (a single `index.html`, no build step) that scales the light rig
for sectional sofas to the required dimensions and outputs a ready-to-use **T3D** for pasting
into Unreal via `Ctrl + V`.

## How to use

1. Open the site.
2. Enter the sofa dimensions: **Width (X)**, **Depth (Y)**, **Height (Z)** in cm.
3. Click **"Copy"**.
4. In Unreal: click in the level viewport → `Ctrl + V`. Five lights will appear
   (`front_fill_lgt`, `main_key_lgt`, `left_rim_lgt`, `right_bounce_lgt`, `right_rim_lgt`)
   in the `Lights` folder.

Use the **Scene schematic** to validate the result before copying. It opens in **Split**
with Plan and Elevation visible together; either view can be expanded. Click a light (or
its colored chip) to inspect its position, aim, intensity, source size, and how much the
unknown sofa dimensions changed it. The calm role palette, stronger engineering grid,
animated aim vectors, light cones, and selection pulse make changes easier to track.
The schematic expands its world-space bounds to match each viewport aspect, so the
dimension grid always fills the canvas without stretching or cropping the scene.

Render previews are loaded from the server when matching files exist under
`Renders/<material>/<render-prefix>_<shot-suffix>.png` next to `index.html`.
The board reads `Renders/manifest.json` when present (regenerate it with
`npm run gen:manifest -- path/to/Renders` after changing render files) and shows
exactly the listed files; without a manifest it falls back to probing the known
material folders. There is no browser drag-drop upload; missing render files are
simply hidden. Per-image comments are shared for everyone through `comments.php`
next to `index.html` (stored in `render-comments.json` on the server); if the
endpoint is unavailable, comments quietly fall back to this browser's
`localStorage`.
For TQ shots, left-arm presets show server renders only in `TQ-R`;
right-arm presets only in `TQ-L` — **the arm-side mapping is crossed on purpose**, the letters in
the shot keys name the rigs and not the arm side (HANDOFF_FORMULA §8). `F` and `FH` renders stay
available for every model.
The bundled default preset is `KOPER_LEFT_ARM_L_SECTIONAL_prod39250480`
with dimensions `384 x 305 x 82`.

> When you enter dimensions equal to the reference ones (453 × 274 × 77), the output matches
> the original rig byte for byte — a handy way to verify that nothing has "drifted".

## Scaling logic

| What | Rule |
|---|---|
| Positions | per-coordinate: `X·(W/453)`, `Y·(D/274)`, `Z·(H/77)` |
| Aim | pitch/yaw follow the same non-uniform X/Y/Z scaling, keeping each light aimed at the same relative sofa area |
| Light distance | `k = |new_pos| / |old_pos|` (individual to each light) |
| Intensity, mode **A** | light sizes `×k`, intensity `×k²` (inverse square holds strictly) |
| Intensity, mode **B** | sizes unchanged, `I·(k²·d² + R²)/(d² + R²) ≈ I·k^p`, where `p = 2d²/(d²+R²)` |
| AttenuationRadius | `×k` (follows the distance) |
| Roll, color, temperature | unchanged (pitch/yaw change only when the axis scales differ) |

- **Axes:** world X ↔ width (453), Y ↔ depth (274), Z ↔ height (77). Determined by
  the fill: `SourceWidth = 500 ≈ 453`. (`computeAll`'s `swap` flag swaps X↔Y; the UI checkbox for it was removed.)
- **Mode A** — recommended: preserves the character of the shadows, with predictable `k²`.
- **Mode B** — explains why "inverse square doesn't work": for large soft
  lights (fill, left_rim), `R` is comparable to the distance → softer falloff (`~k^1.7`),
  while for the sharp `main_key` → almost `k²`.
- **Non-uniform sectionals:** the tool scales each light's direction vector and derives new
  pitch/yaw, preventing aim drift on unusually wide or deep layouts. At the reference size
  and under uniform scaling the original rotations remain byte-identical.

## Automating this

`handoff/` is a self-contained package for reproducing the rig outside the browser:
[`handoff/HANDOFF_FORMULA.md`](handoff/HANDOFF_FORMULA.md) (formula incl. the aim transform,
constants, T3D contract, porting gotchas), machine-readable constants, golden acceptance vectors,
a Python reference implementation, and the UE scene exports the rig is checked against.

```bash
python handoff/light_rig.py --preset 39250480 --view auto -o rig.t3d
python handoff/light_rig.py --selftest      # proves it matches the web tool byte for byte
npm run verify:scene                        # proves the rig still matches the UE scene
npm run handoff                             # regenerate handoff data after editing the rig
```

The acceptance vectors are generated from `index.html`, so they prove a *port* matches the
*tool*. `npm run verify:scene` is the other direction: it compares each shot against
`handoff/ue_reference/<shot>.t3d` — the rig as exported from Unreal (`Ctrl + C` on the five
lights) — and is the only check in the repo with an external reference. Re-export and re-run it
whenever the rig is re-tuned.

## Deploy to GitHub Pages

**Option 1 — separate repository:**
```bash
# copy the contents of light-rig-web/ into a new repository
git init && git add . && git commit -m "light rig scaler"
git branch -M main
git remote add origin <repo-url>
git push -u origin main
```
Settings → Pages → Source: `main` / `/ (root)`. Site: `https://<user>.github.io/<repo>/`.

**Option 2 — `/docs` folder in the current repository:**
rename `light-rig-web/` → `docs/`, then in Settings → Pages choose `main` / `/docs`.

No build is required — this is a pure static file.

For the preview deployment used in production, keep the deployed folder together with its
`Renders/` directory so the relative image URLs resolve correctly, and regenerate
`Renders/manifest.json` whenever render files are added or renamed.
