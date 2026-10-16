# Module 2: Gameplay & big-screen HUD (Teammate B)

**Owns:** `src/sim/`, `src/scene/`. **Reads:** `shared/api.ts` (the `Sim` interface you implement), `shared/state.ts`, `shared/config.ts`, `shared/map.ts`, `ARCHITECTURE.md`.

**Already done (base):** the scene loop (fixed 60 Hz), split-screen layout, keyboard harness (all roles, K keyboard crew, O bot team), phone HUD feed, lobby with QR and roster, timer, scoreboard, viewport labels, crosshair, countdown, results. `src/sim/index.ts` implements the whole `Sim` interface with a real roster, match flow, input holding and Gunner aim, but **kinematic boats** and only a **placeholder Water Cannon** (no crates, kills or respawn).

**Ready-made, tested code to lift:** `docs/research/physics/final.md` (Rapier boat, walls, projectiles, items, step order, tests) and `docs/research/rules/final.md` (teams, rules, items, aim, hud, bots, tests). Adapt it to the repo's `shared/` types; do not rewrite it. The physics research uses 1000 kg: scale forces by 0.4 for `BOAT.mass = 400`.

**Test:** `/scene`, press O three times and Enter (4 bot teams), or K for a keyboard crew. Console: `gr.sim.state`, `gr.sim.debug.*`. `tests/baseline.test.ts` must keep passing.

## MVP (by Gate 2)

- [x] **B1 Rapier boats.** Replace the kinematic `moveBoat` with Rapier 2D (`await RAPIER.init()`, so `createSim` becomes async and `startScene` awaits it): walls from `map.walls`, piles, boat vs boat bounce, keel grip, drift on BRAKE + steer, top speed 10 m/s in about 3 s, hull water slows. *Done when:* a keyboard boat scrapes along walls without sticking and two boats bounce off each other.
- [x] **B2 Crates and inventory.** Pick up by touch (`CRATES.pickupRadius`), red = weapon to the Gunner, blue = power to the Engineer (Gunner in teams of 2), 8 s respawn with random contents by `TIERS`, same weapon tops up, last shot returns to the Water Cannon, two power slots. *Done when:* driving through a red crate shows a weapon on the Gunner phone.
- [x] **B3 Weapons.** Real Water Cannon (push force + hull fill, `WATER_CANNON`), Cannon (fast 2D shot, wall check with `castRay`), Torpedo (lock cone 40 deg, homing). Emit `fired` / `hit` / `splash`. *Done when:* a Cannon hit on a bot boat emits `hit` and `kill`.
- [x] **B4 Kills, sinking, respawn.** Lethal hit -> `sinking` 2 s -> `respawning` until hit + 5 s -> respawn at a dock at least 80 m from every enemy (fallback farthest), inventory wiped, 3 s protection ending when the Gunner fires. Team kills/deaths, kill feed, `debug.sink(team)`. *Done when:* the scoreboard counts and the boat comes back at a safe dock.
- [x] **B5 Shield and Mine.** Shield absorbs one lethal hit (8 s), Mine dropped behind, arms after 1 s, sinks the first enemy, credits the dropper.

## Should (by Gate 3)

- [x] **B6 Aim assist and crosshair.** Bend Cannon shots up to 4 deg toward the nearest enemy near the aim line, set `boat.crosshair` / `aimTarget` / `lockTarget` each step (the gain drop under the crosshair already reads `crosshair === 'enemy'`).
- [x] **B7 Big-screen HUD, per viewport.** Weapon icon + ammo, Engineer powers, water bar, bow-vs-aim arrow, protection timer, shield flash, SUNK overlay with countdown; kill-cam by setting `CameraView.followTeam` to the killer. Shared: kill feed under the timer, minimap (Canvas 2D, enemies only when revealed). Icons from `public/assets/ui/` (Module 3 generates them).
- [x] **B8 Host controls on screen.** Clickable Start / Team size / Add bot / Rematch / New lobby buttons in the lobby and results (the keyboard keys stay), and a "kick" on each roster entry.
- [x] **B9 Bots that play.** Bots drive toward crates and enemies and shoot, so 4 viewports can be tested alone (`docs/research/rules` has `bot.ts`).
- [x] **B10 Should-tier rules.** Mortar (auto-range, 6 m splash), Boost + ram kills, Engineer bailing from `shake`, auto-drain for teams of 2, sudden death between tied teams (`BoatStatus 'out'`), results extras (top Gunner, best ram), countdown beep events.

