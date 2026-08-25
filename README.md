# RH Local Renders

Local control centre for RH BatchRender jobs. It keeps the sectional light-rig reference in the browser, reads model geometry and FBX component IDs, creates `.job.json` files from the live Google Sheet, and launches one-shot renders in `D:\GitHub\rh_unreal_2`.

## Start

Double-click the **RH Local Renders** desktop shortcut. It starts the existing batch file without a visible terminal, waits for the local service, and opens the dashboard. Reopening the shortcut while the current service is already running only opens the site; if runtime files changed, it safely replaces that stale localhost process before opening the page.

The underlying launchers are `Launch_RH_Local_Renders.vbs` and `Start_RH_Local_Renders.bat`. You can also run the batch file directly, or use:

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

Fabric and Shadow are separate Unreal phases because Substrate requires an editor restart. Fabric launches with the effective project override `r.Substrate=True`; Shadow launches in a fresh Unreal process with `r.Substrate=False`, which keeps Composure compatible. If both layers are selected, the service waits for Fabric `job_completed` and changed output files, closes Unreal, then starts Shadow. The override is passed with `-ini:Engine:[/Script/Engine.RendererSettings]` for that process only, so `rh_unreal_2/Config/DefaultEngine.ini` stays unchanged and its normal `r.Substrate=True` setting is preserved. The saved parent job keeps default camera lights plus its local Shadow-light variant; before each Unreal launch the runtime strips the local metadata and gives BatchRender only the active phase's normal `lights` array. For the current Sectionals rules, Shadow overrides `main_key_lgt` with base intensity `100`, inner cone `45`, and outer cone `60`; blank Shadow transform fields inherit the default transform. Both base intensities go through the same model-size/source-mode correction, and light Z remains fixed.

The light rows are refreshed from the public Google Sheet (`gid=0`). `data/sectionals-indoor.csv` is a tracked offline startup copy of the same Sectionals/Indoor rules, not a user cache that needs to be cleared. A successful live refresh is kept in memory for the current service session; the tracked copy lets the service and static reference start with the latest verified rules when Google Sheets is unavailable.

## Model batches, automatic inspection, and generated presets

The model input accepts a full FBX path, exact filename, or unique product substring. **Choose FBX** and drag-and-drop accept multiple files at once and add them to one model batch. Selecting a row opens that model's dimensions and import yaw; removing a row does not touch the FBX on disk.

The tracked `data/models.json` keeps the metadata for the original 16 FBX files. A new FBX placed in `local/models/` is analyzed automatically on first inspection with the installed local Blender: the service reads its bounds, unit scale, back orientation, exact `L`/`R`/`U` sectional form factor, import yaw, and component Material IDs. The name markers (`LEFT_ARM`, `RIGHT_ARM`, and U-shape names) take priority; ambiguous names fall back to the measured footprint. The result is cached in ignored `local/model-metadata.json` and is refreshed if that FBX changes. No file is uploaded or copied, and the runtime does not depend on the old `sectional-classifier` project. Set `RH_BLENDER` only if Blender is installed outside `C:\Program Files\Blender Foundation\`.

Material assignments are normalized from the final component-name word with digits removed: long names ending in `_UPH` and `_UPH1` become one `UPH` row, and the same applies to `Stitches` and `Feet`. One RH material value is applied to every exact source mesh ID in that group, while each task receives only the IDs present in its own FBX. **Generate job** creates one uniquely named `.job.json` whose `tasks` contain every model, while dimensions, side, import yaw, lights, and output folder remain model-specific. Single-model jobs also receive a timestamped JSON and output folder, so generating another job never overwrites the earlier one.

The static preview uses the same tracked `data/models.json`: dropping any batch made from the 16 known FBX files restores their expected `D:\GitHub\RH_Local_Renders\local\models\…` paths and groups their Material IDs without uploading files. First-time analysis of a new FBX, job generation, and Unreal launch require `Start_RH_Local_Renders.bat` because a public web page cannot run Blender or local processes.

There are no bundled model presets. **Render & job history** discovers the JSON jobs and render files already stored under `local/`, including output from a completed plugin run even if a previous browser session missed its final event. A saved job can be selected, opened as a raw `application/json` document for JSONVue or the browser's built-in JSON viewer, shown in Explorer, or launched again. If a new tab is blocked, **View JSON** falls back to the in-page formatted dialog. **Review batch** loads its model list into the native light rig; selecting a model restores that job's dimensions, side, source mode, completion state, and disk render gallery. Each camera shows Fabric, Shadow, and a centered pixel-grid composite of Fabric over the 3:1 Shadow canvas on a neutral checkerboard.

## Automatic delivery post-process

After every successful render plan, the local service automatically prepares the delivery images described by the RH farm handoff. The original Unreal PNG is never opened for writing. A separate file with the `_POST.png` suffix is created beside it through a temporary file and atomic rename, then its mtime is matched to the source. Running the operation again skips current outputs; changing an original causes only its processed counterpart to be regenerated. Saved jobs also expose a **Post-process** action for completing or retrying an older batch without rendering it again.

Both layers are centered without scaling on a transparent `15000×5000` canvas. Fabric is converted from its embedded/source sRGB interpretation to `AdobeRGB1998`. Shadow keeps its alpha, replaces RGB with `#120C06`, self-composites at 25% alpha for `F`, `FH`, and `TQ`, and receives the Adobe RGB profile without an RGB conversion. Both outputs are tagged as 300 DPI and receive a PNG render passport with the job, product, material, camera, source filename, model path, mesh-material map, and available camera data. Settings live in `data/postprocess.json`; the exact delivery profile is tracked at `assets/AdobeRGB1998.icc`.

