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
