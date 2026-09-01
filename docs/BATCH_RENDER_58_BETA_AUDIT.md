# BatchRender, AutoFit, and UE 5.8 beta integration audit

Prepared: 2026-08-28

## AutoFit: the actual iteration count

The active `horizontalFocalLength` implementation is `FindHorizontalDesiredLocationAndFocalLengthByVertexes` in `Plugins/BatchRender/Source/BatchRender/Private/BatchRender.cpp`.

- `ConvergenceCount` defaults to 20 in `BatchRender.h`. This is the library default, not the active production setting.
- The active BatchRender Blueprint call was deliberately configured with `ConvergenceCount=2`, so the current production AutoFit can execute no more than two outer iterations.
- Each iteration recenters horizontally and then adjusts focal length.
- Normal convergence stops when both the horizontal offset error and zoom error are at most 1 pixel.
- A second early exit occurs when focal length hits its clamp twice consecutively; the best result seen so far is returned.
- The optional vertical snapping loop also has the same maximum, but it runs only when exactly one of top/bottom snapping is enabled. Current jobs set every snapping flag to `false`, so this loop does not run.
- The final log writes `OutConvergenceIndex + 1`, so its `Iters=N` value is the real number of completed outer iterations.

Evidence from the current UE 5.6 saved logs: 32 recorded calls, of which 31 converged in 2 iterations and 1 converged in 1 iteration. This distribution is consistent with the explicit two-iteration Blueprint limit. Every recorded call also reported `Converged=1`, meaning the current samples reached the C++ `<= 1 px` condition within that limit.

Conclusion: in the reusable C++ function the programmer is correct about early termination, although the exact condition is not a vague “super-small delta”; it is two absolute pixel errors `<= 1`. But in the current production Blueprint, five iterations are impossible because we explicitly cap the call at two. The logs alone could not distinguish this override from natural early convergence; the active call configuration is decisive. The earlier statement that production AutoFit “does 20 passes” was incorrect.

## Current local render flow

1. The website sends the selected models, type, cameras, layers, frame profile, crop mode, material mapping, and optional resolution overrides to `POST /api/jobs`.
2. `lib/jobs.cjs` validates the selection and writes a BatchRender-compatible `job -> tasks -> cameras/materials/layers` JSON under `local/jobs/generated`.
3. `lib/render-plan.cjs` expands the job into process-isolated phases. For an optimized crop with no valid cache this is calibration Fabric, one or more calibration Shadow phases, final Fabric, and one or more final Shadow phases. Shadow phases are split per model when they inherit a fitted Fabric camera.
4. `server.cjs` starts Unreal Editor separately for every phase. It overrides `r.Substrate=True` and the BatchRender `ApiUrl` on the command line.
5. Unreal polls `GET /api/unreal`. The local service returns the pending phase job once and then returns HTTP 204.
6. Unreal imports the model, resolves sequences/presets by name, expands subtasks, starts PIE/MRQ, and POSTs events to the same URL.
7. Fabric `sequence_camera_data` is persisted and handed to the matching Shadow camera with `fit=none`, so both layers use the same evaluated camera.
8. When a Shadow phase completes, hidden RGB is converted to visible alpha. The UI exposes this as a separate progress phase.
9. Crop calibration waits for the converted Fabric + Shadow pair, finds significant alpha rows in both, adds a 5% margin, makes the result vertically symmetric, aligns height to 8 pixels, and applies the same ratio to pixel height and sensor height.
10. After all render phases, delivery POST is built. Progress and completed counts are recorded and job history derives its POST count from the manifest/delivery files.

The service currently supports one active render plan and one Unreal process at a time. A phase can restart up to three times while preserving completed model outputs.

## Review of the UE 5.8 MCP report

### Already covered by RH_Local_Renders

