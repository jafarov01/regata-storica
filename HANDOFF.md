# HANDOFF: where Gondola Royale stands and how to continue

Updated 2026-10-16 (base phase finished). Read this first, then `ARCHITECTURE.md`, then `SPEC.md` and every file in `shared/`.

## 1. State of the repo

**The base phase from SPEC.md section 13 is done, except the real-phone test.** `npm run dev` runs the whole loop: the scene creates a room and shows the QR, phones join and appear in teams, the host starts a match, phone tilt and GAS drive a boat on the big screen, the timer runs to results and back to the lobby. Checked in the browser with a simulated phone (`?sim=1`). **Not yet checked on a real iPhone or Android phone through the tunnel: that is Gate 1 and the first thing to do together.**

| Area | State | Where |
|---|---|---|
| Spec | Verbatim export of the .docx (re-checked against the latest .docx on 2026-10-16: identical) | `SPEC.md`, `docs/media/` |
| Architecture | How the parts fit, conventions, module status, settled decisions | `ARCHITECTURE.md` |
| Contracts | `config`, `state`, `protocol`, `api`, `map`, `math`. Protocol merged with the netcode research; boat mass settled; `BoatStatus 'out'` added | `shared/` |
| Relay | Real, from the netcode research: rooms, reconnect, rate limits, SPA fallback, health | `server/` |
| Net clients | Real: phone client, scene client, input hold and aim tracker, identity, QR, scanner | `src/net/` |
| Phone | Real sensor stack from the sensors research; join (code checked against the relay), lobby with team and role in large type, Enable controls; role screens follow the match phase: Pilot wheel + BRAKE/GAS, Gunner compass + RECENTER/FIRE (+ P1/P2 in teams of 2), Engineer two powers + water meter; SUNK and results screens; team-colour background, haptics / red flash, rotate overlay; error panel for wrong code, full room, kicked, another tab; resume after reload or lock (code; real-phone test pending) | `src/phone/` |
| Sim | Real (Track B, B1-B10, audited 2026-10-16: fixes listed in `docs/TASKS-B.md`): Rapier boats, crates, Water Cannon / Cannon / Torpedo / Mortar, kills, sinking, respawn, protection, Shield, Mine, Boost and rams, bailing, sudden death, bots that play (closed bot teams). Step: 0.04 ms mean with 4 bot teams | `src/sim/` |
| Scene | Real loop, layout, keyboard harness, phone HUD feed and cues, big-screen HUD (per viewport, kill feed, minimap, kill-cam, host buttons and kick) | `src/scene/` |
| Renderer | Placeholder behind the real `Renderer` interface: real viewports and camera rigs; block buildings, flat water, box boats | `src/render/index.ts` |
| Tests | 119 passing: contracts, relay and rooms, sensor math and sender, phone screen logic, input hold tap counters, baseline sim/layout/feed, gameplay (`tests/sim.test.ts`). `npm run check` green | `tests/`, `src/phone/sensorMath.test.ts` |
| Research | All six write-ups final (netcode and render finished from their drafts), with code and every agent transcript | `docs/research/` |

## 2. Run it

```bash
npm install
npm run dev
```

1. Open http://localhost:5173/scene on the PC. It shows a room code and a QR.
2. Without phones: press **K** for a keyboard crew (or **O** for a bot team), **Enter** to start, drive with **WASD**, aim with the **arrows**, **Space** fires, **R** recenters, **1-6** picks the team.
3. A desktop "phone": open `/play?room=CODE&sim=1` in another window, tap Enable controls, tap CALIBRATE, hold GAS, tilt with **A/D**.
4. A real phone: `npm run tunnel` (needs `brew install cloudflared`), open the scene **on the tunnel URL** (so the QR carries https), scan the QR. Or set `VITE_PUBLIC_ORIGIN=https://<tunnel-host>` to keep the scene on localhost.

Dev console on the scene: `gr.sim.state`, `gr.sim.debug.giveWeapon(0, 'cannon')`, `gr.sim.debug.givePower(0, 'boost')`, `gr.sim.debug.sink(1, 0)`, `gr.sim.debug.endPhase()` (skip the countdown, battle or results), `gr.hold.read('p1')`.

## 3. Next steps, in order

**Who does what: [`docs/TASKS.md`](docs/TASKS.md)** (three modules, one per teammate, with the order of work and the gates).

**Together, first 20 minutes: Gate 1.** Tunnel, one iPhone and one Android: Enable controls, CALIBRATE, tilt, GAS, the boat turns on the TV. If motion fails, the phone says why (HTTPS, permission, no events). Then split:

- **Track A (server/, src/net/, src/phone/, src/landing/)**: `docs/TASKS-A.md`. The plumbing is done; the work is the real phone screens and the on-device checks.
- **Track B (src/sim/, src/scene/)**: `docs/TASKS-B.md`. B1-B10 are done and audited (the fixes are listed there); what is left is the Gate 2 playtest: feel, `PLAYTEST_TUNING`, then folding `TUNING.boat.steerTorqueBaseMul` into `shared/config.ts`.
- **Track C (src/render/, public/assets/)**: `docs/TASKS-C.md`. Land the research renderer behind `Renderer` with an adapter, then assets per `docs/ASSETS.md`.

`shared/` is read-only for agents. A contract change is agreed out loud and committed by one person, with `tests/` updated.

## 4. Research folder

