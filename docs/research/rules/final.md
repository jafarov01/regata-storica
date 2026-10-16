# Research: game rules, lobby and teams, match flow, HUD data, keyboard harness, tuning config

Scope: future files `shared/config.ts`, `shared/state.ts`, `src/sim/teams.ts`, `src/sim/rules.ts`, `src/sim/items.ts`, `src/sim/aim.ts`, `src/sim/hud.ts`, `src/scene/layout.ts`, `src/scene/keyboard.ts`, `src/scene/bot.ts`, `tests/teams.test.ts`, `tests/rules.test.ts`, `tests/layout.test.ts`, `tests/aim.test.ts`.

Everything in section 3 was type-checked with the repo's `tsconfig.json` settings (strict, `noUncheckedIndexedAccess`, `moduleResolution: bundler`, `allowImportingTsExtensions`, `@shared/*` alias) plus `noUnusedLocals` and `noUnusedParameters`, with TypeScript 5.9.3, and the four test files pass under vitest 5.0.5 (57 tests) in a scratch copy of the project that symlinks the installed `node_modules`. Nothing in the repo was touched. The existing `shared/math.ts` (`Vec2`, `wrapAngle`, `angleDiff`, `clamp`, `DEG`, `makeRng`) is reused, not duplicated.

## 1. The problem, in the words of the spec

- "Party deathmatch for 4 to 18 people in one room. Teams crew armed gondolas... One hit sinks a boat, a sunk boat is back in 5 seconds, and after 5 minutes the team with the most kills wins."
- Teams: "The host picks team size in the lobby: 3 (default) or 2." "Players fill teams in join order. Inside a team, roles fill in order: Pilot, then Gunner, then Engineer." "Until the round starts, a player can swap role with a teammate or move to any team with a free slot." "Maximum 6 teams." "Odd counts are balanced, not left over: 7 players in teams of 3 becomes 3 + 2 + 2, never 3 + 3 + 1." Short-handed teams: 2 = "Pilot. The Gunner also gets the two power buttons. Bailing water happens automatically at half speed." 1 (stretch) = "Solo controller: tilt to steer with auto-throttle, one FIRE button that auto-targets the nearest enemy ahead".
- Split screen: 2 teams = two halves; 3 = 2x2 with the spare cell as "Live overview map"; 4 = 2x2, "minimap sits where the cells meet"; 5 = 3x2 with the spare; 6 = 3x2 with the minimap at the centre. "Fixed for the whole round." "Each viewport has a thick border in the team colour and the team name. Team colours: Rosso, Azzurro, Verde, Oro, Viola, Arancio." On death "a 5 s kill-cam on the boat that sank it, with a countdown".
- Match: "Any lethal hit sinks the boat instantly: Cannon, Torpedo, Mortar, Mine, or a boosted ram." "A Mine credits the team that dropped it." "Your own shots, splash and Mines never hurt you." "The Water Cannon never kills." "A Shield absorbs one lethal hit." Death: flips and sinks "about 2 s"; "For 5 s the team's viewport shows a kill-cam"; "After 5 s the boat respawns at a random dock with nothing"; dock "at least 80 m from every enemy boat"; "3 s of spawn protection... It ends early if the Gunner fires". Hull water: "Speed is multiplied by 1 - 0.5 x water / 100"; "2-person teams drain automatically at half speed". Scoring: kills, then fewer deaths, then "30 s overtime between the tied teams, next kill wins". Round flow: Lobby, Countdown 10 s (calibrate, 3-2-1 horn), Battle 5:00 fixed, Results 20 s ("Rematch (same teams) or New lobby"). Stretch: "in the final 60 s crates respawn twice as fast and the timer turns red".
- Items: "Picking up the same weapon tops its ammo back up; a different weapon replaces the old one." "When the last shot is fired, the slot empties and the Water Cannon is back automatically." "The Engineer holds 2 powers. With both slots full, a blue crate is left in the water." Crates respawn "8 s later with random contents from its category". Ammo 5 / 2 / 3; tiers MVP / Should / Stretch.
- Aim: "aim is just an angle in the 2D top-down simulation". "Cannon shots bend up to 4 deg toward the nearest enemy near the aim line, and the gyro gain drops by 40% while an enemy is under the crosshair. Both values live in the tuning config." Torpedo "Locks the nearest enemy in a 40 deg cone ahead". Mortar "lands on the nearest enemy within 10 deg of the aim line and 60 m, even behind buildings; with no target it lands 40 m ahead". Crosshair "States: neutral ring; red diamond when an enemy is on the aim line; X flash on a hit; a lock-on ring when a Torpedo is ready and an enemy is in range."
- Keyboard: "every role can be played from the scene PC keyboard. This is both the dev test harness and the backup if a phone fails mid-demo." "Every feature gets a keyboard or debug toggle, so it can be tested without phones."
- Contracts: `shared/state.ts` "The GameState type: the simulation writes it, the renderer and HUD read it"; `shared/config.ts` "Every tunable number"; interfaces `sim.addPlayer(id, team, role)`, `sim.applyInput(id, input)`, `sim.step(1 / 60)`, `sim.state`, `sim.drainEvents()`. Minimap "shows an enemy only for 2 s after it fires, or while it is in the open lagoon."

## 2. Decisions and why (with rejected alternatives)

### 2a. Lobby and teams (`src/sim/teams.ts`)

**Data model.** `Lobby = { teamSize, teams: string[][], players: Record<id, LobbyPlayer>, spectators: string[] }`. Membership lives only in `teams[i]` (ordered player ids); role is the index (0 Pilot, 1 Gunner, 2 Engineer, `ROLES[index]`). `LobbyPlayer` carries `joinOrder`, `pinned`, `connected`, `enabled` (tapped Enable controls), `ready`, `calibrated`, `kind` ('phone' | 'keyboard' | 'bot'). The same shape is embedded in `GameState` (`teams[i].members`, `players`, `spectators`), so the sim and the lobby share one truth.
Rejected: `player.team` / `player.role` fields. They duplicate the member lists and drift after every swap or rebalance; deriving them (`slotOf`) is O(18) and never wrong.

**Team count and sizes.** `teamCount(n) = min(6, ceil(n / size))`; `targetSizes(n)`: `base = floor(n / t)`, the first `n mod t` teams get `base + 1`. Capacity is `6 x size` (18 in threes, 12 in twos); players beyond it are spectators and do not count in `n`. Full table (verified by `tests/teams.test.ts`):

| n | threes | twos |
|---|---|---|
| 1 | 1 | 1 |
| 2 | 2 | 2 |
| 3 | 3 | 2+1 |
| 4 | 2+2 | 2+2 |
| 5 | 3+2 | 2+2+1 |
| 6 | 3+3 | 2+2+2 |
| 7 | 3+2+2 | 2+2+2+1 |
| 8 | 3+3+2 | 2+2+2+2 |
| 9 | 3+3+3 | 2+2+2+2+1 |
| 10 | 3+3+2+2 | 2+2+2+2+2 |
| 11 | 3+3+3+2 | 2+2+2+2+2+1 |
| 12 | 3+3+3+3 | 2+2+2+2+2+2 |
| 13 | 3+3+3+2+2 | 12 playing + 1 spectator |
| 14 | 3+3+3+3+2 | 12 + 2 spectators |
| 15 | 3+3+3+3+3 | 12 + 3 |
| 16 | 3+3+3+3+2+2 | 12 + 4 |
| 17 | 3+3+3+3+3+2 | 12 + 5 |
| 18 | 3+3+3+3+3+3 | 12 + 6 |

Note n = 1..3 in threes (and n = 1..2 in twos) gives one team, which cannot start; `canStart` says so. The spec's range starts at 4.