The pipeline uses the installed libvips executable at `C:\vips\vips-dev-8.18\bin\vips.exe`. Set `RH_VIPS` to another executable when needed. Preflight blocks a new render if libvips or the profile is unavailable, preventing a batch from finishing without its expected post-process capability. History counts only original render frames; processed companions appear as `POST` and are preferred by the gallery and Combined preview.

The legacy inches-as-centimetres FBX profile uses the opposite X handedness during Unreal import. Automatic inspection accounts for this when deriving import yaw; the affected `prod9910052` model therefore uses `+90°`, while normal metre exports keep the established orientation rule.

## Light reference

The sectional light-rig scaler and schematic are native parts of the dashboard, using the same controls, typography, colours, and responsive layout as the render workflow. X/Y light positions use one shared scale while every source keeps its original Z coordinate, including height-only changes. It reads the tracked `data/sectionals-indoor.csv` directly in the browser, so the reference also works on the static preview without the local service.

## Verification

```powershell
npm test
```

The suite checks tracked and auto-cached model metadata, multi-model jobs, shared Material ID filtering, the sectional sheet, fixed-Z five-light jobs, the exact actor-yaw rules, the Unreal launcher contract, and the native dashboard surface.

The launcher is stored entirely in this repository. The stock BatchRender plugin already reads `ApiUrl` from `Config/DefaultEditor.ini`, fetches a job with `GET`, and reports events such as `render_finished`, `job_completed`, and `error` with `POST`. The dashboard exposes the same protocol at `http://127.0.0.1:5500/api/unreal` and overrides `ApiUrl` only for the launched process.

```powershell
UnrealEditor.exe rh_unreal_2.uproject `
  -BatchRender `
  -ini:Editor:[/Script/BatchRenderEditor.BatchRenderSettings]:ApiUrl=http://127.0.0.1:5500/api/unreal
```

Each generated phase job is served once per Unreal attempt. Completion is measured from actual output files for every model, camera, and layer. If Unreal exits before the phase is complete, the service automatically restarts that phase up to three times with only incomplete models; completed model output and Fabric camera handoff data stay in place. Manual **Retry failed** uses resume mode and also skips complete files. A phase advances only when every expected output exists (and Fabric has supplied all camera states); the dashboard then closes that Unreal process. A combined Fabric/Shadow run is successful only when both ordered phases complete. No persistent config edit is made in `rh_unreal_2`.

## Source and local data

Everything under `local/` is ignored by Git. `local/models/` is permanent input; `local/jobs/` and `local/renders/` are the durable local history displayed by the dashboard and should be retained until the user chooses to remove them. None of these files are committed. The public/static dashboard remains safe when uploaded, but local history and Unreal launch require the localhost service.

## Project layout

```text
app.js / app.css / index.html   browser dashboard
server.cjs                     localhost API and render process control
lib/                           jobs, history, models, light data and Unreal launch logic
data/                          tracked model metadata and light fallback
test/                          product regression tests
scripts/deploy.sh              preview deployment
local/models/                  ignored FBX input only
```