| Folder | Status | Contents |
|---|---|---|
| `sensors/` | final | Permission flow, sign conventions, steering and gyro math, shake, sender, pads, wake lock, simulator, tests. **Landed** in `src/phone/` (sender adapted to the new protocol). |
| `netcode/` | final (`final.md`, assembled from `final.src.md` + `mirror/` by `splice.py`) | Relay, rooms, reconnect, hosting and HTTPS, edge cases, Gate 1 checklist. **Landed** in `server/`, `src/net/`, `tests/`; the status note at the top lists the changes. |
| `physics/` | final | Rapier 0.21 proofs; `coords`, `geom`, `physics`, `loop`, `boat`, `walls`, `items`, `projectiles`, step order; six test files. **For Track B.** Uses 1000 kg: scale forces by 0.4 for the repo's 400 kg. |
| `rules/` | final | `teams`, `rules`, `items`, `aim`, `hud`, `layout`, `keyboard`, `bot`, tests. **For Track B.** Its `shared/` proposals are richer than the repo's; the repo's are authoritative. `layout.ts` is already landed. |
| `map/` | final | The map (same as `shared/map.ts`), validator, annotated rendering. Its heading convention is superseded by `shared/map.ts`. |
| `render/` | final draft (`final.md` joined from `doc/partA.md` + `doc/partB.md`) | Renderer, buildings, water, sky, gondola, crew, VFX, audio, camera, HUD, minimap in `code/`; 19 tests. **For Track C**, behind an adapter (research yaw = -PI/2 - repo yaw). |
| `_workflow/` | complete | Workflow script and every agent transcript (`agent-*.jsonl`; `*.meta.json` names the topic). Netcode `agent-afab987e3f456c9ce`, render `agent-a71c3c61ab65370a0`, sensors `agent-a3805393801a5924b`, physics `agent-a52d0d07d5b35ee55`, rules `agent-a3ceb19eef51e2aa4`, map `agent-abc575981e5c22b0b`. The `verify:*` / `revise:*` agents stopped at the session limit with no result. `main-session/` is the lead session. Personal details were stripped from all transcripts. |

To pull a file out of a transcript: `grep -o '"name":"Write","input":{"file_path":"[^"]*"' docs/research/_workflow/agent-<id>.jsonl | sort -u`; the contents are in the same JSON lines (`"content":`).

## 4b. Characters (added 2026-10-16)

After the QR scan a phone shows "Choose your player": the 14 people of the Via Falchi retreat (cartoon portraits from the event site, in `public/assets/players/`) plus the gondolier, open to anyone. One person per player; the pick is saved on the phone and sent again after any rejoin or big-screen reload. It travels as the `character` control message (`shared/protocol.ts`), lands in `PlayerState.character`, and shows in the big-screen roster, the phone crew list and in the boat: `src/render/avatars.ts` builds each person (look sheet in `shared/characters.ts` + the portrait as a face decal) and seats them by role, swaying with the boat.

Without phones: `gr.sim.applyMessage('kb-1-pilot', { t: 'character', id: 'justin-simon' })` on the scene console.

## 5. Known gaps

- Real phones are untested (Gate 1).
- Steering: `BOAT.steerTorqueBase` 900 alone turned the boat 0.27 rad/s at rest, too slow for the side canals. `TUNING.boat.steerTorqueBaseMul` (1.85, `src/sim/tuning.ts`) now gives the physics research's 0.5 rad/s at rest and about 1.15 rad/s at 8 m/s (measured). Still the first thing to feel at Gate 2; when it is settled, fold it into `shared/config.ts` (`steerTorqueBase` 1665) and set the multiplier to 1.
- The kill-cam ends (own sinking boat) when the killer sinks during it; freezing the killer's last pose instead, as the research did, is for the renderer (Track C).
- The renderer is boxes; no assets in `public/assets/` yet. The crew avatars are real and live in their own module; when Track C lands the research renderer, add `CrewAvatars.root` to each gondola instead of the research `CrewSet` (research model has the bow on +X: wrap the crew in a group with `rotation.y = -PI/2`, deck height ~0.42).
- The 3D people are code-built (proportions, hair, beard, glasses, clothes from each portrait, the cartoon face on the head), not scanned models: recognisable on the big screen, not photo-real. Portraits are published in this public repo, as they are on the event site.
- Phone screens have the wheel, compass needle and Engineer meter as CSS shapes, not drawn art. Vibration, the 30 s lock/unlock resume and the fallback scanner are written but untested on real phones.
- Phones only learn the winner from the volatile `Evt win`, and the results screen shows only their own team's score: `Hud` has no scoreboard (a `shared/protocol.ts` change if wanted).

## 6. Prompt starter for an agent chat

```
You are working on Gondola Royale, a browser party game. Read HANDOFF.md, ARCHITECTURE.md, SPEC.md and every file in shared/ first.
Track: B, gameplay and physics. Only edit files in src/sim/ and src/scene/. Treat shared/ as read-only.
Ready-made, tested code for this track is in docs/research/physics/final.md and docs/research/rules/final.md; adapt it to the repo's shared/ types instead of rewriting it.
Task: <one item from docs/TASKS-B.md>
Done when: <observable result>, testable with the keyboard harness, and `npm run check` passes.
```

## 7. Commands

```bash
npm run dev          # Vite on :5173 + relay on :3000 (proxied), open http://localhost:5173/scene
npm run check        # typecheck + tests + build (CI runs the same)
npm run tunnel       # cloudflared quick tunnel to :5173 (install: brew install cloudflared)
npm run preview      # production build served by the relay on :3000
npm run test:relay   # only the relay integration tests
```
