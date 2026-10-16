# TASKS-C: world and art

Owns `src/render/`, `public/assets/`. Read `HANDOFF.md`, `shared/api.ts` (the `Renderer` interface and `Layout`), `shared/state.ts`, `shared/map.ts` first. Ready-made code: `docs/research/render/code/src/render`, `docs/research/render/code/src/scene`, `docs/research/render/code/tests` (buildings, camera, layout) and the render agent transcript `docs/research/_workflow/agent-a71c3c61ab65370a0.jsonl` (its draft write-up). Assets: `docs/ASSETS.md`.

Decide in the first hour: Mixamo GLB crew or code-built stylised crew. Recommendation from the research: code-built capsule characters with procedural animation for the hackathon; GLB as the upgrade path.

## Base (with everyone)

- [ ] C1 `src/render/index.ts` implementing `Renderer`: one `WebGLRenderer`, scissor viewports from `Layout.cells`, one camera per `CameraView`, `autoClear` once per frame, DPR capped at 1, resize. Box boats and a flat grid. Done: two viewports show two moving boxes driven by the sim.

## MVP (Gate 2)

- [ ] C2 World from the map (`src/render/world.ts`): building blocks from `map.walls` (3 to 5 floors, plaster colours, stone band and algae band at the waterline), merged per block; windows and shutters as `InstancedMesh`; bridges from `map.bridges` (arch generator, the covered bridge with a roof), the campanile at `map.tower`, mooring poles, pile clusters at `map.piles`, the lagoon edge as a breakwater.
- [ ] C3 Water (`src/render/water.ts`): large plane, two scrolling normal maps, HDRI env reflection, dark green-teal, foam wake behind boats. No planar reflections.
- [ ] C4 Sky and light (`src/render/sky.ts`): golden-hour HDRI via `RGBELoader` + `PMREMGenerator`, low sun `DirectionalLight` with one shadow pass per frame (`shadowMap.autoUpdate = false; needsUpdate = true` once per frame), hemisphere fill, ACES tone mapping, fog from `CAMERA.fogNear/fogFar`.
- [ ] C5 Gondola (`src/render/boats.ts`): black asymmetric hull (lathe/extrude, bow along -z), ferro, trim and bow lantern in the team colour (emissive + sprite glow, no point lights), bob/roll/pitch from speed and steer, sits lower with hull water; sinking flip from `status === 'sinking'`.
- [ ] C6 Crates with coloured lanterns, mines, cannonballs with the visual arc (`ProjectileState.y`), torpedo wake, spawn-protection bubble.
- [ ] C7 Minimap (Canvas 2D) and the overview map in the spare cell (Canvas 2D, not a 5th 3D render).

## Should (Gate 3)

- [ ] C8 Crew (`src/render/crew.ts`): Pilot rowing at the stern (faster on GAS), Gunner at the swivel cannon turning with `aimYaw`, Engineer bailing on `shake`; lean into turns, flinch on hit, tumble on sinking, celebrate on the podium.
- [ ] C9 VFX (`src/render/vfx.ts`): muzzle flash and smoke, splashes, explosion water column, wake foam, shield flash, respawn splash, firework bursts for the Mortar and the podium.
- [ ] C10 Audio (`src/render/audio.ts`): `AudioListener` unlocked on the Start click; lapping water, bells, seagulls, cannon, splash, horn, lobby loop; driven by `SimEvent`s.
- [ ] C11 Podium and results visuals.
- [ ] C12 Performance pass with 4 viewports: instancing counts, merged blocks, LOD beyond 120 m, shadow map size, draw-call budget per viewport; cut order: draw distance, shadows, building detail.
