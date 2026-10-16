# TASKS-A: netcode and phones

Owns `server/`, `src/net/`, `src/phone/`, `src/landing/`. Read `HANDOFF.md`, `shared/protocol.ts`, `shared/config.ts` (PHONE, NET) first. Ready-made code: `docs/research/netcode/mirror/` (relay, client, tests) and `docs/research/sensors/final.md` (all sensor math and pads).

Each item: done when the observable result holds and `npm run check` passes. Add a two-line "how to test" to every merge.

## Base (with everyone)

- [ ] A1 `server/index.ts`: express 5 serves `dist/` with an SPA fallback for `/scene` and `/play`, `/api/health`; Socket.IO on the same port with the typed event maps from `shared/protocol.ts`. Done: `npm start` serves the built app; `curl /api/health` returns ok.
- [ ] A2 `server/rooms.ts`: `host` creates a room (4-letter code from `NET.roomCodeAlphabet`, unique) or reclaims one; `hello` validates version and room, maps token -> playerId, re-attaches on reconnect, tells the scene `player:join`; forwards `in` (volatile) and `msg` to the scene with `playerId`; `to` and `hud` fan out to phones; room kept `NET.roomGraceSec` after the scene drops; per-socket input rate limit; `sanitizeInput` / `sanitizePhoneMsg` on every packet. Done: `tests/relay.test.ts` (in-process server, two clients) passes.
- [ ] A3 `src/net/host.ts` (scene) and `src/net/client.ts` (phone): typed `socket.io-client` wrappers, auto-reconnect, token in localStorage (`crypto.randomUUID`), scene room code in sessionStorage. Done: reload the scene tab and the phones stay in the room.
- [ ] A4 `src/phone/main.ts`: read `?room=`, else the join screen (code field + `qr-scanner` fallback); lobby screen with nickname, team colour, role, Swap role, Move team, Ready, one big **Enable controls** button. Done: Gate 1 flow on a real iPhone through the tunnel.

## MVP (Gate 2)

- [ ] A5 `src/phone/sensors.ts`: permission flow (iOS `requestPermission` inside the tap, HTTPS check, 1.5 s watchdog with a clear error), platform sign normalisation, steering from gravity (dead zone 4 deg, full lock 35 deg, calibration), gyro yaw by projection onto gravity (dead zone 2 deg/s, gain 2, accumulated `dYaw`), shake peaks, orientation fallback, invert-aim toggle. Done: the vitest vectors from the sensors research pass; the desktop simulator drives the same code.
- [ ] A6 `src/phone/sender.ts`: 30 Hz loop with absolute scheduling, edge fields reset after each send, neutral packet + pause when the tab hides. Done: the relay sees 30 packets/s per phone, no bursts.
- [ ] A7 Pilot screen: wheel graphic rotating with the tilt, GAS right half, BRAKE left half, CALIBRATE during the countdown, team kills, landscape overlay.
- [ ] A8 Gunner screen: FIRE on the right two-thirds (tap and hold), RECENTER left, weapon and ammo, compass needle from `Hud.aimRel`, CALIBRATE; red flash on hit (iOS) or vibrate (Android).
- [ ] A9 Wake lock (re-request on `visibilitychange`), fullscreen + orientation lock on Android, "rotate your phone" overlay, 100dvh layout, no zoom / pull-to-refresh / callouts.
- [ ] A10 Landing page: PLAYER highlighted on phones (done), SCENE on desktop; the scene page shows the QR (`qrcode` in the browser, `joinUrl(location.origin, code)`), the code and the short URL.

## Should (Gate 3)

- [ ] A11 Engineer screen: two power buttons, water meter, SHAKE TO BAIL prompt; the Gunner gets the power buttons in teams of 2 (`Hud.hasPowers`).
- [ ] A12 Sunk and Results screens from `Hud` (`sunkBy`, `respawnIn`, `timeLeft`).
- [ ] A13 Reconnect into the same slot after the phone slept; `Hud.stale` warning on the scene when a phone goes quiet.
- [ ] A14 Haptics on fire and hit (Android), screen flash (iOS); phone background = team colour with the role in large type.
- [ ] A15 Backup host: deploy the relay to Render/Railway/Fly (long-lived Node, websockets) with `npm start`; document the URL switch.

## Day-one checks (risk list in SPEC.md section 14)

1. iPhone through the tunnel: Enable controls -> motion events flow -> a box boat turns on the TV.
2. Android phone: same, plus vibration.
3. Lock the phone, unlock: it is back in the same slot within 5 s.
