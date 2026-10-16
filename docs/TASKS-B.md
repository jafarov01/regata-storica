# TASKS-B: gameplay and physics

Owns `src/sim/`, `src/scene/`. Read `HANDOFF.md`, `shared/api.ts`, `shared/state.ts`, `shared/config.ts`, `shared/map.ts` first. Ready-made, tested code: `docs/research/physics/final.md` (coords, geom, physics, loop, boat, walls, items, projectiles, step order, six test files) and `docs/research/rules/final.md` (teams, rules, items, aim, hud, layout, keyboard, bot, tests). Adapt it to the repo's `shared/` types; do not rewrite it.

## Base (with everyone)

- [ ] B1 `src/scene/main.ts`: canvas, layout from team count (`src/scene/layout.ts`), `Sim` + `Renderer` wiring, fixed 60 Hz accumulator with `SIM.maxStepsPerFrame`, interpolation alpha, keyboard harness, Start on Enter/Space. Done: `npm run dev` shows two viewports with box boats.
- [ ] B2 `src/sim/index.ts` implementing `Sim` from `shared/api.ts` with Rapier loaded by dynamic import (`await RAPIER.init()`), walls from `getMap().walls`, one boat per team, `applyInput` holding the last packet and dropping stale `seq`. Done: keyboard drives a box boat; it bounces off walls.

## MVP (Gate 2)

- [ ] B3 Boat model (`src/sim/boat.ts`): thrust, reverse 40%, keel grip, drift on BRAKE + steer, speed-scaled steering torque, turn-rate cap, top speed 10 m/s reached in about 3 s, hull-water slowdown. Done: `tests/sim/boat.test.ts` (top speed, keel decay).
- [ ] B4 Lobby and teams (`src/sim/teams.ts`): ordered members, balanced sizes, rebalance with fewest moves, swap/move/pin, spectators, `canStart`, `lobbySnapshot()`. Done: `tests/teams.test.ts` balance table for n = 1..18, both sizes.
- [ ] B5 Match flow (`src/sim/rules.ts`): lobby -> countdown 10 s (beeps, horn) -> battle 300 s -> results 20 s; rematch / new lobby / abort / pause; sim-time deadlines only.
- [ ] B6 Water Cannon, Cannon, Torpedo (`src/sim/projectiles.ts`): 2D hit tests, `castRay` wall blocking, torpedo lock and homing; `fired` / `hit` / `splash` events.
- [ ] B7 Crates and inventory (`src/sim/items.ts`): red/blue categories, weighted contents by tier flags, pickup on touch, 8 s respawn, same-weapon tops up, last shot -> Water Cannon, two power slots.
- [ ] B8 Shield and Mine; lethal-hit resolution order (dead -> own team -> water cannon -> ram rule -> spawn protection -> shield -> sunk); kill credit; death wipes inventory.
- [ ] B9 Sinking and respawn: 2 s sinking (collision mask), respawn at hit + 5 s at a dock >= 80 m from every enemy (fallback farthest), 3 s protection ending on fire; kill-cam target with frozen killer pose.
- [ ] B10 Aim (`src/sim/aim.ts`): world aim yaw, RECENTER, reset on respawn, aim assist bend <= 4 deg, under-crosshair gain x0.6 applied when integrating `dYaw`, torpedo lock cone 40 deg, line-of-sight rays; crosshair state.
- [ ] B11 Scoreboard and HUD data (`src/sim/hud.ts`, `src/scene/hud.ts`): per-viewport HUD (crew, kills/deaths, crosshair, weapon/ammo, powers, water bar, bow-vs-aim arrow, protection timer, SUNK overlay) and the shared top bar (timer, scoreboard), phone `Hud` at 10 Hz via `src/net/host.ts`.
- [ ] B12 Camera rig (`src/scene/camera.ts`): 9 m back, 4 m up along the aim yaw, level look, smoothing on position only, kill-cam, `CameraView[]` for the renderer.
- [ ] B13 Keyboard harness (`src/scene/keyboard.ts`): all roles for the focused team, globals, debug toggles, number-row fallbacks for F-keys; bots (`src/scene/bot.ts`) to fill viewports.
- [ ] B14 Results screen: ranking, kills/deaths, top Gunner, best ram, Rematch / New lobby.

## Should (Gate 3)

- [ ] B15 Mortar: auto-range (10 deg, 60 m, else 40 m), 1.6 s flight, 6 m splash, no wall check.
- [ ] B16 Boost and ram kills from contact events + pre-step velocities; two boosted boats bounce.
- [ ] B17 Kill feed (last 5), minimap reveal rule (2 s after firing, always in the lagoon), kill-cam polish.
- [ ] B18 Engineer: bailing from `shake`, auto-drain at half rate for 2-person teams; Gunner powers in teams of 2.
- [ ] B19 Sudden death (tied teams only), results extras, tuning pass on `shared/config.ts` (see `PLAYTEST_TUNING`).

## Measure at Gate 2

Frame rate with 4 viewports and 4 bot teams on the scene PC, `renderer.info` draw calls per viewport, sim step time (should be under 1 ms).
