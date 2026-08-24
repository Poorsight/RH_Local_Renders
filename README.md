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

Override them with `RH_UNREAL_EDITOR`, `RH_UNREAL_PROJECT`, and `RH_MODELS_ROOT` environment variables.

## Current scope

- Model type: `Sectionals`
- Environment: `Indoor`
- Cameras: `F`, `FH`, `TQ` only
- Actor yaw: `F/FH = 0°`; `TQ R = -36°`; `TQ L/U = +36°`
- An import correction such as `-90°` is added to the camera Actor yaw. `model.Rotation` is deliberately not emitted because BatchRender does not parse it.
- Render layers: Fabric Path Trace 5K and optional Shadow Lumen 15K×5K.

The light rows are refreshed from the public Google Sheet (`gid=0`). `data/sectionals-indoor.csv` is the tracked startup fallback; a successful refresh is kept in memory for the current session.

## Model inspection and generated presets

The model input accepts a full FBX path, exact filename, or unique product substring. The tracked `data/models.json` keeps the dimensions, side, import correction and Material IDs required by the 16 current FBX files, so the dashboard does not depend on another classifier project at runtime.

An FBX can also be dropped directly onto the model field (or selected with **Choose FBX**). The local dashboard matches its filename against the indexed models, fills the full Windows path, and runs the same inspection. The FBX is not uploaded or copied.

There are no bundled model presets. After a successful render produces images, the service adds that model to ignored `local/catalog.json` with its measured dimensions and render files. The UI then displays it under **Rendered models**.

## Light reference

The sectional light-rig scaler and schematic are native parts of the dashboard, using the same controls, typography, colours, and responsive layout as the render workflow. X/Y light positions use one shared scale while every source keeps its original Z coordinate, including height-only changes. It reads the tracked `data/sectionals-indoor.csv` directly in the browser, so the reference also works on the static preview without the local service.

## Verification

```powershell
npm test
```

The suite checks model metadata, the sectional sheet, fixed-Z five-light jobs, material grouping, the exact actor-yaw rules, the Unreal launcher contract, and the native dashboard surface.

The launcher is stored entirely in this repository. The stock BatchRender plugin already reads `ApiUrl` from `Config/DefaultEditor.ini`, fetches a job with `GET`, and reports events such as `render_finished`, `job_completed`, and `error` with `POST`. The dashboard exposes the same protocol at `http://127.0.0.1:5500/api/unreal` and overrides `ApiUrl` only for the launched process.

```powershell
UnrealEditor.exe rh_unreal_2.uproject `
  -BatchRender `
  -ini:Editor:[/Script/BatchRenderEditor.BatchRenderSettings]:ApiUrl=http://127.0.0.1:5500/api/unreal
```

The generated job is served once to that process. A render is marked successful only after the plugin posts `job_completed` and at least one output image was created or updated; the dashboard then closes that Unreal process. No source, config, batch file, binary, or commit is required in `rh_unreal_2` or its BatchRender submodule.

## Source and local data

Everything under `local/` is ignored. Only `local/models/` is kept as permanent input; `local/jobs/`, `local/renders/` and `local/catalog.json` are created later by the application as working output and must not be committed. The public/static dashboard remains safe when uploaded, but launching Unreal requires the localhost service.

## Project layout

```text
app.js / app.css / index.html   browser dashboard
server.cjs                     localhost API and render process control
lib/                           jobs, models, light data and Unreal launch logic
data/                          tracked model metadata and light fallback
test/                          product regression tests
scripts/deploy.sh              preview deployment
local/models/                  ignored FBX input only
```
