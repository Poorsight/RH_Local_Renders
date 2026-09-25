# Leather sofas on UE 5.6

The tool supports the Airtable/light-sheet category `Leather_Sofas`. This is a tool-only adaptation; no BatchRender or Unreal asset changes are required by this code.

## Routing

- UI: **Leather sofas**; internal product type: `leather_sofas`.
- Files stay in `local/models/sofas`. An underscore-delimited `LEATHER` token in the filename selects the leather group; other sofas and sectionals keep their existing groups. Explicitly filed `leather_sofas` models also work.
- Sheet: `airtable_categories=Leather_Sofas`, `environment=Indoor`.
- Empty `sequence_prefix` derives `Leather_Sofa_Indoor`, matching the dedicated sequences. An explicit value must match that rig key to be selected by this profile.
- Cameras: `Leather_Sofa_Indoor_F`, `_P`, `_TQ`, `_TQB`; DTL is not enabled by this change.
- Levels use a different word order: `Sofa_Indoor_Leather_Background`, `_KeyLight`, `_Shadow`.
- Each light row must supply `light_sublevel_suffix` (`Background`, `KeyLight`, or `Shadow`). The tool combines it with the level prefix, not the camera sequence prefix.
- Product loads Background + KeyLight. Shadow loads Shadow + KeyLight.
- The product pass retains the plugin layer name `Fabric` even for leather materials. It uses the existing Path Trace preset.
- No fabric-scene `light_blocker` transform/visibility override is injected into leather scenes.
- Camera yaw, scale inspection, full/optimized frame handling and camera handoff follow ordinary-sofa behavior. Dedicated sequence assets participate in the camera-fit cache identity.

## Light settings and first test

Numeric `default_*` columns drive product lights. Empty `shadow_*` columns retain the existing inheritance behavior (use the corresponding product value); they do **not** mean zero or an independently configured shadow rig. The first leather validation is therefore Fabric-only, not a validated leather shadow workflow.

The initial case is BELLA_LEATHER_TWO_SEAT_SOFA_CLASSIC_9_10151993, F, CAVALLINO_LEATHER_IVORY_V1 on Uph + Stitches, UPH_WOOD_BROWN_OAK on Feet, 5000×5000 full frame. This does not validate all three models, all eight finishes, other cameras or shadow settings.

Tests: `npm test` includes `test/leather.test.cjs`; existing fabric/sectional rigs are checked for unchanged behavior when leather rows are added. Browser validation covers automatic category selection, four camera choices, material fields, desktop/mobile layout and console errors.
