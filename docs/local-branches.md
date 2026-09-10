# Local controller branches

Created 2026-09-11. These are local branches of `D:/GitHub/RH_Local_Renders`; they do not switch the Unreal project or its plugin.

| Branch | Purpose | Starting point |
| --- | --- | --- |
| `codex/current-project` | Restore and adapt the pre-migration controller for the current Unreal project on `main`, with BatchRender `41e4edc`. | Controller `e2f864b`, matching the source baseline captured on 2026-09-10. |
| `codex/experimental-cpp-plugin` | Preserve development for the rewritten native C++ BatchRender on its `5.6` branch. | Existing adapter history plus snapshot `9a4b163`, which includes all 11 previously uncommitted files. |

## Current-project branch status

This branch is a restoration baseline, not a completed compatibility release. The legacy camera-handoff patch passes `git apply --check` against plugin `41e4edc`, but it has not been applied or compiled as part of this branch split. That check alone does not prove runtime compatibility. Existing bridge checks may correctly reject an unpatched plugin.

The old controller's shadow defaults come from the baseline. The baseline archive also contains an experimental native Substrate shadow processor. Choosing which shadow mode to restore remains pending; do not infer that making these branches authorizes restoring that processor or launching a render.

Keep the current project's lighting commit `b4904ee` and scene/material assets. Any needed local plugin adaptation belongs on a separate local plugin branch; do not rewrite project or plugin remote history.

## Experimental branch status

The snapshot preserves the tool-owned Python adapter, camera handoff, crop/cache changes, and the latest Shadow Substrate OFF mode. It does not certify the rewritten plugin's render results or compatibility with the legacy plugin currently checked out in the project.

## Switching and data safety

- Git switching changes source files only. An already running Node service keeps its loaded implementation until restarted; do not mix an old process with frontend files from a different branch.
- Switch only while renders and the saved-job queue are inactive, and restart the controller before using the selected branch for rendering, after its compatibility checks are satisfied.
- Both branches share ignored local jobs, images, settings and caches in this checkout. Branches are not separate runtime environments. Keep test job/output identities distinct and validate cache context before reuse.
- `main` and the unrelated `feature/preview-renders` branch are left unchanged. Neither new development branch was pushed or deployed by this operation.

## Recovery sources

- `C:/Users/Dima/Desktop/BatchRender_Baseline_2026-09-10/snapshots/render-tool-source.zip`
- `C:/Users/Dima/Desktop/BatchRender_Baseline_2026-09-10/snapshots/plugin-working-tree.zip`
- `C:/Users/Dima/Desktop/BatchRender_UE56_2026-09-10/rh-local-history.bundle`

