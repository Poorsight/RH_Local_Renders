# Local controller branches

Created 2026-09-11. These are local branches of `D:/GitHub/RH_Local_Renders`; they do not switch the Unreal project or its plugin.

Update 2026-09-16: active local controller branch is now `codex/ue56-integration`,
preserving the current controller features while targeting clean upstream project
and plugin `5.6`. See [ue56-switch-2026-09-16.md](ue56-switch-2026-09-16.md).
The older branch descriptions below remain historical recovery context.

| Branch | Purpose | Starting point |
| --- | --- | --- |
| `codex/current-project` | Restore and adapt the pre-migration controller for the current Unreal project on `main`, with BatchRender `41e4edc`. | Controller `e2f864b`, matching the source baseline captured on 2026-09-10. |
| `codex/experimental-cpp-plugin` | Preserve development for the rewritten native C++ BatchRender on its `5.6` branch. | Existing adapter history plus snapshot `9a4b163`, which includes all 11 previously uncommitted files. |

## Current-project branch status

Restored and built with the user's subsequent authorization on 2026-09-11. Both Fabric and Shadow use Substrate ON. Shadow RGB-to-alpha conversion runs in the Unreal plugin after MRQ; the controller's external RGB recovery is disabled. The controller still owns local crop calibration, job planning, preview and delivery POST.

The project and plugin each use a local `codex/current-project-integration` branch. The project starts at lighting commit `b4904ee`; its scene/material assets are preserved. The plugin starts at `41e4edc` and adds camera handoff (`56ad0d4`), focal convergence correction (`78720e3`), and native shadow processing (`9f4ec7e`), followed by a local rebuilt-binaries commit. The upstream limiting-axis fix is retained, not duplicated.

See [current-project-restoration.md](current-project-restoration.md) for actual test results and limits. Low-resolution technical tests do not certify every camera, model or historical lighting match.

## Experimental branch status

The snapshot preserves the tool-owned Python adapter, camera handoff, crop/cache changes, and the latest Shadow Substrate OFF mode. It does not certify the rewritten plugin's render results or compatibility with the legacy plugin currently checked out in the project.

## Switching and data safety

- Git switching changes source files only. An already running Node service keeps its loaded implementation until restarted; do not mix an old process with frontend files from a different branch.
- Switch only while renders and the saved-job queue are inactive, and restart the controller before using the selected branch for rendering, after its compatibility checks are satisfied.
- Both branches share ignored local jobs, images, settings and caches in this checkout. Branches are not separate runtime environments. Keep test job/output identities distinct and validate cache context before reuse.
- `main` and the unrelated `feature/preview-renders` branch are left unchanged. Neither new development branch was pushed or deployed by this operation.

## Recovery sources

Git preserves the controller baseline at `e2f864b`, the experimental snapshot at `9a4b163` (branch head `706a99f`), and the original plugin patch commits `2668a2e`, `2edff0c`, `477c123`. Desktop archives recorded during the earlier backup were not present when checked during restoration; do not rely on those paths as the only recovery copy.