**Rebalance with the fewest moves** (`rebalance()`, run after every join, leave, size change and manual move):
1. Capacity: if more than `6 x size` people sit in teams (the host lowered the size), the most recent unpinned joiners go to the spectator queue; if seats are free, spectators are promoted in join order.
2. The target multiset is matched to teams by current size, largest to largest (ties: more pinned members first, then lower index). Only surplus people have to move; a team that is already at its target keeps everyone.
3. Teams beyond the target count are dissolved: by construction they are the smallest, with the fewest pins, with the highest index. Surplus teams give up unpinned members first, most recent joiners first (`moverPriority`). So the last person to join is the one who opens a new team, which is what a newcomer expects.
4. Deficits are filled in team order with the pool sorted by join order; a moved player is appended, so takes the next free role and nobody else's role shifts. Surviving teams are compacted and renumbered only if a middle team dissolved (`renumbered: true` so the HUD can re-colour).
Minimality: every person in surplus (or in a dissolved team) must move at least once for the sizes to match the target; the algorithm moves each of them exactly once and nobody else. The join test asserts "at most one existing player moves per join" for n = 1..18.
Rejected: re-dealing everyone by join order after every change (simple, but a leave can re-seat half the room and swap everyone's role). Rejected: leaving teams unbalanced until the host presses Balance (the spec says balanced, "not left over").

**Explicit moves.** `swapRoles(id, teammate)` swaps the two indices and pins both. `moveToTeam(id, team)` is allowed only when `team.members.length < teamSize`; it pins the mover and then rebalances, which may bump one *unpinned* person from an over-full team (7 players, p7 moves into a team of 2: that team keeps 3 because pinned members count in the tiebreak, and the other 3-team gives up its most recent joiner). Pinned players are moved only if no unpinned candidate exists.
Rejected: allowing 3+3+1 after a manual move (contradicts "never 3+3+1").

**Spectators.** A join beyond capacity lands in `spectators` (join order). The phone shows "Spectator, you are next" and the player keeps the lobby screen; promotion happens on a leave in the lobby, on a team-size increase, or at New lobby. During countdown/battle a dropped slot is kept for its token, so spectators are promoted only in the lobby.
Rejected: refusing the join; people re-scan and the host cannot see them.

**Leaving during countdown or battle.** `markDisconnected` only flips `connected`; the seat, boat and score stay. The sim treats a controller with no packet for `net.inputTimeoutSeconds` (1.5 s) as idle: steer 0, gas false, so the boat coasts to a stop and stays a target. Reconnecting with the same token (`reconnectPlayer`) resumes the slot. The keyboard focus (keys 1-6) overrides that team's inputs for as long as the host holds it, which is the mid-demo backup. Removal (`leavePlayer`) is only for the lobby or an explicit host kick.
Rejected: auto-removing and rebalancing mid-match, which would change roles for people who are playing.

**Short-handed teams.** Roles stay Pilot/Gunner by index; `controlsFor()` tells the phone what to draw: a 2-person Gunner gets `powers: true`, and `bailRate()` returns the automatic 20 units/s (half of the Engineer's 40 at full shake) for teams of 1 or 2 members. A 1-person team gets `solo: true`: the sim forces `gas = true`, steer from tilt, and FIRE uses `aimAssist` with the Torpedo-style cone (nearest enemy ahead of the aim). Solo is stretch; the data model already supports it so a late join never breaks.

**Flags and Start.** `enabled` is set when Enable controls succeeds (iOS permission granted), `calibrated` when a calibrate packet arrives during the countdown (reset to false at countdown start). `canStart`: at least 2 teams, each with a connected Pilot (member 0). Everything else is a warning (names shown in orange on the lobby screen), because the keyboard can cover any missing or unready phone and a stuck person must not block the room.
Rejected: requiring every player `ready`: a party lobby never reaches all-ready.

**Rematch and new lobby.** `rematchLobby` keeps teams, roles and pins, resets `ready`/`calibrated`; the sim resets scores, inventories and boats. `resetLobby` drops disconnected players and pins and re-seats everyone by original `joinOrder` (so the same people get the same colours when nothing changed).

### 2b. Split screen and colours (`src/scene/layout.ts`, `shared/config.ts`)

Rects are normalised (0..1) with a top-left origin, which is what the CSS/canvas HUD wants; `toGlPixels()` flips to the bottom-left pixel origin that `WebGLRenderer.setViewport(x, y, w, h)` and `setScissor(...)` expect (the installed `@types/three` 0.186 doc comment says "(x, y) is the lower-left corner of the region").

| teams | grid | cells (team index order: left to right, top to bottom) | spare | minimap |
|---|---|---|---|---|
| 2 | 2x1 | (0,0,.5,1) (.5,0,.5,1) | none | square 26% of height, bottom-centre, straddling the seam |
| 3 | 2x2 | TL TR BL | BR = overview | inside the spare cell |
| 4 | 2x2 | TL TR BL BR | none | square 24% of height, centred at (.5,.5) |
| 5 | 3x2 | top row 3, bottom row 2 | BR = overview | inside the spare cell |
| 6 | 3x2 | all 6 | none | square 22% of height at the centre |

Cell aspect at 1080p: halves 960x1080 (8:9), 2x2 cells 16:9, 3x2 cells 640x540 (1.19). The camera FOV is per cell, so the halves show a taller, narrower slice; the renderer uses `rectAspect()` for each camera. The top bar (timer, scoreboard, kill feed) is a translucent overlay in the top 7.5% between x = 0.28 and 0.72, drawn over the cells. Borders are `borderFrac` = 0.6% of height (about 6 px at 1080p) in the team colour; the team name sits in the top-left corner on a pill of the team colour with `textColour`.

Team colours were chosen for a projector: bright, saturated, far apart in Lab, and each with a text colour that passes WCAG 4.5:1. Computed with the WCAG 2.1 relative-luminance formula (sources in section 6); the minimum pairwise CIE76 distance is 42.5 (Oro vs Arancio), all others are above 46:

| team | hex | text on it | contrast vs white | vs black | vs dark water #1D4E4A |
|---|---|---|---|---|---|
| Rosso | #E53935 | white | 4.23 | 4.97 | 2.22 |
| Azzurro | #29B6F6 | black | 2.30 | 9.12 | 4.07 |
| Verde | #4CAF50 | black | 2.78 | 7.56 | 3.37 |
| Oro | #FFD600 | black | 1.41 | 14.87 | 6.64 |
| Viola | #BA68C8 | black | 3.56 | 5.90 | 2.63 |
| Arancio | #FB8C00 | black | 2.37 | 8.85 | 3.95 |

Rosso and Viola are the darkest against the water, so every border, crosshair and name pill gets a 1-2 px black halo; that is also what keeps them readable when the projector washes out. Red/green confusion is covered by the name on every viewport, boat lantern and phone.
Rejected: the pure CSS names (red, blue, ...): navy and purple vanish on a projector; and pastel sets, which lose the Oro/Arancio and Azzurro/Viola separation.

### 2c. Match state machine (`src/sim/rules.ts`)

Phases: `lobby -> countdown (10 s) -> battle (300 s) -> [overtime (30 s)] -> results (20 s) -> lobby`. `overtime` is its own phase in `GameState` (the viewports and phones need to know), and `phoneHud()` maps it to the protocol's `'battle'` so the spec's `Hud.phase` union stays as written.

Timers are absolute sim times: `phaseEndsAt`, `statusUntil`, `shieldUntil`, ... compared with `state.simTime`, which only advances inside `sim.step()`. Pause therefore means "do not call step" (`paused: true` for the HUD); nothing is decremented, nothing can drift, and a tab that was hidden for 30 s catches up through `sim.maxStepsPerFrame` instead of skipping phases. Abort = `lobbyClock()` plus a sim reset of boats and scores, teams kept.
Rejected: `setTimeout`/`performance.now()` timers: they keep running through a pause and a frozen tab, and they make tests slow.

Transitions (`tickMatch`): countdown end emits `horn` and `phase: battle`; `countdownBeeps` emits `beep 3/2/1` exactly once each even with uneven steps (tested). Battle end: `tiedForFirst` (same kills *and* deaths as the leader) with more than one team -> overtime, else results with `decidedBy: 'kills' | 'deaths'`. Results end -> lobby (rematch-ready) when `match.autoReturnToLobby` is on; the host's Rematch button just calls Start again, New lobby calls `resetLobby`.

Sudden death decisions:
- Only the tied teams play. `overtimeBoatPlan` marks every other boat `status: 'out'`: it is lifted off the water (collider removed), its viewport shows the overview map with "ELIMINATED, watch the overtime", its phones show the Sunk screen without a countdown. Their mines, smoke and projectiles are removed so an eliminated team cannot decide the match.
- Tied boats keep position and inventory; a tied boat that is sinking or respawning respawns immediately with fresh protection, so the overtime never starts with a dead team. All tied boats are revealed on the minimap for the whole overtime (`minimap.revealTiedTeamsInOvertime`): 30 s is too short for hide and seek.
- `overtimeKill` ends the match on the first kill between tied teams (results in 20 s, ranking puts the killer first).
- Still tied at 30 s: `decideAfterOvertime` gives the win to the tied team whose last kill came first (`lastKillAt`, "they got there first"); if nobody scored at all it is a declared draw (both crews on the podium, `draw: true`). One overtime only.
Rejected: repeating overtime until a kill (can loop forever); coin flip (feels unfair on a big screen); keeping eliminated boats on the water as hazards (their kills would have no meaning and their mines would decide the match).

### 2d. Combat rules (`src/sim/rules.ts`, `src/sim/items.ts`)

`resolveHit(target, source, now)` checks in this order: not alive -> ignored; same team -> ignored (shots, splash, mines, rams, including the owner's own old mine after a respawn, because team index is stable); Water Cannon -> ignored (never lethal); ram -> lethal only if the attacker is boosted, the target is not, and the relative impact speed is at least `boat.ramMinImpactSpeed` (7 m/s); spawn protection -> ignored and the Shield is *not* consumed; Shield -> `shielded` (consumed, spin-out); else `sunk` with a `Killer { team, playerId, weapon, pose }`.
Kill credit goes to `source.team` and `source.playerId` recorded when the projectile/mine was created, so a Mine still credits its team after that team has sunk or respawned, and `creditKill` adds the kill to the team and to the player (Gunner for shots, dropper for Mines, Pilot for rams) and a death to the victim team and each of its crew.
Rejected: checking the Shield before spawn protection (a fresh boat would lose a Shield it just looted to a shot that should bounce off the bubble).

Timeline (`sinkTimeline(hitAt)`): status `sinking` until hit + 2 s, `respawning` until hit + 5 s (kill-cam for those 5 s), teleport to the dock at hit + 5 s, `protectedUntil` hit + 8 s. Firing any weapon ends the protection; the Water Cannon too (`weapons.waterCannon.endsSpawnProtection = true`), because the stream pushes enemies into mines and walls and is an attack by the spec's own words ("sets up kills"). It is a config flag in case the playtest shows people losing the bubble by holding FIRE out of habit.

Kill-cam target: the killer boat (team index) while it is alive; `Killer.pose` is frozen at the hit, and the camera falls back to it the moment the killer sinks or respawns, so the kill-cam never cuts to an empty dock. A debug sink (F6) has no killer: the cell shows the countdown over the own sinking boat ("SUNK").

Respawn dock (`pickRespawnDock`): candidates = docks with no boat within `dockClearance` (12 m) and with every enemy boat on the water at least 80 m away; random among them (seeded `rng` for replays); fallback: the free dock with the largest nearest-enemy distance; last resort: any dock. Two boats respawning in the same step pass the first pick in `occupied` (tested).

Hull water: `speedMultiplier = 1 - 0.5 x water / 100`; the stream adds 25/s (a full hull in 4 s); bailing removes `shake x 40` per second on a 3-person team (full shake empties in 2.5 s) and a flat 20/s on 1- and 2-person teams; no natural drain for 3-person teams so the Engineer has a job. Clamped 0..100.

Inventory (`applyPickup`, `consumeShot`, `usePower`): one weapon slot plus the implicit infinite Water Cannon; same weapon tops up to full ammo; different weapon replaces (consumed either way); the last shot sets `weapon = null` so the HUD and phone show Water Cannon again; two power slots fill in order; a third blue crate is `consumed: false` and stays; items whose tier is off are `effect: 'disabled'` and also never rolled. Death: `wipeInventory()`.

Crates: a crate point's category is fixed (`crateCategoryForIndex`: 3 of every 5 map points are red, `crates.weaponShare = 0.6`, because a Gunner without a weapon cannot score). Contents are rolled with weights among the enabled tiers: weapons Cannon 50, Torpedo 30, Mortar 20 (Should); powers Shield 35, Mine 35, Boost 20 (Should), Smoke 5 and Wave 5 (Stretch). Respawn 8 s; 4 s in the last 60 s when the stretch tier is on (`crateRespawnDelay`, `isFrenzy` also turns the timer red).

### 2e. Aiming (`src/sim/aim.ts`)

Aim is one world angle per team (`aimYaw`, radians, bow direction `(cos a, sin a)` on the sim plane; sim `y` is world `z`, final sign conventions belong to `shared/map.ts`). Candidates are the enemy boats that are `alive` and not inside smoke (`hidden`).

- Aim assist: inside a cone of half-angle 8 deg and 70 m, the enemy with the smallest angular offset wins (distance breaks ties), and the shot yaw is bent by `clamp(offset, -4 deg, +4 deg)`. Why smallest angle, not nearest: "near the aim line" is what the Gunner sees; a boat 2 deg off at 60 m is the one they are aiming at, not a boat 7 deg off at 20 m.
- Under the crosshair ("red diamond", gyro gain x 0.6): the aim ray hits the enemy's hull circle (3.5 m) within 90 m; while already on target the circle is 4.6 m (hysteresis) so the state does not flicker at the hull edge. A ray-vs-circle test instead of a fixed angle because the angular size of a 6 m boat changes 3x between 20 m and 60 m.
- The gain reduction is applied on the scene PC when integrating: `aimYaw = wrap(aimYaw + dYaw x (onTarget ? 0.6 : 1) x gyroSign)` (`integrateAim`). The phone sends raw `dYaw` (already dead-zoned and x2 as the spec's sensor note says) because it knows nothing about enemies, the scene is the single source of truth, the same code path serves the keyboard and the bots, and the 0.6 is then a config number instead of a phone redeploy.
- Torpedo lock: nearest enemy *by distance* in a 40 deg cone (half-angle 20) ahead of the **aim**, within 70 m. Along the aim, not the bow: the lock ring is drawn on the crosshair, the Gunner is looking there, and a bow-relative lock would fire at a boat that is not even on screen when the Gunner is looking sideways. Nearest by distance because the torpedo homes (90 deg/s), so angle inside the cone hardly matters but travel time does.
- Mortar: nearest enemy within 10 deg half-angle and 60 m, walls ignored (it lobs); otherwise the point 40 m ahead along the aim.
- Crosshair state from the same facts (`crosshairFor`): hit flash (0.3 s after `hit`) > lock ring (Torpedo equipped and a lock) > red diamond (`onTarget`) > neutral.
- Line of sight: yes for the diamond, the assist and the Torpedo lock; no for the Mortar. A red diamond on a boat behind a building invites wasted shots, and a lock ring on a target the torpedo will never reach feels like a bug. The test is injected (`LineOfSight` callback); the sim implements it with Rapier `world.castRay(new Ray(a, dir), dist, true, QueryFilterFlags.ONLY_FIXED)` (walls, poles and bridge piers are fixed bodies, so dynamic boats never block the ray; verified on the installed 0.21.0: `ONLY_FIXED = 6`, returns `RayColliderHit | null` with `timeOfImpact`). At most 6 teams x 1 ray per step, negligible. Tests use `() => true` / `() => false`.

### 2f. Scoring (`src/sim/rules.ts`)

`compareTeams`: kills desc, deaths asc, earliest `lastKillAt` (a team that never scored sorts after one that did), index asc. `rankTeams` gives the podium order for places 2..6 as well. `computeResults` adds `topGunner` (the player with most kills, any role; ties by join order) and `bestRam` (highest `impactSpeed` of a lethal ram, kept per player in `bestRamSpeed`). Kill feed: `killFeedText` -> "Azzurro sank Verde with a Torpedo", "Oro sank Viola with a Mine", "Rosso rammed Oro", "Verde sank" for a debug sink; `pushKillFeed` keeps the last 5. Minimap: `revealAfterFire` sets `revealedUntil = now + 2` for lethal weapons (the Water Cannon only if `minimap.revealOnWaterCannon`), and `isRevealed` is true while in a lagoon cell (`shared/map.ts` answers `isLagoon(x, y)`), during overtime for tied teams, never while sinking or respawning.

### 2g. Keyboard harness and bots (`src/scene/keyboard.ts`, `src/scene/bot.ts`)

The harness emits the exact `PilotIn` / `GunnerIn` / `EngIn` packets a phone would (`harnessInputs` is pure: pressed codes + edge codes + dt -> one frame), and the scene feeds them through `sim.applyInput(memberId, packet)` for the members of the focused team, so phones, keyboard and bots share one input path. Keys use `KeyboardEvent.code` (physical position: `KeyA` is the A position on AZERTY too), values confirmed against the W3C UI Events code spec.

| key | action |
|---|---|
| 1..6 (`Digit1`..`Digit6`) | focus team |
| A / D | Pilot steer (held) |
| W / S | GAS / BRAKE (held) |
| C | Pilot CALIBRATE (tap) |
| Left / Right | Gunner aim: `dYaw = +-120 deg/s x dt` |
| Space | FIRE (held: auto-fire where the weapon allows) |
| R | RECENTER (tap) |
| Q / E | Engineer power slot 0 / 1 (tap) |
| B | SHAKE TO BAIL (held = shake 1) |
| Enter | Start (lobby) / Rematch (results) |
| P | pause |
| F1 or 7 | debug overlay |
| F2 or 8 | collider wireframes |
| F3 or 9 | free camera |
| F4 or 0 | add a fake team (3 bot players) |
| F5 or - | give the focused Gunner a random weapon |
| F6 or = | sink the focused boat (no killer, feed "X sank") |
| T | toggle bots for all non-focused teams |

F-keys: Chrome binds F1 (help), F3 (find), F5 (reload), F6 (focus toolbar), F11 (fullscreen) itself, and outside fullscreen a page cannot reliably cancel them with `preventDefault()` (reports differ by platform; sources in section 6). Chromium's `IsReservedCommandOrKey` states that in fullscreen "all commands except for IDC_FULLSCREEN and IDC_EXIT should be delivered to the web page", so the harness calls `startFullscreenCapture()` from the Start click (user activation): `requestFullscreen()` and then, where it exists (Chrome 68+, Edge 79+, secure context, JS-initiated fullscreen only, needs a permission prompt since Chrome 130), `navigator.keyboard.lock([...F-keys])`. Because none of that is guaranteed on every PC, every F-key has a plain alternative on the number row (7 8 9 0 - =). `e.repeat` events are ignored (held keys stay in `pressed`), and `blur` clears the set so GAS never sticks when someone alt-tabs.
Rejected: `KeyboardEvent.key` (layout dependent: Z/W swap on AZERTY); making F-keys the only binding.

Bots (`botThink`): read-only over `GameState`, return the three packets plus their memory. Waypoint = nearest weapon crate when unarmed, else the nearest alive enemy, else any crate; steer = `clamp(angleDiff / 30 deg, -1, 1)`, gas unless the target is more than 110 deg behind; stuck (speed < 0.8 m/s for 2 s) -> reverse 1.5 s with the wheel flipped; aim turns toward the nearest enemy at 150 deg/s (sending `dYaw` so the sim's on-target gain and sign apply exactly as for a phone) and fires inside 55 m and 12 deg (Water Cannon inside 14 m); a power every 8 s when it makes sense (Shield under 30 m, Boost under 45 m, Mine under 25 m); shake whenever there is water. Enough to fill 4 viewports with moving, shooting, sinking, respawning boats and to feed the kill feed and scoreboard on day one.

### 2h. `shared/config.ts`

Groups: `teams`, `boat`, `steer`, `water`, `weapons` (waterCannon, cannon, torpedo, mortar), `powers`, `items` (label, tier, weight), `crates`, `match`, `respawn`, `aim`, `camera`, `phone`, `net`, `minimap`, `bots`, `sim`, plus `TIERS`, `TEAM_COLOURS` and `PLAYTEST_TUNING`. `[spec]` marks numbers from SPEC.md; the rest are defaults. `as const` gives literal types for free; `GameConfig = typeof CONFIG` is what every pure function takes as an optional last parameter, so tests can pass a modified copy. Tier gating is one table: `TIERS.stretch = false` removes Smoke, Wave, the frenzy and solo controls everywhere at once.

### 2i. `shared/state.ts`

`GameState` holds phase and absolute timers, teams (name, colours, ordered members, kills, deaths, lastKillAt), boats (pose and prevPose for interpolation, velocity, aimYaw, status and statusUntil, water, weapon and ammo, powers, shield/boost/protection/smoke/reveal timers, killedBy with the frozen killer pose, crosshair state, lock and assist teams, the echoed input for animation), players (id, name, joinOrder, pinned, connected, enabled, ready, calibrated, kind, kills, deaths, bestRamSpeed), spectators, crates (category, contents or null while respawning, respawnAt), mines, projectiles (kind, position, velocity, height for the arc, owner, target, landing point), smoke, kill feed (last 5), results, overtimeTeams, frenzy. `createEmptyState('RIVA')` survives `JSON.parse(JSON.stringify())` unchanged (checked with tsx).
Must NOT be in it: Rapier `World`, `RigidBody`, `Collider` or their `handle` values (the installed 0.21.0 returns handles like `5e-324`, packed index+generation floats that only mean something to the live World and change when the world is rebuilt for a new match), Three.js objects, functions, `Map`/`Set`/`Date`, class instances, wall-clock timestamps, countdown values that would need decrementing, derived data such as `player.team` (use `slotOf`). The sim keeps a private side table `Map<teamIndex, RigidBody>` / `Map<crateId, Collider>`.

`src/sim/hud.ts` projects the state: `phoneHud(state, playerId)` is the spec's `Hud` message (overtime reported as battle, `respawnIn` = ceil(statusUntil - now), ammo -1 for the Water Cannon), `viewportHud(state, team)` has the top-left crew list with roles, kills/deaths, weapon/ammo, powers, water, protection/shield/boost seconds left, `bowVsAim` for the bottom arrow, crosshair state and the kill-cam text/countdown; `sharedHud(state)` has the m:ss clock, red flag (overtime, frenzy, last `match.clockRedLastSeconds` = 30 s), ranked scoreboard and the kill feed strings.


## 3. Code, ready to paste (type-checked and tested)

Target paths are relative to the repo root. Imports use the `@shared/*` alias with `.ts` extensions (as `tsconfig.json` and `vite.config.ts` allow) inside `src/`, relative `./` imports inside `shared/` and `../` from `tests/` (matching the existing `tests/math.test.ts`). `src/scene/keyboard.ts` and `src/scene/bot.ts` import `PilotIn`, `GunnerIn`, `EngIn` from `@shared/protocol.ts`; the stand-in used for type-checking declares exactly the SPEC section 11 types:

```ts
// shared/protocol.ts (excerpt that these files depend on)
export type PilotIn = { t: 'in'; role: 'pilot'; steer: number; gas: boolean; brake: boolean };
export type GunnerIn = { t: 'in'; role: 'gunner'; dYaw: number; fire: boolean; recenter: boolean };
export type EngIn = { t: 'in'; role: 'engineer'; use: 0 | 1 | null; shake: number };
```


### `shared/config.ts`

```ts
/**
 * Every tunable number in one place. Read by the sim, the renderer, the HUD,
 * the phone and the bots. No logic here beyond tiny helpers; no imports from
 * src/. Values marked [spec] come from SPEC.md, the rest are our defaults
 * to be adjusted at the playtest (see PLAYTEST_TUNING at the bottom).
 */

export type Tier = 'mvp' | 'should' | 'stretch';

export type WeaponKind = 'cannon' | 'torpedo' | 'mortar';
export type PowerKind = 'shield' | 'mine' | 'boost' | 'smoke' | 'wave';
export type ItemKind = WeaponKind | PowerKind;
export type CrateCategory = 'weapon' | 'power';

/** Which scope tiers are switched on. Flip a tier off and every feature in it disappears from crates, HUD and rules. */
export const TIERS: Readonly<Record<Tier, boolean>> = {
  mvp: true,
  should: true,
  stretch: false,
};

export interface TeamColour {
  /** Italian name shown on the viewport border and the phone. */
  name: string;
  /** Fill colour: viewport border, crosshair, boat trim and lantern, phone background. */
  hex: string;
  /** Text colour that reads on `hex` (WCAG contrast >= 4.1 against it). */
  text: '#000000' | '#FFFFFF';
}

/** [spec] Team order is join order; the colour follows the team index. */
export const TEAM_COLOURS: readonly TeamColour[] = [
  { name: 'Rosso', hex: '#E53935', text: '#FFFFFF' },
  { name: 'Azzurro', hex: '#29B6F6', text: '#000000' },
  { name: 'Verde', hex: '#4CAF50', text: '#000000' },
  { name: 'Oro', hex: '#FFD600', text: '#000000' },
  { name: 'Viola', hex: '#BA68C8', text: '#000000' },
  { name: 'Arancio', hex: '#FB8C00', text: '#000000' },
];

export interface ItemDef {
  kind: ItemKind;
  /** Shown in the HUD, the phone and the kill feed ("sank X with a Torpedo"). */
  label: string;
  tier: Tier;
  /** Relative weight inside its crate category. */
  weight: number;
}

export const CONFIG = {
  teams: {
    maxTeams: 6, // [spec] most viewports a projector shows readably
    defaultTeamSize: 3 as 2 | 3, // [spec] host picks 3 (default) or 2
    maxPlayers: 18, // [spec] 6 teams x 3
    minTeamsToStart: 2, // a match needs an enemy
  },

  boat: {
    length: 6, // [spec] m
    width: 1.4, // [spec] m
    mass: 400, // kg, arcade value (a real gondola is ~600 kg; lighter = snappier)
    topSpeed: 10, // [spec] m/s
    boostMultiplier: 1.6, // [spec] 16 m/s with Boost
    reverseThrustRatio: 0.4, // [spec] reverse is 40% of forward thrust
    forwardThrust: 2600, // N; with mass 400 and damping 0.6 this reaches ~10 m/s
    linearDamping: 0.6, // 1/s, water resistance (Rapier RigidBodyDesc.setLinearDamping)
    angularDamping: 3.0, // 1/s
    lateralGrip: 8, // 1/s, how fast sideways velocity is killed (the keel)
    driftGrip: 2, // 1/s, same while BRAKE is held at speed (stern slides out)
    driftMinSpeed: 4, // m/s, BRAKE below this is plain reverse, above it is a drift turn
    steerTorqueAtRest: 400, // N m, slow turn still possible at rest
    steerTorqueAtSpeed: 1800, // N m, reached at topSpeed
    hullRadius: 3.2, // m, bounding circle used by aim tests and crate pickup
    ramMinImpactSpeed: 7, // m/s relative speed for a boosted ram to be lethal
  },

  steer: {
    deadZoneDeg: 4, // [spec]
    fullLockDeg: 35, // [spec]
    sign: 1 as 1 | -1, // flip if left turns right on the first phone test
  },

  water: {
    max: 100, // [spec] hull water 0..100
    speedPenalty: 0.5, // [spec] speed x (1 - 0.5 * water / 100)
    fillPerSecond: 25, // 4 s of continuous Water Cannon stream fills a hull
    bailPerSecondAtFullShake: 40, // Engineer shaking hard empties a full hull in 2.5 s
    autoDrainPerSecond: 20, // [spec] 2-person teams drain at half the manual rate
    naturalDrainPerSecond: 0, // 3-person teams: the Engineer has to work
  },

  weapons: {
    waterCannon: {
      range: 14, // m, short stream
      halfAngleDeg: 6, // the stream is a thin cone
      pushForce: 1800, // N, continuous push along the stream
      endsSpawnProtection: true, // decision: any firing ends the bubble, water cannon included
    },
    cannon: {
      ammo: 5, // [spec]
      speed: 45, // m/s, fast straight shot
      range: 90, // m, the ball is removed beyond this
      cooldown: 0.45, // s between shots while FIRE is held (auto-fire allowed)
      autoFire: true,
      hitRadius: 1.2, // m, ball vs hull-circle check
    },
    torpedo: {
      ammo: 2, // [spec]
      speed: 20, // m/s, slower than the cannon, homes
      lifetime: 7, // s
      lockHalfAngleDeg: 20, // [spec] 40 degree cone ahead of the aim
      lockRange: 70, // m
      homingTurnRateDegPerSec: 90, // how fast it bends toward the lock
      cooldown: 1.0,
      autoFire: false,
      hitRadius: 1.5,
    },
    mortar: {
      ammo: 3, // [spec]
      targetHalfAngleDeg: 10, // [spec] within 10 degrees of the aim line
      targetRange: 60, // [spec] m
      fallbackRange: 40, // [spec] lands 40 m ahead without a target
      splashRadius: 6, // [spec] m
      flightTime: 1.8, // s, fixed so the lob is readable
      cooldown: 1.2,
      autoFire: false,
    },
  },

  powers: {
    shield: { duration: 8, hits: 1 }, // [spec] 8 s or 1 hit
    mine: { armDelay: 1, lifetime: 45, triggerRadius: 2.5, dropBehind: 5 }, // [spec] arms after 1 s, lasts 45 s
    boost: { duration: 3 }, // [spec] 3 s, speed from boat.boostMultiplier
    smoke: { duration: 6, radius: 7, trailSpacing: 4 }, // [spec] 6 s trail, hides and breaks locks
    wave: { radius: 12, impulse: 2500 }, // [spec] shoves every boat within 12 m
    ping: { reveal: 2, cooldown: 20 }, // [spec] stretch, Engineer
  },

  items: [
    { kind: 'cannon', label: 'Cannon', tier: 'mvp', weight: 50 },
    { kind: 'torpedo', label: 'Torpedo', tier: 'mvp', weight: 30 },
    { kind: 'mortar', label: 'Mortar', tier: 'should', weight: 20 },
    { kind: 'shield', label: 'Shield', tier: 'mvp', weight: 35 },
    { kind: 'mine', label: 'Mine', tier: 'mvp', weight: 35 },
    { kind: 'boost', label: 'Boost', tier: 'should', weight: 20 },
    { kind: 'smoke', label: 'Smoke', tier: 'stretch', weight: 5 },
    { kind: 'wave', label: 'Wave', tier: 'stretch', weight: 5 },
  ] as readonly ItemDef[],

  crates: {
    respawnSeconds: 8, // [spec]
    frenzyRespawnSeconds: 4, // [spec] stretch: twice as fast in the final minute
    pickupRadius: 2.5, // m, crate centre to hull circle
    weaponShare: 0.6, // 3 of every 5 crate points are red (weapon)
    powerSlots: 2, // [spec] Engineer holds 2 powers
  },

  match: {
    countdownSeconds: 10, // [spec]
    battleSeconds: 300, // [spec]
    resultsSeconds: 20, // [spec]
    suddenDeathSeconds: 30, // [spec]
    frenzyLastSeconds: 60, // [spec] stretch: timer turns red, crates respawn faster
    hornAtSecondsLeft: 3, // 3-2-1 beeps then the horn at 0
    clockRedLastSeconds: 30, // the big clock turns red for the last 30 s (and all of overtime / frenzy)
    autoReturnToLobby: true, // results time out into a rematch-ready lobby
  },

  respawn: {
    sinkSeconds: 2, // [spec] flip and sink
    respawnSeconds: 5, // [spec] measured from the hit
    killCamSeconds: 5, // [spec]
    spawnProtectionSeconds: 3, // [spec]
    minDistanceToEnemy: 80, // [spec] m
    dockClearance: 12, // m, a dock already holding a boat is skipped
  },

  aim: {
    gyroGain: 2, // [spec] phone turn x2 = view turn
    gyroDeadZoneDegPerSec: 2, // [spec] hand tremor
    gyroSign: 1 as 1 | -1, // flip on the first test if left turns right
    onTargetGain: 0.6, // [spec] gain drops by 40% while an enemy is under the crosshair
    onTargetRadius: 3.5, // m, hull circle used for "under the crosshair" (hullRadius + margin)
    onTargetStickyRadius: 4.6, // m, larger circle while already on target (hysteresis)
    onTargetRange: 90, // m
    assistHalfAngleDeg: 8, // candidates for the 4 degree bend
    assistRange: 70, // m
    assistMaxBendDeg: 4, // [spec]
    requireLineOfSight: true, // diamond + assist + torpedo lock need a clear wall ray
    keyboardTurnRateDegPerSec: 120, // Left/Right keys
    hitFlashSeconds: 0.3, // X flash after a landed shot
  },

  camera: {
    back: 9, // [spec] m behind the boat along the aim
    up: 4, // [spec] m above the water
    fovDeg: 60,
    yawSmoothingTau: 0.08, // s, exponential smoothing of the camera yaw toward aimYaw
    killCamDistance: 14, // m from the killer
    killCamHeight: 7,
    far: 220, // m, haze hides the rest
  },

  phone: {
    inputHz: 30, // [spec]
    hudHz: 10, // [spec]
    shakePeakThreshold: 15, // [spec] m/s^2 without gravity
    shakePeaksPerSecondForFull: 4, // peaks/s that map to shake = 1
    vibrateFireMs: 25,
    vibrateHitMs: 120,
    flashMs: 150, // iOS has no vibration: red flash
    gravityLowPassTau: 0.15, // s, gravity vector filter for the gyro projection
  },

  net: {
    inputTimeoutSeconds: 1.5, // no packet for this long: the controller is idle (boat coasts)
    reconnectGraceSeconds: 180, // the slot is kept for a token this long after a drop
    tokenStorageKey: 'gondola.token',
    roomCodeLength: 4,
  },

  minimap: {
    revealAfterFireSeconds: 2, // [spec]
    revealOnWaterCannon: false, // the stream is short range; it would reveal constantly
    revealInLagoon: true, // [spec]
    revealTiedTeamsInOvertime: true, // decision: sudden death must not be hide and seek
  },

  bots: {
    turnRateDegPerSec: 150,
    fireRange: 55,
    fireHalfAngleDeg: 12,
    stuckSeconds: 2,
    stuckSpeed: 0.8,
    reverseSeconds: 1.5,
    waypointReached: 6,
    powerUseInterval: 8,
  },

  sim: {
    hz: 60, // [spec] fixed step
    maxStepsPerFrame: 5, // spiral-of-death guard when a tab was hidden
  },
} as const;

export type GameConfig = typeof CONFIG;

export function itemDef(kind: ItemKind, cfg: GameConfig = CONFIG): ItemDef {
  const def = cfg.items.find((d) => d.kind === kind);
  if (!def) throw new Error(`unknown item ${kind}`);
  return def;
}

export function isWeapon(kind: ItemKind): kind is WeaponKind {
  return kind === 'cannon' || kind === 'torpedo' || kind === 'mortar';
}

export function itemEnabled(kind: ItemKind, tiers: Readonly<Record<Tier, boolean>> = TIERS, cfg: GameConfig = CONFIG): boolean {
  return tiers[itemDef(kind, cfg).tier];
}

/** What to tune with real players at checkpoint 2, in priority order. */
export const PLAYTEST_TUNING: readonly string[] = [
  'aim.gyroGain and aim.gyroDeadZoneDegPerSec (twitchy vs sluggish)',
  'aim.assistMaxBendDeg and aim.onTargetGain (hits per shot should be about 1 in 3)',
  'steer.deadZoneDeg and steer.fullLockDeg (nobody should need to wrench the phone)',
  'boat.forwardThrust, linearDamping, steerTorqueAtSpeed (feel of the turn)',
  'respawn.minDistanceToEnemy and spawnProtectionSeconds (spawn kills)',
  'water.fillPerSecond and bailPerSecondAtFullShake (is bailing a real job)',
  'weapons.cannon.ammo, torpedo.ammo, mortar.ammo and crates.respawnSeconds (looting pace)',
  'items[].weight (are Torpedoes deciding every fight)',
  'boat.ramMinImpactSpeed (rams should be rare and loud)',
];
```


### `shared/state.ts`

```ts
/**
 * GameState: the simulation writes it, everything else reads it.
 *
 * Rules for this file:
 *  - plain data only: numbers, strings, booleans, arrays, records, null.
 *    JSON.parse(JSON.stringify(state)) must give an equal object.
 *  - NO Rapier World / RigidBody / Collider objects and NO Rapier handles
 *    (they are packed f64 values such as 5e-324 that only mean something to
 *    the live World). NO Three.js objects, NO functions, NO Map/Set/Date,
 *    NO class instances. The sim keeps its handles in a private side table
 *    keyed by team index / crate id / mine id.
 *  - every timer is an absolute sim time in seconds (compare with simTime),
 *    never a wall-clock value and never a countdown that must be decremented.
 */
import type { CrateCategory, ItemKind, PowerKind, WeaponKind } from './config.ts';

export type Phase = 'lobby' | 'countdown' | 'battle' | 'overtime' | 'results';
export type Role = 'pilot' | 'gunner' | 'engineer';
export const ROLES: readonly Role[] = ['pilot', 'gunner', 'engineer'];
export type TeamSize = 2 | 3;
export type BoatStatus = 'alive' | 'sinking' | 'respawning' | 'out';
/** What can sink a boat. Powers other than the Mine never kill. */
export type LethalKind = WeaponKind | 'mine' | 'ram';
export type CrosshairState = 'neutral' | 'target' | 'hit' | 'lock';
export type PlayerKind = 'phone' | 'keyboard' | 'bot';
export type ProjectileKind = WeaponKind;

/** Sim-plane pose. x, y are metres on the water (sim y = world z); angle is radians, bow direction = (cos angle, sin angle). */
export interface Pose {
  x: number;
  y: number;
  angle: number;
}

export interface Killer {
  team: number;
  playerId: string | null;
  weapon: LethalKind;
  /** The killer's pose at the moment of the hit: the kill-cam looks here if the killer sinks or respawns meanwhile. */
  pose: Pose;
}

export interface BoatState {
  team: number;
  /** After the last sim step. */
  pose: Pose;
  /** Before the last sim step; the renderer lerps prevPose -> pose by the frame's alpha. */
  prevPose: Pose;
  vx: number;
  vy: number;
  speed: number;
  /** World angle of the Gunner's aim (stabilised: does not follow the bow). */
  aimYaw: number;
  status: BoatStatus;
  /** Sim time at which `status` ends: sinking -> respawning -> alive. 0 while alive. */
  statusUntil: number;
  water: number;
  weapon: { kind: WeaponKind; ammo: number } | null;
  powers: [PowerKind | null, PowerKind | null];
  shieldUntil: number;
  boostUntil: number;
  protectedUntil: number;
  smokeUntil: number;
  revealedUntil: number;
  fireReadyAt: number;
  hitFlashUntil: number;
  /** Echo of the last applied inputs, for animation (rowing, bailing) and the bots. */
  input: { steer: number; gas: boolean; brake: boolean; fire: boolean; shake: number };
  /** Set on a lethal hit, cleared at respawn. Drives the kill-cam and "SUNK by X". */
  killedBy: Killer | null;
  crosshair: CrosshairState;
  /** Enemy team the Torpedo would lock, or the Cannon would bend toward. */
  lockTeam: number | null;
  assistTeam: number | null;
}

export interface TeamState {
  index: number;
  name: string;
  colour: string;
  textColour: string;
  /** Player ids in role order: [pilot, gunner, engineer]. */
  members: string[];
  kills: number;
  deaths: number;
  /** Sim time of the last kill, for the "first to reach the score" tiebreak. 0 = never. */
  lastKillAt: number;
}

export interface PlayerState {
  id: string;
  name: string;
  joinOrder: number;
  /** Placed by hand (moved or swapped): the balancer moves these last. */
  pinned: boolean;
  connected: boolean;
  /** Tapped Enable controls (sensor permission granted). */
  enabled: boolean;
  ready: boolean;
  calibrated: boolean;
  kind: PlayerKind;
  kills: number;
  deaths: number;
  bestRamSpeed: number;
}

export interface CrateState {
  id: number;
  x: number;
  y: number;
  category: CrateCategory;
  /** null while the crate is respawning. */
  contents: ItemKind | null;
  respawnAt: number;
}

export interface MineState {
  id: number;
  x: number;
  y: number;
  ownerTeam: number;
  ownerPlayer: string | null;
  armedAt: number;
  expiresAt: number;
}

export interface ProjectileState {
  id: number;
  kind: ProjectileKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Visual height above the water for the arc; hits are decided in 2D. */
  height: number;
  ownerTeam: number;
  ownerPlayer: string | null;
  /** Torpedo lock or Mortar target team, null when unguided. */
  targetTeam: number | null;
  /** Mortar landing point (fixed at launch). */
  landX: number;
  landY: number;
  spawnedAt: number;
  expiresAt: number;
}

export interface SmokeState {
  id: number;
  x: number;
  y: number;
  ownerTeam: number;
  until: number;
}

export interface KillFeedEntry {
  at: number;
  killerTeam: number | null;
  victimTeam: number;
  weapon: LethalKind | 'none';
  text: string;
}

export interface ResultsState {
  /** Team indices, best first. */
  ranking: number[];
  winner: number | null;
  draw: boolean;
  decidedBy: 'kills' | 'deaths' | 'overtime' | 'firstToScore' | 'draw';
  topGunner: { playerId: string; name: string; kills: number } | null;
  bestRam: { playerId: string; name: string; speed: number } | null;
}

export interface GameState {
  roomCode: string;
  tick: number;
  /** Seconds of simulated time. Advances only while the sim steps, so pause freezes every timer. */
  simTime: number;
  phase: Phase;
  /** Sim time at which the current phase ends (0 in the lobby). */
  phaseEndsAt: number;
  paused: boolean;
  teamSize: TeamSize;
  teams: TeamState[];
  /** One boat per team, same index. */
  boats: BoatState[];
  players: Record<string, PlayerState>;
  /** Join-order queue of players beyond capacity. */
  spectators: string[];
  crates: CrateState[];
  mines: MineState[];
  projectiles: ProjectileState[];
  smoke: SmokeState[];
  /** Newest last, at most 5. */
  killFeed: KillFeedEntry[];
  results: ResultsState | null;
  /** Teams still playing in sudden death; empty otherwise. */
  overtimeTeams: number[];
  /** Final-minute frenzy is on (stretch). */
  frenzy: boolean;
}

export type SimEvent =
  | { kind: 'phase'; phase: Phase }
  | { kind: 'horn' }
  | { kind: 'beep'; secondsLeft: number }
  | { kind: 'fired'; team: number; weapon: WeaponKind | 'waterCannon' }
  | { kind: 'hit'; team: number; victimTeam: number }
  | { kind: 'shielded'; team: number; byTeam: number }
  | { kind: 'kill'; team: number; victimTeam: number; playerId: string | null; weapon: LethalKind }
  | { kind: 'sunk'; team: number; byTeam: number | null }
  | { kind: 'respawn'; team: number }
  | { kind: 'pickup'; team: number; item: ItemKind }
  | { kind: 'power'; team: number; power: PowerKind }
  | { kind: 'crateRespawn'; crateId: number }
  | { kind: 'win'; team: number | null };

export function createEmptyState(roomCode: string, teamSize: TeamSize = 3): GameState {
  return {
    roomCode,
    tick: 0,
    simTime: 0,
    phase: 'lobby',
    phaseEndsAt: 0,
    paused: false,
    teamSize,
    teams: [],
    boats: [],
    players: {},
    spectators: [],
    crates: [],
    mines: [],
    projectiles: [],
    smoke: [],
    killFeed: [],
    results: null,
    overtimeTeams: [],
    frenzy: false,
  };
}

export function roleAt(index: number): Role | null {
  return ROLES[index] ?? null;
}
```


### `src/sim/teams.ts`

```ts
/**
 * Lobby, teams and roles. Pure functions: every call returns a new Lobby and
 * the list of people it moved, so the host UI can toast "Marco -> Verde".
 *
 * Invariants:
 *  - a player is in exactly one place: one team's member list or the spectator queue.
 *  - role = index in the member list: 0 Pilot, 1 Gunner, 2 Engineer.
 *  - after every change the team sizes are the balanced multiset for the
 *    active player count (7 in threes is 3+2+2, never 3+3+1).
 */
import { CONFIG } from '@shared/config.ts';
import type { PlayerState, Role, TeamSize } from '@shared/state.ts';
import { ROLES } from '@shared/state.ts';

export type LobbyPlayer = Pick<
  PlayerState,
  'id' | 'name' | 'joinOrder' | 'pinned' | 'connected' | 'enabled' | 'ready' | 'calibrated' | 'kind'
>;

export interface Lobby {
  teamSize: TeamSize;
  /** teams[i] = player ids in role order. */
  teams: string[][];
  players: Record<string, LobbyPlayer>;
  /** Join-order queue beyond capacity. */
  spectators: string[];
}

export interface Move {
  id: string;
  /** Team index before, null = spectators or new. */
  from: number | null;
  /** Team index after (final numbering), null = spectators. */
  to: number | null;
}

export interface LobbyChange {
  lobby: Lobby;
  moves: Move[];
  /** Some surviving team changed its index (and therefore its colour). */
  renumbered: boolean;
}

export interface Slot {
  team: number;
  role: Role;
  index: number;
}

/** What one phone has to show. Merged roles for short-handed teams. */
export interface ControlSet {
  steer: boolean;
  gas: boolean;
  aim: boolean;
  fire: boolean;
  powers: boolean;
  bail: boolean;
  /** 1-person team: auto-throttle and auto-target FIRE (stretch). */
  solo: boolean;
}

const MAX_TEAMS = CONFIG.teams.maxTeams;

export function capacity(size: TeamSize, maxTeams: number = MAX_TEAMS): number {
  return size * maxTeams;
}

/** Number of teams for n active players: min(6, ceil(n / size)). */
export function teamCount(n: number, size: TeamSize, maxTeams: number = MAX_TEAMS): number {
  if (n <= 0) return 0;
  return Math.min(maxTeams, Math.ceil(n / size));
}

/**
 * Balanced sizes, largest first: base = floor(n / t), the first (n mod t) teams get one more.
 * Players beyond capacity are not counted (they are spectators).
 */
export function targetSizes(n: number, size: TeamSize, maxTeams: number = MAX_TEAMS): number[] {
  const active = Math.min(Math.max(0, n), capacity(size, maxTeams));
  const t = teamCount(active, size, maxTeams);
  if (t === 0) return [];
  const base = Math.floor(active / t);
  const extra = active % t;
  const out: number[] = [];
  for (let i = 0; i < t; i++) out.push(base + (i < extra ? 1 : 0));
  return out;
}

export function balanceTable(size: TeamSize, upTo: number = 18): { n: number; sizes: number[]; spectators: number }[] {
  const rows: { n: number; sizes: number[]; spectators: number }[] = [];
  for (let n = 1; n <= upTo; n++) {
    rows.push({ n, sizes: targetSizes(n, size), spectators: Math.max(0, n - capacity(size)) });
  }
  return rows;
}

export function createLobby(teamSize: TeamSize = CONFIG.teams.defaultTeamSize): Lobby {
  return { teamSize, teams: [], players: {}, spectators: [] };
}

export function slotOf(lobby: Lobby, id: string): Slot | null {
  for (let t = 0; t < lobby.teams.length; t++) {
    const members = lobby.teams[t];
    if (!members) continue;
    const i = members.indexOf(id);
    if (i >= 0) {
      const role = ROLES[i];
      if (role) return { team: t, role, index: i };
    }
  }
  return null;
}

export function controlsFor(lobby: Lobby, id: string): ControlSet | null {
  const slot = slotOf(lobby, id);
  if (!slot) return null;
  const size = lobby.teams[slot.team]?.length ?? 0;
  if (size === 1) return { steer: true, gas: false, aim: false, fire: true, powers: true, bail: false, solo: true };
  if (slot.role === 'pilot') return { steer: true, gas: true, aim: false, fire: false, powers: false, bail: false, solo: false };
  if (slot.role === 'gunner') {
    // 2-person team: the Gunner also gets the two power buttons; bailing is automatic.
    return { steer: false, gas: false, aim: true, fire: true, powers: size === 2, bail: false, solo: false };
  }
  return { steer: false, gas: false, aim: false, fire: false, powers: true, bail: true, solo: false };
}

function clone(lobby: Lobby): Lobby {
  const players: Record<string, LobbyPlayer> = {};
  for (const [id, p] of Object.entries(lobby.players)) players[id] = { ...p };
  return {
    teamSize: lobby.teamSize,
    teams: lobby.teams.map((m) => [...m]),
    players,
    spectators: [...lobby.spectators],
  };
}

function joinOrderOf(lobby: Lobby, id: string): number {
  return lobby.players[id]?.joinOrder ?? Number.MAX_SAFE_INTEGER;
}

/** Unpinned first, then most recent joiners first. */
function moverPriority(lobby: Lobby, a: string, b: string): number {
  const pa = lobby.players[a]?.pinned ? 1 : 0;
  const pb = lobby.players[b]?.pinned ? 1 : 0;
  if (pa !== pb) return pa - pb;
  return joinOrderOf(lobby, b) - joinOrderOf(lobby, a);
}

/**
 * Re-establish the invariants with the fewest moves:
 *  1. demote the most recent joiners beyond capacity to spectators, promote spectators into free capacity;
 *  2. the balanced size multiset is matched to teams by current size (largest keeps largest), so only surplus people move;
 *  3. surplus teams give up unpinned, most recent joiners first; dissolved teams are the smallest with the fewest pins;
 *  4. deficits are filled in team order, earliest joiners first; a moved player takes the next free role.
 * Each person who moves does so exactly once, which is the minimum for the chosen target multiset.
 */
export function rebalance(input: Lobby): LobbyChange {
  const lobby = clone(input);
  const moves: Move[] = [];
  const cap = capacity(lobby.teamSize);

  interface Work {
    orig: number;
    members: string[];
    target: number;
  }
  const work: Work[] = lobby.teams.map((members, orig) => ({ orig, members, target: 0 }));
  let active = work.reduce((n, w) => n + w.members.length, 0);
  const homeless: { id: string; from: number | null }[] = [];

  // 1a. over capacity (team size was lowered): demote most recent joiners.
  while (active > cap) {
    let best: { w: Work; id: string } | null = null;
    for (const w of work) {
      for (const id of w.members) {
        if (!best || moverPriority(lobby, id, best.id) < 0) best = { w, id };
      }
    }
    if (!best) break;
    best.w.members.splice(best.w.members.indexOf(best.id), 1);
    lobby.spectators.push(best.id);
    moves.push({ id: best.id, from: best.w.orig, to: null });
    active--;
  }
  lobby.spectators.sort((a, b) => joinOrderOf(lobby, a) - joinOrderOf(lobby, b));
  // 1b. free capacity: promote spectators in join order.
  while (active < cap && lobby.spectators.length > 0) {
    const id = lobby.spectators.shift();
    if (id === undefined) break;
    homeless.push({ id, from: null });
    active++;
  }

  // 2. targets by current size: largest team keeps the largest target.
  const targets = targetSizes(active, lobby.teamSize);
  const pinnedCount = (w: Work): number => w.members.filter((id) => lobby.players[id]?.pinned).length;
  const order = [...work].sort((a, b) => b.members.length - a.members.length || pinnedCount(b) - pinnedCount(a) || a.orig - b.orig);
  while (work.length < targets.length) {
    const w: Work = { orig: -1, members: [], target: 0 };
    work.push(w);
    order.push(w);
  }
  for (let i = 0; i < order.length; i++) {
    const w = order[i];
    if (w) w.target = targets[i] ?? 0; // beyond the target count: dissolved
  }

  // 3. surplus leaves (dissolved teams have target 0 so everybody leaves).
  for (const w of work) {
    while (w.members.length > w.target) {
      const sorted = [...w.members].sort((a, b) => moverPriority(lobby, a, b));
      const id = sorted[0];
      if (id === undefined) break;
      w.members.splice(w.members.indexOf(id), 1);
      homeless.push({ id, from: w.orig });
    }
  }

  // 4. fill deficits in team order, earliest joiners first.
  homeless.sort((a, b) => joinOrderOf(lobby, a.id) - joinOrderOf(lobby, b.id));
  const kept = work.filter((w) => w.target > 0);
  for (const w of kept) {
    while (w.members.length < w.target && homeless.length > 0) {
      const h = homeless.shift();
      if (!h) break;
      w.members.push(h.id);
      moves.push({ id: h.id, from: h.from, to: w.orig }); // fixed up below
    }
  }
  // anything left over (should not happen) goes to spectators
  for (const h of homeless) {
    lobby.spectators.push(h.id);
    moves.push({ id: h.id, from: h.from, to: null });
  }

  // compact and renumber
  const finalIndex = new Map<number, number>();
  let renumbered = false;
  kept.forEach((w, i) => {
    if (w.orig >= 0) {
      finalIndex.set(w.orig, i);
      if (w.orig !== i) renumbered = true;
    }
  });
  lobby.teams = kept.map((w) => w.members);
  // `to` was recorded as orig index (or -1 for a new team): translate to the final index.
  for (const m of moves) {
    if (m.to === null) continue;
    if (m.to >= 0) m.to = finalIndex.get(m.to) ?? m.to;
    else m.to = kept.findIndex((w) => w.members.includes(m.id));
  }
  return { lobby, moves, renumbered };
}

export function joinPlayer(input: Lobby, player: LobbyPlayer): LobbyChange {
  const lobby = clone(input);
  if (lobby.players[player.id]) return reconnectPlayer(lobby, player.id, player.name);
  lobby.players[player.id] = { ...player, pinned: false };
  lobby.spectators.push(player.id); // rebalance promotes it if there is room
  return rebalance(lobby);
}

/** Same token comes back: same slot, same role. */
export function reconnectPlayer(input: Lobby, id: string, name?: string): LobbyChange {
  const lobby = clone(input);
  const p = lobby.players[id];
  if (!p) return { lobby, moves: [], renumbered: false };
  p.connected = true;
  if (name) p.name = name;
  return { lobby, moves: [], renumbered: false };
}

/** Lobby phase only: the player is gone for good and the teams close up. */
export function leavePlayer(input: Lobby, id: string): LobbyChange {
  const lobby = clone(input);
  if (!lobby.players[id]) return { lobby, moves: [], renumbered: false };
  for (const members of lobby.teams) {
    const i = members.indexOf(id);
    if (i >= 0) members.splice(i, 1);
  }
  lobby.spectators = lobby.spectators.filter((s) => s !== id);
  delete lobby.players[id];
  return rebalance(lobby);
}

/** Countdown or battle: the slot stays, the boat idles, the keyboard can take it. */
export function markDisconnected(input: Lobby, id: string): Lobby {
  const lobby = clone(input);
  const p = lobby.players[id];
  if (p) p.connected = false;
  return lobby;
}

export function setTeamSize(input: Lobby, size: TeamSize): LobbyChange {
  const lobby = clone(input);
  lobby.teamSize = size;
  return rebalance(lobby);
}

export function setFlags(
  input: Lobby,
  id: string,
  flags: Partial<Pick<LobbyPlayer, 'enabled' | 'ready' | 'calibrated' | 'name'>>,
): Lobby {
  const lobby = clone(input);
  const p = lobby.players[id];
  if (p) Object.assign(p, flags);
  return lobby;
}

/** Swap role with a teammate (both become pinned). */
export function swapRoles(input: Lobby, id: string, otherId: string): LobbyChange {
  const lobby = clone(input);
  const a = slotOf(lobby, id);
  const b = slotOf(lobby, otherId);
  if (!a || !b || a.team !== b.team || id === otherId) return { lobby, moves: [], renumbered: false };
  const members = lobby.teams[a.team];
  if (!members) return { lobby, moves: [], renumbered: false };
  members[a.index] = otherId;
  members[b.index] = id;
  const pa = lobby.players[id];
  const pb = lobby.players[otherId];
  if (pa) pa.pinned = true;
  if (pb) pb.pinned = true;
  return { lobby, moves: [], renumbered: false };
}

/** Move to any team with a free slot (members < teamSize). The mover is pinned; the balancer then fixes sizes around them. */
export function moveToTeam(input: Lobby, id: string, team: number): LobbyChange {
  const lobby = clone(input);
  const from = slotOf(lobby, id);
  const dest = lobby.teams[team];
  if (!dest || dest.length >= lobby.teamSize || (from && from.team === team)) {
    return { lobby, moves: [], renumbered: false };
  }
  if (from) lobby.teams[from.team]?.splice(from.index, 1);
  else lobby.spectators = lobby.spectators.filter((s) => s !== id);
  dest.push(id);
  const p = lobby.players[id];
  if (p) p.pinned = true;
  const result = rebalance(lobby);
  result.moves.unshift({ id, from: from ? from.team : null, to: team });
  return result;
}

export interface StartCheck {
  ok: boolean;
  problems: string[];
  warnings: string[];
}

/** The host needs at least 2 teams, each with a connected Pilot. Missing Enable controls only warns: the keyboard can cover. */
export function canStart(lobby: Lobby, minTeams: number = CONFIG.teams.minTeamsToStart): StartCheck {
  const problems: string[] = [];
  const warnings: string[] = [];
  if (lobby.teams.length < minTeams) problems.push(`need ${minTeams} teams, have ${lobby.teams.length}`);
  lobby.teams.forEach((members, t) => {
    const pilot = members[0];
    const p = pilot ? lobby.players[pilot] : undefined;
    if (!p) problems.push(`team ${t} has no Pilot`);
    else if (!p.connected) problems.push(`team ${t}: Pilot ${p.name} is disconnected`);
    for (const id of members) {
      const m = lobby.players[id];
      if (m && m.kind === 'phone' && !m.enabled) warnings.push(`${m.name} has not tapped Enable controls`);
    }
  });
  return { ok: problems.length === 0, problems, warnings };
}

/** Rematch: same teams, same roles; per-round flags reset. Disconnected players keep their slot. */
export function rematchLobby(input: Lobby): Lobby {
  const lobby = clone(input);
  for (const p of Object.values(lobby.players)) {
    p.ready = false;
    p.calibrated = false;
  }
  return lobby;
}

/** New lobby: pins cleared, disconnected players dropped, everyone re-seated by join order. */
export function resetLobby(input: Lobby): LobbyChange {
  const fresh = createLobby(input.teamSize);
  const ids = Object.values(input.players)
    .filter((p) => p.connected)
    .sort((a, b) => a.joinOrder - b.joinOrder);
  for (const p of ids) {
    fresh.players[p.id] = { ...p, pinned: false, ready: false, calibrated: false };
    fresh.spectators.push(p.id);
  }
  return rebalance(fresh);
}

export function activePlayerCount(lobby: Lobby): number {
  return lobby.teams.reduce((n, m) => n + m.length, 0);
}
```


### `src/sim/rules.ts`

```ts
/**
 * Match flow, combat rules, respawn, hull water, scoring. Pure functions over
 * plain data; the Sim class calls them and applies the results to GameState
 * and to Rapier. Every time value is sim time in seconds.
 */
import { CONFIG, itemDef } from '@shared/config.ts';
import type { GameConfig, WeaponKind } from '@shared/config.ts';
import type { Vec2 } from '@shared/math.ts';
import type {
  BoatStatus,
  Killer,
  KillFeedEntry,
  LethalKind,
  Phase,
  PlayerState,
  Pose,
  ResultsState,
  SimEvent,
  TeamSize,
  TeamState,
} from '@shared/state.ts';

// ---------------------------------------------------------------------------
// Match state machine (timers are absolute sim times; pause = do not step)
// ---------------------------------------------------------------------------

export interface MatchClock {
  phase: Phase;
  phaseEndsAt: number;
}

export type MatchTransition =
  | { kind: 'none' }
  | { kind: 'battle' }
  | { kind: 'overtime'; teams: number[] }
  | { kind: 'results'; results: ResultsState }
  | { kind: 'lobby' };

export function lobbyClock(): MatchClock {
  return { phase: 'lobby', phaseEndsAt: 0 };
}

export function startCountdown(now: number, cfg: GameConfig = CONFIG): MatchClock {
  return { phase: 'countdown', phaseEndsAt: now + cfg.match.countdownSeconds };
}

export function timeLeft(clock: MatchClock, now: number): number {
  return clock.phase === 'lobby' ? 0 : Math.max(0, clock.phaseEndsAt - now);
}

/** 3-2-1 beeps: emitted when the whole-second countdown crosses 3, 2, 1. */
export function countdownBeeps(prevLeft: number, left: number, cfg: GameConfig = CONFIG): SimEvent[] {
  const out: SimEvent[] = [];
  const a = Math.ceil(prevLeft);
  const b = Math.ceil(left);
  for (let s = Math.min(a - 1, cfg.match.hornAtSecondsLeft); s >= Math.max(b, 1); s--) {
    out.push({ kind: 'beep', secondsLeft: s });
  }
  return out;
}

/**
 * Advance the phase clock. Call once per sim step after simTime advanced.
 * `teams` and `players` are needed to settle the result when the battle ends.
 */
export function tickMatch(
  clock: MatchClock,
  now: number,
  teams: readonly TeamState[],
  players: Readonly<Record<string, PlayerState>>,
  cfg: GameConfig = CONFIG,
): { clock: MatchClock; transition: MatchTransition; events: SimEvent[] } {
  if (clock.phase === 'lobby' || now < clock.phaseEndsAt) return { clock, transition: { kind: 'none' }, events: [] };
  switch (clock.phase) {
    case 'countdown':
      return {
        clock: { phase: 'battle', phaseEndsAt: clock.phaseEndsAt + cfg.match.battleSeconds },
        transition: { kind: 'battle' },
        events: [{ kind: 'horn' }, { kind: 'phase', phase: 'battle' }],
      };
    case 'battle': {
      const tied = tiedForFirst(teams);
      if (tied.length > 1) {
        return {
          clock: { phase: 'overtime', phaseEndsAt: clock.phaseEndsAt + cfg.match.suddenDeathSeconds },
          transition: { kind: 'overtime', teams: tied },
          events: [{ kind: 'horn' }, { kind: 'phase', phase: 'overtime' }],
        };
      }
      const results = computeResults(teams, players, leaderDecidedBy(teams));
      return finish(clock, results, cfg);
    }
    case 'overtime': {
      const results = decideAfterOvertime(teams, players);
      return finish(clock, results, cfg);
    }
    case 'results':
      return cfg.match.autoReturnToLobby
        ? { clock: lobbyClock(), transition: { kind: 'lobby' }, events: [{ kind: 'phase', phase: 'lobby' }] }
        : { clock, transition: { kind: 'none' }, events: [] };
    default:
      return { clock, transition: { kind: 'none' }, events: [] };
  }
}

function finish(clock: MatchClock, results: ResultsState, cfg: GameConfig): { clock: MatchClock; transition: MatchTransition; events: SimEvent[] } {
  return {
    clock: { phase: 'results', phaseEndsAt: clock.phaseEndsAt + cfg.match.resultsSeconds },
    transition: { kind: 'results', results },
    events: [{ kind: 'phase', phase: 'results' }, { kind: 'win', team: results.winner }],
  };
}

/** Next kill wins: call when a kill lands during overtime. */
export function overtimeKill(
  now: number,
  killerTeam: number,
  teams: readonly TeamState[],
  players: Readonly<Record<string, PlayerState>>,
  cfg: GameConfig = CONFIG,
): { clock: MatchClock; results: ResultsState } {
  const results = computeResults(teams, players, 'overtime', killerTeam);
  return { clock: { phase: 'results', phaseEndsAt: now + cfg.match.resultsSeconds }, results };
}

/** Host abort: back to the lobby, scores dropped, teams kept. */
export function abortMatch(): MatchClock {
  return lobbyClock();
}

/** Which boats leave the water for sudden death, and which tied boats must respawn immediately. */
export function overtimeBoatPlan(
  boats: readonly { team: number; status: BoatStatus }[],
  tied: readonly number[],
): { out: number[]; respawnNow: number[] } {
  const out: number[] = [];
  const respawnNow: number[] = [];
  for (const b of boats) {
    if (!tied.includes(b.team)) out.push(b.team);
    else if (b.status !== 'alive') respawnNow.push(b.team);
  }
  return { out, respawnNow };
}

// ---------------------------------------------------------------------------
// Lethal hits
// ---------------------------------------------------------------------------

export interface HitTarget {
  team: number;
  status: BoatStatus;
  shieldUntil: number;
  protectedUntil: number;
  boostUntil: number;
}

export type HitSource =
  | { kind: WeaponKind | 'mine'; team: number; playerId: string | null; pose: Pose }
  | { kind: 'ram'; team: number; playerId: string | null; pose: Pose; attackerBoostUntil: number; impactSpeed: number }
  | { kind: 'waterCannon'; team: number; playerId: string | null; pose: Pose };

export type IgnoreReason = 'notAlive' | 'ownTeam' | 'protected' | 'notLethal' | 'attackerNotBoosted' | 'bothBoosted' | 'ramTooSlow';

export type HitOutcome =
  | { result: 'ignored'; reason: IgnoreReason }
  | { result: 'shielded'; byTeam: number }
  | { result: 'sunk'; killer: Killer };

/**
 * Order of checks (each one is a test case):
 *  1. target not alive  -> ignored (a sinking boat cannot be killed twice)
 *  2. same team         -> ignored (own shots, splash, mines, rams never hurt you)
 *  3. not lethal        -> ignored (Water Cannon; an unboosted or slow ram; two boosted boats bounce)
 *  4. spawn protection  -> ignored, the Shield is NOT consumed
 *  5. Shield up         -> shielded, Shield consumed
 *  6. otherwise         -> sunk, credited to source.team / source.playerId
 */
export function resolveHit(target: HitTarget, source: HitSource, now: number, cfg: GameConfig = CONFIG): HitOutcome {
  if (target.status !== 'alive') return { result: 'ignored', reason: 'notAlive' };
  if (target.team === source.team) return { result: 'ignored', reason: 'ownTeam' };
  if (source.kind === 'waterCannon') return { result: 'ignored', reason: 'notLethal' };
  if (source.kind === 'ram') {
    const attackerBoosted = now < source.attackerBoostUntil;
    const targetBoosted = now < target.boostUntil;
    if (!attackerBoosted) return { result: 'ignored', reason: 'attackerNotBoosted' };
    if (targetBoosted) return { result: 'ignored', reason: 'bothBoosted' };
    if (source.impactSpeed < cfg.boat.ramMinImpactSpeed) return { result: 'ignored', reason: 'ramTooSlow' };
  }
  if (now < target.protectedUntil) return { result: 'ignored', reason: 'protected' };
  if (now < target.shieldUntil) return { result: 'shielded', byTeam: source.team };
  return {
    result: 'sunk',
    killer: { team: source.team, playerId: source.playerId, weapon: source.kind, pose: { ...source.pose } },
  };
}

// ---------------------------------------------------------------------------
// Death -> sinking -> respawn -> spawn protection
// ---------------------------------------------------------------------------

export interface SinkTimeline {
  hitAt: number;
  /** flip + sink animation, status 'sinking' */
  sinkingUntil: number;
  /** status 'respawning' until here, then teleport to the dock */
  respawnAt: number;
  killCamUntil: number;
  protectedUntil: number;
}

export function sinkTimeline(hitAt: number, cfg: GameConfig = CONFIG): SinkTimeline {
  const r = cfg.respawn;
  return {
    hitAt,
    sinkingUntil: hitAt + r.sinkSeconds,
    respawnAt: hitAt + r.respawnSeconds,
    killCamUntil: hitAt + r.killCamSeconds,
    protectedUntil: hitAt + r.respawnSeconds + r.spawnProtectionSeconds,
  };
}

export function statusAt(t: SinkTimeline, now: number): BoatStatus {
  if (now < t.sinkingUntil) return 'sinking';
  if (now < t.respawnAt) return 'respawning';
  return 'alive';
}

/** Any firing ends the bubble; the Water Cannon too unless the config says otherwise. */
export function firingEndsProtection(weapon: WeaponKind | 'waterCannon', cfg: GameConfig = CONFIG): boolean {
  return weapon !== 'waterCannon' || cfg.weapons.waterCannon.endsSpawnProtection;
}

export interface Dock extends Vec2 {
  id: number;
}

/**
 * Random dock at least minDistanceToEnemy from every enemy boat on the water and
 * not within dockClearance of any boat (or a dock chosen earlier this step).
 * Fallback: the free dock farthest from the nearest enemy; last resort: any dock.
 */
export function pickRespawnDock(
  docks: readonly Dock[],
  enemies: readonly Vec2[],
  occupied: readonly Vec2[],
  rng: () => number,
  cfg: GameConfig = CONFIG,
): Dock | null {
  if (docks.length === 0) return null;
  const minEnemy = (d: Dock): number => enemies.reduce((m, e) => Math.min(m, Math.hypot(e.x - d.x, e.y - d.y)), Infinity);
  const isFree = (d: Dock): boolean => occupied.every((o) => Math.hypot(o.x - d.x, o.y - d.y) >= cfg.respawn.dockClearance);
  const free = docks.filter(isFree);
  const pool = free.length > 0 ? free : [...docks];
  const safe = pool.filter((d) => minEnemy(d) >= cfg.respawn.minDistanceToEnemy);
  if (safe.length > 0) return safe[Math.min(safe.length - 1, Math.floor(rng() * safe.length))] ?? null;
  let best: Dock | null = null;
  let bestDist = -1;
  for (const d of pool) {
    const m = minEnemy(d);
    if (m > bestDist) {
      bestDist = m;
      best = d;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Hull water
// ---------------------------------------------------------------------------

export function speedMultiplier(water: number, cfg: GameConfig = CONFIG): number {
  return 1 - cfg.water.speedPenalty * (water / cfg.water.max);
}

/** Bail rate in units/s: Engineer shaking (0..1) on a 3-person team, automatic half rate on 2- and 1-person teams. */
export function bailRate(shake: number, teamMembers: number, cfg: GameConfig = CONFIG): number {
  if (teamMembers >= 3) return Math.max(cfg.water.naturalDrainPerSecond, shake * cfg.water.bailPerSecondAtFullShake);
  return cfg.water.autoDrainPerSecond;
}

/** `streamSeconds` = seconds of Water Cannon stream that hit this step (0 or dt). */
export function stepWater(
  water: number,
  streamSeconds: number,
  shake: number,
  teamMembers: number,
  dt: number,
  cfg: GameConfig = CONFIG,
): number {
  const filled = water + streamSeconds * cfg.water.fillPerSecond;
  const bailed = filled - bailRate(shake, teamMembers, cfg) * dt;
  return Math.max(0, Math.min(cfg.water.max, bailed));
}

export function membersForWater(teamSize: TeamSize, members: number): number {
  return Math.min(teamSize, members);
}

// ---------------------------------------------------------------------------
// Scoring, ranking, results, kill feed, minimap
// ---------------------------------------------------------------------------

export interface KillRecord {
  killerTeam: number;
  killerPlayer: string | null;
  victimTeam: number;
  weapon: LethalKind;
  at: number;
  /** Ram only: relative speed at impact, for "best ram". */
  impactSpeed?: number;
}

/** Returns new team and player records with the kill applied (inputs untouched). */
export function creditKill(
  teams: readonly TeamState[],
  players: Readonly<Record<string, PlayerState>>,
  kill: KillRecord,
): { teams: TeamState[]; players: Record<string, PlayerState> } {
  const nextTeams = teams.map((t) => {
    if (t.index === kill.killerTeam) return { ...t, kills: t.kills + 1, lastKillAt: kill.at };
    if (t.index === kill.victimTeam) return { ...t, deaths: t.deaths + 1 };
    return t;
  });
  const nextPlayers: Record<string, PlayerState> = { ...players };
  const killer = kill.killerPlayer ? nextPlayers[kill.killerPlayer] : undefined;
  if (killer && kill.killerPlayer) {
    nextPlayers[kill.killerPlayer] = {
      ...killer,
      kills: killer.kills + 1,
      bestRamSpeed: kill.weapon === 'ram' ? Math.max(killer.bestRamSpeed, kill.impactSpeed ?? 0) : killer.bestRamSpeed,
    };
  }
  const victim = teams.find((t) => t.index === kill.victimTeam);
  for (const id of victim?.members ?? []) {
    const p = nextPlayers[id];
    if (p) nextPlayers[id] = { ...p, deaths: p.deaths + 1 };
  }
  return { teams: nextTeams, players: nextPlayers };
}

/** Kills desc, deaths asc, earliest last kill, lower index. A team that never scored sorts after one that did. */
export function compareTeams(a: TeamState, b: TeamState): number {
  if (a.kills !== b.kills) return b.kills - a.kills;
  if (a.deaths !== b.deaths) return a.deaths - b.deaths;
  const la = a.lastKillAt > 0 ? a.lastKillAt : Infinity;
  const lb = b.lastKillAt > 0 ? b.lastKillAt : Infinity;
  if (la !== lb) return la - lb;
  return a.index - b.index;
}

export function rankTeams(teams: readonly TeamState[]): number[] {
  return [...teams].sort(compareTeams).map((t) => t.index);
}

/** Teams equal to the leader on kills AND deaths (rules 1 and 2 exhausted). */
export function tiedForFirst(teams: readonly TeamState[]): number[] {
  const ranked = [...teams].sort(compareTeams);
  const top = ranked[0];
  if (!top) return [];
  return ranked.filter((t) => t.kills === top.kills && t.deaths === top.deaths).map((t) => t.index);
}

function leaderDecidedBy(teams: readonly TeamState[]): ResultsState['decidedBy'] {
  const ranked = [...teams].sort(compareTeams);
  const a = ranked[0];
  const b = ranked[1];
  if (!a || !b) return 'kills';
  return a.kills === b.kills ? 'deaths' : 'kills';
}

/** Still tied after 30 s: the tied team that reached the final score first wins; nobody ever scored -> draw. */
export function decideAfterOvertime(teams: readonly TeamState[], players: Readonly<Record<string, PlayerState>>): ResultsState {
  const tied = tiedForFirst(teams);
  const scored = tied
    .map((i) => teams.find((t) => t.index === i))
    .filter((t): t is TeamState => !!t && t.lastKillAt > 0)
    .sort((a, b) => a.lastKillAt - b.lastKillAt);
  const first = scored[0];
  if (first) return computeResults(teams, players, 'firstToScore', first.index);
  return { ...computeResults(teams, players, 'draw', null), draw: true, winner: null };
}

export function computeResults(
  teams: readonly TeamState[],
  players: Readonly<Record<string, PlayerState>>,
  decidedBy: ResultsState['decidedBy'],
  forcedWinner: number | null = null,
): ResultsState {
  let ranking = rankTeams(teams);
  if (forcedWinner !== null) ranking = [forcedWinner, ...ranking.filter((i) => i !== forcedWinner)];
  const winner = ranking[0] ?? null;
  return {
    ranking,
    winner,
    draw: false,
    decidedBy,
    topGunner: topGunner(players),
    bestRam: bestRam(players),
  };
}

/** Most kills by one player (shots credit the Gunner, Mines whoever dropped them, rams the Pilot). */
export function topGunner(players: Readonly<Record<string, PlayerState>>): ResultsState['topGunner'] {
  let best: PlayerState | null = null;
  for (const p of Object.values(players)) {
    if (p.kills <= 0) continue;
    if (!best || p.kills > best.kills || (p.kills === best.kills && p.joinOrder < best.joinOrder)) best = p;
  }
  return best ? { playerId: best.id, name: best.name, kills: best.kills } : null;
}

export function bestRam(players: Readonly<Record<string, PlayerState>>): ResultsState['bestRam'] {
  let best: PlayerState | null = null;
  for (const p of Object.values(players)) {
    if (p.bestRamSpeed <= 0) continue;
    if (!best || p.bestRamSpeed > best.bestRamSpeed) best = p;
  }
  return best ? { playerId: best.id, name: best.name, speed: best.bestRamSpeed } : null;
}

export function weaponLabel(weapon: LethalKind | 'none', cfg: GameConfig = CONFIG): string {
  if (weapon === 'ram') return 'a ram';
  if (weapon === 'none') return 'the sea';
  return `a ${itemDef(weapon, cfg).label}`;
}

/** "Azzurro sank Verde with a Torpedo"; "Rosso rammed Oro"; "Verde sank (debug)". */
export function killFeedText(killerName: string | null, victimName: string, weapon: LethalKind | 'none', cfg: GameConfig = CONFIG): string {
  if (killerName === null || weapon === 'none') return `${victimName} sank`;
  if (weapon === 'ram') return `${killerName} rammed ${victimName}`;
  return `${killerName} sank ${victimName} with ${weaponLabel(weapon, cfg)}`;
}

export function pushKillFeed(feed: readonly KillFeedEntry[], entry: KillFeedEntry, max: number = 5): KillFeedEntry[] {
  const next = [...feed, entry];
  return next.length > max ? next.slice(next.length - max) : next;
}

/** Firing reveals the boat on the minimap for 2 s (not the Water Cannon by default). */
export function revealAfterFire(revealedUntil: number, now: number, weapon: WeaponKind | 'waterCannon', cfg: GameConfig = CONFIG): number {
  if (weapon === 'waterCannon' && !cfg.minimap.revealOnWaterCannon) return revealedUntil;
  return Math.max(revealedUntil, now + cfg.minimap.revealAfterFireSeconds);
}

export function isRevealed(
  boat: { status: BoatStatus; revealedUntil: number },
  now: number,
  inLagoon: boolean,
  overtime: boolean,
  cfg: GameConfig = CONFIG,
): boolean {
  if (boat.status !== 'alive') return false;
  if (overtime && cfg.minimap.revealTiedTeamsInOvertime) return true;
  if (inLagoon && cfg.minimap.revealInLagoon) return true;
  return now < boat.revealedUntil;
}

/** Ram pre-check used by the collision handler before building a HitSource. */
export function ramIsLethal(attackerBoostUntil: number, targetBoostUntil: number, impactSpeed: number, now: number, cfg: GameConfig = CONFIG): boolean {
  return now < attackerBoostUntil && now >= targetBoostUntil && impactSpeed >= cfg.boat.ramMinImpactSpeed;
}
```


### `src/sim/items.ts`

```ts
/**
 * Crates and inventory. Pure functions over plain data.
 */
import { CONFIG, isWeapon, itemDef } from '@shared/config.ts';
import type { CrateCategory, GameConfig, ItemKind, PowerKind, Tier, WeaponKind } from '@shared/config.ts';
import { TIERS } from '@shared/config.ts';
import type { Phase } from '@shared/state.ts';

export interface Inventory {
  weapon: { kind: WeaponKind; ammo: number } | null;
  powers: [PowerKind | null, PowerKind | null];
}

export type PickupResult =
  | { inv: Inventory; consumed: true; effect: 'topUp' | 'replace' | 'newWeapon' | 'newPower' }
  | { inv: Inventory; consumed: false; effect: 'powersFull' | 'disabled' };

export function emptyInventory(): Inventory {
  return { weapon: null, powers: [null, null] };
}

/** Death wipes everything; the Water Cannon is implicit and infinite. */
export function wipeInventory(): Inventory {
  return emptyInventory();
}

export function ammoFor(kind: WeaponKind, cfg: GameConfig = CONFIG): number {
  return cfg.weapons[kind].ammo;
}

/** Crate point i is red (weapon) for 3 of every 5 points, so weapons are never far away. */
export function crateCategoryForIndex(i: number, cfg: GameConfig = CONFIG): CrateCategory {
  const period = 5;
  const reds = Math.round(cfg.crates.weaponShare * period);
  return i % period < reds ? 'weapon' : 'power';
}

export function itemsInCategory(
  category: CrateCategory,
  cfg: GameConfig = CONFIG,
  tiers: Readonly<Record<Tier, boolean>> = TIERS,
): ItemKind[] {
  return cfg.items
    .filter((d) => tiers[d.tier] && (category === 'weapon') === isWeapon(d.kind))
    .map((d) => d.kind);
}

/** Weighted roll among the enabled items of the category. */
export function rollCrateContents(
  category: CrateCategory,
  rng: () => number,
  cfg: GameConfig = CONFIG,
  tiers: Readonly<Record<Tier, boolean>> = TIERS,
): ItemKind {
  const kinds = itemsInCategory(category, cfg, tiers);
  const total = kinds.reduce((s, k) => s + itemDef(k, cfg).weight, 0);
  let r = rng() * total;
  for (const k of kinds) {
    r -= itemDef(k, cfg).weight;
    if (r < 0) return k;
  }
  const last = kinds[kinds.length - 1];
  if (!last) throw new Error(`no enabled items in category ${category}`);
  return last;
}

/**
 * Same weapon tops the ammo up; a different weapon replaces the old one;
 * powers fill the first free slot; with both full the crate stays in the water.
 */
export function applyPickup(
  inv: Inventory,
  item: ItemKind,
  cfg: GameConfig = CONFIG,
  tiers: Readonly<Record<Tier, boolean>> = TIERS,
): PickupResult {
  if (!tiers[itemDef(item, cfg).tier]) return { inv, consumed: false, effect: 'disabled' };
  if (isWeapon(item)) {
    const ammo = ammoFor(item, cfg);
    if (inv.weapon && inv.weapon.kind === item) {
      return { inv: { ...inv, weapon: { kind: item, ammo } }, consumed: true, effect: 'topUp' };
    }
    return { inv: { ...inv, weapon: { kind: item, ammo } }, consumed: true, effect: inv.weapon ? 'replace' : 'newWeapon' };
  }
  const slot: 0 | 1 | null = inv.powers[0] === null ? 0 : inv.powers[1] === null ? 1 : null;
  if (slot === null) return { inv, consumed: false, effect: 'powersFull' };
  const powers: [PowerKind | null, PowerKind | null] = [inv.powers[0], inv.powers[1]];
  powers[slot] = item;
  return { inv: { ...inv, powers }, consumed: true, effect: 'newPower' };
}

/** One shot of the current weapon. The last shot empties the slot: the Water Cannon is back automatically. */
export function consumeShot(inv: Inventory): { inv: Inventory; fired: WeaponKind | 'waterCannon'; emptied: boolean } {
  if (!inv.weapon) return { inv, fired: 'waterCannon', emptied: false };
  const ammo = inv.weapon.ammo - 1;
  if (ammo <= 0) return { inv: { ...inv, weapon: null }, fired: inv.weapon.kind, emptied: true };
  return { inv: { ...inv, weapon: { kind: inv.weapon.kind, ammo } }, fired: inv.weapon.kind, emptied: false };
}

export function usePower(inv: Inventory, slot: 0 | 1): { inv: Inventory; power: PowerKind | null } {
  const power = inv.powers[slot];
  if (!power) return { inv, power: null };
  const powers: [PowerKind | null, PowerKind | null] = [inv.powers[0], inv.powers[1]];
  powers[slot] = null;
  return { inv: { ...inv, powers }, power };
}

export function weaponLabel(inv: Inventory, cfg: GameConfig = CONFIG): string {
  return inv.weapon ? itemDef(inv.weapon.kind, cfg).label : 'Water Cannon';
}

/** 8 s normally; 4 s in the final minute when the frenzy (stretch) is on. */
export function crateRespawnDelay(
  now: number,
  phase: Phase,
  phaseEndsAt: number,
  cfg: GameConfig = CONFIG,
  tiers: Readonly<Record<Tier, boolean>> = TIERS,
): number {
  const frenzy = tiers.stretch && phase === 'battle' && phaseEndsAt - now <= cfg.match.frenzyLastSeconds;
  return frenzy ? cfg.crates.frenzyRespawnSeconds : cfg.crates.respawnSeconds;
}

export function isFrenzy(
  now: number,
  phase: Phase,
  phaseEndsAt: number,
  cfg: GameConfig = CONFIG,
  tiers: Readonly<Record<Tier, boolean>> = TIERS,
): boolean {
  return tiers.stretch && phase === 'battle' && phaseEndsAt - now <= cfg.match.frenzyLastSeconds;
}
```


### `src/sim/aim.ts`

```ts
/**
 * Aiming in 2D (SPEC section 4). Aim is one world angle per team; every shot
 * leaves flat along it. These functions are pure: they take the shooter's
 * position, the aim yaw, the enemy candidates and an injected line-of-sight
 * test (a Rapier wall ray in the sim, `() => true` in tests).
 */
import { CONFIG } from '@shared/config.ts';
import type { GameConfig, WeaponKind } from '@shared/config.ts';
import { angleDiff, clamp, DEG, wrapAngle } from '@shared/math.ts';
import type { CrosshairState } from '@shared/state.ts';

export interface AimCandidate {
  team: number;
  x: number;
  y: number;
  /** Inside smoke: invisible to assist, diamond and locks. */
  hidden: boolean;
}

/** True when nothing solid (walls, bridges piers, poles) lies between a and b. */
export type LineOfSight = (ax: number, ay: number, bx: number, by: number) => boolean;
export const ALWAYS_VISIBLE: LineOfSight = () => true;

export interface Bearing {
  team: number;
  x: number;
  y: number;
  dist: number;
  /** Signed angle from the aim line to the enemy, radians, positive = anticlockwise. */
  offset: number;
}

/** Distance along the unit ray (ox, oy) + t (dx, dy) to the first point on the circle, or null. */
export function rayCircleDistance(ox: number, oy: number, dx: number, dy: number, cx: number, cy: number, r: number): number | null {
  const fx = ox - cx;
  const fy = oy - cy;
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - r * r;
  const disc = b * b - 4 * c;
  if (disc < 0) return null;
  const s = Math.sqrt(disc);
  const t0 = (-b - s) / 2;
  if (t0 >= 0) return t0;
  const t1 = (-b + s) / 2;
  return t1 >= 0 ? 0 : null; // origin inside the circle counts as distance 0
}

export function bearings(ox: number, oy: number, aimYaw: number, candidates: readonly AimCandidate[]): Bearing[] {
  const out: Bearing[] = [];
  for (const c of candidates) {
    if (c.hidden) continue;
    const dx = c.x - ox;
    const dy = c.y - oy;
    const dist = Math.hypot(dx, dy);
    if (dist < 1e-6) continue;
    out.push({ team: c.team, x: c.x, y: c.y, dist, offset: angleDiff(aimYaw, Math.atan2(dy, dx)) });
  }
  return out;
}

/**
 * Red diamond + gyro slow-down: the aim ray hits an enemy's hull circle within
 * range and with line of sight. `wasOnTarget` enlarges the circle (hysteresis)
 * so the state does not flicker at the hull edge.
 */
export function enemyUnderCrosshair(
  ox: number,
  oy: number,
  aimYaw: number,
  candidates: readonly AimCandidate[],
  wasOnTarget: boolean,
  cfg: GameConfig = CONFIG,
  los: LineOfSight = ALWAYS_VISIBLE,
): number | null {
  const dx = Math.cos(aimYaw);
  const dy = Math.sin(aimYaw);
  const r = wasOnTarget ? cfg.aim.onTargetStickyRadius : cfg.aim.onTargetRadius;
  let best: { team: number; t: number } | null = null;
  for (const c of candidates) {
    if (c.hidden) continue;
    const t = rayCircleDistance(ox, oy, dx, dy, c.x, c.y, r);
    if (t === null || t > cfg.aim.onTargetRange) continue;
    if (best && t >= best.t) continue;
    if (cfg.aim.requireLineOfSight && !los(ox, oy, c.x, c.y)) continue;
    best = { team: c.team, t };
  }
  return best ? best.team : null;
}

/**
 * Cannon aim assist: among enemies inside the assist cone (smallest angular
 * offset wins, distance breaks ties), bend the shot by at most assistMaxBendDeg.
 */
export function aimAssist(
  ox: number,
  oy: number,
  aimYaw: number,
  candidates: readonly AimCandidate[],
  cfg: GameConfig = CONFIG,
  los: LineOfSight = ALWAYS_VISIBLE,
): { yaw: number; team: number | null } {
  const half = cfg.aim.assistHalfAngleDeg * DEG;
  const maxBend = cfg.aim.assistMaxBendDeg * DEG;
  let best: Bearing | null = null;
  for (const b of bearings(ox, oy, aimYaw, candidates)) {
    if (b.dist > cfg.aim.assistRange || Math.abs(b.offset) > half) continue;
    if (best && (Math.abs(b.offset) > Math.abs(best.offset) || (Math.abs(b.offset) === Math.abs(best.offset) && b.dist >= best.dist))) continue;
    if (cfg.aim.requireLineOfSight && !los(ox, oy, b.x, b.y)) continue;
    best = b;
  }
  if (!best) return { yaw: aimYaw, team: null };
  return { yaw: wrapAngle(aimYaw + clamp(best.offset, -maxBend, maxBend)), team: best.team };
}

/** Torpedo lock: the NEAREST enemy (by distance) inside the 40 degree cone ahead of the AIM, within lockRange. */
export function torpedoLock(
  ox: number,
  oy: number,
  aimYaw: number,
  candidates: readonly AimCandidate[],
  cfg: GameConfig = CONFIG,
  los: LineOfSight = ALWAYS_VISIBLE,
): number | null {
  const half = cfg.weapons.torpedo.lockHalfAngleDeg * DEG;
  let best: Bearing | null = null;
  for (const b of bearings(ox, oy, aimYaw, candidates)) {
    if (b.dist > cfg.weapons.torpedo.lockRange || Math.abs(b.offset) > half) continue;
    if (best && b.dist >= best.dist) continue;
    if (cfg.aim.requireLineOfSight && !los(ox, oy, b.x, b.y)) continue;
    best = b;
  }
  return best ? best.team : null;
}

/** Mortar: lands on the nearest enemy within 10 degrees of the aim line and 60 m (walls do not matter), else 40 m ahead. */
export function mortarTarget(
  ox: number,
  oy: number,
  aimYaw: number,
  candidates: readonly AimCandidate[],
  cfg: GameConfig = CONFIG,
): { x: number; y: number; team: number | null } {
  const half = cfg.weapons.mortar.targetHalfAngleDeg * DEG;
  let best: Bearing | null = null;
  for (const b of bearings(ox, oy, aimYaw, candidates)) {
    if (b.dist > cfg.weapons.mortar.targetRange || Math.abs(b.offset) > half) continue;
    if (best && b.dist >= best.dist) continue;
    best = b;
  }
  if (best) return { x: best.x, y: best.y, team: best.team };
  const r = cfg.weapons.mortar.fallbackRange;
  return { x: ox + Math.cos(aimYaw) * r, y: oy + Math.sin(aimYaw) * r, team: null };
}

/**
 * The sim integrates the phone's dYaw (already dead-zoned and x2 on the phone).
 * The on-target gain lives here because only the sim knows where enemies are.
 */
export function integrateAim(aimYaw: number, dYaw: number, onTarget: boolean, cfg: GameConfig = CONFIG): number {
  const gain = (onTarget ? cfg.aim.onTargetGain : 1) * cfg.aim.gyroSign;
  return wrapAngle(aimYaw + dYaw * gain);
}

/** Crosshair state from the same facts, priority: hit flash > lock ring > red diamond > neutral. */
export function crosshairFor(args: {
  now: number;
  hitFlashUntil: number;
  weapon: WeaponKind | null;
  lockTeam: number | null;
  onTarget: boolean;
}): CrosshairState {
  if (args.now < args.hitFlashUntil) return 'hit';
  if (args.weapon === 'torpedo' && args.lockTeam !== null) return 'lock';
  if (args.onTarget) return 'target';
  return 'neutral';
}

/** Keyboard Gunner: Left/Right produce a dYaw per frame like a phone would. */
export function keyboardDYaw(left: boolean, right: boolean, dt: number, cfg: GameConfig = CONFIG): number {
  const dir = (right ? -1 : 0) + (left ? 1 : 0);
  return dir * cfg.aim.keyboardTurnRateDegPerSec * DEG * dt;
}
```


### `src/sim/hud.ts`

```ts
/**
 * HUD data: pure projections of GameState for the phone (Hud message), each
 * viewport and the shared top bar. No DOM, no Three.js.
 */
import { CONFIG, itemDef } from '@shared/config.ts';
import type { GameConfig } from '@shared/config.ts';
import { angleDiff } from '@shared/math.ts';
import type { CrosshairState, GameState, Role } from '@shared/state.ts';
import { roleAt } from '@shared/state.ts';
import { rankTeams } from './rules.ts';

/** Mirrors the Hud message of SPEC section 11 (overtime is reported as 'battle'). */
export interface PhoneHud {
  t: 'hud';
  phase: 'lobby' | 'countdown' | 'battle' | 'results';
  team: number;
  role: Role;
  kills: number;
  deaths: number;
  respawnIn: number;
  weapon: string;
  ammo: number;
  powers: [string | null, string | null];
  water: number;
  alive: boolean;
}

export function phonePhase(phase: GameState['phase']): PhoneHud['phase'] {
  return phase === 'overtime' ? 'battle' : phase;
}

export function phoneHud(state: GameState, playerId: string, cfg: GameConfig = CONFIG): PhoneHud | null {
  for (const team of state.teams) {
    const index = team.members.indexOf(playerId);
    if (index < 0) continue;
    const role = roleAt(index);
    const boat = state.boats[team.index];
    if (!role) return null;
    return {
      t: 'hud',
      phase: phonePhase(state.phase),
      team: team.index,
      role,
      kills: team.kills,
      deaths: team.deaths,
      respawnIn: boat && boat.status !== 'alive' && boat.status !== 'out' ? Math.max(0, Math.ceil(boat.statusUntil - state.simTime)) : 0,
      weapon: boat?.weapon ? itemDef(boat.weapon.kind, cfg).label : 'Water Cannon',
      ammo: boat?.weapon ? boat.weapon.ammo : -1,
      powers: [boat?.powers[0] ? itemDef(boat.powers[0], cfg).label : null, boat?.powers[1] ? itemDef(boat.powers[1], cfg).label : null],
      water: boat ? Math.round(boat.water) : 0,
      alive: boat ? boat.status === 'alive' : false,
    };
  }
  return null;
}

export interface ViewportHud {
  team: number;
  name: string;
  colour: string;
  textColour: string;
  crew: { name: string; role: Role; connected: boolean }[];
  kills: number;
  deaths: number;
  weaponLabel: string;
  ammo: number | null;
  powers: [string | null, string | null];
  water: number;
  protectionLeft: number;
  shieldLeft: number;
  boostLeft: number;
  /** Bow direction relative to the aim (the camera), radians: 0 = bow straight ahead. */
  bowVsAim: number;
  crosshair: CrosshairState;
  killCam: { text: string; countdown: number; killerTeam: number | null } | null;
  out: boolean;
}

export function viewportHud(state: GameState, teamIndex: number, cfg: GameConfig = CONFIG): ViewportHud | null {
  const team = state.teams[teamIndex];
  const boat = state.boats[teamIndex];
  if (!team || !boat) return null;
  const now = state.simTime;
  const killer = boat.killedBy;
  const killerTeam = killer ? state.teams[killer.team] : undefined;
  const showKillCam = boat.status === 'sinking' || boat.status === 'respawning';
  return {
    team: teamIndex,
    name: team.name,
    colour: team.colour,
    textColour: team.textColour,
    crew: team.members.map((id, i) => ({
      name: state.players[id]?.name ?? '?',
      role: roleAt(i) ?? 'engineer',
      connected: state.players[id]?.connected ?? false,
    })),
    kills: team.kills,
    deaths: team.deaths,
    weaponLabel: boat.weapon ? itemDef(boat.weapon.kind, cfg).label : 'Water Cannon',
    ammo: boat.weapon ? boat.weapon.ammo : null,
    powers: [boat.powers[0] ? itemDef(boat.powers[0], cfg).label : null, boat.powers[1] ? itemDef(boat.powers[1], cfg).label : null],
    water: boat.water,
    protectionLeft: Math.max(0, boat.protectedUntil - now),
    shieldLeft: Math.max(0, boat.shieldUntil - now),
    boostLeft: Math.max(0, boat.boostUntil - now),
    bowVsAim: angleDiff(boat.aimYaw, boat.pose.angle),
    crosshair: boat.crosshair,
    killCam: showKillCam
      ? {
          text: killerTeam ? `SUNK by ${killerTeam.name}` : 'SUNK',
          countdown: Math.max(0, Math.ceil(boat.statusUntil - now)),
          killerTeam: killer ? killer.team : null,
        }
      : null,
    out: boat.status === 'out',
  };
}

export interface SharedHud {
  clock: string;
  clockRed: boolean;
  phaseLabel: string;
  scoreboard: { team: number; name: string; colour: string; kills: number; deaths: number }[];
  killFeed: string[];
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export function sharedHud(state: GameState, cfg: GameConfig = CONFIG): SharedHud {
  const left = state.phase === 'lobby' ? 0 : Math.max(0, state.phaseEndsAt - state.simTime);
  const labels: Record<GameState['phase'], string> = {
    lobby: 'LOBBY',
    countdown: 'GET READY',
    battle: '',
    overtime: 'SUDDEN DEATH',
    results: 'RESULTS',
  };
  return {
    clock: formatClock(left),
    clockRed: state.phase === 'overtime' || (state.phase === 'battle' && (state.frenzy || left <= cfg.match.clockRedLastSeconds)),
    phaseLabel: state.paused ? 'PAUSED' : labels[state.phase],
    scoreboard: rankTeams(state.teams).map((i) => {
      const t = state.teams[i];
      return { team: i, name: t?.name ?? '', colour: t?.colour ?? '#fff', kills: t?.kills ?? 0, deaths: t?.deaths ?? 0 };
    }),
    killFeed: state.killFeed.map((e) => e.text),
  };
}
```


### `src/scene/layout.ts`

```ts
/**
 * Split-screen rectangles for 2..6 teams (SPEC section 2), fixed for the round.
 * Rects are normalised (0..1) with the origin at the TOP-LEFT (CSS/HUD
 * convention). Three.js setViewport/setScissor want pixels from the
 * BOTTOM-LEFT: use toGlPixels().
 */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type SpareUse = 'overview' | 'none';

export interface Layout {
  teams: number;
  cols: number;
  rows: number;
  /** One rect per team, team index order: left to right, then top to bottom. */
  cells: Rect[];
  /** Spare grid cell (3 and 5 teams): live overview map. */
  spare: Rect | null;
  /** Where the minimap goes: the spare cell, or a square where the cells meet. */
  minimap: Rect;
  /** Translucent bar over the top centre: round timer + live scoreboard, kill feed under it. */
  topBar: Rect;
  /** Border thickness as a fraction of screen height (team colour). */
  borderFrac: number;
}

const SCREEN_ASPECT = 16 / 9;

function grid(cols: number, rows: number): Rect[] {
  const out: Rect[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) out.push({ x: c / cols, y: r / rows, w: 1 / cols, h: 1 / rows });
  }
  return out;
}

/** A square of `heightFrac` of the screen height, centred at (cx, cy), in normalised units. */
export function centredSquare(cx: number, cy: number, heightFrac: number, aspect: number = SCREEN_ASPECT): Rect {
  const h = heightFrac;
  const w = heightFrac / aspect;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

export function layoutFor(teams: number, aspect: number = SCREEN_ASPECT): Layout {
  const n = Math.max(1, Math.min(6, Math.floor(teams)));
  const topBar: Rect = { x: 0.28, y: 0, w: 0.44, h: 0.075 };
  const borderFrac = 0.006;
  switch (n) {
    case 1: {
      const cell: Rect = { x: 0, y: 0, w: 1, h: 1 };
      return { teams: 1, cols: 1, rows: 1, cells: [cell], spare: null, minimap: { x: 0.8, y: 0.72, w: 0.18, h: 0.26 }, topBar, borderFrac };
    }
    case 2: {
      const cells = grid(2, 1);
      // no spare cell: a small minimap bottom-centre, straddling the seam
      return { teams: 2, cols: 2, rows: 1, cells, spare: null, minimap: centredSquare(0.5, 0.84, 0.26, aspect), topBar, borderFrac };
    }
    case 3: {
      const g = grid(2, 2);
      const spare = g[3] ?? { x: 0.5, y: 0.5, w: 0.5, h: 0.5 };
      return { teams: 3, cols: 2, rows: 2, cells: g.slice(0, 3), spare, minimap: inset(spare, 0.04), topBar, borderFrac };
    }
    case 4: {
      return { teams: 4, cols: 2, rows: 2, cells: grid(2, 2), spare: null, minimap: centredSquare(0.5, 0.5, 0.24, aspect), topBar, borderFrac };
    }
    case 5: {
      const g = grid(3, 2);
      const spare = g[5] ?? { x: 2 / 3, y: 0.5, w: 1 / 3, h: 0.5 };
      return { teams: 5, cols: 3, rows: 2, cells: g.slice(0, 5), spare, minimap: inset(spare, 0.04), topBar, borderFrac };
    }
    default: {
      return { teams: 6, cols: 3, rows: 2, cells: grid(3, 2), spare: null, minimap: centredSquare(0.5, 0.5, 0.22, aspect), topBar, borderFrac };
    }
  }
}

export function inset(r: Rect, pad: number): Rect {
  return { x: r.x + pad, y: r.y + pad, w: r.w - 2 * pad, h: r.h - 2 * pad };
}

/** Pixels with the origin at the TOP-LEFT (CSS overlays, 2D canvas HUD). */
export function toCssPixels(r: Rect, width: number, height: number): PixelRect {
  return { x: Math.round(r.x * width), y: Math.round(r.y * height), w: Math.round(r.w * width), h: Math.round(r.h * height) };
}

/** Pixels with the origin at the BOTTOM-LEFT, for WebGLRenderer.setViewport / setScissor. */
export function toGlPixels(r: Rect, width: number, height: number): PixelRect {
  const x = Math.round(r.x * width);
  const w = Math.round(r.w * width);
  const h = Math.round(r.h * height);
  const yTop = Math.round(r.y * height);
  return { x, y: height - yTop - h, w, h };
}

export function rectAspect(r: Rect, width: number, height: number): number {
  return (r.w * width) / (r.h * height);
}

/** Does any pair of cells overlap (should never happen)? */
export function cellsOverlap(cells: readonly Rect[]): boolean {
  for (let i = 0; i < cells.length; i++) {
    for (let j = i + 1; j < cells.length; j++) {
      const a = cells[i];
      const b = cells[j];
      if (!a || !b) continue;
      const eps = 1e-9;
      if (a.x + a.w > b.x + eps && b.x + b.w > a.x + eps && a.y + a.h > b.y + eps && b.y + b.h > a.y + eps) return true;
    }
  }
  return false;
}
```


### `src/scene/keyboard.ts`

```ts
/**
 * Keyboard harness: one keyboard plays every role of up to 6 teams.
 * Pure part: harnessInputs() turns the set of pressed KeyboardEvent.code
 * values into the same PilotIn / GunnerIn / EngIn packets a phone sends.
 * DOM part: KeyboardHarness listens on window and calls back for globals.
 *
 * Keys use KeyboardEvent.code (physical position: 'KeyA' is the same key on
 * AZERTY). F1..F6 are intercepted by Chrome outside fullscreen on some
 * platforms, so every F-key has a plain alternative (7 8 9 0 - =) and
 * startFullscreenCapture() asks for fullscreen + navigator.keyboard.lock().
 */
import { CONFIG } from '@shared/config.ts';
import type { GameConfig } from '@shared/config.ts';
import type { EngIn, GunnerIn, PilotIn } from '@shared/protocol.ts';
import { keyboardDYaw } from '../sim/aim.ts';

export type GlobalAction =
  | 'start'
  | 'pause'
  | 'debugOverlay'
  | 'colliders'
  | 'freeCamera'
  | 'addFakeTeam'
  | 'giveRandomWeapon'
  | 'sinkFocused'
  | 'toggleBots';

export const KEYS = {
  focusTeam: ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6'] as const,
  pilot: { left: 'KeyA', right: 'KeyD', gas: 'KeyW', brake: 'KeyS', calibrate: 'KeyC' },
  gunner: { left: 'ArrowLeft', right: 'ArrowRight', fire: 'Space', recenter: 'KeyR' },
  engineer: { power0: 'KeyQ', power1: 'KeyE', bail: 'KeyB' },
  globals: {
    start: ['Enter'],
    pause: ['KeyP'],
    debugOverlay: ['F1', 'Digit7'],
    colliders: ['F2', 'Digit8'],
    freeCamera: ['F3', 'Digit9'],
    addFakeTeam: ['F4', 'Digit0'],
    giveRandomWeapon: ['F5', 'Minus'],
    sinkFocused: ['F6', 'Equal'],
    toggleBots: ['KeyT'],
  } satisfies Record<GlobalAction, readonly string[]>,
} as const;

export interface HarnessFrame {
  pilot: PilotIn;
  gunner: GunnerIn;
  engineer: EngIn;
  calibrate: boolean;
}

/** Pure: pressed codes -> one frame of inputs for the focused team. `edge` = codes that went down this frame (taps). */
export function harnessInputs(
  pressed: ReadonlySet<string>,
  edge: ReadonlySet<string>,
  dt: number,
  cfg: GameConfig = CONFIG,
): HarnessFrame {
  const k = KEYS;
  const steer = (pressed.has(k.pilot.right) ? 1 : 0) - (pressed.has(k.pilot.left) ? 1 : 0);
  const use: 0 | 1 | null = edge.has(k.engineer.power0) ? 0 : edge.has(k.engineer.power1) ? 1 : null;
  return {
    pilot: { t: 'in', role: 'pilot', steer: steer * cfg.steer.sign, gas: pressed.has(k.pilot.gas), brake: pressed.has(k.pilot.brake) },
    gunner: {
      t: 'in',
      role: 'gunner',
      dYaw: keyboardDYaw(pressed.has(k.gunner.left), pressed.has(k.gunner.right), dt, cfg),
      fire: pressed.has(k.gunner.fire),
      recenter: edge.has(k.gunner.recenter),
    },
    engineer: { t: 'in', role: 'engineer', use, shake: pressed.has(k.engineer.bail) ? 1 : 0 },
    calibrate: edge.has(k.pilot.calibrate),
  };
}

export function globalActionFor(code: string): GlobalAction | null {
  for (const [action, codes] of Object.entries(KEYS.globals) as [GlobalAction, readonly string[]][]) {
    if (codes.includes(code)) return action;
  }
  return null;
}

export function focusTeamFor(code: string): number | null {
  const i = (KEYS.focusTeam as readonly string[]).indexOf(code);
  return i >= 0 ? i : null;
}

const HANDLED: ReadonlySet<string> = new Set<string>([
  ...KEYS.focusTeam,
  ...Object.values(KEYS.pilot),
  ...Object.values(KEYS.gunner),
  ...Object.values(KEYS.engineer),
  ...Object.values(KEYS.globals).flat(),
]);

export interface HarnessCallbacks {
  onGlobal: (action: GlobalAction) => void;
  onFocusTeam: (team: number) => void;
}

/** DOM side. Call sample(dt) once per render frame and feed the result to the sim for the focused team's slots. */
export class KeyboardHarness {
  readonly pressed = new Set<string>();
  private edge = new Set<string>();
  focusedTeam = 0;

  constructor(
    private readonly target: Window,
    private readonly callbacks: HarnessCallbacks,
    private readonly cfg: GameConfig = CONFIG,
  ) {}

  attach(): void {
    this.target.addEventListener('keydown', this.onKeyDown);
    this.target.addEventListener('keyup', this.onKeyUp);
    this.target.addEventListener('blur', this.onBlur);
  }

  detach(): void {
    this.target.removeEventListener('keydown', this.onKeyDown);
    this.target.removeEventListener('keyup', this.onKeyUp);
    this.target.removeEventListener('blur', this.onBlur);
  }

  sample(dt: number): HarnessFrame {
    const frame = harnessInputs(this.pressed, this.edge, dt, this.cfg);
    this.edge = new Set();
    return frame;
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (!HANDLED.has(e.code)) return;
    e.preventDefault();
    if (e.repeat) return; // auto-repeat: the key is still in `pressed`
    this.pressed.add(e.code);
    this.edge.add(e.code);
    const team = focusTeamFor(e.code);
    if (team !== null) {
      this.focusedTeam = team;
      this.callbacks.onFocusTeam(team);
      return;
    }
    const action = globalActionFor(e.code);
    if (action) this.callbacks.onGlobal(action);
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    if (!HANDLED.has(e.code)) return;
    e.preventDefault();
    this.pressed.delete(e.code);
  };

  private readonly onBlur = (): void => {
    this.pressed.clear(); // never leave GAS stuck when the window loses focus
  };
}

/**
 * Call from the Start button click (user activation): fullscreen makes Chrome
 * deliver F1..F6 to the page, and the Keyboard Lock API (Chrome, secure
 * context) captures them even where the OS would take them.
 */
export async function startFullscreenCapture(root: HTMLElement): Promise<void> {
  if (!document.fullscreenElement) await root.requestFullscreen();
  const kb = (navigator as Navigator & { keyboard?: { lock?: (codes?: string[]) => Promise<void> } }).keyboard;
  if (kb?.lock) await kb.lock(['F1', 'F2', 'F3', 'F4', 'F5', 'F6']);
}
```


### `src/scene/bot.ts`

```ts
/**
 * Trivial bot: drives toward crates or enemies, fires when lined up, uses
 * powers now and then, bails. It only reads GameState and emits the same
 * packets a phone would, so it tests the whole input path.
 */
import { CONFIG } from '@shared/config.ts';
import type { GameConfig } from '@shared/config.ts';
import { angleDiff, clamp, DEG } from '@shared/math.ts';
import type { EngIn, GunnerIn, PilotIn } from '@shared/protocol.ts';
import type { BoatState, GameState } from '@shared/state.ts';

export interface BotMemory {
  waypoint: { x: number; y: number } | null;
  stuckSince: number;
  reverseUntil: number;
  nextPowerAt: number;
}

export interface BotFrame {
  pilot: PilotIn;
  gunner: GunnerIn;
  engineer: EngIn;
  mem: BotMemory;
}

export function createBot(): BotMemory {
  return { waypoint: null, stuckSince: -1, reverseUntil: 0, nextPowerAt: 0 };
}

function idleFrame(mem: BotMemory): BotFrame {
  return {
    pilot: { t: 'in', role: 'pilot', steer: 0, gas: false, brake: false },
    gunner: { t: 'in', role: 'gunner', dYaw: 0, fire: false, recenter: false },
    engineer: { t: 'in', role: 'engineer', use: null, shake: 0 },
    mem,
  };
}

function nearestEnemy(state: GameState, me: BoatState): BoatState | null {
  let best: BoatState | null = null;
  let bestD = Infinity;
  for (const b of state.boats) {
    if (b.team === me.team || b.status !== 'alive') continue;
    const d = Math.hypot(b.pose.x - me.pose.x, b.pose.y - me.pose.y);
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best;
}

function nearestCrate(state: GameState, me: BoatState, category: 'weapon' | 'power' | null): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestD = Infinity;
  for (const c of state.crates) {
    if (c.contents === null || (category && c.category !== category)) continue;
    const d = Math.hypot(c.x - me.pose.x, c.y - me.pose.y);
    if (d < bestD) {
      bestD = d;
      best = { x: c.x, y: c.y };
    }
  }
  return best;
}

export function botThink(
  state: GameState,
  team: number,
  memIn: BotMemory,
  dt: number,
  rng: () => number,
  cfg: GameConfig = CONFIG,
): BotFrame {
  const me = state.boats[team];
  const mem: BotMemory = { ...memIn };
  if (!me || me.status !== 'alive' || (state.phase !== 'battle' && state.phase !== 'overtime')) {
    return idleFrame({ ...mem, waypoint: null, stuckSince: -1 });
  }
  const now = state.simTime;
  const b = cfg.bots;
  const enemy = nearestEnemy(state, me);
  const enemyDist = enemy ? Math.hypot(enemy.pose.x - me.pose.x, enemy.pose.y - me.pose.y) : Infinity;

  // --- waypoint: a weapon crate when unarmed, otherwise the enemy, otherwise any crate
  const reached = mem.waypoint && Math.hypot(mem.waypoint.x - me.pose.x, mem.waypoint.y - me.pose.y) < b.waypointReached;
  if (!mem.waypoint || reached || rng() < dt * 0.1) {
    mem.waypoint = (me.weapon ? null : nearestCrate(state, me, 'weapon')) ?? (enemy ? { x: enemy.pose.x, y: enemy.pose.y } : null) ?? nearestCrate(state, me, null);
  }

  // --- stuck detection: slow for stuckSeconds -> reverse for reverseSeconds with the wheel flipped
  if (me.speed < b.stuckSpeed) {
    if (mem.stuckSince < 0) mem.stuckSince = now;
    else if (now - mem.stuckSince > b.stuckSeconds && now >= mem.reverseUntil) {
      mem.reverseUntil = now + b.reverseSeconds;
      mem.stuckSince = -1;
      mem.waypoint = null;
    }
  } else {
    mem.stuckSince = -1;
  }

  // --- pilot
  let steer = 0;
  let gas = false;
  let brake = false;
  if (mem.waypoint) {
    const want = Math.atan2(mem.waypoint.y - me.pose.y, mem.waypoint.x - me.pose.x);
    const diff = angleDiff(me.pose.angle, want);
    steer = clamp(diff / (30 * DEG), -1, 1);
    gas = Math.abs(diff) < 110 * DEG;
    brake = !gas;
  }
  if (now < mem.reverseUntil) {
    steer = -steer;
    gas = false;
    brake = true;
  }

  // --- gunner: turn the aim toward the enemy, fire when lined up and in range
  let dYaw = 0;
  let fire = false;
  if (enemy) {
    const want = Math.atan2(enemy.pose.y - me.pose.y, enemy.pose.x - me.pose.x);
    const diff = angleDiff(me.aimYaw, want);
    const step = b.turnRateDegPerSec * DEG * dt;
    dYaw = clamp(diff, -step, step) * cfg.aim.gyroSign; // undo the sim's sign so the bot turns the right way
    const range = me.weapon ? b.fireRange : cfg.weapons.waterCannon.range;
    fire = enemyDist <= range && Math.abs(diff) <= b.fireHalfAngleDeg * DEG && now >= me.fireReadyAt;
  }

  // --- engineer: a power every few seconds when it makes sense, shake whenever there is water
  let use: 0 | 1 | null = null;
  if (now >= mem.nextPowerAt) {
    const slot = me.powers[0] ? 0 : me.powers[1] ? 1 : null;
    if (slot !== null) {
      const power = me.powers[slot];
      const wantIt =
        (power === 'shield' && enemyDist < 30) ||
        (power === 'boost' && enemyDist < 45) ||
        (power === 'mine' && enemyDist < 25) ||
        power === 'smoke' ||
        power === 'wave';
      if (wantIt) {
        use = slot;
        mem.nextPowerAt = now + b.powerUseInterval;
      }
    }
  }

  return {
    pilot: { t: 'in', role: 'pilot', steer: steer * cfg.steer.sign, gas, brake },
    gunner: { t: 'in', role: 'gunner', dYaw, fire, recenter: false },
    engineer: { t: 'in', role: 'engineer', use, shake: me.water > 0 ? 1 : 0 },
    mem,
  };
}
```


### `tests/teams.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import {
  balanceTable,
  canStart,
  controlsFor,
  createLobby,
  joinPlayer,
  leavePlayer,
  moveToTeam,
  rebalance,
  resetLobby,
  setTeamSize,
  slotOf,
  swapRoles,
  targetSizes,
  teamCount,
} from '../src/sim/teams.ts';
import type { Lobby, LobbyPlayer } from '../src/sim/teams.ts';

function player(i: number, kind: LobbyPlayer['kind'] = 'phone'): LobbyPlayer {
  return { id: `p${i}`, name: `P${i}`, joinOrder: i, pinned: false, connected: true, enabled: true, ready: false, calibrated: false, kind };
}

function fill(n: number, size: 2 | 3): Lobby {
  let lobby = createLobby(size);
  for (let i = 1; i <= n; i++) lobby = joinPlayer(lobby, player(i)).lobby;
  return lobby;
}

const sizes = (lobby: Lobby): number[] => lobby.teams.map((m) => m.length);

describe('balance table', () => {
  it('teams of 3: min(6, ceil(n/3)) teams, remainder spread, never 3+3+1', () => {
    const expected: Record<number, number[]> = {
      1: [1], 2: [2], 3: [3], 4: [2, 2], 5: [3, 2], 6: [3, 3], 7: [3, 2, 2], 8: [3, 3, 2], 9: [3, 3, 3],
      10: [3, 3, 2, 2], 11: [3, 3, 3, 2], 12: [3, 3, 3, 3], 13: [3, 3, 3, 2, 2], 14: [3, 3, 3, 3, 2],
      15: [3, 3, 3, 3, 3], 16: [3, 3, 3, 3, 2, 2], 17: [3, 3, 3, 3, 3, 2], 18: [3, 3, 3, 3, 3, 3],
    };
    for (const row of balanceTable(3)) {
      expect(row.sizes, `n=${row.n}`).toEqual(expected[row.n]);
      expect(row.spectators).toBe(0);
    }
  });
  it('teams of 2: capacity 12, the rest are spectators', () => {
    const expected: Record<number, number[]> = {
      1: [1], 2: [2], 3: [2, 1], 4: [2, 2], 5: [2, 2, 1], 6: [2, 2, 2], 7: [2, 2, 2, 1], 8: [2, 2, 2, 2],
      9: [2, 2, 2, 2, 1], 10: [2, 2, 2, 2, 2], 11: [2, 2, 2, 2, 2, 1], 12: [2, 2, 2, 2, 2, 2],
    };
    for (const row of balanceTable(2)) {
      expect(row.sizes, `n=${row.n}`).toEqual(expected[Math.min(row.n, 12)]);
      expect(row.spectators).toBe(Math.max(0, row.n - 12));
    }
    expect(teamCount(13, 2)).toBe(6);
    expect(targetSizes(100, 3)).toEqual([3, 3, 3, 3, 3, 3]);
  });
});

describe('join order and rebalance', () => {
  it('fills by join order and roles by index; seats already taken are kept when a team forms', () => {
    const three = fill(3, 3);
    expect(three.teams).toEqual([['p1', 'p2', 'p3']]);
    expect(slotOf(three, 'p1')).toEqual({ team: 0, role: 'pilot', index: 0 });
    expect(slotOf(three, 'p2')).toEqual({ team: 0, role: 'gunner', index: 1 });
    expect(slotOf(three, 'p3')?.role).toBe('engineer');
    const four = fill(4, 3); // 2+2: the most recent joiner (p3) opens team 1 with p4
    expect(four.teams).toEqual([['p1', 'p2'], ['p3', 'p4']]);
    const five = fill(5, 3); // 3+2: p5 fills the deficit, nobody else moves
    expect(five.teams).toEqual([['p1', 'p2', 'p5'], ['p3', 'p4']]);
    expect(slotOf(five, 'p3')).toEqual({ team: 1, role: 'pilot', index: 0 });
  });
  it('every join moves at most one existing player (the most recent joiner)', () => {
    let lobby = createLobby(3);
    for (let i = 1; i <= 18; i++) {
      const r = joinPlayer(lobby, player(i));
      const others = r.moves.filter((m) => m.id !== `p${i}`);
      expect(others.length, `join ${i}`).toBeLessThanOrEqual(1);
      if (others[0]) expect(others[0].id).toBe(`p${i - 1}`);
      lobby = r.lobby;
      expect(sizes(lobby)).toEqual(targetSizes(i, 3));
    }
  });
  it('7 in threes is 3+2+2; the 7th join moves exactly one person', () => {
    const six = fill(6, 3);
    expect(sizes(six)).toEqual([3, 3]);
    const r = joinPlayer(six, player(7));
    expect(sizes(r.lobby)).toEqual([3, 2, 2]);
    expect(r.moves.map((m) => m.id).sort()).toEqual(['p6', 'p7']);
    expect(slotOf(r.lobby, 'p6')).toEqual({ team: 2, role: 'pilot', index: 0 });
  });
  it('a leave closes up with the fewest moves and keeps the invariant', () => {
    const seven = fill(7, 3); // [1,2,3] [4,5] [6,7]
    const r = leavePlayer(seven, 'p4');
    expect(sizes(r.lobby)).toEqual([3, 3]);
    expect(r.moves.length).toBe(1);
    expect(r.lobby.players['p4']).toBeUndefined();
    const r2 = leavePlayer(seven, 'p1'); // [2,3] [4,5] [6,7] -> 6 players -> [3,3]
    expect(sizes(r2.lobby)).toEqual([3, 3]);
    expect(r2.moves.length).toBe(2);
  });
  it('beyond capacity joiners queue as spectators and are promoted on a leave', () => {
    let lobby = fill(19, 3);
    expect(lobby.spectators).toEqual(['p19']);
    lobby = leavePlayer(lobby, 'p3').lobby;
    expect(lobby.spectators).toEqual([]);
    expect(slotOf(lobby, 'p19')).not.toBeNull();
  });
  it('switching team size re-seats: 18 in threes -> 12 in twos + 6 spectators, and back', () => {
    const l18 = fill(18, 3);
    const twos = setTeamSize(l18, 2).lobby;
    expect(sizes(twos)).toEqual([2, 2, 2, 2, 2, 2]);
    expect(twos.spectators.length).toBe(6);
    const back = setTeamSize(twos, 3).lobby;
    expect(sizes(back)).toEqual([3, 3, 3, 3, 3, 3]);
    expect(back.spectators).toEqual([]);
  });
  it('rebalance is idempotent on a balanced lobby', () => {
    const lobby = fill(11, 3);
    const r = rebalance(lobby);
    expect(r.moves).toEqual([]);
    expect(r.renumbered).toBe(false);
    expect(r.lobby.teams).toEqual(lobby.teams);
  });
});

describe('explicit moves', () => {
  it('swap role with a teammate pins both', () => {
    const lobby = fill(3, 3);
    const r = swapRoles(lobby, 'p1', 'p3');
    expect(r.lobby.teams[0]).toEqual(['p3', 'p2', 'p1']);
    expect(r.lobby.players['p1']?.pinned).toBe(true);
    expect(r.lobby.players['p3']?.pinned).toBe(true);
    expect(swapRoles(lobby, 'p1', 'p1').lobby.teams).toEqual(lobby.teams);
  });
  it('move to a team with a free slot; the balancer bumps someone else, never the pinned mover', () => {
    const seven = fill(7, 3);
    expect(seven.teams).toEqual([['p1', 'p2', 'p5'], ['p3', 'p4'], ['p6', 'p7']]);
    expect(moveToTeam(seven, 'p3', 0).lobby.teams).toEqual(seven.teams); // team 0 is full: refused
    const r = moveToTeam(seven, 'p7', 1); // team 1 had a free slot -> 3+3+1, the balancer restores {3,2,2}
    expect([...sizes(r.lobby)].sort()).toEqual([2, 2, 3]);
    expect(slotOf(r.lobby, 'p7')?.team).toBe(1);
    expect(r.lobby.players['p7']?.pinned).toBe(true);
    expect(r.lobby.teams[1]?.length).toBe(3); // the team holding the pinned mover keeps its 3
    expect(r.moves.filter((m) => m.id !== 'p7').length).toBe(1); // exactly one other person moved
  });
});

describe('roles, start check, reset', () => {
  it('merges roles for short-handed teams', () => {
    const three = fill(3, 3);
    expect(controlsFor(three, 'p2')?.powers).toBe(false);
    const two = fill(2, 2);
    expect(controlsFor(two, 'p2')).toMatchObject({ aim: true, fire: true, powers: true, bail: false });
    const one = fill(1, 3);
    expect(controlsFor(one, 'p1')?.solo).toBe(true);
  });
  it('start needs 2 teams with a connected Pilot; missing Enable controls is only a warning', () => {
    expect(canStart(fill(3, 3)).ok).toBe(false);
    const four = fill(4, 3);
    expect(canStart(four)).toMatchObject({ ok: true, problems: [], warnings: [] });
    const notEnabled: Lobby = { ...four, players: { ...four.players, p2: { ...player(2), enabled: false } } };
    expect(canStart(notEnabled).ok).toBe(true);
    expect(canStart(notEnabled).warnings.length).toBe(1);
    const pilotGone: Lobby = { ...four, players: { ...four.players, p1: { ...player(1), connected: false } } };
    expect(canStart(pilotGone).ok).toBe(false);
  });
  it('new lobby drops pins and disconnected players, keeps join order', () => {
    const seven = fill(7, 3);
    const pinned = moveToTeam(seven, 'p7', 1).lobby;
    const gone: Lobby = { ...pinned, players: { ...pinned.players, p2: { ...player(2), connected: false } } };
    const fresh = resetLobby(gone).lobby;
    expect(fresh.players['p2']).toBeUndefined();
    expect(fresh.teams).toEqual([['p1', 'p3', 'p4'], ['p5', 'p6', 'p7']]);
    expect(Object.values(fresh.players).every((p) => !p.pinned)).toBe(true);
  });
});
```


### `tests/rules.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { CONFIG } from '../shared/config.ts';
import { makeRng } from '../shared/math.ts';
import type { PlayerState, Pose, TeamState } from '../shared/state.ts';
import {
  bailRate,
  compareTeams,
  countdownBeeps,
  creditKill,
  decideAfterOvertime,
  firingEndsProtection,
  isRevealed,
  killFeedText,
  overtimeBoatPlan,
  overtimeKill,
  pickRespawnDock,
  pushKillFeed,
  rankTeams,
  resolveHit,
  revealAfterFire,
  sinkTimeline,
  speedMultiplier,
  startCountdown,
  statusAt,
  stepWater,
  tickMatch,
  tiedForFirst,
} from '../src/sim/rules.ts';
import type { HitSource, HitTarget } from '../src/sim/rules.ts';
import { applyPickup, consumeShot, crateCategoryForIndex, crateRespawnDelay, emptyInventory, rollCrateContents, usePower } from '../src/sim/items.ts';

const pose: Pose = { x: 0, y: 0, angle: 0 };
const alive = (over: Partial<HitTarget> = {}): HitTarget => ({ team: 1, status: 'alive', shieldUntil: 0, protectedUntil: 0, boostUntil: 0, ...over });
const cannon = (team = 0): HitSource => ({ kind: 'cannon', team, playerId: 'g', pose });

describe('resolveHit matrix', () => {
  const now = 100;
  it('sinking or respawning boats cannot be hit again', () => {
    expect(resolveHit(alive({ status: 'sinking' }), cannon(), now)).toEqual({ result: 'ignored', reason: 'notAlive' });
    expect(resolveHit(alive({ status: 'respawning' }), cannon(), now).result).toBe('ignored');
  });
  it('own team never hurts you: shots, mines, rams', () => {
    expect(resolveHit(alive({ team: 0 }), cannon(0), now)).toEqual({ result: 'ignored', reason: 'ownTeam' });
    expect(resolveHit(alive({ team: 0 }), { kind: 'mine', team: 0, playerId: null, pose }, now).result).toBe('ignored');
  });
  it('the Water Cannon never kills, even without shield or protection', () => {
    expect(resolveHit(alive(), { kind: 'waterCannon', team: 0, playerId: 'g', pose }, now)).toEqual({ result: 'ignored', reason: 'notLethal' });
  });
  it('spawn protection ignores the hit and keeps the Shield', () => {
    const t = alive({ protectedUntil: now + 1, shieldUntil: now + 5 });
    expect(resolveHit(t, cannon(), now)).toEqual({ result: 'ignored', reason: 'protected' });
    expect(resolveHit(t, cannon(), now + 1)).toEqual({ result: 'shielded', byTeam: 0 });
  });
  it('a Shield absorbs exactly one lethal hit; expired shields do not', () => {
    expect(resolveHit(alive({ shieldUntil: now + 0.1 }), cannon(), now).result).toBe('shielded');
    expect(resolveHit(alive({ shieldUntil: now }), cannon(), now).result).toBe('sunk');
  });
  it('lethal hit credits the team and the player, remembers the weapon and the killer pose', () => {
    const r = resolveHit(alive(), { kind: 'torpedo', team: 3, playerId: 'gun3', pose: { x: 5, y: 6, angle: 1 } }, now);
    expect(r).toEqual({ result: 'sunk', killer: { team: 3, playerId: 'gun3', weapon: 'torpedo', pose: { x: 5, y: 6, angle: 1 } } });
  });
  it('a Mine credits the team that dropped it even if that team has died since (team index is stable)', () => {
    const r = resolveHit(alive(), { kind: 'mine', team: 2, playerId: 'eng2', pose }, now);
    expect(r.result === 'sunk' && r.killer.team === 2 && r.killer.weapon === 'mine').toBe(true);
  });
  it('rams: only boosted, only fast enough, never when both are boosted', () => {
    const ram = (over: Partial<Extract<HitSource, { kind: 'ram' }>> = {}): HitSource => ({ kind: 'ram', team: 0, playerId: 'pilot0', pose, attackerBoostUntil: now + 1, impactSpeed: 9, ...over });
    expect(resolveHit(alive(), ram(), now).result).toBe('sunk');
    expect(resolveHit(alive(), ram({ attackerBoostUntil: now }), now)).toEqual({ result: 'ignored', reason: 'attackerNotBoosted' });
    expect(resolveHit(alive({ boostUntil: now + 1 }), ram(), now)).toEqual({ result: 'ignored', reason: 'bothBoosted' });
    expect(resolveHit(alive(), ram({ impactSpeed: CONFIG.boat.ramMinImpactSpeed - 0.01 }), now)).toEqual({ result: 'ignored', reason: 'ramTooSlow' });
    expect(resolveHit(alive({ shieldUntil: now + 1 }), ram(), now).result).toBe('shielded');
  });
});

describe('death timeline', () => {
  it('hit -> 2 s sinking -> respawn at 5 s -> 3 s protection; kill-cam 5 s', () => {
    const t = sinkTimeline(10);
    expect(t).toEqual({ hitAt: 10, sinkingUntil: 12, respawnAt: 15, killCamUntil: 15, protectedUntil: 18 });
    expect(statusAt(t, 10)).toBe('sinking');
    expect(statusAt(t, 11.99)).toBe('sinking');
    expect(statusAt(t, 12)).toBe('respawning');
    expect(statusAt(t, 14.99)).toBe('respawning');
    expect(statusAt(t, 15)).toBe('alive');
  });
  it('any firing ends protection, the Water Cannon per config', () => {
    expect(firingEndsProtection('cannon')).toBe(true);
    expect(firingEndsProtection('waterCannon')).toBe(CONFIG.weapons.waterCannon.endsSpawnProtection);
  });
});

describe('respawn dock', () => {
  const docks = Array.from({ length: 8 }, (_, i) => ({ id: i, x: i * 50, y: 0 })); // 0..350 m along x
  it('picks only docks at least 80 m from every enemy', () => {
    const rng = makeRng(1);
    for (let i = 0; i < 50; i++) {
      const d = pickRespawnDock(docks, [{ x: 100, y: 0 }], [], rng);
      expect(d).not.toBeNull();
      expect(Math.abs(d!.x - 100)).toBeGreaterThanOrEqual(80);
    }
  });
  it('falls back to the farthest dock when none is safe, skipping occupied docks', () => {
    const enemies = docks.map((d) => ({ x: d.x + 10, y: 0 })); // an enemy near every dock
    const d = pickRespawnDock(docks, enemies, [{ x: 350, y: 0 }], () => 0.5);
    expect(d).not.toBeNull();
    expect(d!.x).not.toBe(350);
    expect(pickRespawnDock([], [], [], () => 0)).toBeNull();
  });
  it('two boats respawning in the same step never share a dock', () => {
    const first = pickRespawnDock(docks, [], [], () => 0)!;
    const second = pickRespawnDock(docks, [], [first], () => 0)!;
    expect(second.id).not.toBe(first.id);
  });
});

describe('hull water', () => {
  it('full hull halves the speed', () => {
    expect(speedMultiplier(0)).toBe(1);
    expect(speedMultiplier(50)).toBeCloseTo(0.75);
    expect(speedMultiplier(100)).toBeCloseTo(0.5);
  });
  it('fills under the stream, bails with shake, auto-drains at half rate for 2-person teams, clamps 0..100', () => {
    expect(stepWater(0, 1, 0, 3, 1)).toBe(CONFIG.water.fillPerSecond);
    expect(stepWater(100, 1, 0, 3, 1)).toBe(100);
    expect(stepWater(50, 0, 1, 3, 1)).toBe(50 - CONFIG.water.bailPerSecondAtFullShake);
    expect(stepWater(50, 0, 0, 3, 1)).toBe(50 - CONFIG.water.naturalDrainPerSecond);
    expect(stepWater(50, 0, 0, 2, 1)).toBe(50 - CONFIG.water.autoDrainPerSecond);
    expect(bailRate(1, 2)).toBe(CONFIG.water.bailPerSecondAtFullShake / 2);
    expect(stepWater(1, 0, 1, 3, 1)).toBe(0);
  });
});

function team(index: number, kills: number, deaths: number, lastKillAt = 0): TeamState {
  return { index, name: `T${index}`, colour: '#fff', textColour: '#000', members: [`p${index}`], kills, deaths, lastKillAt };
}
function playerRec(id: string, kills: number, bestRamSpeed = 0, joinOrder = 0): PlayerState {
  return { id, name: id, joinOrder, pinned: false, connected: true, enabled: true, ready: true, calibrated: true, kind: 'phone', kills, deaths: 0, bestRamSpeed };
}

describe('scoring and results', () => {
  it('ranks by kills, then fewer deaths, then earliest last kill, then index', () => {
    const teams = [team(0, 3, 5, 200), team(1, 3, 2, 250), team(2, 5, 9, 100), team(3, 3, 2, 240)];
    expect(rankTeams(teams)).toEqual([2, 3, 1, 0]);
    expect(compareTeams(team(0, 1, 0, 0), team(1, 1, 0, 50))).toBeGreaterThan(0); // never scored sorts after
  });
  it('detects a tie for first only when kills and deaths are both equal', () => {
    expect(tiedForFirst([team(0, 4, 1), team(1, 4, 1), team(2, 4, 2)])).toEqual([0, 1]);
    expect(tiedForFirst([team(0, 4, 1), team(1, 4, 2)])).toEqual([0]);
    expect(tiedForFirst([])).toEqual([]);
  });
  it('credits kills to team and player, deaths to the victim team and its crew, tracks the best ram', () => {
    const teams = [team(0, 0, 0), team(1, 0, 0)];
    const players = { p0: playerRec('p0', 0), p1: playerRec('p1', 0) };
    const r = creditKill(teams, players, { killerTeam: 0, killerPlayer: 'p0', victimTeam: 1, weapon: 'ram', at: 42, impactSpeed: 11 });
    expect(r.teams[0]).toMatchObject({ kills: 1, lastKillAt: 42 });
    expect(r.teams[1]).toMatchObject({ deaths: 1 });
    expect(r.players['p0']).toMatchObject({ kills: 1, bestRamSpeed: 11 });
    expect(r.players['p1']).toMatchObject({ deaths: 1 });
    expect(teams[0]?.kills).toBe(0); // inputs untouched
  });
  it('results extras: top Gunner is the player with most kills, best ram the fastest', () => {
    const players = { a: playerRec('a', 2, 0, 1), b: playerRec('b', 4, 9.5, 2), c: playerRec('c', 4, 12, 3) };
    const r = decideAfterOvertime([team(0, 4, 1, 100), team(1, 4, 1, 90)], players);
    expect(r.winner).toBe(1); // reached the score first
    expect(r.decidedBy).toBe('firstToScore');
    expect(r.topGunner).toEqual({ playerId: 'b', name: 'b', kills: 4 });
    expect(r.bestRam).toEqual({ playerId: 'c', name: 'c', speed: 12 });
    const draw = decideAfterOvertime([team(0, 0, 0), team(1, 0, 0)], players);
    expect(draw).toMatchObject({ draw: true, winner: null, decidedBy: 'draw' });
  });
  it('kill feed strings and the 5-entry cap', () => {
    expect(killFeedText('Azzurro', 'Verde', 'torpedo')).toBe('Azzurro sank Verde with a Torpedo');
    expect(killFeedText('Rosso', 'Oro', 'ram')).toBe('Rosso rammed Oro');
    expect(killFeedText('Oro', 'Viola', 'mine')).toBe('Oro sank Viola with a Mine');
    expect(killFeedText(null, 'Verde', 'none')).toBe('Verde sank');
    let feed = pushKillFeed([], { at: 0, killerTeam: 0, victimTeam: 1, weapon: 'cannon', text: 'a' });
    for (let i = 1; i < 7; i++) feed = pushKillFeed(feed, { at: i, killerTeam: 0, victimTeam: 1, weapon: 'cannon', text: `t${i}` });
    expect(feed.length).toBe(5);
    expect(feed[0]?.text).toBe('t2');
  });
  it('minimap: 2 s after firing, always in the lagoon, never while sunk', () => {
    expect(revealAfterFire(0, 10, 'cannon')).toBe(12);
    expect(revealAfterFire(0, 10, 'waterCannon')).toBe(0);
    expect(isRevealed({ status: 'alive', revealedUntil: 12 }, 11.9, false, false)).toBe(true);
    expect(isRevealed({ status: 'alive', revealedUntil: 12 }, 12, false, false)).toBe(false);
    expect(isRevealed({ status: 'alive', revealedUntil: 0 }, 12, true, false)).toBe(true);
    expect(isRevealed({ status: 'sinking', revealedUntil: 99 }, 12, true, false)).toBe(false);
  });
});

describe('match state machine (sim time)', () => {
  const noPlayers = {};
  it('lobby -> countdown(10) -> battle(300) with horn -> results(20) -> lobby', () => {
    let clock = startCountdown(5);
    expect(clock).toEqual({ phase: 'countdown', phaseEndsAt: 15 });
    expect(tickMatch(clock, 14.99, [], noPlayers).transition.kind).toBe('none');
    let r = tickMatch(clock, 15, [], noPlayers);
    expect(r.clock).toEqual({ phase: 'battle', phaseEndsAt: 315 });
    expect(r.events.some((e) => e.kind === 'horn')).toBe(true);
    clock = r.clock;
    r = tickMatch(clock, 315, [team(0, 2, 1), team(1, 1, 1)], noPlayers);
    expect(r.clock).toEqual({ phase: 'results', phaseEndsAt: 335 });
    expect(r.transition).toMatchObject({ kind: 'results', results: { winner: 0, decidedBy: 'kills' } });
    r = tickMatch(r.clock, 335, [], noPlayers);
    expect(r.clock.phase).toBe('lobby');
  });
  it('a tie on kills and deaths goes to a 30 s sudden death for the tied teams only; next kill wins', () => {
    const clock = { phase: 'battle' as const, phaseEndsAt: 300 };
    const teams = [team(0, 3, 1, 100), team(1, 3, 1, 120), team(2, 1, 4)];
    const r = tickMatch(clock, 300, teams, noPlayers);
    expect(r.clock).toEqual({ phase: 'overtime', phaseEndsAt: 330 });
    expect(r.transition).toEqual({ kind: 'overtime', teams: [0, 1] });
    expect(overtimeBoatPlan([{ team: 0, status: 'alive' }, { team: 1, status: 'respawning' }, { team: 2, status: 'alive' }], [0, 1])).toEqual({ out: [2], respawnNow: [1] });
    const k = overtimeKill(310, 1, teams, noPlayers);
    expect(k.clock).toEqual({ phase: 'results', phaseEndsAt: 330 });
    expect(k.results).toMatchObject({ winner: 1, decidedBy: 'overtime', ranking: [1, 0, 2] });
    const still = tickMatch(r.clock, 330, teams, noPlayers);
    expect(still.transition).toMatchObject({ kind: 'results', results: { winner: 0, decidedBy: 'firstToScore' } });
  });
  it('beeps at 3, 2, 1 exactly once each even with uneven steps', () => {
    const all: number[] = [];
    let prev = 10;
    for (let t = 9.98; t >= -0.01; t -= 0.017) {
      for (const e of countdownBeeps(prev, Math.max(0, t))) if (e.kind === 'beep') all.push(e.secondsLeft);
      prev = Math.max(0, t);
    }
    expect(all).toEqual([3, 2, 1]);
  });
});

describe('inventory and crates', () => {
  it('same weapon tops up, different replaces, last shot brings the Water Cannon back', () => {
    let inv = emptyInventory();
    let r = applyPickup(inv, 'cannon');
    expect(r).toMatchObject({ consumed: true, effect: 'newWeapon' });
    inv = r.inv;
    inv = { ...inv, weapon: { kind: 'cannon', ammo: 1 } };
    r = applyPickup(inv, 'cannon');
    expect(r.inv.weapon).toEqual({ kind: 'cannon', ammo: 5 });
    expect(r.effect).toBe('topUp');
    r = applyPickup(r.inv, 'torpedo');
    expect(r.inv.weapon).toEqual({ kind: 'torpedo', ammo: 2 });
    expect(r.effect).toBe('replace');
    let s = consumeShot(r.inv);
    expect(s).toMatchObject({ fired: 'torpedo', emptied: false });
    s = consumeShot(s.inv);
    expect(s).toMatchObject({ fired: 'torpedo', emptied: true });
    expect(s.inv.weapon).toBeNull();
    expect(consumeShot(s.inv).fired).toBe('waterCannon');
  });
  it('two power slots; a third blue crate stays in the water; disabled tiers are not picked up', () => {
    let r = applyPickup(emptyInventory(), 'shield');
    r = applyPickup(r.inv, 'mine');
    expect(r.inv.powers).toEqual(['shield', 'mine']);
    const full = applyPickup(r.inv, 'boost');
    expect(full).toMatchObject({ consumed: false, effect: 'powersFull' });
    expect(applyPickup(emptyInventory(), 'wave', CONFIG, { mvp: true, should: true, stretch: false })).toMatchObject({ consumed: false, effect: 'disabled' });
    const u = usePower(r.inv, 0);
    expect(u.power).toBe('shield');
    expect(u.inv.powers).toEqual([null, 'mine']);
  });
  it('crate rolls respect category, weights and tier flags', () => {
    const rng = makeRng(7);
    const counts: Record<string, number> = {};
    for (let i = 0; i < 2000; i++) {
      const k = rollCrateContents('weapon', rng, CONFIG, { mvp: true, should: false, stretch: false });
      counts[k] = (counts[k] ?? 0) + 1;
    }
    expect(counts['mortar']).toBeUndefined();
    expect(counts['cannon']! / 2000).toBeCloseTo(50 / 80, 1);
    expect(rollCrateContents('power', () => 0.999, CONFIG, { mvp: true, should: true, stretch: true })).toBe('wave');
    expect([0, 1, 2, 3, 4].map((i) => crateCategoryForIndex(i))).toEqual(['weapon', 'weapon', 'weapon', 'power', 'power']);
  });
  it('crates respawn in 8 s, 4 s in the final minute when the stretch tier is on', () => {
    expect(crateRespawnDelay(100, 'battle', 300)).toBe(8);
    expect(crateRespawnDelay(250, 'battle', 300, CONFIG, { mvp: true, should: true, stretch: true })).toBe(4);
    expect(crateRespawnDelay(250, 'battle', 300, CONFIG, { mvp: true, should: true, stretch: false })).toBe(8);
  });
});
```


### `tests/aim.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { CONFIG } from '../shared/config.ts';
import { DEG } from '../shared/math.ts';
import { aimAssist, crosshairFor, enemyUnderCrosshair, integrateAim, keyboardDYaw, mortarTarget, rayCircleDistance, torpedoLock } from '../src/sim/aim.ts';
import type { AimCandidate } from '../src/sim/aim.ts';

const enemy = (team: number, x: number, y: number, hidden = false): AimCandidate => ({ team, x, y, hidden });

describe('aim assist', () => {
  it('bends by at most 4 degrees toward the enemy nearest the aim line', () => {
    const far = enemy(1, 40, Math.tan(6 * DEG) * 40); // 6 deg off, 40 m
    const r = aimAssist(0, 0, 0, [far]);
    expect(r.team).toBe(1);
    expect(r.yaw).toBeCloseTo(4 * DEG, 6);
    const close = enemy(2, 30, Math.tan(2 * DEG) * 30); // 2 deg off: exact
    expect(aimAssist(0, 0, 0, [far, close])).toMatchObject({ team: 2 });
    expect(aimAssist(0, 0, 0, [far, close]).yaw).toBeCloseTo(2 * DEG, 6);
  });
  it('ignores enemies outside the cone, out of range, hidden in smoke or behind a wall', () => {
    expect(aimAssist(0, 0, 0, [enemy(1, 40, Math.tan(9 * DEG) * 40)]).team).toBeNull();
    expect(aimAssist(0, 0, 0, [enemy(1, CONFIG.aim.assistRange + 1, 0)]).team).toBeNull();
    expect(aimAssist(0, 0, 0, [enemy(1, 40, 0, true)]).team).toBeNull();
    expect(aimAssist(0, 0, 0, [enemy(1, 40, 0)], CONFIG, () => false).team).toBeNull();
    expect(aimAssist(0, 0, 0, []).yaw).toBe(0);
  });
});

describe('under the crosshair', () => {
  it('is a ray-vs-hull-circle test with hysteresis and line of sight', () => {
    expect(rayCircleDistance(0, 0, 1, 0, 50, 0, 3.5)).toBeCloseTo(46.5);
    expect(rayCircleDistance(0, 0, 1, 0, -50, 0, 3.5)).toBeNull();
    expect(rayCircleDistance(0, 0, 1, 0, 0, 0, 3.5)).toBe(0);
    const edge = enemy(1, 50, 4.0); // 4 m off the line: outside 3.5, inside the sticky 4.6
    expect(enemyUnderCrosshair(0, 0, 0, [edge], false)).toBeNull();
    expect(enemyUnderCrosshair(0, 0, 0, [edge], true)).toBe(1);
    expect(enemyUnderCrosshair(0, 0, 0, [enemy(1, 50, 0)], false, CONFIG, () => false)).toBeNull();
    expect(enemyUnderCrosshair(0, 0, 0, [enemy(1, CONFIG.aim.onTargetRange + 10, 0)], false)).toBeNull();
    expect(enemyUnderCrosshair(0, 0, 0, [enemy(2, 60, 0), enemy(1, 30, 0)], false)).toBe(1); // nearest wins
  });
  it('gyro gain drops to 0.6 while on target, applied by the sim not the phone', () => {
    expect(integrateAim(0, 0.1, false)).toBeCloseTo(0.1);
    expect(integrateAim(0, 0.1, true)).toBeCloseTo(0.06);
    expect(integrateAim(Math.PI - 0.01, 0.05, false)).toBeCloseTo(-Math.PI + 0.04);
  });
});

describe('torpedo lock and mortar', () => {
  it('locks the nearest enemy inside 40 degrees of the AIM, not the bow', () => {
    const aim = 90 * DEG; // gunner looks to the side
    const ahead = enemy(1, 60, 0); // along the bow: outside the aim cone
    const side = enemy(2, 0, 50);
    expect(torpedoLock(0, 0, aim, [ahead, side])).toBe(2);
    expect(torpedoLock(0, 0, 0, [ahead, side])).toBe(1);
    expect(torpedoLock(0, 0, 0, [enemy(1, 60, Math.tan(21 * DEG) * 60)])).toBeNull();
    expect(torpedoLock(0, 0, 0, [enemy(1, CONFIG.weapons.torpedo.lockRange + 1, 0)])).toBeNull();
    expect(torpedoLock(0, 0, 0, [enemy(1, 60, 0, true)])).toBeNull();
    expect(torpedoLock(0, 0, 0, [enemy(1, 60, 0)], CONFIG, () => false)).toBeNull();
    expect(torpedoLock(0, 0, 0, [enemy(1, 60, 0), enemy(2, 20, Math.tan(15 * DEG) * 20)])).toBe(2); // nearest by distance
  });
  it('mortar lands on the nearest enemy within 10 degrees and 60 m (walls ignored), else 40 m ahead', () => {
    expect(mortarTarget(0, 0, 0, [enemy(1, 50, Math.tan(9 * DEG) * 50)])).toMatchObject({ team: 1 });
    expect(mortarTarget(0, 0, 0, [enemy(1, 50, Math.tan(11 * DEG) * 50)])).toEqual({ x: 40, y: 0, team: null });
    expect(mortarTarget(0, 0, 0, [enemy(1, 61, 0)]).team).toBeNull();
    const r = mortarTarget(10, 10, 90 * DEG, []);
    expect(r.x).toBeCloseTo(10);
    expect(r.y).toBeCloseTo(50);
  });
  it('crosshair priority: hit flash > lock > diamond > neutral', () => {
    expect(crosshairFor({ now: 1, hitFlashUntil: 1.2, weapon: 'torpedo', lockTeam: 1, onTarget: true })).toBe('hit');
    expect(crosshairFor({ now: 1, hitFlashUntil: 0, weapon: 'torpedo', lockTeam: 1, onTarget: false })).toBe('lock');
    expect(crosshairFor({ now: 1, hitFlashUntil: 0, weapon: 'cannon', lockTeam: 1, onTarget: true })).toBe('target');
    expect(crosshairFor({ now: 1, hitFlashUntil: 0, weapon: null, lockTeam: null, onTarget: false })).toBe('neutral');
  });
  it('keyboard Left/Right produce a dYaw like a phone', () => {
    expect(keyboardDYaw(true, false, 0.5)).toBeCloseTo(60 * DEG);
    expect(keyboardDYaw(false, true, 0.5)).toBeCloseTo(-60 * DEG);
    expect(keyboardDYaw(true, true, 0.5)).toBe(0);
  });
});
```


### `tests/layout.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { cellsOverlap, layoutFor, rectAspect, toCssPixels, toGlPixels } from '../src/scene/layout.ts';

describe('split-screen layouts (SPEC section 2 table)', () => {
  it('2 teams: two side-by-side halves, no spare', () => {
    const l = layoutFor(2);
    expect(l.cells).toEqual([
      { x: 0, y: 0, w: 0.5, h: 1 },
      { x: 0.5, y: 0, w: 0.5, h: 1 },
    ]);
    expect(l.spare).toBeNull();
  });
  it('3 teams: 2x2 with the spare cell as overview', () => {
    const l = layoutFor(3);
    expect(l.cells.length).toBe(3);
    expect(l.spare).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
    expect(l.minimap.x).toBeGreaterThan(0.5);
  });
  it('4 teams: 2x2, minimap centred where the cells meet', () => {
    const l = layoutFor(4);
    expect(l.cells.length).toBe(4);
    expect(l.spare).toBeNull();
    expect(l.minimap.x + l.minimap.w / 2).toBeCloseTo(0.5);
    expect(l.minimap.y + l.minimap.h / 2).toBeCloseTo(0.5);
    expect(rectAspect(l.minimap, 1920, 1080)).toBeCloseTo(1); // a square on a 16:9 screen
  });
  it('5 teams: 3x2 with a spare; 6 teams: 3x2 full', () => {
    const l5 = layoutFor(5);
    expect(l5.cells.length).toBe(5);
    expect(l5.spare).toEqual({ x: 2 / 3, y: 0.5, w: 1 / 3, h: 0.5 });
    const l6 = layoutFor(6);
    expect(l6.cells.length).toBe(6);
    expect(l6.spare).toBeNull();
  });
  it('cells never overlap, stay inside the screen and cover it with the spare', () => {
    for (let n = 1; n <= 6; n++) {
      const l = layoutFor(n);
      expect(cellsOverlap(l.cells), `n=${n}`).toBe(false);
      const area = l.cells.reduce((s, c) => s + c.w * c.h, 0) + (l.spare ? l.spare.w * l.spare.h : 0);
      expect(area).toBeCloseTo(1);
      for (const c of l.cells) {
        expect(c.x).toBeGreaterThanOrEqual(0);
        expect(c.y).toBeGreaterThanOrEqual(0);
        expect(c.x + c.w).toBeLessThanOrEqual(1 + 1e-9);
        expect(c.y + c.h).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });
  it('clamps to 1..6', () => {
    expect(layoutFor(0).cells.length).toBe(1);
    expect(layoutFor(9).cells.length).toBe(6);
  });
});

describe('pixel conversion', () => {
  it('GL rects flip y (bottom-left origin) and CSS rects do not', () => {
    const l = layoutFor(4);
    const tl = l.cells[0]!;
    expect(toCssPixels(tl, 1920, 1080)).toEqual({ x: 0, y: 0, w: 960, h: 540 });
    expect(toGlPixels(tl, 1920, 1080)).toEqual({ x: 0, y: 540, w: 960, h: 540 });
    const br = l.cells[3]!;
    expect(toGlPixels(br, 1920, 1080)).toEqual({ x: 960, y: 0, w: 960, h: 540 });
    expect(rectAspect(tl, 1920, 1080)).toBeCloseTo(16 / 9);
    expect(rectAspect(layoutFor(2).cells[0]!, 1920, 1080)).toBeCloseTo(8 / 9);
  });
});
```


## 4. Edge cases and how each is handled

Lobby and teams
- n = 1..3 in threes (1..2 in twos): one team, `canStart` -> "need 2 teams". The host lowers the team size or presses F4 for a bot team.
- The 4th player in threes: 3 -> 2+2; the most recent joiner (p3) opens team 1 with p4, p1/p2 keep their roles.
- 6 -> 7 in threes: 3+3 -> 3+2+2, exactly one existing player moves (tested); 12 -> 13: 3+3+3+3 -> 3+3+3+2+2, one move.
- A leave that lowers the team count (7 -> 6): the smallest team dissolves; if the leaver was a Pilot of a full team, two people move (tested: 1 or 2 moves, never more than the surplus).
- The 19th joiner in threes, 13th in twos: spectator queue, promoted on the next lobby-phase leave or New lobby.
- Host lowers size 3 -> 2 with 18 people: the 6 most recent unpinned joiners become spectators (tested); raising it back promotes them in join order.
- Host raises size 2 -> 3 with 12 people: 6 teams of 2 become 4 teams of 3 (two teams dissolve, 4 people move).
- Manual move into a team with a free slot creating 3+3+1: the balancer bumps one unpinned player from an over-full team; the mover is never bumped; pinned players move only when nobody unpinned is available.
- Swap role with yourself or with someone on another team: no-op. Move to your own team or a full team: no-op (`moves: []`).
- A player who joins twice with the same token (reconnect): `joinPlayer` detects the id and calls `reconnectPlayer` (slot kept, name updated); no second seat.
- Disconnect in the lobby: the seat is kept until the host kicks (`leavePlayer`) or starts; `canStart` complains only if a Pilot is disconnected (the keyboard, or a swap, fixes it).
- Disconnect during countdown or battle: seat kept, boat idles after 1.5 s of silence, `viewportHud.crew[i].connected = false` greys the name; reconnect resumes; keys 1-6 take it over.
- Roles when a 3-person team loses someone mid-match: nothing changes until the next lobby; the missing role's phone functions are covered by the keyboard if needed; water drain stays at the 3-person rule because the member list still has 3 ids (the slot is reserved).
- A bot team (F4): 3 players of kind 'bot' with ids `bot:<n>:pilot` etc.; `canStart` ignores `enabled` for non-phones; `resetLobby` drops bots that were marked disconnected.
- Rematch with a player who never came back: the slot stays empty-but-reserved; the host can kick in the lobby; `resetLobby` drops them.
- Renumbering: dissolving a middle team (only possible after manual moves) shifts later teams' indices; `renumbered: true` tells the host UI to re-announce colours. Colours are never reassigned once the countdown starts.

Match flow
- Pause during countdown or overtime: the sim simply does not step; `sharedHud.phaseLabel = 'PAUSED'`; phones keep the last HUD.
- Abort: `abortMatch()` -> lobby, teams kept, scores and boats reset by the sim.
- Tab hidden: `sim.maxStepsPerFrame` (5) caps catch-up; the game effectively pauses, no phase is skipped.
- Horn exactly at countdown end; beeps 3-2-1 once each even when a frame straddles two whole seconds (tested).
- Battle ends while a boat is sinking: status carries into results (the animation finishes), nothing respawns in results.
- Tie on kills only: deaths decide, no overtime. Tie on both with 3+ teams: all tied teams play the overtime; non-tied boats are `out`, their mines/projectiles/smoke removed.
- Tied boat sinking at the transition: respawns immediately with protection (`overtimeBoatPlan.respawnNow`).
- Overtime kill: results immediately, killer ranked first; a kill by a Mine dropped before overtime by a tied team counts; mines of out teams were removed.
- Overtime with no kill: `firstToScore` tiebreak; 0-0 -> draw with both crews on the podium.
- Results time out with nobody pressing anything: back to the lobby with teams kept, Enter starts a rematch.

Combat and respawn
- Sinking boat hit again: ignored. Protected boat hit: ignored, Shield kept. Shield and protection both up: protection consumes the hit.
- Own mine after respawn: still own team, still ignored. Enemy mine dropped by a team that is now dead: still kills, still credits that team and its dropper.
- Ram: needs the attacker boosted, the target not boosted, relative speed >= 7 m/s; two boosted boats bounce; a boosted ram into a Shield spins the target out and consumes the Shield; a protected boat cannot be rammed and its own ram is not lethal (it has no Boost anyway, items are wiped).
- Water Cannon on a shielded or protected boat: still pushes and fills (it is never a "hit"), but `firingEndsProtection` ends the *shooter's* protection.
- Killer sinks before the victim's kill-cam ends: camera stays on `Killer.pose`; killer respawns: same, no cut to the dock.
- No safe dock (every dock within 80 m of an enemy): the free dock with the largest enemy distance; all docks occupied: clearance ignored; no docks at all (bad map): `null`, the sim logs and reuses the last pose.
- Two boats respawn in one step: the second pick receives the first as `occupied`, never the same dock (tested).
- Water at 100 and still under the stream: clamped, speed x 0.5; water below 0: clamped to 0.
- Picking up a red crate while sinking/respawning: the sim only tests crate pickup for `alive` boats; a crate consumed by a boat that gets sunk in the same step still respawns in 8 s.
- Both power slots full: blue crate stays and keeps its contents (not re-rolled); with Boost held and a Shield up, a third pickup still fails.
- Last shot of a Torpedo while locked: the projectile keeps its `targetTeam`; the slot is empty before the shot lands; a Torpedo whose target entered smoke loses the lock (the sim clears `targetTeam` and it flies straight).
- Mortar fired with no target: lands 40 m ahead along the aim, splash 6 m, can hit a boat that drives there.
- Tier flags off: items never rolled, never picked up, never shown; frenzy never starts.
- Crate respawn timing when the frenzy starts: the delay is evaluated when the crate is taken, so a crate taken at 4:00 still takes 8 s; one taken at 4:01 takes 4 s.

Aim
- No enemies alive (everyone sinking): assist returns the raw yaw, crosshair neutral, lock null.
- Enemy at 0 m (ramming): `rayCircleDistance` returns 0 (origin inside the circle) -> on target; `bearings` skips coincident points.
- Enemy exactly at the cone edge: `<=` keeps it (8.000 deg is in, 8.001 is out).
- Aim wrap at +-pi: `integrateAim` wraps; `angleDiff` handles the seam (tested).
- Keyboard Left and Right held together: `dYaw = 0`.
- Gyro sign wrong on the first test: flip `aim.gyroSign` (bots undo it so they still turn the right way).

Keyboard
- Focused team has no Engineer (2-person) or no Gunner (solo): the frame is still produced; the scene drops packets for roles that have no member.
- Held key when the window loses focus: `blur` clears `pressed`.
- Auto-repeat keydown: ignored via `e.repeat`.
- F-keys swallowed by Chrome outside fullscreen: the number-row alternatives work everywhere; the Start click requests fullscreen and keyboard lock.
- Keyboard lock permission refused or unsupported: `startFullscreenCapture` resolves anyway (feature-detected), the alternatives remain.


## 5. How to test on day one

Without phones (keyboard + bots, the spec's "placeholder loop")
1. `npm test`: `tests/teams.test.ts` (balance table, join/leave moves, spectators, size switch, swap/move, start check, reset), `tests/rules.test.ts` (hit matrix, timeline, docks, water, scoring, feed, minimap, state machine, inventory, crates), `tests/aim.test.ts` (assist, diamond, lock, mortar, crosshair, keyboard dYaw), `tests/layout.test.ts` (rects, overlap, coverage, GL flip). 57 tests, about 0.2 s.
2. `npm run dev`, open `http://localhost:5173/scene`. Press F4 (or 0) four times: four bot teams appear in the lobby in Rosso, Azzurro, Verde, Oro with 3 bot players each; the layout switches 1 -> 2 -> 2x2 as teams are added.
3. Enter: countdown 10 s with beeps at 3-2-1 and the horn; the clock then reads 5:00 and counts down. Press T so the bots drive, loot, shoot, sink and respawn: the kill feed fills, the scoreboard reorders, cells show the kill-cam and "SUNK by X" with a countdown.
4. Press 1, hold W and A/D: Rosso's boat responds while the bots keep the other three busy. Left/Right turns the view, not the boat; the bow arrow at the bottom turns; the diamond appears when an enemy crosses the crosshair and Left/Right feel slower (x 0.6). F5 gives a random weapon; Space fires; the last shot returns the Water Cannon. Q/E use powers; B bails after a bot's water cannon fills the hull (the bar in the bottom right).
5. F6 sinks the focused boat: feed "Rosso sank", 2 s sink, respawn at a dock at least 80 m from the bots, bubble for 3 s that ends as soon as Space is pressed.
6. P pauses: the clock stops, nothing moves, P resumes with no jump. Let the 5:00 run out: results for 20 s (ranking, top Gunner, best ram), then the lobby again with the same teams; Enter rematches.
7. Force a tie: with two bot teams and bots off (T), F5 + Space to score once from each side with identical deaths, let the clock run out: overtime 30 s with "SUDDEN DEATH", the third team's cell shows "ELIMINATED"; score once -> results immediately.
8. Layout check: F4 up to six teams and look at 2 / 3 / 4 / 5 / 6 cells: the minimap sits in the spare cell or at the centre; borders and names in the right colours; F1 (or 7) overlays fps and the per-team state.

With phones (after Gate 1)
1. `npm run tunnel`, scan the QR with two phones: both appear in the lobby in join order (Pilot, Gunner of Rosso). A third phone becomes Rosso's Engineer; a fourth opens Azzurro and takes Rosso's Engineer with it (2+2): both phones show the new colour and role.
2. On a phone: Swap role with a teammate -> roles flip on the big screen and both phones. Move to the other team -> allowed only when it has a free slot; the bumped player (if any) gets a toast.
3. Lock a phone during the countdown: its name greys out, the boat idles when the battle starts; unlock -> it resumes in the same slot; press 1 and W meanwhile to drive it from the keyboard.
4. Enable controls not tapped on one phone: Start is still allowed; the lobby lists the name in orange.
5. Host switches team size 3 -> 2 with 7 phones: 2+2+2 and one spectator phone showing "you are next"; back to 3: 3+2+2.
6. Play one full round: calibration during the countdown (C on the keyboard for the focused Pilot), 5:00, results, Rematch keeps teams; New lobby re-seats by join order.

## 6. Sources

Installed packages (read, not remembered)
- `node_modules/@dimforge/rapier2d-compat/package.json` (0.21.0) and `dist/pipeline/world.d.ts`: `init(): Promise<void>`, `new World(gravity)`, `step()`, `timestep` setter, `castRay(ray, maxToi, solid, filterFlags?, filterGroups?, filterExcludeCollider?, filterExcludeRigidBody?, filterPredicate?): RayColliderHit | null`; `dist/pipeline/query_pipeline.d.ts`: `QueryFilterFlags.ONLY_FIXED = 6`; `dist/dynamics/rigid_body.d.ts`: `readonly handle: RigidBodyHandle` (number). Probe script `probe-rapier.mjs` in the scratchpad printed `rapierVersion 0.21.0`, body handle `5e-324`, wall handle `0`, `ONLY_FIXED` ray toi `19.5` to a wall at x = 20 with half-width 0.5, `null` when the ray misses.
- `node_modules/@types/three/src/renderers/WebGLRenderer.d.ts` lines 279-299: `setViewport(x, y, width, height)` "(x, y) is the lower-left corner of the region", `setScissor`, `setScissorTest(enable)`; `src/math/MathUtils.d.ts`: `euclideanModulo`, `degToRad`, `clamp`, `lerp`.
- `node_modules/vitest/package.json` (5.0.5), `dist/index.d.ts` exports `expect`, `describe`, `it`; `toBeCloseTo(number, numDigits?)` in `dist/chunks/config.d.*.d.ts`.
- `node_modules/typescript/package.json` 5.9.3; the repo's `tsconfig.json`, `vite.config.ts` (alias `@shared`, vitest `test.include`), `shared/math.ts`, `tests/math.test.ts` (import style `../shared/math.ts`).

Platform behaviour
- W3C, UI Events KeyboardEvent code Values: `KeyA`, `Digit1`, `ArrowLeft`, `Space`, `Enter`, `F1`..`F6`, `Backquote`, `Escape`, `ShiftLeft`. https://www.w3.org/TR/uievents-code/
- Chromium `chrome/browser/ui/browser_command_controller.cc`, `IsReservedCommandOrKey`: "In fullscreen, all commands except for IDC_FULLSCREEN and IDC_EXIT should be delivered to the web page"; in app windows no keys are reserved; on macOS reserved while the toolbar is visible. https://chromium.googlesource.com/chromium/src/+/HEAD/chrome/browser/ui/browser_command_controller.cc
- Chromium `chrome_dll.rc` (historic accelerator resource): `VK_F5, IDC_RELOAD, VIRTKEY` and F1 -> help. https://chromium.googlesource.com/chromium/src/+/dc26192a317d9511ce983fd4b26b1130fe25761a/chrome/app/chrome_dll.rc and https://codereview.chromium.org/10796
- Reports that F1/F3/F5 cannot always be cancelled from a page: SmartClient KeyboardEvents docs https://www.smartclient.com/smartgwt-4.0/javadoc/com/smartgwt/client/docs/KeyboardEvents.html ; p5.js forum thread with mixed results on Chrome/Edge https://discourse.processing.org/t/use-of-f1-key-in-p5-js/35055
- Keyboard Lock: MDN `Keyboard.lock()` (secure context, transient activation, `lock(keyCodes?)`, "can only capture keys that are granted access by the underlying operating system") https://developer.mozilla.org/en-US/docs/Web/API/Keyboard/lock ; WICG spec ("only valid when a JavaScript-initiated fullscreen is active", F11 fullscreen excluded, Escape held 2 s exits) https://wicg.github.io/keyboard-lock/ ; Chrome developers article (feature detection `'keyboard' in navigator && 'lock' in navigator.keyboard`, "As of Chrome 130 (September 2024), requesting a keyboard or pointer lock requires permission") https://developer.chrome.com/docs/capabilities/web-apis/keyboard-lock ; Chrome blog support table Chrome 68, Edge 79, no Firefox/Safari https://developer.chrome.com/blog/better-full-screen-mode
- WCAG 2.1 contrast ratio `(L1 + 0.05) / (L2 + 0.05)`, 4.5:1 for text (SC 1.4.3), 3:1 for non-text (SC 1.4.11), relative luminance with the 0.04045 sRGB threshold (change log). https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio and https://www.w3.org/TR/WCAG21/#dfn-relative-luminance ; colour numbers computed by `colours2.mjs` in the scratchpad.

Spec
- `/Users/makhlugjafarov_cognitex/Documents/regata-storica/SPEC.md` sections 2, 3, 4, 5, 6, 10, 11, 12, 14.
