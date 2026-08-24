# RH Local Renders

Local control centre for RH BatchRender jobs. It keeps the sectional light-rig reference in the browser, reads model geometry and FBX component IDs, creates `.job.json` files from the live Google Sheet, and launches one-shot renders in `D:\GitHub\rh_unreal_2`.

## Start

Double-click `Start_RH_Local_Renders.bat`, or run:

```powershell
cd D:\GitHub\RH_Local_Renders
npm start
```

Open `http://127.0.0.1:5500/`. The service binds only to localhost.

Default local paths:

- Unreal Editor: `D:\Unreal_Engine\UE_5.6\Engine\Binaries\Win64\UnrealEditor.exe`
- Unreal project: `D:\GitHub\rh_unreal_2\rh_unreal_2.uproject`
- models: `D:\GitHub\RH_Local_Renders\local\models\`
- jobs: `D:\GitHub\RH_Local_Renders\local\jobs\generated\`
- renders: `D:\GitHub\RH_Local_Renders\local\renders\`

Override them with `RH_UNREAL_EDITOR`, `RH_UNREAL_PROJECT`, `RH_MODELS_ROOT`, and `RH_CLASSIFIER_ROOT` environment variables.

## Current scope

- Model type: `Sectionals`
- Environment: `Indoor`
- Cameras: `F`, `FH`, `TQ` only
- Actor yaw: `F/FH = 0°`; `TQ R = -36°`; `TQ L/U = +36°`
- An import correction such as `-90°` is added to the camera Actor yaw. `model.Rotation` is deliberately not emitted because BatchRender does not parse it.
- Render layers: Fabric Path Trace 5K and optional Shadow Lumen 15K×5K.

The light rows are refreshed from the public Google Sheet (`gid=0`). `data/sectionals-indoor.csv` is the tracked fallback, and the latest successful download is cached under ignored `local/cache/`.

## Model inspection and generated presets

The model input accepts a full FBX path, exact filename, or unique product substring. Geometry metadata comes from `D:\GitHub\sectional-classifier\cache`; the existing report supplies corrected units, side, dimensions, and import-orientation warnings. Material IDs are the suffixes of component names after the last colon, for example `UPH`, `Stitches`, and `Feet`.

There are no bundled model presets. After a successful render produces images, the service adds that model to ignored `local/catalog.json` with its measured dimensions and render files. The UI then displays it under **Rendered models**.

## Light reference

`light-rig-reference.html` is the standalone scaler/schematic preserved from the original project. The dashboard embeds it and forwards the public page hash, so links such as `#v=F&W=343&D=307&H=79&m=A&cb=role` still configure the reference.

The scaler handoff remains in `handoff/`. Run `npm run handoff` after changing its rig constants.

## Verification

```powershell
npm test
```

The suite checks the old T3D golden vectors and UE exports, the cached sectional sheet, five-light job shape, material grouping, and the exact sectional actor-yaw rules.

The launcher is stored entirely in this repository. The stock BatchRender plugin already reads `ApiUrl` from `Config/DefaultEditor.ini`, fetches a job with `GET`, and reports events such as `render_finished`, `job_completed`, and `error` with `POST`. The dashboard exposes the same protocol at `http://127.0.0.1:5500/api/unreal` and overrides `ApiUrl` only for the launched process.

```powershell
UnrealEditor.exe rh_unreal_2.uproject `
  -BatchRender `
  -ini:Editor:[/Script/BatchRenderEditor.BatchRenderSettings]:ApiUrl=http://127.0.0.1:5500/api/unreal
```

The generated job is served once to that process. A render is marked successful only after the plugin posts `job_completed` and at least one output image was created or updated; the dashboard then closes that Unreal process. No source, config, batch file, binary, or commit is required in `rh_unreal_2` or its BatchRender submodule.

## Source and local data

Everything under `local/` is ignored: FBX files, generated jobs, cached sheet data, renders, and the generated catalogue must not be committed. The public/static dashboard remains safe when uploaded, but launching Unreal requires the localhost service.
