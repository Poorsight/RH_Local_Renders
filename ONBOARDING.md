# RH Local Renders — agent handoff

## Product state

The project has two coupled surfaces:

1. `index.html`, `app.css`, `app.js`, and `server.cjs` form the local render-control dashboard.
2. `light-rig-reference.html` is the standalone sectional light-rig calculator preserved as a visual reference and embedded near the bottom of the dashboard.

Do not add bundled model presets. A preset is a generated catalogue entry and may appear only after a successful local render has produced image files.

## Data flow

```text
FBX name/path
  -> sectional-classifier cache/report
  -> dimensions + side + import yaw + component Material IDs
  -> Google Sheets Sectionals / Indoor rig (tracked CSV fallback)
  -> local/jobs/generated/<model>.job.json
  -> UnrealEditor rh_unreal_2.uproject -BatchRenderJob=...
  -> local/renders/<model>/
  -> local/catalog.json
```

`server.cjs` uses only Node built-ins and binds to `127.0.0.1`. Keep process launches argument-based with `shell:false`; never accept executable names or arbitrary command arguments from the HTTP request.

## Sectional rules

- Only `F`, `FH`, and `TQ` are valid. `P` and `TQB` are Sofa cameras and must not enter sectional jobs.
- Actor rotations from sheet `gid=419483503`: `F/FH = 0`, `TQ R = -36`, `TQ L = +36`, `TQ U = +36`.
- Add `importYaw` to those Actor yaw values. BatchRender's `FModelData` has no rotation field.
- `Sectional_Indoor_R` uses its own TQ light rig. L and U share the second TQ light rig.
- Padding is `0.0016` on all four sides with snapping false.
- Fabric is `4_k_PathTrace_PNG`, 5000×5000, 36×36 sensor.
- Shadow is `4_k_Lumen_PNG_Background_Shadows`, 15000×5000, 108×36 sensor, `PostProcess_shadow`.

Light positions/intensities use the rigid-rig formula documented in `handoff/HANDOFF_FORMULA.md` and tested against four UE exports. Source geometry is intentionally local code data because the Google Sheet does not contain emitter sizes.

## Unreal bridge

`D:\GitHub\rh_unreal_2\Plugins\BatchRender\Source\BatchRenderEditor` parses `-BatchRenderJob=<file>`, invokes the existing `TestJob` path after editor initialization, suppresses the background API queue, and optionally exits through `-BatchRenderExitOnComplete`.

The Unreal repository and BatchRender submodule may contain unrelated user changes, especially `.uasset` and material/texture folders. Preserve them.

## Commands

```powershell
cd D:\GitHub\RH_Local_Renders
npm test
npm start

& D:\Unreal_Engine\UE_5.6\Engine\Build\BatchFiles\Build.bat `
  UnrealEditor Win64 Development `
  -Project=D:\GitHub\rh_unreal_2\rh_unreal_2.uproject `
  -WaitMutex -NoHotReloadFromIDE
```

For UI changes, check desktop and 390px mobile layouts, interactions, horizontal overflow, loading/offline states, and browser console errors.

## Public preview

Keep the historical `/dmitriy.derevyanko/light-rig/` URL working. The static copy shows the dashboard and embedded reference; local actions show offline unless `server.cjs` is running on the same origin. The hash is forwarded to `light-rig-reference.html`.
