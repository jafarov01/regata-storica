# HANDOFF: where Gondola Royale stands and how to continue

Written 2026-10-16 by Claude (Fable 5.1) for Makhlug's teammates and their agents.
Read this first, then `SPEC.md`, then every file in `shared/`.

## 1. What exists in this repo right now

| Area | State | Where |
|---|---|---|
| Spec | Committed verbatim (exported from the .docx), with its two diagrams | `SPEC.md`, `docs/media/` |
| Toolchain | Vite 8.3, TypeScript 5.9 (pinned, not 7), Vitest 5, tsx, Socket.IO 4.8, Three 0.186, Rapier 2D compat 0.21, express 5. `npm install` done, `npm test` green (13 tests) | `package.json`, `vite.config.ts`, `tsconfig*.json`, `.github/workflows/ci.yml` |
| Contract files (DONE, authoritative) | `shared/config.ts` (every tunable + tier flags), `shared/state.ts` (GameState, SimEvent), `shared/protocol.ts` (all messages + Socket.IO typed event maps + sanitizers), `shared/api.ts` (Sim and Renderer interfaces between tracks), `shared/map.ts` (the 50x38 ASCII map, parser, walls merge, docks with headings, bridges, lagoon mask), `shared/math.ts` | `shared/` |
| Tests for the contracts | map (connectivity, counts, quays, wall cover), math | `tests/` |
| App shell | `index.html`, `src/main.ts` (routes `/`, `/scene`, `/play` with dynamic imports so phones never load Three/Rapier), `src/landing/index.ts`, `src/styles/base.css` | `src/` |
| Research with ready-to-paste, type-checked and tested code | 4 finished write-ups (sensors, physics, rules, map), 2 nearly finished (netcode `final.src.md`, render `doc/part*.md`) with their code trees, plus the full agent transcripts | `docs/research/` (see section 3) |
| NOT implemented yet | `server/` (relay), `src/net/`, `src/phone/`, `src/sim/`, `src/scene/`, `src/render/`, assets | folders exist, empty |

`npm run typecheck` currently fails only because `src/scene/main.ts` and `src/phone/main.ts` do not exist yet (the router imports them). Everything else type-checks.

## 2. Decisions that are now fixed (do not re-litigate without telling the others)