## Audit of B1-B10 (2026-10-16, branch `b/audit-fixes`)

Checked against SPEC, the config numbers and TIERS, and the research. Fixed, each with a test in `tests/sim.test.ts` ("audit fixes"):

- **Steering before CALIBRATE.** The sim now keeps a phone Pilot's steer at 0 until its `calibrate` arrives (the phone did this, the sim did not).
- **Fire taps in the countdown or lobby** were queued and fired the moment the battle started. Taps are now consumed but only count while fighting.
- **Powers for the Gunner** went by the lobby's team size, so the Gunner of a 2-member crew in teams of 3 (3+2+2) and keyboard crews could never use a power. Now by the crew aboard (`gunnerHasPowers` in `src/sim/ctx.ts`), in the sim, `Hud.hasPowers` and the keyboard Q/E.
- **Gyro gain drop** only applied while the crosshair showed the red diamond, not while it showed a Torpedo lock or the hit X with an enemy still on the line. Now `aimTarget !== null`; `Hud.onTarget` follows the same rule.
- **Bot teams took phones.** A phone joining after O sat on the bot's boat (the bot then stopped driving), and rebalancing moved phones into bot teams. Bot teams are now closed and count as one full team; rebalancing never moves keyboard or bot seats; a team size change keeps keyboard crews and bots in their teams.
- **Ram during spawn protection** did not end the protection. A boosted ram now ends it, like a lethal shot.
- **Sudden death 'out' boats** kept "SUNK by" and a respawn time on the HUD and phones. Cleared.
- **Top Gunner** counted the Pilot's ram kills; rams now only count for best ram.
- **Kill-cam** cut to the killer's wreck and then to its respawn dock when the killer sank during the countdown. It now ends for good and shows the own boat (`src/scene/views.ts`). Freezing the killer's last pose needs the renderer (see HANDOFF).
- **Phone cues.** `shielded`, `respawn`, `pickup` (item name), `power`, `rammed` and the victim's name on `kill` are now forwarded; nothing goes to keyboard or bot seats.
- **Lobby resend.** A phone that reloaded into the same seat never got the roster again (it had not changed). Every join, rejoin and leave now resends it (`LobbySync`).
- **Kill feed** sat over the right cell's team label at the centre seam (2, 4, 6 teams); it now sits below the labels.
- **Steering at rest** was 0.27 rad/s. `TUNING.boat.steerTorqueBaseMul` (1.85) gives the research's 0.5 rad/s at rest and about 1.15 to 1.3 rad/s at speed.
- Smaller: no per-step allocations left in the boat poses, aim helpers, bot brains and crate loop; bot aim rate in sim time (`SIM.dt`); bow arrow angle wrapped; Water Cannon cue maps cleared at match start; new `gr.sim.debug.endPhase()` ends the countdown, battle (sudden death if tied) or results on the next step.

Checked and correct: yaw and Rapier conventions, respawn docks (80 m from every alive enemy, farthest as fallback), inventory wipe, same-weapon top-up, last shot back to the Water Cannon, two power slots, 8 s crates with TIERS rolls, Torpedo cone (40 deg total), assist 4 deg, Mine arming and dropper credit, Shield, ram kills, bailing and auto-drain, sudden death between tied teams, ranking, match flow and rematch.

## Measure at Gate 2

Frame rate with 4 bot teams on the scene PC, sim step time (under 1 ms), and tune with `PLAYTEST_TUNING` in `shared/config.ts`.

Sim step with 4 bot teams, measured in Node over a full 5:00 battle (2026-10-16, dev Mac): mean 0.038 ms, p99 0.11 ms, worst 0.9 ms. `tests/sim.test.ts` "B9 bots" asserts the mean stays under 1 ms.
