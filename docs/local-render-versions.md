# Local renderer versions

Updated 2026-09-16. The active workflow is the rewritten upstream UE 5.6 plugin.

| Component | Active version | Retained legacy version (local only) |
|---|---|---|
| RH_Local_Renders tool | `5.6` (formerly `codex/ue56-integration`) | `codex/current-project` |
| rh_unreal_2 project | `5.6`, with the six main lighting/scene assets (`4da1981`) | `codex/current-project-integration`, `7681430` |
| BatchRender plugin | `5.6`, `f65c13e` | `codex/current-project-integration`, `a07bccb` |

The active service on port 5500 uses `D:/GitHub/rh_unreal_2/rh_unreal_2.uproject`.
The project and plugin in that directory must remain on their matching `5.6` branches.

## Legacy camera fit

The legacy plugin keeps the local camera handoff and native Substrate shadow integration,
but no longer contains the early-convergence change `78720e3`. The only source change
from `6b24855` is restoring the original residual projection in
`Source/BatchRender/Private/BatchRender.cpp`; rebuilt DLL/PDB files are committed locally.
The legacy project pins that exact plugin commit. This is not a change to public main.

There was no three-iteration cap in the JavaScript tool to remove. The solver permits up
to 20 iterations and exits on convergence. After removal of the old local residual check,
BELLA F and BLAKE FH/TQ converge in three iterations, give the requested 8-pixel side
margins, and their six Fabric frames match the tested 5.6 frames exactly in RGBA.

Restore the legacy workflow only by deliberately selecting the matching legacy tool,
project and plugin branches, with Unreal closed and local assets preserved. Switching
the tool branch alone does not select a different Unreal project or plugin.

## Comparison evidence

Render images and reports remain under ignored `local/renders/compare_*` and
`local/validation/2026-09-16/`. Temporary comparison project directories and their
test-only branch names are retired. Cleanup backups/manifest are kept under
`local/validation/2026-09-16/comparison-cleanup/`.

No remote branch, FTP deployment, production light, material or renderer source is
changed by selecting this local workflow.
