# Module 3: Graphics, audio & assets (Teammate C)

**Owns:** `src/render/`, `public/assets/`, and the camera rigs. **Reads:** `shared/api.ts` (the `Renderer` interface you implement), `shared/state.ts` (what you draw), `shared/map.ts` (walls, bridges, tower, piles, docks), `ARCHITECTURE.md`.

**Already done (base):** `src/render/index.ts` implements `Renderer` with one WebGL renderer, scissor viewports, one camera per team (9 m back, 4 m up along the aim, level look), one shadow pass per frame. Everything visible is a placeholder: block buildings, flat water, box boats, sphere projectiles.

**Ready-made, tested code to lift:** `docs/research/render/code` (renderer, buildings, water, sky, gondola, crew, VFX, audio, perf, minimap; 19 tests) and its write-up `docs/research/render/final.md`. It uses its own state slice and yaw convention: write one adapter `GameState -> RenderState` at the top of `src/render/index.ts`; **research yaw = -PI/2 - repo yaw** (repo forward is `(-sin yaw, -cos yaw)`). Do not change `shared/`.

**Assets:** every file name and a ready-to-paste prompt are in [`ASSETS.md`](ASSETS.md). Generated images go in `public/assets/textures/` and `public/assets/ui/`, sounds in `public/assets/sounds/`.

**Test:** `/scene`, press O three times and Enter: 4 bot teams in a 2x2 grid. Console: `gr.sim.debug.teleport(0, x, z, yaw)`, `gr.sim.debug.giveWeapon(0, 'cannon')`.

## MVP (by Gate 2)

- [ ] **C1 Land the research renderer** behind `Renderer` with the adapter; keep the scissor viewports and camera behaviour. *Done when:* 4 viewports show the research world with the bots driving, at 60 fps on the scene PC.
- [ ] **C2 Venice from the map.** Buildings from `map.walls` (3 to 5 floors, plaster colours, Istrian stone band, algae band at the waterline), instanced windows and shutters, bridges from `map.bridges` (the covered bridge with a roof), the campanile at `map.tower`, piles, mooring poles.
- [ ] **C3 Water, sky and light.** Scrolling normal-map water (dark green-teal), golden-hour HDRI `sky.hdr`, low sun with one shadow pass, ACES tone mapping, fog from `CAMERA.fogNear/fogFar`. No planar reflections.
- [ ] **C4 Gondola.** Black asymmetric hull with the ferro, team-colour trim and bow lantern (emissive + glow sprite, no point lights), bob/roll/pitch from speed and steer, sits lower with hull water, flips and sinks while `status === 'sinking'`, hidden while `respawning`.
- [ ] **C5 Game objects.** Crates with red/blue lanterns (`state.crates`), projectiles with their arc (`ProjectileState.y`), Water Cannon stream, torpedo wake, mines, shield bubble (`shieldUntil`), spawn-protection bubble (`protectedUntil`).

## Should (by Gate 3)

- [ ] **C6 Generate and drop in the assets** from `ASSETS.md`: textures, UI icons (Module 2's HUD uses them), logo, lobby background; download the sounds and the HDRI. Check every tile for seams.
- [ ] **C7 Audio.** `AudioListener` unlocked on the first click (`unlockAudio`), ambient loop, cannon, splash, explosion, pickup, horn at battle start, lobby loop; driven by `SimEvent`s passed to `render()`.
- [ ] **C8 Crew.** *(Mostly done in `src/render/avatars.ts`: the players' picked people, seated by role, rowing, aiming, bailing, sway, sinking and cheering. Carry `CrewAvatars` into the research gondola rather than its `CrewSet`; see HANDOFF 4b.)* Code-built characters (capsules) recommended: Pilot rows at the stern faster on GAS (`boat.gas`, `rowPhase`), Gunner turns with `aimYaw`, Engineer bails on `shake`; lean into turns, tumble on sinking.
- [ ] **C9 VFX.** Muzzle flash and smoke (`fired`), splash (`splash`, misses), explosion water column (`hit`/`sunk`), wake foam, respawn splash, fireworks for the Mortar and the podium.
- [ ] **C10 Performance pass and podium.** Quality presets, LOD beyond 120 m, draw calls per viewport (`renderer.info`), shadow map size; podium view on the results screen. Cut order if slow: draw distance, shadows, building detail.