- **Compatibility API:** already implemented at `/api/unreal`; this is the suggested GET/POST single-URL polling adapter.
- **ApiUrl configuration:** an empty value in `DefaultEditor.ini` is intentional for safety. The runner injects its local URL using an Unreal command-line INI override for each process.
- **Current jobs:** the tool generates jobs with current production sequence/preset names and machine paths. The stale `Plugins/BatchRender/Tests/Jobs/Test_*` fixtures do not affect normal tool runs.
- **Single-job claim behavior:** the local bridge returns one phase job once, then 204. It matches events to the active job before completing the phase.
- **Access boundary:** `/api/unreal` is loopback-only. The website also has optional bearer-key protection for non-local mutations.
- **Progress and history:** render, Shadow recovery, delivery POST, camera handoff, resume, and POST history counts already exist.

### Required before the first useful UE 5.8 beta render

- Add a render-target selection that resolves the UE 5.8 editor and `D:\GitHub\rh_unreal_2_58\rh_unreal_2.uproject` per job instead of using the current global UE 5.6 constants.
- Stamp every generated job/history record with target ID, engine version, project, and shadow-pipeline mode.
- Connect the new Composite Shadow Reflection Catcher to the dynamically imported sofa actors. The existing UE 5.8 proof uses a proxy cube; this is not yet BatchRender integration.
- Make the UE 5.8 Shadow layer/preset produce the standalone RGBA catcher result. Current generated jobs still request the legacy `PostProcess_shadow` path and `4_k_Lumen_PNG_Background_Shadows`.
- Run one complete generated tool job through GET -> render events -> camera handoff -> files -> `job_completed` -> history.
- Compare UE 5.8 Fabric output against UE 5.6/reference renders before exposing the beta to routine use.
- Keep cache identities target-specific. The current camera/crop tokens include the project/renderer fingerprint, but target ID should also be explicit for diagnosis and future same-path upgrades.

### Required for a production multi-worker farm, but not a blocker for local beta

- Versioned JSON Schema (or equivalent strict validation) for the boundary between a central queue and workers.
- Worker identity, atomic claim/lease, acknowledgement, heartbeat, and job retry/idempotency rules.
- Authentication between central queue and workers. Loopback-only authorization is enough only while each worker talks to its own local controller.
- Require successful HTTP status codes in the Unreal GET client.
- Persist/retry outgoing Unreal events or make completion recoverable by output reconciliation.
- A migrated automated smoke fixture that does not use deleted `Test_*` assets.

### Not required unless the worker architecture changes

- An inbound HTTP server inside Unreal. The current polling model is simpler and already matches the tool.
- A packaged standalone worker. The present system intentionally launches Unreal Editor and PIE; Editor-only is acceptable if that remains the farm contract.
- Re-enabling a fixed API URL in project config. Per-process injection prevents accidental contact with a production queue.

## Recommended beta target model

Use explicit target records rather than one global editor/project pair:

| Target | Editor/project | Shadow pipeline | Status |
| --- | --- | --- | --- |
| `ue56-production` | UE 5.6 + primary project | `legacy-substrate-recovery` | current default |
| `ue58-beta` | UE 5.8 + migrated copy | `native-composite-rgba` | opt-in beta |

The selected target should be saved into the job, displayed in active progress and history, and used by preflight. Engine choice must be immutable after a job starts.

For `ue56-production`, run Shadow RGB-to-alpha recovery before crop and preview. For `ue58-beta`, first validate that native RGBA alpha is non-empty, then skip recovery. Both targets may continue through the common delivery stage for canvas, color profile, DPI, metadata, naming, and `POST` layout.

## Readiness verdict

- **UE 5.6 local rendering:** operational with the current Substrate shadow recovery/crop/delivery pipeline.
- **UE 5.8 plugin parser and orchestration:** technically loadable and compatible with the polling bridge.
- **UE 5.8 as a website beta:** not ready yet; the missing work is mainly target selection plus connecting the new Composite shadow output to imported furniture and running an end-to-end job.
- **UE 5.8 for a production farm:** not ready; complete beta visual validation first, then add distributed-worker reliability controls.