1. **One repo, one Vite app, three routes.** Client-side routing on `location.pathname`; the dev server and the relay both fall back to `index.html`.
2. **Coordinates** (in `shared/map.ts`, used by `shared/state.ts`): metres, Three.js frame, Y up, water at y = 0, map origin at the centre, row 0 of the ASCII map is the far side (negative z). The 2D sim uses `(x, z)`. **Yaw = `Object3D.rotation.y`**: forward = `(-sin yaw, -cos yaw)`, yaw 0 looks toward -z, positive yaw turns left. Rapier binding (from the physics research, consistent with this): `sim.x = world.x`, `sim.y = -world.z`, Rapier rotation angle = yaw, the hull's bow is the body's local +y. The map research write-up used a different heading convention (0 = +x, `mesh.rotation.y = -heading`); **that part is superseded** by `shared/map.ts`.
3. **Relay is dumb.** It only understands `host`, `hello`, `in`, `msg`, `to`, `hud` and routes by room code (see `shared/protocol.ts`). Inputs are volatile at 30 Hz; the sim holds the last input; `dYaw` is accumulated on the phone between sends so a dropped packet loses at most one window.
4. **Rooms**: 4-letter codes from `NET.roomCodeAlphabet`; phone token in localStorage rejoins the same slot; the scene keeps its code in sessionStorage and reclaims it; the relay keeps a room 90 s after its scene drops.
5. **Teams**: ordered member list per team, role = index (Pilot, Gunner, Engineer). Team count `min(6, ceil(n / size))`, sizes balanced (7 in threes = 3+2+2). Rebalance moves the most recent joiners first; manual moves pin a player. Beyond 18 (or 12 in twos) = spectators. Full algorithm and tests in `docs/research/rules/final.md`.
6. **Sensors**: steering = `atan2(up.x, up.y)` of the low-passed gravity vector minus the calibration angle; Gunner yaw rate = `rotationRate . unit(up)`; **iOS reports `accelerationIncludingGravity` with the opposite sign to Android/the spec** (flat face up: iOS z = -9.81, Android z = +9.81), so normalise with `sign = -1` on iOS before projecting, and keep an "Invert aim" toggle. `rotationRate.alpha/beta/gamma` are the rates about device x/y/z in that order (what Chromium and WebKit actually do). `event.interval` is seconds on WebKit and milliseconds on Chromium: never use it, use `performance.now()` deltas. Details and code: `docs/research/sensors/final.md`.
7. **Physics**: Rapier damping is `v *= 1/(1 + dt*d)`, so terminal speed is `F/(m*d)`; boat 1000 kg (research) with thrust sized for 10 m/s; keel = scale lateral velocity by `exp(-grip*dt)` via `setLinvel`; ram detection from `COLLISION_EVENTS` + pre-step velocities + `world.contactPair`; sinking = collision groups to a "sinking" mask, then `setEnabled(false)`, respawn by teleport. Colliders become queryable only after one `world.step()`. Details and code: `docs/research/physics/final.md`. Note: `shared/config.ts` in the repo uses mass 400 and its own thrust/damping numbers; either adopt the research's 1000 kg block or keep 400 kg and re-derive thrust = m * d * vTop. Both are fine; pick one and keep `BOAT.topSpeed` true.
8. **Rendering**: one `WebGLRenderer`, scissor viewports per team; `renderer.shadowMap.autoUpdate = false; needsUpdate = true` once per frame renders shadows once for all viewports (verified in three 0.186 source: `WebGLShadowMap` resets `needsUpdate` after one render). HUD as DOM overlays per viewport rect. No planar reflections. Layout rects per `SPEC.md` section 2 (rules research has the exact table and `toGlPixels` flip).
9. **Match flow**: lobby -> countdown 10 s -> battle 300 s -> optional sudden death 30 s (tied teams only, others eliminated) -> results 20 s. Timers are sim-time deadlines (`phaseEndsAt`), never wall-clock. Hit -> sinking 2 s -> respawn at hit + 5 s -> protection 3 s.
10. **Keyboard harness**: keys 1-6 focus a team; A/D W/S C for the Pilot, Left/Right Space R for the Gunner, Q/E B for the Engineer; Enter start, P pause; debug on F1..F6 with 7 8 9 0 - = as fallbacks (Chrome eats F-keys outside fullscreen). Bots exist in the rules research to fill 4 viewports without phones.

## 3. The research folder: what is where

Every file the research agents produced was copied verbatim into `docs/research/`:

| Folder | Status | Contents |
|---|---|---|
| `sensors/` | **final.md complete** (~100 KB) | Permission flow, sign conventions with sources, steering and gyro math with numeric proofs, shake, 30 Hz sender, touch pads, wake lock, desktop simulator, test vectors. Code targets `src/phone/*`. |
| `physics/` | **final.md complete** (~120 KB) | Rapier 0.21 proofs, `src/sim/coords.ts`, `geom.ts`, `physics.ts`, `loop.ts`, `boat.ts`, `walls.ts`, `items.ts`, `projectiles.ts`, `sim.ts` order of operations, six test files (all passing in the agent's sandbox). |
| `rules/` | **final.md complete** (~160 KB) | `src/sim/teams.ts`, `rules.ts`, `items.ts`, `aim.ts`, `hud.ts`, `src/scene/layout.ts`, `keyboard.ts`, `bot.ts`, and tests. Also its own proposal for `shared/config.ts` and `shared/state.ts` (richer than the repo's; the repo's are authoritative, lift what you need). The agent's sandbox copy of its typed code is in `rules/shared`, `rules/src`, `rules/tests`. |
| `map/` | **final.md complete** (~94 KB) | The map (identical to `shared/map.ts`), `validate.mjs` (standalone validator, "ALL CHECKS PASSED"), annotated rendering, a parser proposal (superseded on the heading convention only), consumer snippets. |
| `netcode/` | **nearly final write-up in `final.src.md`** (~40 KB, written just before the limit; not reviewed) | `mirror/` is a working copy of the repo with `server/`, `src/net`, `shared/protocol` drafts, `tests/relay.test.ts`, a load test and logs (`relay-smoke.log`); `proof-relay.ts` proves the Socket.IO forwarding pattern; `proof-express-wildcard.ts` proves the express 5 SPA fallback syntax; `vite-proof/` proves the dev proxy. Read the agent transcript for its conclusions (see below). |
| `render/` | **write-up drafted in `doc/partA.md` + `doc/partB.md`** (not joined into a final.md; not reviewed) | `code/src/render/*`, `code/src/scene/*`, `code/tests/{buildings,camera,layout}.test.ts`, `proof-exports.mjs` (verified three 0.186 addon exports). Read the transcript for the write-up it had drafted. |
| `_workflow/` | complete | The workflow script and every agent transcript (`agent-*.jsonl`, one JSON object per line; `*.meta.json` names the topic). The netcode agent is `agent-afab987e3f456c9ce`, render is `agent-a71c3c61ab65370a0`, sensors `agent-a3805393801a5924b`, physics `agent-a52d0d07d5b35ee55`, rules `agent-a3ceb19eef51e2aa4`, map `agent-abc575981e5c22b0b`. The `verify:*` and `revise:*` agents are reviewers that stopped at the session limit with no result; their transcripts are kept for completeness. |
| `_workflow/main-session/` | complete | The lead session's own transcript (`session-69884729.jsonl`), its saved tool outputs, the workflow script and the project memory note. All transcripts here had harness reminders and personal details stripped; the logic, tool calls and file contents are unchanged. |

To pull a draft out of a transcript, grep for the `Write` tool calls:
```bash
grep -o '"name":"Write","input":{"file_path":"[^"]*"' docs/research/_workflow/agent-afab987e3f456c9ce.jsonl | sort -u
```
and the file contents are in the same JSON lines (`"content":`).

## 4. Known gaps and mismatches to resolve first

- `src/scene/main.ts` and `src/phone/main.ts` are missing: write them first so `npm run typecheck` and `npm run dev` work.
- The research code was written against each agent's own copy of `shared/*`; adapt imports and names to the repo's `shared/` (`BOAT`, `AIM`, `WEAPONS`, `GameState` fields, `InputPacket` with `seq`). Expect an hour of reconciliation per track, not more; the logic is done.
- `shared/state.ts` has `BoatState.status: 'alive' | 'sinking' | 'respawning'`; the rules research adds `'out'` for teams eliminated in sudden death. Add it if you implement sudden death.
- The research `Hud` adds `overtime` as its own phase and reports it as `'battle'` to phones; the repo's `Phase` already includes `'suddendeath'`. Either is fine; keep `shared/protocol.ts` as the truth.
- Nobody has run anything in a browser yet. Gate 1 (one phone steers a box boat) is still the first thing to prove.
- Assets: none yet. See `docs/ASSETS.md` for the sound list and the image prompts.

## 5. Suggested order of work (three laptops, three agents)

Base (together, 1 hour): write `src/scene/main.ts` (loop: fixed 60 Hz sim step with accumulator, render with alpha, keyboard harness) and `src/phone/main.ts` (join, lobby, role screens) as thin shells; write `server/index.ts` from `docs/research/netcode/mirror/server`; get a box boat moving from the keyboard in two viewports; start the tunnel and test one iPhone. Then split:

- **Track A (server/, src/net/, src/phone/, src/landing/)**: `docs/TASKS-A.md`. Lift from `docs/research/netcode/mirror` and `docs/research/sensors/final.md`.
- **Track B (src/sim/, src/scene/)**: `docs/TASKS-B.md`. Lift from `docs/research/physics/final.md` and `docs/research/rules/final.md`.
- **Track C (src/render/, public/assets/)**: `docs/TASKS-C.md`. Lift from `docs/research/render/code` and the render transcript; assets per `docs/ASSETS.md`.

`shared/` is read-only for agents. A contract change is agreed out loud and committed by one person, with the tests in `tests/` updated.

## 6. Prompt starter for an agent chat

```
You are working on Gondola Royale, a browser party game. Read SPEC.md, HANDOFF.md and every file in shared/ first.
Track: B, gameplay and physics. Only edit files in src/sim/ and src/scene/. Treat shared/ as read-only.
Ready-made, tested code for this track is in docs/research/physics/final.md and docs/research/rules/final.md; adapt it to the repo's shared/ types instead of rewriting it.
Task: <one item from docs/TASKS-B.md>
Done when: <observable result>, testable with the keyboard harness, and `npm run check` passes.
```

## 7. Commands

```bash
npm install
npm run dev          # Vite on :5173 + relay on :3000 (proxied), open http://localhost:5173
npm run check        # typecheck + tests + build
npm run tunnel       # cloudflared quick tunnel to :5173 (install: brew install cloudflared)
npm run preview      # production build served by the relay on :3000
```
