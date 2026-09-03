# Future render-pipeline improvements

This file records investigated or proposed improvements for a later dedicated implementation request. Items in the “hypothesis” section are not implemented yet.

## Implemented local changes

The local dashboard uses the UE 5.6 production renderer with Legacy Composure RGB-to-alpha recovery.

The BatchRender plugin has a separate local branch `codex/rh-fit-convergence`:

- `02ebd93` adds job-side focal handoff support;
- `5639d89` checks convergence using the newly calculated focal;
- `81359b8` checks the axis that actually limits the fitted frame;
- `2c39c1f` contains the compiled UE 5.6 plugin binaries.

On the measured heavy FBX, camera Fit changed from 20 non-converging iterations and roughly 33 seconds to 2 converged iterations and roughly 10 seconds per view, with the same camera state.

`RH_Local_Renders` also persists camera results in ignored `local/cache/camera-fit-profiles.json`. A repeat job can apply the cached location, rotation, and focal length with `fit: none`. Each view is saved as soon as Unreal reports it and is invalidated when the FBX, sequence/form factor, sequence asset, Actor/import yaw, padding, perspective setting, model scale, or compiled BatchRender plugin changes.

Important attribution detail: upstream BatchRender already sends the `sequence_camera_data` event through `SendSequenceCameraData`. Its camera structure includes at least location, rotation, focal length, sensor data, and related camera defaults. Our plugin branch did not introduce that outbound event. The local change adds job JSON support for `Camera.OverrideFocalLength` / `Camera.FocalLength`, queues focal overrides, and applies the saved focal to the Level Sequence. The local service consumes the existing outbound event, persists the complete camera state, and sends the transform/focal back to later phases and jobs.

## Current process and model lifecycle

Unreal restarts between render phases, not between every model. Models inside one phase are processed sequentially in the same editor process.

Between models, the current `ClearProduct` path still performs expensive work:

- deletes temporary `/BatchRender/Temp/*` StaticMesh and material packages;
- waits for StaticMesh compilation;
- ends and cleans PIE/world state;
- reloads `Composure.umap`;
- imports the next FBX.

For a new model using `Optimized crop`, the safe order can require four Unreal launches for the whole batch:

1. Crop Fabric with Substrate ON.
2. Crop Shadow with Substrate ON, followed by RGB-to-alpha normalization.
3. Final Fabric with Substrate ON.
4. Final Shadow with Substrate ON, followed by RGB-to-alpha normalization.

When crop profiles already exist, only Final Fabric and Final Shadow remain. The process boundaries preserve camera handoff and phase isolation; Substrate stays enabled throughout.

## Hypothesis: persistent StaticMesh cache and stable Composure map

1. Import an FBX once into an on-disk Unreal cache keyed by normalized FBX path, file size, and modified time. Add a content hash when stronger validation is required.
2. Store imported assets in a fingerprint namespace such as `/Game/RH_LocalCache/<fingerprint>/...` to prevent package-name collisions.
3. Load ready StaticMesh assets through Asset Registry in later Fabric, Shadow, and calibration phases instead of repeating Interchange import.
4. Keep `Composure` open throughout a phase. Between models, destroy only product actors/components and release references; do not delete the disk cache or execute `MAP LOAD` for every model.
5. Run GC or restart the editor only after a configurable number of models or when RAM/VRAM reaches a threshold. Keep the current `ClearProduct` path as a safe fallback.

The disk cache must not mean loading every cached model into memory. Only a bounded working set should be resident.

## Hypothesis: scheduling up to 10,000 models

The user-facing JSON can remain one logical job, while the local service produces smaller runtime shards based on estimated memory cost, FBX size, and vertex count. A shard might contain 10 heavy sofas or 25–50 light models.

The scheduler should track these states per model and view:

- imported asset cached;
- camera Fit cached;
- crop calibration cached;
- Fabric views complete;
- Shadow views complete;
- POST complete.

Only missing work should be emitted to Unreal. For this scale, a local SQLite queue is preferable to repeatedly scanning and rewriting one very large JSON. JSON remains the editable logical job; SQLite owns execution state, retries, shards, cache records, and completed outputs.

The primary expected performance gain is eliminating repeated FBX import and full map cleanup. Combining all four Optimized-crop phases into one Unreal process is still not the first target because the phases have distinct render configurations and camera-handoff requirements.

## Estimated implementation difficulty

Keeping the Composure map open and replacing `ClearProduct` with product-actor lifecycle management is a medium-risk plugin/Blueprint refactor. It requires strict reference cleanup and memory tests but is reasonably isolated.

Persistent imported packages are a larger change. It requires deterministic package names, Asset Registry lookup, import invalidation, save/load handling, material-ID preservation, disk limits/eviction, and a fallback when a cached package is incomplete.

Large-job sharding and durable scheduling are another separate layer. They should be implemented after the asset lifecycle is stable, not mixed into the first cache prototype.
