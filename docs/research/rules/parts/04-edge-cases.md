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
