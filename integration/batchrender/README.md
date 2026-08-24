# BatchRender camera handoff bridge

RH Local Renders needs one capability that BatchRender commit `6da4ae0` does not expose in its documented job JSON: applying a focal length calculated during Fabric to a later Shadow process.

The integration is intentionally kept outside the BatchRender submodule:

- `rh-camera-handoff.patch` is the complete, reviewable upstream delta.
- `scripts/setup-batchrender-bridge.ps1` detects built-in support, an already applied patch, a cleanly applicable patch, stale binaries, and incompatible upstream changes.
- The script never resets the plugin, deletes files, changes assets, commits, or pushes.
- If a future plugin update includes equivalent support, marker detection treats it as built-in and patch application becomes a no-op.
- If an upstream update conflicts, the script exits before changing any files.

Check after every BatchRender update:

```powershell
.\scripts\setup-batchrender-bridge.ps1 -Action Check
```

Apply and rebuild when required:

```powershell
.\scripts\setup-batchrender-bridge.ps1 -Action Setup
```

Expected final state is `Ready`. A clean plugin commit that contains both the supported C++ source and its DLLs stays `Ready` after a branch checkout even though Git changes file timestamps. `RebuildRequired` means locally changed C++ source is newer than the DLLs. `PatchRequired` means the current upstream source is compatible but unpatched. `Incompatible` requires reviewing the new upstream version and refreshing the patch; no partial patch is left behind.

Long term, this small change should be merged into the BatchRender upstream repository. The local compatibility layer can remain as the version/status guard.
