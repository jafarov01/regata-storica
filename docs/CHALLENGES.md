# The hard parts and their solutions

Each entry: the risk, the decision, and where the full write-up with code lives in `docs/research/`.

## 1. iOS motion permission and HTTPS

Risk: without HTTPS and a user tap, sensors silently return nothing.
Solution: the single **Enable controls** tap calls `DeviceMotionEvent.requestPermission()` (and the orientation one for the fallback), requests the wake lock and, on Android, fullscreen + landscape lock; a 1.5 s watchdog shows a clear error when no `devicemotion` event arrives (HTTP page, denied permission, desktop). HTTPS comes from the tunnel (`npm run tunnel`, Cloudflare quick tunnel supports WebSockets, random URL per run, the QR is generated at runtime from `location.origin`); LAN alternative `npm run dev:https` with a self-signed cert (phones must accept the warning). Write-up: `docs/research/sensors/final.md` sections 2 (D3, D7) and 4; hosting in the netcode agent transcript.

## 2. Steering from the gravity vector

Solution: `phi = atan2(up.x, up.y)` of the low-passed (80 ms) gravity vector; `steer` from `wrap(phi_cal - phi)` with a 4 deg dead zone, full lock at 35 deg and a `0.6x + 0.4x^3` curve. Exact at any pitch; both landscape orientations and the iOS sign inversion only shift the calibration offset. Numeric proofs and test vectors: `docs/research/sensors/final.md` section 3.1.

## 3. Gyro aim that is not twitchy and does not drift

Solution: yaw rate = `rotationRate . unit(up)` (projection onto the world vertical), `rotationRate.alpha/beta/gamma` being the rates about device x/y/z in that order (what browsers actually do, not the old spec text); dead zone 2 deg/s, gain 2, integrated into `dYaw` between 30 Hz sends; RECENTER and respawn reset the sim's aim; the scene applies the 40 % gain drop while an enemy is under the crosshair; aim assist bends shots up to 4 deg. **iOS reports `accelerationIncludingGravity` with the opposite sign** (flat: z = -9.81), so normalise with `sign = -1` on iOS, confirmed by a physics detector during the lobby, with an "Invert aim" toggle as the last resort. Write-up: `docs/research/sensors/final.md` D2, D3, D9; aiming rules in `docs/research/rules/final.md` 2e.

## 4. Frame rate with 4 viewports

Solution: one renderer, scissor viewports, **one shadow pass per frame** (`shadowMap.autoUpdate = false`, `needsUpdate = true` before the first viewport; verified in three 0.186 `WebGLShadowMap`), DPR 1 (each cell is 960x540 at 1080p), merged building blocks, instanced windows/poles/lanterns, fog hiding beyond 120 m, no planar water reflections, no point lights on lanterns, Canvas 2D for the minimap and overview. Measure at Gate 2 with 4 bot teams. Write-up: render agent transcript and `docs/research/render/code`.

## 5. The relay, rooms and reconnect

Solution: the relay only routes by room code and player id (scene: `host`, `gate`, `kick`, `hud`, `evt`, `lobby`; phone: `hello`, `in`, `swap`, `ready`, `calibrate`, `rename`, `leave`); inputs volatile at 30 Hz with aim, fire taps and power taps sent as running totals so a lost packet costs nothing, HUD volatile at 10 Hz per player, roster reliable; token in localStorage rejoins the same slot, the scene reclaims its room code from sessionStorage, 90 s grace after the scene drops; every packet sanitised and rate limited; express 5 SPA fallback; Vite proxies `/socket.io` with `ws: true`. Contract: `shared/protocol.ts`. Code: `server/`, `src/net/` (landed from `docs/research/netcode/final.md`, with tests).

## 6. Boat physics that feels arcade and stays stable

Solution: Rapier 2D 0.21 with `y := -z` so the Rapier angle equals the Three.js yaw; damping `v *= 1/(1 + dt d)` gives terminal speed `F/(m d)` (thrust derived from the top speed); keel by scaling lateral velocity `exp(-grip dt)`; steering torque from the steady-state turn rate; ram detection from collision events plus pre-step velocities and `contactPair`; sinking by collision mask, respawn by teleport; projectiles as plain objects with segment-vs-OBB tests and `castRay` for walls. Write-up and tested code: `docs/research/physics/final.md`.

## 7. The map as one ASCII grid

Solution: `shared/map.ts` holds the 50x38 grid; greedy rectangle merge gives 69 wall colliders; docks face the longest run of open water; bridges are water for physics; the lagoon mask drives the minimap reveal; `npm test` fails on any structural break (connectivity, counts, quays). Validator and measurements (Monte Carlo on the 80 m respawn rule: a candidate dock always exists): `docs/research/map/`.

## 8. Teams that stay balanced and roles that never block

Solution: ordered members, role = index; `min(6, ceil(n / size))` teams with balanced sizes; rebalance moves the most recent joiners first and keeps manual moves pinned; spectators beyond capacity; Start needs only two teams with a connected Pilot (the keyboard covers anyone). Full algorithm, table for n = 1..18 and tests: `docs/research/rules/final.md` 2a.

## 9. Spawn kills, ties and the kill-cam

Solution: respawn only at docks >= 80 m from every enemy (fallback: farthest), 3 s protection that ends on fire; ranking by kills then deaths, one 30 s sudden death between the tied teams only; kill-cam on the killer with its pose frozen at the hit so the camera never cuts to an empty dock. `docs/research/rules/final.md` 2c, 2d.

## 10. Three agents without merge conflicts

Solution: folder ownership (README), `shared/` read-only, every feature behind a keyboard or debug toggle, one task per agent chat with the prompt starter in `HANDOFF.md`, merges every 45 to 60 minutes with a "how to test" note.
