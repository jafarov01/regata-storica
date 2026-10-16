# Module 2: Gameplay & big-screen HUD (Teammate B)

**Owns:** `src/sim/`, `src/scene/`. **Reads:** `shared/api.ts` (the `Sim` interface you implement), `shared/state.ts`, `shared/config.ts`, `shared/map.ts`, `ARCHITECTURE.md`.

**Already done (base):** the scene loop (fixed 60 Hz), split-screen layout, keyboard harness (all roles, K keyboard crew, O bot team), phone HUD feed, lobby with QR and roster, timer, scoreboard, viewport labels, crosshair, countdown, results. `src/sim/index.ts` implements the whole `Sim` interface with a real roster, match flow, input holding and Gunner aim, but **kinematic boats** and only a **placeholder Water Cannon** (no crates, kills or respawn).

**Ready-made, tested code to lift:** `docs/research/physics/final.md` (Rapier boat, walls, projectiles, items, step order, tests) and `docs/research/rules/final.md` (teams, rules, items, aim, hud, bots, tests). Adapt it to the repo's `shared/` types; do not rewrite it. The physics research uses 1000 kg: scale forces by 0.4 for `BOAT.mass = 400`.

**Test:** `/scene`, press O three times and Enter (4 bot teams), or K for a keyboard crew. Console: `gr.sim.state`, `gr.sim.debug.*`. `tests/baseline.test.ts` must keep passing.

## MVP (by Gate 2)

- [ ] **B1 Rapier boats.** Replace the kinematic `moveBoat` with Rapier 2D (`await RAPIER.init()`, so `createSim` becomes async and `startScene` awaits it): walls from `map.walls`, piles, boat vs boat bounce, keel grip, drift on BRAKE + steer, top speed 10 m/s in about 3 s, hull water slows. *Done when:* a keyboard boat scrapes along walls without sticking and two boats bounce off each other.
- [ ] **B2 Crates and inventory.** Pick up by touch (`CRATES.pickupRadius`), red = weapon to the Gunner, blue = power to the Engineer (Gunner in teams of 2), 8 s respawn with random contents by `TIERS`, same weapon tops up, last shot returns to the Water Cannon, two power slots. *Done when:* driving through a red crate shows a weapon on the Gunner phone.
- [ ] **B3 Weapons.** Real Water Cannon (push force + hull fill, `WATER_CANNON`), Cannon (fast 2D shot, wall check with `castRay`), Torpedo (lock cone 40 deg, homing). Emit `fired` / `hit` / `splash`. *Done when:* a Cannon hit on a bot boat emits `hit` and `kill`.
- [ ] **B4 Kills, sinking, respawn.** Lethal hit -> `sinking` 2 s -> `respawning` until hit + 5 s -> respawn at a dock at least 80 m from every enemy (fallback farthest), inventory wiped, 3 s protection ending when the Gunner fires. Team kills/deaths, kill feed, `debug.sink(team)`. *Done when:* the scoreboard counts and the boat comes back at a safe dock.
- [ ] **B5 Shield and Mine.** Shield absorbs one lethal hit (8 s), Mine dropped behind, arms after 1 s, sinks the first enemy, credits the dropper.

## Should (by Gate 3)

- [ ] **B6 Aim assist and crosshair.** Bend Cannon shots up to 4 deg toward the nearest enemy near the aim line, set `boat.crosshair` / `aimTarget` / `lockTarget` each step (the gain drop under the crosshair already reads `crosshair === 'enemy'`).
- [ ] **B7 Big-screen HUD, per viewport.** Weapon icon + ammo, Engineer powers, water bar, bow-vs-aim arrow, protection timer, shield flash, SUNK overlay with countdown; kill-cam by setting `CameraView.followTeam` to the killer. Shared: kill feed under the timer, minimap (Canvas 2D, enemies only when revealed). Icons from `public/assets/ui/` (Module 3 generates them).
- [ ] **B8 Host controls on screen.** Clickable Start / Team size / Add bot / Rematch / New lobby buttons in the lobby and results (the keyboard keys stay), and a "kick" on each roster entry.
- [ ] **B9 Bots that play.** Bots drive toward crates and enemies and shoot, so 4 viewports can be tested alone (`docs/research/rules` has `bot.ts`).
- [ ] **B10 Should-tier rules.** Mortar (auto-range, 6 m splash), Boost + ram kills, Engineer bailing from `shake`, auto-drain for teams of 2, sudden death between tied teams (`BoatStatus 'out'`), results extras (top Gunner, best ram), countdown beep events.

## Measure at Gate 2

Frame rate with 4 bot teams on the scene PC, sim step time (under 1 ms), and tune with `PLAYTEST_TUNING` in `shared/config.ts`.
