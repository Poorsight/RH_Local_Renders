# Codex handoff for Claude

Use this file to resume the current work without reading the whole chat.

## Current task
Continue the `feature/preview-renders` work for `D:\GitHub\light-rig-scaler`.

The user wants render previews to come from server files instead of browser drag-drop uploads. The deployed tool and render folders are expected to live together so relative URLs like `Renders/...` resolve from the same origin.

## What Codex changed
- Created a Codex skill equivalent to Claude's preview deploy skill:
  - `C:\Users\Dima\.codex\skills\preview-deploy`
  - Windows uploader: `scripts\upload-preview.ps1`
  - Private local config: `deploy.config`
- Replaced the old `index.html` render board:
  - Removed drag-drop file input.
  - Removed IndexedDB image storage, export, and import.
  - Added server render loading from `Renders/<material>/<prefix>_<suffix>.png`.
  - Added `localStorage` comments keyed by final image URL with prefix `lrs_render_comment:`.
- Updated `ONBOARDING.md` and `README.md` for the new server-render workflow.

## Render filename assumptions
Material folders currently wired in `index.html`:
- `PERFORMANCE_LINEN_WEAVE_CAMEL_V1`
- `VELVETY_NATURAL_V1`

Built-in presets have an `r` property used as the filename prefix, for example:
- `BORGO_RIGHT_ARM_L_SECTIONAL_prod39250511`
- `KOPER_LEFT_ARM_L_SECTIONAL_prod39250480`
- `MASSON_LEFT_ARM_TWO_SEAT_CHAISE_END_U_SECTIONAL_prod40460153`

Default preset:
- The first dropdown option is intentionally named `KOPER_LEFT_ARM_L_SECTIONAL_prod39250480`, not `Reference (...)`, so the initial selection has an `r` prefix and loads server renders immediately.
- The older human-readable duplicate `Koper · Left-Arm L (39250480)` was removed to avoid two presets pointing at the same render files.

Shot suffixes currently wired:
- `F` -> `F`
- `FH` -> `FH`
- `TQR` -> `RIGHT_ARM`, fallback `TQ`
- `TQL` -> `LEFT_ARM`, fallback `TQ`

Prefix variants currently wired:
- `r`
- `r_FH`

The `r_FH` fallback is needed for some current Borgo files from the FTP listing, for example `BORGO_RIGHT_ARM_L_SECTIONAL_prod39250511_FH_F.png` and `BORGO_RIGHT_ARM_L_SECTIONAL_prod39250511_FH_TQ.png`.

The current server folder has render files for SKU prefixes `39250511`, `39250480`, and `40460153`.

If actual server filenames differ, change only `RB_MATERIALS`, `RB_VIEW_SUFFIXES`, `rbPrefixVariants`, or the built-in preset `r` prefixes in `index.html`.

## Validation already run
- Full script syntax check via Node `new Function(script)`: OK.
- `npm.cmd test`: OK, all checks passed.
- After deploy, public `index.html` was checked: it contains `Server renders for`, contains `rbPrefixVariants`, and no longer contains `IndexedDB`.
- Sample public render image URLs from `Renders/` returned HTTP 200.

Use `npm.cmd test` on this Windows machine. Plain `npm test` can fail because PowerShell blocks `npm.ps1`.

## Deployment note
The current `index.html` was deployed to preview after merge to `main`.

The public light-rig URL discussed in chat is:
`https://preview.3dsource.com/dmitriy.derevyanko/light-rig/`

Do not paste or print FTP passwords. Use the existing local skill config or environment variable.

On this machine, invoke the Codex PowerShell uploader directly from PowerShell:

```powershell
& 'C:\Users\Dima\.codex\skills\preview-deploy\scripts\upload-preview.ps1' 'D:\GitHub\light-rig-scaler\index.html' 'light-rig'
```

Running it through a nested `powershell -File ...` failed once with a curl connect error even though direct invocation worked.

## Update 2026-07-04 (Claude, macOS session)

The render board is now manifest-first:

- `index.html` fetches `Renders/manifest.json` (`{ files:["<material>/<file>.png", ...] }`) and shows exactly the listed files. Material folders are discovered from the manifest (labels prettified from the dir name; `RB_MATERIALS` keeps label overrides). With a manifest there is no 404 probing at all.
- Without a manifest the old per-file probing over `RB_MATERIALS` still runs, so existing deploys keep working unchanged.
- Deploy step to add: regenerate the manifest and upload it together with the render files:
  `npm.cmd run gen:manifest -- D:\path\to\Renders` (or `node scripts\gen-render-manifest.cjs D:\path\to\Renders`).
- Arm gating no longer parses preset display names: built-in presets carry `arm:"L"|"R"`; name parsing remains only as a fallback for user presets.
- The render-preview conventions are pure exported functions now (`rbCandidateFiles`, `rbMatchManifest`, `presetArmSide`, `armRequiredView`, `armBlocksView`) and `test/sanity.cjs` tests them directly — the old source-regex scraping in the test is gone.

## Update 2026-07-04, part 2: shared render comments

- New file `comments.php` must be uploaded next to `index.html` (one-time). It stores one shared note per render in `render-comments.json` (created on first save, keyed by `<material>/<file>.png`).
- After uploading, verify from a browser or curl: `GET https://preview.3dsource.com/dmitriy.derevyanko/light-rig/comments.php` must return JSON (`{}` initially), NOT the PHP source. If it returns source, PHP is not enabled for that directory and comments silently stay per-browser (localStorage fallback) — then we need a different endpoint host.
- The deploy directory must be writable by the web server user so `render-comments.json` can be created.
- Deploy scripts must NEVER overwrite or delete `render-comments.json`.
- Client behavior: the board GETs the whole comment map, POSTs `{key, text}` debounced; empty text deletes the key. Old local notes migrate to the shared store automatically the first time their card renders in shared mode. Save-state mark per card: `✓` shared / `…` saving / `local` fallback / `!` save failed.
- Verified on macOS against a Python shim implementing the same GET/POST contract (shared save, cross-browser reload, migration, deletion, fallback). The PHP file itself was NOT executed locally (no PHP on this machine) — eyeball it or test after the first upload.
