> **Status (2026-10-16):** final. Written by the netcode research agent just before the session limit and assembled with `splice.py` (the `@@FILE@@` markers are replaced by the files in `mirror/`). Not reviewed by a second agent.
> **In the repo now:** `server/`, `src/net/` and `tests/{relay,rooms}.test.ts` are this code, landed with three changes: (1) `shared/protocol.ts` keeps this transport design but carries the richer game payloads (`Hud`, `Evt`, `Lobby` with teams) and imports `Role`/`Phase` from `shared/state.ts`; `GunnerIn` also has `use`/`uc` for teams of 2; (2) `AimTracker.apply` takes a `gain` for the under-crosshair slowdown; (3) the relay ignores `PORT` in dev (uses `RELAY_PORT`, default 3000) because tools often export `PORT` for Vite. The `mirror/` copies below are the research versions; the repo files are the truth.

# Netcode: realtime relay, rooms, reconnect, hosting and HTTPS

Target files: `shared/protocol.ts`, `server/rooms.ts`, `server/relay.ts`, `server/index.ts`, `src/net/identity.ts`, `src/net/client.ts`, `src/net/sceneClient.ts`, `src/net/inputHold.ts`, `src/net/qr.ts`, `src/net/scanner.ts`, `tests/relay.test.ts`, `tests/rooms.test.ts`, plus two patches (`vite.config.ts`, `package.json`).

Everything in section 3 was typechecked with the repo's own `tsconfig.json` and `tsconfig.server.json` (strict, `noUncheckedIndexedAccess`, plus `--noUnusedLocals --noUnusedParameters`), the test suite ran green under vitest 5.0.5 on node 24.15 (16 tests), `server/index.ts` was smoke-run with tsx 4.23 (health, SPA fallback, cache headers), and an 18-phone load test ran through the real relay. Platform claims come from the installed typings/sources under `node_modules` or from the cited pages. Nothing was written inside the repo.

## 0. Evidence index (what was run, what it showed)

| Check | Result |
|---|---|
| Express 5.3.0 route syntax (`proof-express-wildcard.ts`) | `app.get('*')` throws `Missing parameter name at index 1: *`; `/{*splat}` and `/*splat` accepted. Express 5 depends on `router@2.2.0` -> `path-to-regexp@8.4.2`. |
| Socket.IO 4.8.4 relay proof (`proof-relay.ts`) | `io.to(room).emit`, `socket.join([a,b])`, `socket.data`, `emitWithAck`, per-player rooms, `maxHttpBufferSize` (oversize -> ws close code 1009, client `transport close`), `connectionStateRecovery` (`recovered: true` on both ends after `engine.close()`), server `disconnect(true)` -> client `io server disconnect`, `active: false`. |
| vitest 5 pattern (`vitest-proof/`) | server on port 0 + two `socket.io-client` sockets inside `beforeAll`: passes in 236 ms. |
| Vite 8.3.4 bundle of `qrcode` + `qr-scanner` + `socket.io-client` (`vite-proof/`) | builds; `qrcode` resolves to `lib/browser.js` (package `browser` field, Vite `DEFAULT_MAIN_FIELDS` starts with `browser`); qr-scanner's `import("./qr-scanner-worker.min.js")` becomes chunk `qr-scanner-worker.min-*.js` (43.95 kB). |
| Repo `vite.config.ts` as scaffolded | **fails `tsc`**: `TS2769 ... 'test' does not exist in type 'UserConfigExport'`. Fix: `defineConfig` from `vitest/config` (section 3.13). |
| Volatile semantics | read from `engine.io/build/transports/websocket.js` line 63 and `engine.io-client/build/esm/transports/websocket.js` lines 52-73: `writable=false` synchronously on every write, back to true asynchronously. A test with 3 emits in one tick lost 2 of them through a volatile forward; the reliable forward delivers 10/10 in order. |
| Load test (`mirror/loadtest.ts`, localhost) | 18 phones x 30 Hz for 5 s: 2646 sent, 2646 received, 0 % loss; relay hop p50 0.92 ms, p90 2.33 ms, p99 5.80 ms, max 16 ms. HUD fan-out 18 x 10 Hz: 882/882. |
| Payload sizes (JSON) | pilot `in` 78 B, gunner `in` 110 B, engineer `in` 70 B, `hud` 165 B, 18-player `lobby` 1995 B. |

## 1. The problem, in the words of the spec

- "Relay server: a small Node process. Routes messages between phones and the scene by room code. Never does game logic of any kind." (SPEC.md section 1)
- "Inputs flow right at 30 Hz, status flows back at 10 Hz. The relay never runs game logic." (section 11) "Phones send input 30 times per second, not on every sensor event." (section 3)
- "HTTPS everywhere. iOS only grants motion sensors and the camera on secure pages, and only after a user tap." "Zero friction. Scan, tap, play in under 30 seconds. No install, no account." (sections 0-1)
- "It creates a room with a 4-letter code (for example RIVA) and shows a large QR ... The QR encodes https://<host>/play?room=RIVA ... The PLAYER button on the landing page stays as a fallback. It opens an in-app QR scanner plus a field to type the 4-letter code." (section 2)
- "Reconnect: keep a token in localStorage; the same token rejoins the same team and role." "Phones sleeping or dropping: a locked screen kills the connection. Wake lock, plus auto-reconnect into the same slot using the token." (sections 11 and 14)
- "Hosting: relay on the scene PC, exposed with Cloudflare Tunnel (cloudflared tunnel --url http://localhost:3000) or ngrok http 3000. Backup host: Render, Railway or Fly.io. Serverless functions are a poor fit for a WebSocket relay." (section 11)
- "Latency: the tunnel adds a round trip. Expect about 50 to 100 ms, fine for this game. Send input at 30 Hz and interpolate." (section 14)
- "Venue WiFi: the tunnel goes over the internet, so guest-network isolation doesn't matter. Backup: phone hotspot for the scene PC, or the backup host." (section 14)
- Messages to keep: `Hello`, `Swap`, `PilotIn`, `GunnerIn` ("dYaw: radians since last packet"), `EngIn`, `Hud`, `Evt` (section 11). Gate 1: "one phone steers a box boat on the TV ... the riskiest unknown."

## 2. Decisions and why

### 2.1 Socket.IO 4.8.4, one namespace, three rooms per game room

- One default namespace `/`. Per game room `CODE`, three Socket.IO rooms: `CODE:scene` (the one scene socket), `CODE:players` (every phone), `CODE:p7` (one phone). `io.to('CODE:scene').emit('in', pid, msg)` is the fan-in; `io.to('CODE:p7').emit('hud', msg)` and `io.to('CODE:players').emit('lobby', msg)` are the fan-outs. `socket.to(...)` (which excludes the sender) is not needed because scene and phones are never in the same target room. Verified against `socket.io/dist/index.d.ts` (`to`, `in`, `except`, `volatile`, `fetchSockets`) and `socket.d.ts` (`join(rooms: Room | Room[])`, `leave`, `data`, `recovered`, `disconnect(close?)`).
- Typed events: `new Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>(httpServer, opts)`; client `io(...)` returns `Socket<ServerToClientEvents, ClientToServerEvents>` (`socket.io-client/build/esm/socket.d.ts`). `emitWithAck` is typed from the ack parameter of the event map; `socket.timeout(ms).emitWithAck(...)` rejects on timeout (`DecorateAcknowledgements`).
- Rejected: raw `ws`. Socket.IO gives rooms, acks, heartbeats, reconnection with backoff, and the HTTP long-polling fallback that turns out to matter on iOS LAN testing (2.11). Rejected: WebRTC data channels (no NAT/TURN work for a hackathon). Rejected: one namespace per room (`io.of(/^\/room-/)`): rooms are enough and keep one connection path through the Vite proxy.

### 2.2 Reliable vs volatile: the one rule that matters

`volatile` means "discard if the transport is not writable right now". That flag is **not** "connected or not": `engine.io/build/transports/websocket.js` sets `this.writable = false` at the top of `send(packets)` and only sets it back in the ws send callback; the browser transport does the same and restores it on `nextTick` (`engine.io-client/build/esm/transports/websocket.js` lines 52-73). `socket.io/dist/client.js` line 173 discards a volatile packet when `!this.conn.transport.writable`; `socket.io-client/build/esm/socket.js` line 263 does the same client-side. Consequence, measured: a loop that emits 18 HUDs, or a relay that forwards inputs from 18 phones arriving in the same tick, keeps the **first** packet and drops the rest if those emits are volatile.

Decision table:

| Leg | Emits per tick per socket | Mode | Why |
|---|---|---|---|
| phone -> relay `in` (30 Hz) | 1 | volatile on WebSocket, reliable on polling | one packet per 33 ms; while offline it is dropped, not queued (a queue would burst stale steering on reconnect). On polling the transport is unwritable for a whole round trip, so volatile would discard most packets; reliable lets polling batch them. |
| relay -> scene `in` | up to 18 | **reliable** | fan-in; the volatile window would eat same-tick packets (test "same-tick burst ... complete and in order"). The scene socket is a wired PC; a dead scene is not in the room, so nothing queues. |
| scene -> relay `hud`/`evt` | up to 18 | **reliable** | emitted in a loop in one tick. |
| relay -> phone `hud`/`evt` | 1 | volatile | one per phone per 100 ms; drops rather than queues on a sleeping phone. |
| `lobby`, `room`, `welcome`, `err`, `joined/left/reconnected`, `swap/ready/calibrate/rename/leave`, `gate`, `kick` | rare | reliable | must arrive; each is a snapshot or an edge the other side needs. |

HUD shape decision: **per-player `hud` packets** (165 B, 10 Hz, 1.6 KB/s per phone), not one room broadcast with all players' fields. A broadcast would be ~18 x 150 B = 2.7 KB x 10 Hz x 18 phones = 486 KB/s out of the relay versus 30 KB/s, for no gain: a phone needs only its own fields. `lobby` is the opposite case (everyone needs everyone) and is sent on change only.

### 2.3 `connectionStateRecovery`: off

What it does (verified in `socket.io-adapter/dist/in-memory-adapter.js`, `SessionAwareAdapter`): after an *unexpected* disconnect it keeps the socket's `id`, rooms and `data` plus every **reliable** event (volatile and ack'd events are skipped) for `maxDisconnectionDuration` (default 120 000 ms per the typings) and replays the missed ones when the *same client `Socket` object* reconnects with its `pid`/`offset`. Proof: after `socket.io.engine.close()` both sides reported `recovered: true` and the same `socket.id`. Limits: a page reload creates a new client Socket (no `pid`), so nothing is recovered; a manual `socket.disconnect()` is not stored (docs); the server must have sent at least one event; every reliable packet is appended with a trailing offset argument (seen as `'Q54Uz54'` in the proof); with our reliable `in` forward it would store ~540 packets/s for two minutes and replay stale inputs. The 30-second phone sleep is handled by the token re-join instead (2.4), which also survives reloads and relay restarts. Rejected: enabling it with a short window; the extra argument and replay semantics buy nothing we need.

### 2.4 Identity and reconnect

- Phone token: `crypto.randomUUID()` in `localStorage` (`gr.playerToken`). `randomUUID` exists only in secure contexts (MDN), and a plain-http LAN test page has none, so `getRandomValues` (works in insecure contexts, MDN) builds a v4 UUID as fallback. Storage access is try/catch'd (Safari private mode).
- Relay maps token -> (room, pid) in `RoomRegistry`. `hello` with a known token re-attaches the new socket to the same pid and tells the scene `reconnected`; the scene owns the roster (team, role, ready, calibrated) and simply flips `connected`. `hello` is sent on **every** `connect`, so it is idempotent and independent of Socket.IO internals.
- Second device with the same token (duplicated tab): newest socket wins, the old one gets `err replaced` and is detached (test "rejoins the same slot").
- Player disconnect vs leave: a transport close keeps the slot for `NET.playerGraceMs` (10 min, longer than a match) and the scene gets `left {reason:'disconnect'}` (it shows "phone dropped" and keeps the seat); `leave` frees the slot immediately (`left {reason:'leave'}`); `kick` from the scene does the same plus `err kicked` to the phone; a slot that stays disconnected past the grace is `left {reason:'expired'}`.
- Scene: `sessionStorage['gr.scene'] = {code, sceneToken}`. On reload it sends `host {code, sceneToken}`; the relay re-claims if the room is still alive and the token matches, answers `room {reclaimed:true, players:[...]}` and tells phones `room {sceneOnline:true}`. A wrong token or an expired room answers `no_room`, and the client clears the session and hosts a fresh room (new code, new QR). Grace: `NET.sceneGraceMs` = 90 s (long enough for a Vite full reload or a laptop lid flap, short enough that a crashed scene does not hold phones hostage). Meanwhile phones get `room {sceneOnline:false}` (show "Big screen reconnecting..."), inputs still flow but have no receiver. After the grace the relay sends `err room_closed` to every phone in the room, detaches them and deletes the room. A duplicated scene tab shares `sessionStorage`; a re-claim therefore replaces the previous scene socket (`err replaced`), so inputs never fan out to two scenes.
- The scene also needs its roster to survive its own reload: persist the pid -> seat map in `sessionStorage` from the lobby code (Track A phone/lobby work), and rebuild it from `room.players` on `reclaimed`.

### 2.5 Room codes

4 letters from `ABCDEFGHJKMNPRSTUVWXYZ` (no I, L, O, Q: they read as 1/l, I, 0, O on a projector), unique per server (the registry checks). Generated as consonant-vowel-consonant-vowel from `BCDFGHJKMNPRSTVWXYZ` x `AEU` (3249 combinations, pronounceable: "DAMU", "SETA"), with a small blocklist, falling back to any 4 letters from the alphabet after 64 collisions (234 256 codes). Note: the spec's example "RIVA" contains I and is therefore not a valid code here; "DAMA" is. Input is upper-cased and trimmed; `roomCodeFromText` also accepts a pasted `/play?room=DAMA` link.

### 2.6 Gate: full room, match running, late joiners

The relay must answer "room full" and "match running" without knowing the game, so the scene sends a tiny `gate {max, locked, late}` whenever it changes (team size change, start, end). Unknown token + `players.size >= max` -> `err room_full`. Unknown token while `locked` -> `welcome {queued:true}` and `joined {queued:true}` to the scene (which seats them as spectator until the next lobby) when `late:'queue'`, or `err match_running` when `late:'reject'`. Known tokens always re-join, locked or not. Default gate: `max: 18, locked: false, late: 'queue'`.

### 2.7 Rate and flow control

- Phones: `setInterval(1000/30)`, one packet per tick built by a sampler the phone UI supplies; `seq` is assigned by the net client. Browsers throttle timers in background tabs, which is fine: a backgrounded phone cannot play.
- Relay per socket: token bucket 45 inputs/s with burst 60 (a 30 Hz phone never trips it; a runaway loop does), 10 control messages/s (`hello/host/swap/ready/calibrate/rename`) with `err rate_limited` on excess. `maxHttpBufferSize: 8192` closes the connection on any single message above 8 KB (engine.io default is 1 MB); our largest message, an 18-player roster, is ~2 KB.
- Validation: `parseInput` checks `t`, `role`, finite numbers, clamps `steer` to [-1, 1], `dYaw` to [-pi, pi], `yaw` to +-64 pi, `shake` to [0, 1], coerces booleans with `=== true`, normalises `use` to `0 | 1 | null`, and drops anything else. Names: control characters stripped, 16 chars max.
- HUD: the scene calls `startHudLoop(collect)` at 10 Hz; one reliable `hud` per player per tick to the relay, volatile from the relay to each phone. Roster `lobby`: on change, reliable, full snapshot.
- Scene-side hold: `InputHold.offer` keeps the last packet per pid, drops `seq <= last` unless it jumped back by more than 1000 (phone reload), and `read()` reports `dropped: ageMs > 1500` so the HUD shows "phone dropped" and the sim keeps applying the last known gas/steer (a boat that coasts straight is better than one that stops dead).

### 2.8 `dYaw`: deltas versus absolute yaw

The spec defines `dYaw` as radians since the last packet. Deltas are exactly what volatile delivery breaks: every dropped packet is rotation lost forever, and 30 Hz over a tunnel with a sleeping tab will drop packets. Decision: keep the field name and meaning, but make the sim use two added fields:

- `yaw`: the phone's accumulated aim angle since its last calibrate/recenter (already gain-applied and dead-zoned). Absolute, so any packet alone is enough: `aimWorld = base + yaw`.
- `ep`: an epoch counter the phone increments on calibrate/recenter. When the scene sees `ep` change it re-bases: `base = bowHeading - yaw`, which puts the aim behind the bow at that instant (the spec's "reset behind the bow"). This is robust to a lost `recenter: true` packet; `recenter` is kept for the HUD flash only.
- `dYaw` stays for logging, drift tests and as a turn-rate hint for the aim-assist gain drop.
- Same idea for edges: `fc` counts fire taps (a 20 ms tap can fall between two 33 ms packets), `uc` counts power uses and the phone latches `use` for ~5 packets; `AimTracker.takeFireTap` / `takeUse` apply each tap exactly once.

Rejected: TCP-reliable deltas (no drops but a 2-minute replay burst after a sleep, and the relay would have to queue for dead phones); server-side integration (the relay would interpret game data).

### 2.9 Heartbeat

Server `pingInterval: 10000, pingTimeout: 10000` (engine.io defaults 25 000 / 20 000). The server pings; the client closes if no ping arrives within `pingInterval + pingTimeout` (Socket.IO docs). So a vanished phone is `left` on the scene within 20 s, and a phone wakes up and notices its dead link within 20 s at worst. The 10 s ping also keeps Cloudflare's WebSocket idle timeout (documented as "a period of time", widely reported as ~100 s) from closing quiet connections. The InputHold's 1.5 s rule covers the HUD; the heartbeat only drives relay bookkeeping. `PhoneClient` additionally forces a fresh transport on `visibilitychange -> visible` when no ping was seen for two intervals (iOS reports that `onclose` sometimes never fires after long background time).

### 2.10 Express 5, static, SPA fallback, tsx

- Express 5 uses `path-to-regexp` 8: `'*'` throws; the wildcard needs a name, and braces make it optional so it also matches `/`: `app.get('/{*splat}', ...)` (Express migration guide, proven). `/api/*` and `/socket.io/*` are answered 404 inside the fallback so a typo never returns `index.html` as JSON. Socket.IO attaches to the `http.Server` itself and intercepts `/socket.io` before Express.
- `express.static(dist/assets, { immutable: true, maxAge: '1y' })` for hashed assets, `express.static(dist, { index: false, maxAge: 0 })` for the rest, and `res.sendFile(index.html, { headers: { 'Cache-Control': 'no-store' } })` so phones always fetch the newest build (measured headers in section 0). Without `dist/` the server answers 503 with the dev-mode hint.
- `/api/health` returns `{ok, uptimeSec, rooms, players, sockets, dist}` (`io.engine.clientsCount`).
- `tsx watch server/index.ts` in dev (already in `package.json`), `NODE_ENV=production tsx server/index.ts` in prod. tsx reads the root `tsconfig.json` `paths`, so `@shared/protocol.ts` resolves at runtime (smoke-run proved it). For a backup host, move `tsx` to `dependencies` (section 3.14), because a production `npm install` skips devDependencies.
- CORS: not configured. In dev the phone talks to Vite on 5173, which proxies `/socket.io` with `ws: true` to 3000 (same origin); in prod Express serves the app and the socket on one port. `allowRequest` optionally restricts the `Origin` header (`ALLOWED_ORIGINS=https://x.trycloudflare.com`); leave it empty for the demo.

### 2.11 Hosting and HTTPS

**Cloudflare quick tunnel (primary).** `brew install cloudflared` (Cloudflare downloads page), then `cloudflared tunnel --url http://localhost:5173` (dev, `npm run tunnel`) or `--url http://localhost:3000` (prod, `npm run tunnel:prod`). Each run gets a new random `*.trycloudflare.com` hostname; no account. Documented limits: 200 in-flight requests (HTTP 429 above), no Server-Sent Events, no uptime guarantee. WebSockets: Cloudflare proxies WebSockets on all plans with no configuration; a third-party guide tested a WebSocket server through a quick tunnel and reports Socket.IO and Vite HMR work. Connect time: the URL prints within seconds, but the name resolves 3-33 s later (measured by the same guide), so start the tunnel before opening the scene. Keep the 10 s ping (2.9) for the idle timeout. Rejected as primary: named tunnels (need an account and a domain; fine if someone has one, they also remove the 200-request cap).

**ngrok free (fallback).** `ngrok http 5173`. Free plan shows an interstitial "You are about to visit..." page in front of HTML browser traffic; it is skipped only by sending the `ngrok-skip-browser-warning` request header (any value) or a custom User-Agent, which a QR scan into Safari cannot do. Consequence: every phone taps "Visit Site" once, then a 7-day cookie suppresses it for that domain; API/WebSocket requests are not affected, so the socket works after that tap. The free plan also gives one static dev domain (stable QR between runs), 1 GB/month, 20 000 HTTP requests/month, 4 000 req/min, 3 endpoints. Acceptable as a backup; the extra tap is why cloudflared is first.

**Vite dev through the tunnel.** `server.allowedHosts` must include the tunnel host (`.trycloudflare.com`, `.ngrok-free.app`) or Vite answers 403 "Blocked request"; `true` works but disables the DNS-rebinding check. HMR: the HMR client connects back to the page host; through a 443 tunnel set `server.ws = { protocol: 'wss', host: TUNNEL_HOST, clientPort: 443 }` (Vite 8 types: `server.hmr.{protocol,host,port,clientPort,path,timeout,server}` are `@deprecated Use server.ws.*`, still auto-synced; `WsOptions` has `protocol, host, port, clientPort, path, timeout, server`). Phones never need HMR; only the scene PC does, and it can simply use `http://localhost:5173`. The `/socket.io` proxy uses `ws: true` (`ProxyOptions.ws`). Alternative without config: `cloudflared tunnel --url http://localhost:5173 --http-host-header localhost:5173`.

**Production path.** `npm run build && npm start` then `npm run tunnel:prod`: one port, Express serves `dist/`, Socket.IO on the same server, no proxy, no HMR. This is the demo configuration.

**LAN HTTPS with `@vitejs/plugin-basic-ssl` (and why it half-works on iPhone).** The plugin creates a self-signed certificate (not a CA). WebKit decides "secure context" from scheme and host only (`SecurityOrigin.cpp`: `shouldTreatAsPotentiallyTrustworthy` checks the secure-scheme registry, `localhost`, loopback; it never inspects the certificate; the W3C Secure Contexts spec says `https`/`wss` -> potentially trustworthy, with no certificate-error clause). So after the user taps through "This Connection Is Not Private", the page *is* a secure context and `DeviceMotionEvent.requestPermission()` (secure context + transient activation, MDN) is available. What does **not** work: `wss://` to that same host. iOS Safari accepts the page certificate but refuses WebSocket connections to a self-signed server ("For some reason, the iOS browser accepted the cert for HTTPS, but not WSS", 2020; a widely-shared gist: "self-signed certs do NOT work for websocket connections ... Manually installing the certificate doesn't help"; Apple forum on iOS 26 beta: `wss://192.168.1.81/...` "The certificate for this server is invalid" after the page loaded). The mitigation is in the client: `transports: ['websocket', 'polling'], tryAllTransports: true`, because `engine.io-client` only moves to the next transport on error when `tryAllTransports` is set (`socket.js` `_onError`, lines 596-601); the polling fallback is plain HTTPS XHR, which honours the accepted certificate, and the input loop switches to reliable emits on polling (2.2). Expect polling on LAN to add one RTT (~5-20 ms) of jitter: fine for Gate 1, not what you demo with.

**mkcert (proper LAN HTTPS).** `brew install mkcert && mkcert -install && mkcert 192.168.1.23 localhost`, then `vite --https` with `server.https = { key, cert }` instead of basic-ssl. On the iPhone: AirDrop `$(mkcert -CAROOT)/rootCA.pem`, Settings > Profile Downloaded > Install, then Settings > General > About > Certificate Trust Settings > enable full trust (mkcert README). With a trusted CA, `wss://` works and WebSocket is used. One known problem: on some iOS 18 builds the installed CA does not appear in the trust settings. Budget 10 minutes per phone; only worth it if the venue has no internet.

**Backup hosts.** Render Free: web services spin down after 15 minutes with no inbound HTTP request *or WebSocket message on an existing connection* (changelog 2026-02-24), wake on the next request in about one minute, 750 free instance hours/month, may restart at any time; our 10 s pings count as WebSocket messages, so a live room never sleeps. Railway: Free Trial with a one-time $5 credit for 30 days, no credit card; Free plan with $1/month credit; Hobby $5/month; no spin-down. Fly.io: no free tier for new organisations (trial of 2 machine-hours or 7 days), cheapest always-on machine $2.19 per 30 days; machines can auto-stop when idle. Pick: **Render Free** as the no-card, documented option; wake it 10 minutes before the demo by opening `/api/health`. Recipe: push the repo to GitHub; Render > New > Web Service > connect the repo; Runtime Node; Build command `npm ci && npm run build`; Start command `npm start`; Health check path `/api/health`; no env vars needed (`PORT` is injected and `server/index.ts` reads it; `HOST` defaults to `0.0.0.0`); move `tsx` to `dependencies` first (3.14); deploy, open `https://<service>.onrender.com/scene`, and the QR encodes that origin automatically. For Railway it is the same build/start pair with `PORT` injected.

### 2.12 Latency, ordering, no prediction

- Budget through a tunnel: phone -> Cloudflare edge -> cloudflared on the PC. The spec expects 50-100 ms RTT; the relay itself adds ~1 ms (p50 0.92 ms, p99 5.8 ms measured). End to end: half a sample interval (16 ms) + one way (25-50 ms) + relay (1 ms) + up to one sim step (16 ms) + one frame (16 ms): roughly 75-100 ms glass-to-glass. Steering and gas are continuous and the boat has inertia, so this is below what players feel; gyro aim at gain 2 is where latency shows, which is why aim assist exists in the spec.
- Why 30 Hz plus hold is enough: the sim runs at 60 Hz and reads the held packet every step, so a 30 Hz stream is sampled twice; no interpolation of inputs is needed (positions are interpolated by the renderer, not inputs).
- No client prediction: phones never render the world; there is nothing to predict and nothing to reconcile. The only phone-side feedback (steering-wheel graphic, compass needle) is local and immediate.
- Ordering and staleness: `seq` per input packet, assigned by the client. Socket.IO guarantees ordering on one connection, but after a reconnect or on the polling fallback the scene can receive an old packet after a newer one from the previous connection; `InputHold` drops `seq <= last`. No clock sync: there are no timestamps on the wire; the relay stamps nothing; staleness is measured by arrival time on the scene.
- RTT on screen: the phone can show `await socket.timeout(2000).emitWithAck('hello', ...)` round-trip time in its debug footer; cheap and useful at the venue.

## 3. Code

Paths are repo-relative. Imports use `@shared/protocol.ts` (alias in `tsconfig.json`, `vite.config.ts`, and resolved by tsx through `tsconfig.json` `paths`; `allowImportingTsExtensions` is on). Every file below is the exact text that passed the checks in section 0.

### 3.1 `shared/protocol.ts`

```ts
/**
 * Gondola Royale wire protocol, version 1.
 *
 *   phone  --in/swap/ready/calibrate/rename/leave-->  relay  --(pid, msg)-->  scene
 *   scene  --hud/evt/lobby/gate/kick-->               relay  --msg-->         phone(s)
 *
 * Rules that every file in src/net and server/ follows:
 *   - The relay routes by room code and player id. It never reads game fields.
 *   - Every message object carries `t` (its type) so logs and tests can tell them apart.
 *   - Messages are small: short keys, no timestamps, no clock sync. Ordering of the
 *     30 Hz input stream comes from `seq`; everything else is a full snapshot that
 *     supersedes the previous one, so a lost packet never leaves a stale flag behind.
 *   - `v` is sent once per connection (socket.io `auth`) and inside `hello`/`host`.
 *
 * The parsers at the bottom are the only place that validates untrusted phone input.
 * They are pure (no imports) so the relay, the keyboard harness and tests share them.
 */

export const PROTOCOL_VERSION = 1 as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

export type Role = 'pilot' | 'gunner' | 'engineer';
export type Seat = Role | 'spectator';
export type Phase = 'lobby' | 'countdown' | 'battle' | 'results';

/** Tunables that both ends must agree on. Game tuning lives in shared/config.ts, not here. */
export const NET = {
  /** Phones send one input packet every 1000/30 ms, not one per sensor event. */
  inputHz: 30,
  /** The scene sends one HUD snapshot per player at this rate. */
  hudHz: 10,
  /** No input for this long means the phone dropped: the HUD shows it, the sim holds the last packet. */
  inputStaleMs: 1500,
  /** A `seq` that jumps backwards by more than this is a phone restart, not a late packet. */
  seqResetGap: 1000,
  /** Hard cap on players per room (6 teams x 3). The scene may lower it with a `gate`. */
  maxPlayers: 18,
  /** Longest name the relay accepts. Longer names are cut, not rejected. */
  nameMax: 16,
  /** A player slot (token -> pid) survives a disconnect for this long. */
  playerGraceMs: 10 * 60_000,
  /** A room survives its scene socket leaving for this long (reload, HMR, laptop sleep). */
  sceneGraceMs: 90_000,
  /** Relay-side rate limits per socket. Inputs: sustained/s and burst. Others: per second. */
  inputRatePerSec: 45,
  inputBurst: 60,
  controlRatePerSec: 10,
  /** Largest single socket.io message the relay accepts (bytes). Inputs are ~90 B, a full roster ~1.5 KB. */
  maxMessageBytes: 8192,
  /** Server ping settings. Phones detect a dead link within pingInterval + pingTimeout. */
  pingIntervalMs: 10_000,
  pingTimeoutMs: 10_000,
} as const;

// ---------------------------------------------------------------------------
// Room codes
// ---------------------------------------------------------------------------

/** 22 letters: no I, L, O, Q (they read as 1, I, 0, O on a projector). */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPRSTUVWXYZ';
export const ROOM_CODE_LENGTH = 4;
const ROOM_CODE_RE = /^[ABCDEFGHJKMNPRSTUVWXYZ]{4}$/;

/** Upper-cases and trims user input; returns null unless it is a valid code. */
export function normalizeRoomCode(raw: string): string | null {
  const code = raw.trim().toUpperCase();
  return ROOM_CODE_RE.test(code) ? code : null;
}

/** Extracts a room code from a scanned QR / pasted link (`/play?room=RIVA`) or a bare code. */
export function roomCodeFromText(text: string): string | null {
  const direct = normalizeRoomCode(text);
  if (direct) return direct;
  try {
    const url = new URL(text.trim(), 'https://x.invalid');
    const q = url.searchParams.get('room');
    return q ? normalizeRoomCode(q) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// phone -> relay -> scene  (inputs, 30 Hz, volatile)
// ---------------------------------------------------------------------------

/**
 * Shared header of every input packet.
 * `seq` is assigned by src/net/client.ts, monotonic per connection; the scene drops
 * packets whose seq is not greater than the last one it applied (see src/net/inputHold.ts).
 */
export interface InputBase {
  t: 'in';
  seq: number;
}

/** Pilot: `steer` is -1..1 after dead zone and full-lock mapping; gas/brake are held states. */
export interface PilotIn extends InputBase {
  role: 'pilot';
  steer: number;
  gas: boolean;
  brake: boolean;
}

/**
 * Gunner. Aim is sent twice so a dropped packet never loses rotation:
 *   dYaw  radians turned since the previous packet the phone built (the spec's field; kept for
 *         logging, drift tests and as a velocity hint for the aim-assist gain)
 *   yaw   radians accumulated since the last calibrate/recenter (absolute, what the sim uses)
 *   ep    "epoch": incremented by the phone on every calibrate or recenter. The scene re-bases
 *         its world aim when ep changes, so a lost `recenter: true` packet still recenters.
 *   fire  held state; fc counts fire taps so a tap shorter than one packet is never lost.
 */
export interface GunnerIn extends InputBase {
  role: 'gunner';
  dYaw: number;
  yaw: number;
  ep: number;
  fire: boolean;
  fc: number;
  recenter: boolean;
}

/**
 * Engineer. `use` is the slot tapped (latched for ~5 packets by the phone), `uc` counts taps so the
 * scene applies each tap exactly once (apply when uc changes and use !== null). `shake` is 0..1.
 */
export interface EngIn extends InputBase {
  role: 'engineer';
  use: 0 | 1 | null;
  uc: number;
  shake: number;
}

export type InputMsg = PilotIn | GunnerIn | EngIn;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** What the phone UI produces each tick; the net client adds `seq`. */
export type InputSample = DistributiveOmit<InputMsg, 'seq'>;

// ---------------------------------------------------------------------------
// phone -> relay  (control messages, reliable)
// ---------------------------------------------------------------------------

export interface Hello {
  t: 'hello';
  v: ProtocolVersion;
  room: string;
  token: string;
  name: string;
}
export interface Swap {
  t: 'swap';
  team?: number;
  role?: Role;
}
export interface Ready {
  t: 'ready';
  ready: boolean;
}
/** The phone finished calibration (Pilot: level angle; Gunner: pointed at the screen). */
export interface Calibrate {
  t: 'calibrate';
}
export interface Rename {
  t: 'rename';
  name: string;
}
export interface Leave {
  t: 'leave';
}

// ---------------------------------------------------------------------------
// scene -> relay -> phone(s)
// ---------------------------------------------------------------------------

export interface Hud {
  t: 'hud';
  phase: Phase;
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

export type EvtKind = 'kill' | 'sunk' | 'respawn' | 'shielded' | 'fired' | 'pickup' | 'win';
export interface Evt {
  t: 'evt';
  kind: EvtKind;
}

export interface LobbyMember {
  pid: string;
  name: string;
  team: number;
  seat: Seat;
  ready: boolean;
  calibrated: boolean;
  connected: boolean;
}
/** Full roster snapshot. Sent to every phone on every change; each phone finds itself by pid. */
export interface Lobby {
  t: 'lobby';
  phase: Phase;
  teamSize: 2 | 3;
  teams: number;
  members: LobbyMember[];
}

// ---------------------------------------------------------------------------
// relay <-> scene and relay <-> phone bookkeeping
// ---------------------------------------------------------------------------

/** Scene asks for a room. With `code` + `sceneToken` it re-claims the room after a reload. */
export interface HostMsg {
  t: 'host';
  v: ProtocolVersion;
  code?: string;
  sceneToken?: string;
}
export interface RelayPlayer {
  pid: string;
  name: string;
  connected: boolean;
  queued: boolean;
}
export interface RoomCreated {
  t: 'room';
  code: string;
  sceneToken: string;
  reclaimed: boolean;
  players: RelayPlayer[];
}
/** Scene tells the relay who may join. The relay enforces it without knowing why. */
export interface Gate {
  t: 'gate';
  /** Players the room accepts (<= NET.maxPlayers). */
  max: number;
  /** True while a match runs. New tokens are then queued (late: 'queue') or refused. */
  locked: boolean;
  late: 'queue' | 'reject';
}

export interface Welcome {
  t: 'welcome';
  v: ProtocolVersion;
  code: string;
  pid: string;
  token: string;
  /** The token was already in this room: same pid, same seat. */
  rejoined: boolean;
  /** Joined while locked: the scene seats this player at the next lobby. */
  queued: boolean;
  sceneOnline: boolean;
}

export type ErrCode =
  | 'bad_version'
  | 'bad_hello'
  | 'no_room'
  | 'room_full'
  | 'match_running'
  | 'room_closed'
  | 'kicked'
  | 'replaced'
  | 'rate_limited'
  | 'not_in_room';
export interface Err {
  t: 'err';
  code: ErrCode;
  msg?: string;
}

/** To phones: the big screen's socket went away (grace period) or came back. */
export interface RoomStatus {
  t: 'room';
  sceneOnline: boolean;
}

/** To the scene. */
export interface PlayerJoined {
  t: 'joined';
  pid: string;
  name: string;
  queued: boolean;
}
export interface PlayerLeft {
  t: 'left';
  pid: string;
  reason: 'disconnect' | 'leave' | 'kick' | 'expired';
}
export interface PlayerReconnected {
  t: 'reconnected';
  pid: string;
  name: string;
}

export type PhoneToRelay = Hello | Swap | Ready | Calibrate | Rename | Leave | InputMsg;
export type RelayToPhone = Welcome | Err | RoomStatus | Hud | Evt | Lobby;
export type SceneToRelay = HostMsg | Gate | Hud | Evt | Lobby;
export type RelayToScene = RoomCreated | Err | PlayerJoined | PlayerLeft | PlayerReconnected;

// ---------------------------------------------------------------------------
// Socket.IO typed event maps (socket.io 4.8: Server<C2S, S2C, InterServer, SocketData>)
// ---------------------------------------------------------------------------

export interface ClientToServerEvents {
  // scene
  host: (msg: HostMsg, ack: (res: RoomCreated | Err) => void) => void;
  gate: (msg: Gate) => void;
  kick: (pid: string) => void;
  hud: (pid: string, msg: Hud) => void;
  evt: (pid: string | null, msg: Evt) => void;
  lobby: (msg: Lobby) => void;
  // phone
  hello: (msg: Hello, ack: (res: Welcome | Err) => void) => void;
  in: (msg: InputMsg) => void;
  swap: (msg: Swap) => void;
  ready: (msg: Ready) => void;
  calibrate: (msg: Calibrate) => void;
  rename: (msg: Rename) => void;
  leave: (msg: Leave) => void;
}

export interface ServerToClientEvents {
  // to the scene, tagged with the player id
  joined: (msg: PlayerJoined) => void;
  left: (msg: PlayerLeft) => void;
  reconnected: (msg: PlayerReconnected) => void;
  in: (pid: string, msg: InputMsg) => void;
  swap: (pid: string, msg: Swap) => void;
  ready: (pid: string, msg: Ready) => void;
  calibrate: (pid: string, msg: Calibrate) => void;
  rename: (pid: string, msg: Rename) => void;
  // to phones
  hud: (msg: Hud) => void;
  evt: (msg: Evt) => void;
  lobby: (msg: Lobby) => void;
  room: (msg: RoomStatus) => void;
  // to either
  err: (msg: Err) => void;
}

/** Single-process relay: no inter-server events. */
export type InterServerEvents = Record<string, never>;

export interface SocketData {
  kind: 'scene' | 'player' | null;
  code: string | null;
  pid: string | null;
  token: string | null;
}

// ---------------------------------------------------------------------------
// Validation of untrusted phone messages (pure; used by server/relay.ts and tests)
// ---------------------------------------------------------------------------

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}
function num(x: unknown): number | null {
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}
function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
function uint(x: unknown): number | null {
  const n = num(x);
  return n !== null && n >= 0 && n <= Number.MAX_SAFE_INTEGER ? Math.floor(n) : null;
}
function bool(x: unknown): boolean {
  return x === true;
}

/** Trims, strips control characters, caps length. Returns null for an empty name. */
export function sanitizeName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const clean = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, NET.nameMax);
  return clean.length > 0 ? clean : null;
}

/** Validates and clamps one input packet. Returns null for anything the sim must not see. */
export function parseInput(x: unknown): InputMsg | null {
  if (!isRecord(x) || x['t'] !== 'in') return null;
  const seq = uint(x['seq']);
  if (seq === null) return null;
  switch (x['role']) {
    case 'pilot': {
      const steer = num(x['steer']);
      if (steer === null) return null;
      return { t: 'in', seq, role: 'pilot', steer: clamp(steer, -1, 1), gas: bool(x['gas']), brake: bool(x['brake']) };
    }
    case 'gunner': {
      const dYaw = num(x['dYaw']);
      const yaw = num(x['yaw']);
      const ep = uint(x['ep']);
      const fc = uint(x['fc']);
      if (dYaw === null || yaw === null || ep === null || fc === null) return null;
      return {
        t: 'in',
        seq,
        role: 'gunner',
        dYaw: clamp(dYaw, -Math.PI, Math.PI),
        yaw: clamp(yaw, -64 * Math.PI, 64 * Math.PI),
        ep,
        fire: bool(x['fire']),
        fc,
        recenter: bool(x['recenter']),
      };
    }
    case 'engineer': {
      const shake = num(x['shake']);
      const uc = uint(x['uc']);
      if (shake === null || uc === null) return null;
      const u = x['use'];
      const use: 0 | 1 | null = u === 0 ? 0 : u === 1 ? 1 : null;
      return { t: 'in', seq, role: 'engineer', use, uc, shake: clamp(shake, 0, 1) };
    }
    default:
      return null;
  }
}

export function parseHello(x: unknown): Hello | null {
  if (!isRecord(x) || x['t'] !== 'hello' || x['v'] !== PROTOCOL_VERSION) return null;
  const room = typeof x['room'] === 'string' ? normalizeRoomCode(x['room']) : null;
  const token = x['token'];
  const name = sanitizeName(x['name']);
  if (!room || typeof token !== 'string' || token.length < 8 || token.length > 64 || !name) return null;
  return { t: 'hello', v: PROTOCOL_VERSION, room, token, name };
}

export function parseHost(x: unknown): HostMsg | null {
  if (!isRecord(x) || x['t'] !== 'host' || x['v'] !== PROTOCOL_VERSION) return null;
  const msg: HostMsg = { t: 'host', v: PROTOCOL_VERSION };
  if (typeof x['code'] === 'string' && typeof x['sceneToken'] === 'string') {
    const code = normalizeRoomCode(x['code']);
    if (code && x['sceneToken'].length >= 8 && x['sceneToken'].length <= 64) {
      msg.code = code;
      msg.sceneToken = x['sceneToken'];
    }
  }
  return msg;
}

export function parseSwap(x: unknown): Swap | null {
  if (!isRecord(x) || x['t'] !== 'swap') return null;
  const out: Swap = { t: 'swap' };
  const team = x['team'];
  if (team !== undefined) {
    const n = uint(team);
    if (n === null || n > 5) return null;
    out.team = n;
  }
  const role = x['role'];
  if (role !== undefined) {
    if (role !== 'pilot' && role !== 'gunner' && role !== 'engineer') return null;
    out.role = role;
  }
  return out;
}

export function parseReady(x: unknown): Ready | null {
  if (!isRecord(x) || x['t'] !== 'ready') return null;
  return { t: 'ready', ready: bool(x['ready']) };
}

export function parseCalibrate(x: unknown): Calibrate | null {
  return isRecord(x) && x['t'] === 'calibrate' ? { t: 'calibrate' } : null;
}

export function parseRename(x: unknown): Rename | null {
  if (!isRecord(x) || x['t'] !== 'rename') return null;
  const name = sanitizeName(x['name']);
  return name ? { t: 'rename', name } : null;
}

export function parseGate(x: unknown): Gate | null {
  if (!isRecord(x) || x['t'] !== 'gate') return null;
  const max = uint(x['max']);
  const late = x['late'];
  if (max === null || (late !== 'queue' && late !== 'reject')) return null;
  return { t: 'gate', max: clamp(max, 1, NET.maxPlayers), locked: bool(x['locked']), late };
}

/** The scene is our own PC, so scene payloads get a shape check only (the relay never reads game fields). */
export function hasTag<T extends string>(x: unknown, t: T): x is { t: T } & Record<string, unknown> {
  return isRecord(x) && x['t'] === t;
}
```

### 3.2 `server/rooms.ts`

```ts
/**
 * In-memory room registry. Pure data, no socket.io: everything here is unit-testable
 * with fake clocks and fake randomness (see tests/rooms.test.ts).
 *
 * What the relay owns:  room code -> scene socket, token -> (room, pid), connection state, gate.
 * What the scene owns:  teams, roles, ready/calibrated flags, who plays and who spectates.
 */
import { NET, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, type ErrCode, type Gate, type RelayPlayer } from '@shared/protocol.ts';

export interface PlayerRec {
  pid: string;
  token: string;
  name: string;
  /** Live socket id, or null while the phone is disconnected. */
  socketId: string | null;
  queued: boolean;
  joinedAt: number;
  /** Last time the socket was attached; the slot expires NET.playerGraceMs after a disconnect. */
  disconnectedAt: number | null;
}

export interface RoomRec {
  code: string;
  sceneToken: string;
  sceneSocketId: string | null;
  sceneLeftAt: number | null;
  createdAt: number;
  gate: Gate;
  /** token -> player */
  players: Map<string, PlayerRec>;
  nextPid: number;
}

export type JoinResult =
  | { ok: true; room: RoomRec; player: PlayerRec; rejoined: boolean; replacedSocketId: string | null }
  | { ok: false; code: ErrCode };

export interface SweepResult {
  closedRooms: RoomRec[];
  expiredPlayers: Array<{ room: RoomRec; player: PlayerRec }>;
}

/** Consonant-vowel-consonant-vowel codes read aloud easily ("RIVA", "DAMU"). */
const CONSONANTS = 'BCDFGHJKMNPRSTVWXYZ';
const VOWELS = 'AEU';
/** Words we would rather not print on a projector in Italy. Regenerated if hit. */
const BLOCKED = new Set(['CACA', 'KAKA', 'PUTA', 'PENE', 'SEGA', 'CULA', 'CULE', 'CULU', 'NAZE', 'NAZA', 'FUKA']);

export interface RegistryOptions {
  rng?: () => number;
  now?: () => number;
  sceneGraceMs?: number;
  playerGraceMs?: number;
  maxPlayers?: number;
}

export class RoomRegistry {
  private readonly rooms = new Map<string, RoomRec>();
  /** player token -> room code */
  private readonly tokens = new Map<string, string>();
  private readonly rng: () => number;
  private readonly now: () => number;
  private readonly sceneGraceMs: number;
  private readonly playerGraceMs: number;
  private readonly maxPlayers: number;

  constructor(opts: RegistryOptions = {}) {
    this.rng = opts.rng ?? Math.random;
    this.now = opts.now ?? Date.now;
    this.sceneGraceMs = opts.sceneGraceMs ?? NET.sceneGraceMs;
    this.playerGraceMs = opts.playerGraceMs ?? NET.playerGraceMs;
    this.maxPlayers = opts.maxPlayers ?? NET.maxPlayers;
  }

  get size(): number {
    return this.rooms.size;
  }

  get playerCount(): number {
    let n = 0;
    for (const r of this.rooms.values()) n += r.players.size;
    return n;
  }

  get(code: string): RoomRec | undefined {
    return this.rooms.get(code);
  }

  roomOfToken(token: string): RoomRec | undefined {
    const code = this.tokens.get(token);
    return code ? this.rooms.get(code) : undefined;
  }

  /** A new room with a unique code. The sceneToken lets the same scene re-claim it after a reload. */
  create(sceneSocketId: string, sceneToken: string): RoomRec {
    const code = this.generateCode();
    const room: RoomRec = {
      code,
      sceneToken,
      sceneSocketId,
      sceneLeftAt: null,
      createdAt: this.now(),
      gate: { t: 'gate', max: this.maxPlayers, locked: false, late: 'queue' },
      players: new Map(),
      nextPid: 1,
    };
    this.rooms.set(code, room);
    return room;
  }

  /** Re-attaches a scene socket to its room. Null when the room is gone or the token is wrong. */
  reclaim(code: string, sceneToken: string, sceneSocketId: string): RoomRec | null {
    const room = this.rooms.get(code);
    if (!room || room.sceneToken !== sceneToken) return null;
    room.sceneSocketId = sceneSocketId;
    room.sceneLeftAt = null;
    return room;
  }

  /** The scene socket went away. The room stays for sceneGraceMs. Returns the room or null. */
  sceneLeft(code: string, sceneSocketId: string): RoomRec | null {
    const room = this.rooms.get(code);
    if (!room || room.sceneSocketId !== sceneSocketId) return null;
    room.sceneSocketId = null;
    room.sceneLeftAt = this.now();
    return room;
  }

  setGate(code: string, gate: Gate): void {
    const room = this.rooms.get(code);
    if (room) room.gate = { ...gate, max: Math.min(gate.max, this.maxPlayers) };
  }

  /**
   * A phone says hello. The same token always lands in the same slot (same pid), whatever
   * happened to its socket in between; a token moving to another room leaves the old one.
   */
  join(code: string, token: string, name: string, socketId: string): JoinResult {
    const room = this.rooms.get(code);
    if (!room) return { ok: false, code: 'no_room' };

    const previousRoom = this.roomOfToken(token);
    if (previousRoom && previousRoom !== room) this.removePlayer(previousRoom, token);

    const existing = room.players.get(token);
    if (existing) {
      const replacedSocketId = existing.socketId !== null && existing.socketId !== socketId ? existing.socketId : null;
      existing.socketId = socketId;
      existing.disconnectedAt = null;
      existing.name = name;
      return { ok: true, room, player: existing, rejoined: true, replacedSocketId };
    }

    if (room.players.size >= room.gate.max) return { ok: false, code: 'room_full' };
    if (room.gate.locked && room.gate.late === 'reject') return { ok: false, code: 'match_running' };

    const player: PlayerRec = {
      pid: `p${room.nextPid++}`,
      token,
      name,
      socketId,
      queued: room.gate.locked,
      joinedAt: this.now(),
      disconnectedAt: null,
    };
    room.players.set(token, player);
    this.tokens.set(token, code);
    return { ok: true, room, player, rejoined: false, replacedSocketId: null };
  }

  /** A player socket closed. Only the live socket detaches the slot (an old replaced socket does not). */
  playerSocketLeft(token: string, socketId: string): { room: RoomRec; player: PlayerRec } | null {
    const room = this.roomOfToken(token);
    const player = room?.players.get(token);
    if (!room || !player || player.socketId !== socketId) return null;
    player.socketId = null;
    player.disconnectedAt = this.now();
    return { room, player };
  }

  /** Explicit leave or kick: the slot is freed at once. */
  removeByToken(token: string): { room: RoomRec; player: PlayerRec } | null {
    const room = this.roomOfToken(token);
    const player = room?.players.get(token);
    if (!room || !player) return null;
    this.removePlayer(room, token);
    return { room, player };
  }

  removeByPid(code: string, pid: string): PlayerRec | null {
    const room = this.rooms.get(code);
    if (!room) return null;
    for (const p of room.players.values()) {
      if (p.pid === pid) {
        this.removePlayer(room, p.token);
        return p;
      }
    }
    return null;
  }

  /** Called every few seconds by the relay: closes rooms whose scene stayed away, expires dead slots. */
  sweep(): SweepResult {
    const now = this.now();
    const out: SweepResult = { closedRooms: [], expiredPlayers: [] };
    for (const room of this.rooms.values()) {
      if (room.sceneLeftAt !== null && now - room.sceneLeftAt >= this.sceneGraceMs) {
        out.closedRooms.push(room);
        continue;
      }
      for (const player of room.players.values()) {
        if (player.disconnectedAt !== null && now - player.disconnectedAt >= this.playerGraceMs) {
          out.expiredPlayers.push({ room, player });
        }
      }
    }
    for (const { room, player } of out.expiredPlayers) this.removePlayer(room, player.token);
    for (const room of out.closedRooms) this.close(room.code);
    return out;
  }

  close(code: string): RoomRec | null {
    const room = this.rooms.get(code);
    if (!room) return null;
    for (const token of room.players.keys()) this.tokens.delete(token);
    this.rooms.delete(code);
    return room;
  }

  snapshot(room: RoomRec): RelayPlayer[] {
    return [...room.players.values()].map((p) => ({ pid: p.pid, name: p.name, connected: p.socketId !== null, queued: p.queued }));
  }

  /** Unique per server. Tries pronounceable CVCV codes first, then anything from the alphabet. */
  generateCode(): string {
    for (let attempt = 0; attempt < 64; attempt++) {
      const code = this.pick(CONSONANTS) + this.pick(VOWELS) + this.pick(CONSONANTS) + this.pick(VOWELS);
      if (!BLOCKED.has(code) && !this.rooms.has(code)) return code;
    }
    for (;;) {
      let code = '';
      for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += this.pick(ROOM_CODE_ALPHABET);
      if (!BLOCKED.has(code) && !this.rooms.has(code)) return code;
    }
  }

  private pick(alphabet: string): string {
    const i = Math.min(alphabet.length - 1, Math.floor(this.rng() * alphabet.length));
    return alphabet.charAt(i);
  }

  private removePlayer(room: RoomRec, token: string): void {
    room.players.delete(token);
    if (this.tokens.get(token) === room.code) this.tokens.delete(token);
  }
}
```

### 3.3 `server/relay.ts`

```ts
/**
 * The Socket.IO relay: one namespace ("/"), rooms keyed by the 4-letter code.
 *
 *   `${code}:scene`     the scene socket (at most one)
 *   `${code}:players`   every phone in the room
 *   `${code}:${pid}`    one phone
 *
 * Volatile rule (verified in engine.io's transports): a transport is "not writable" from the moment
 * a frame is handed to it until the send callback / next tick, and a volatile packet emitted in that
 * window is silently discarded. So `volatile` is only safe where a socket emits at most one packet
 * per tick: the phone's own 30 Hz stream, and the relay's per-phone HUD/evt delivery. Fan-in to
 * the scene (18 phones -> one socket) and anything emitted in a loop must be reliable.
 * lobby/room/err/welcome are reliable. The relay validates shape and size and never reads game
 * fields. Attach it to any http.Server; server/index.ts and tests/relay.test.ts both do.
 */
import type { Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server, type Socket } from 'socket.io';
import {
  NET,
  PROTOCOL_VERSION,
  hasTag,
  parseCalibrate,
  parseGate,
  parseHello,
  parseHost,
  parseInput,
  parseReady,
  parseRename,
  parseSwap,
  type ClientToServerEvents,
  type Err,
  type ErrCode,
  type Hud,
  type Evt,
  type InterServerEvents,
  type Lobby,
  type ServerToClientEvents,
  type SocketData,
} from '@shared/protocol.ts';
import { RoomRegistry, type RoomRec } from './rooms.ts';

export type RelayServer = Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;
export type RelaySocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

export interface RelayOptions {
  registry?: RoomRegistry;
  /** Browser origins allowed to open a socket. Empty/undefined = any (the tunnel URL is random anyway). */
  allowedOrigins?: string[];
  log?: (line: string) => void;
  sweepIntervalMs?: number;
}

export interface Relay {
  io: RelayServer;
  registry: RoomRegistry;
  close(): Promise<void>;
}

const sceneRoom = (code: string): string => `${code}:scene`;
const playersRoom = (code: string): string => `${code}:players`;
const playerRoom = (code: string, pid: string): string => `${code}:${pid}`;

/** Token bucket: `rate` tokens per second, up to `burst` stored. */
class Bucket {
  private tokens: number;
  private last: number;
  constructor(
    private readonly rate: number,
    private readonly burst: number,
    now: number,
  ) {
    this.tokens = burst;
    this.last = now;
  }
  take(now: number): boolean {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

function err(code: ErrCode, msg?: string): Err {
  return msg === undefined ? { t: 'err', code } : { t: 'err', code, msg };
}

export function createRelay(httpServer: HttpServer, opts: RelayOptions = {}): Relay {
  const registry = opts.registry ?? new RoomRegistry();
  const log = opts.log ?? ((line: string): void => console.log(`[relay] ${line}`));
  const allowed = new Set(opts.allowedOrigins ?? []);

  const io: RelayServer = new Server(httpServer, {
    path: '/socket.io',
    serveClient: false,
    // WebSocket first; phones on a self-signed LAN cert fall back to HTTPS polling (see docs).
    transports: ['websocket', 'polling'],
    pingInterval: NET.pingIntervalMs,
    pingTimeout: NET.pingTimeoutMs,
    maxHttpBufferSize: NET.maxMessageBytes,
    // connectionStateRecovery stays OFF: it would keep every reliable packet (540 inputs/s) for two
    // minutes and replay stale inputs/HUDs on recovery. The token re-join in `hello` covers reconnects.
    allowRequest: (req, fn) => {
      const origin = req.headers.origin;
      if (allowed.size > 0 && origin !== undefined && !allowed.has(origin)) {
        fn('origin not allowed', false);
        return;
      }
      fn(null, true);
    },
  });

  // Protocol version gate. A mismatch surfaces on the client as connect_error with data.code.
  io.use((socket, next) => {
    const v: unknown = socket.handshake.auth['v'];
    if (v !== PROTOCOL_VERSION) {
      const e = new Error('bad_version') as Error & { data?: unknown };
      e.data = { code: 'bad_version', want: PROTOCOL_VERSION };
      next(e);
      return;
    }
    next();
  });

  const emptyData = (): SocketData => ({ kind: null, code: null, pid: null, token: null });

  function bySocketId(id: string): RelaySocket | undefined {
    return io.sockets.sockets.get(id);
  }

  function announceSceneStatus(room: RoomRec, sceneOnline: boolean): void {
    io.to(playersRoom(room.code)).emit('room', { t: 'room', sceneOnline });
  }

  function closeRoom(room: RoomRec, reason: ErrCode): void {
    for (const s of io.sockets.sockets.values()) {
      if (s.data.code !== room.code) continue;
      s.emit('err', err(reason));
      for (const r of s.rooms) if (r !== s.id) void s.leave(r);
      s.data = emptyData();
    }
    registry.close(room.code);
    log(`room ${room.code} closed (${reason})`);
  }

  function detachPlayerSocket(s: RelaySocket): void {
    const { code, pid } = s.data;
    if (code) {
      void s.leave(playersRoom(code));
      if (pid) void s.leave(playerRoom(code, pid));
    }
    s.data = emptyData();
  }

  io.on('connection', (socket) => {
    socket.data = emptyData();
    const inputBucket = new Bucket(NET.inputRatePerSec, NET.inputBurst, Date.now());
    const controlBucket = new Bucket(NET.controlRatePerSec, NET.controlRatePerSec * 2, Date.now());
    let droppedInputs = 0;

    const control = (): boolean => {
      if (controlBucket.take(Date.now())) return true;
      socket.emit('err', err('rate_limited'));
      return false;
    };

    // ---------------- scene ----------------

    socket.on('host', (raw, ack) => {
      if (typeof ack !== 'function' || !control()) return;
      const msg = parseHost(raw);
      if (!msg) {
        ack(err('bad_hello'));
        return;
      }
      let room: RoomRec | null = null;
      let reclaimed = false;
      if (msg.code && msg.sceneToken) {
        const previousSceneId = registry.get(msg.code)?.sceneSocketId ?? null;
        room = registry.reclaim(msg.code, msg.sceneToken, socket.id);
        reclaimed = room !== null;
        if (!room) {
          // Lost the race with the grace period, or a different server: tell the scene so it starts fresh.
          ack(err('no_room'));
          return;
        }
        if (previousSceneId !== null && previousSceneId !== socket.id) {
          // A duplicated scene tab shares sessionStorage: the newest scene wins, the old one is told.
          const old = bySocketId(previousSceneId);
          if (old) {
            old.emit('err', err('replaced'));
            void old.leave(sceneRoom(room.code));
            old.data = emptyData();
          }
        }
      }
      if (!room) room = registry.create(socket.id, randomUUID());
      socket.data = { kind: 'scene', code: room.code, pid: null, token: room.sceneToken };
      void socket.join(sceneRoom(room.code));
      ack({ t: 'room', code: room.code, sceneToken: room.sceneToken, reclaimed, players: registry.snapshot(room) });
      if (reclaimed) announceSceneStatus(room, true);
      log(`scene ${socket.id} ${reclaimed ? 'reclaimed' : 'created'} room ${room.code}`);
    });

    socket.on('gate', (raw) => {
      const { kind, code } = socket.data;
      if (kind !== 'scene' || !code) return;
      const gate = parseGate(raw);
      if (gate) registry.setGate(code, gate);
    });

    socket.on('kick', (pid) => {
      const { kind, code } = socket.data;
      if (kind !== 'scene' || !code || typeof pid !== 'string') return;
      const player = registry.removeByPid(code, pid);
      if (!player) return;
      const target = player.socketId ? bySocketId(player.socketId) : undefined;
      if (target) {
        target.emit('err', err('kicked'));
        detachPlayerSocket(target);
      }
      socket.emit('left', { t: 'left', pid, reason: 'kick' });
    });

    socket.on('hud', (pid, msg) => {
      const { kind, code } = socket.data;
      if (kind !== 'scene' || !code || typeof pid !== 'string' || !hasTag(msg, 'hud')) return;
      // One HUD per phone per tick: volatile is safe here and drops rather than queues on a dead link.
      io.to(playerRoom(code, pid)).volatile.emit('hud', msg as Hud);
    });

    socket.on('evt', (pid, msg) => {
      const { kind, code } = socket.data;
      if (kind !== 'scene' || !code || !hasTag(msg, 'evt')) return;
      const target = pid === null ? playersRoom(code) : typeof pid === 'string' ? playerRoom(code, pid) : null;
      if (target) io.to(target).volatile.emit('evt', msg as Evt);
    });

    socket.on('lobby', (msg) => {
      const { kind, code } = socket.data;
      if (kind !== 'scene' || !code || !hasTag(msg, 'lobby')) return;
      io.to(playersRoom(code)).emit('lobby', msg as Lobby);
    });

    // ---------------- phone ----------------

    socket.on('hello', (raw, ack) => {
      if (typeof ack !== 'function' || !control()) return;
      const msg = parseHello(raw);
      if (!msg) {
        ack(err('bad_hello'));
        return;
      }
      // A socket that was in another room (or this one under another token) leaves it first.
      if (socket.data.kind === 'player' && socket.data.token && socket.data.token !== msg.token) {
        const gone = registry.removeByToken(socket.data.token);
        if (gone) io.to(sceneRoom(gone.room.code)).emit('left', { t: 'left', pid: gone.player.pid, reason: 'leave' });
        detachPlayerSocket(socket);
      }
      const res = registry.join(msg.room, msg.token, msg.name, socket.id);
      if (!res.ok) {
        ack(err(res.code));
        return;
      }
      const { room, player, rejoined, replacedSocketId } = res;
      if (replacedSocketId) {
        // Same token from a second tab/phone: the newest socket wins, the old one is told why.
        const old = bySocketId(replacedSocketId);
        if (old) {
          old.emit('err', err('replaced'));
          detachPlayerSocket(old);
        }
      }
      socket.data = { kind: 'player', code: room.code, pid: player.pid, token: player.token };
      void socket.join([playersRoom(room.code), playerRoom(room.code, player.pid)]);
      ack({
        t: 'welcome',
        v: PROTOCOL_VERSION,
        code: room.code,
        pid: player.pid,
        token: player.token,
        rejoined,
        queued: player.queued,
        sceneOnline: room.sceneSocketId !== null,
      });
      if (rejoined) io.to(sceneRoom(room.code)).emit('reconnected', { t: 'reconnected', pid: player.pid, name: player.name });
      else io.to(sceneRoom(room.code)).emit('joined', { t: 'joined', pid: player.pid, name: player.name, queued: player.queued });
      log(`player ${player.pid} (${player.name}) ${rejoined ? 'rejoined' : 'joined'} ${room.code}`);
    });

    socket.on('in', (raw) => {
      const { kind, code, pid } = socket.data;
      if (kind !== 'player' || !code || !pid) return;
      if (!inputBucket.take(Date.now())) {
        if (++droppedInputs % 300 === 1) log(`rate limit: dropping inputs from ${pid} in ${code}`);
        return;
      }
      const msg = parseInput(raw);
      if (!msg) return;
      // Reliable on purpose: many phones feed one scene socket in the same tick (see header).
      io.to(sceneRoom(code)).emit('in', pid, msg);
    });

    socket.on('swap', (raw) => {
      const { kind, code, pid } = socket.data;
      if (kind !== 'player' || !code || !pid || !control()) return;
      const msg = parseSwap(raw);
      if (msg) io.to(sceneRoom(code)).emit('swap', pid, msg);
    });

    socket.on('ready', (raw) => {
      const { kind, code, pid } = socket.data;
      if (kind !== 'player' || !code || !pid || !control()) return;
      const msg = parseReady(raw);
      if (msg) io.to(sceneRoom(code)).emit('ready', pid, msg);
    });

    socket.on('calibrate', (raw) => {
      const { kind, code, pid } = socket.data;
      if (kind !== 'player' || !code || !pid || !control()) return;
      const msg = parseCalibrate(raw);
      if (msg) io.to(sceneRoom(code)).emit('calibrate', pid, msg);
    });

    socket.on('rename', (raw) => {
      const { kind, code, pid, token } = socket.data;
      if (kind !== 'player' || !code || !pid || !token || !control()) return;
      const msg = parseRename(raw);
      if (!msg) return;
      const room = registry.get(code);
      const player = room?.players.get(token);
      if (player) player.name = msg.name;
      io.to(sceneRoom(code)).emit('rename', pid, msg);
    });

    socket.on('leave', () => {
      const { kind, token } = socket.data;
      if (kind !== 'player' || !token) return;
      const gone = registry.removeByToken(token);
      if (gone) io.to(sceneRoom(gone.room.code)).emit('left', { t: 'left', pid: gone.player.pid, reason: 'leave' });
      detachPlayerSocket(socket);
    });

    // ---------------- either ----------------

    socket.on('disconnect', (reason) => {
      const { kind, code, token } = socket.data;
      if (kind === 'scene' && code) {
        const room = registry.sceneLeft(code, socket.id);
        if (room) {
          announceSceneStatus(room, false);
          log(`scene left ${code} (${reason}); grace ${NET.sceneGraceMs} ms`);
        }
      } else if (kind === 'player' && token) {
        const gone = registry.playerSocketLeft(token, socket.id);
        if (gone) {
          io.to(sceneRoom(gone.room.code)).emit('left', { t: 'left', pid: gone.player.pid, reason: 'disconnect' });
          log(`player ${gone.player.pid} dropped from ${gone.room.code} (${reason})`);
        }
      }
    });
  });

  const sweep = setInterval(() => {
    const { closedRooms, expiredPlayers } = registry.sweep();
    for (const { room, player } of expiredPlayers) {
      io.to(sceneRoom(room.code)).emit('left', { t: 'left', pid: player.pid, reason: 'expired' });
    }
    for (const room of closedRooms) closeRoom(room, 'room_closed');
  }, opts.sweepIntervalMs ?? 5000);
  sweep.unref();

  return {
    io,
    registry,
    async close(): Promise<void> {
      clearInterval(sweep);
      await io.close();
    },
  };
}
```

### 3.4 `server/index.ts`

```ts
/**
 * Relay process: Express 5 serves the built app (dist/) with an SPA fallback for /scene and
 * /play, exposes /api/health, and hosts the Socket.IO relay on the same port.
 *
 *   dev : `tsx watch server/index.ts` on :3000, Vite on :5173 proxies /socket.io and /api here
 *   prod: `npm run build && NODE_ENV=production tsx server/index.ts`, tunnel to :3000
 *
 * Env: PORT (default 3000), HOST (default 0.0.0.0), ALLOWED_ORIGINS (comma list, optional).
 */
import express from 'express';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRelay } from './relay.ts';

const PORT = Number(process.env['PORT'] ?? process.env['RELAY_PORT'] ?? 3000);
const HOST = process.env['HOST'] ?? '0.0.0.0';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const INDEX = path.join(DIST, 'index.html');
const allowedOrigins = (process.env['ALLOWED_ORIGINS'] ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

const app = express();
app.disable('x-powered-by');
// Behind cloudflared/ngrok/Render the first proxy sets X-Forwarded-*; trust one hop for req.ip / req.protocol.
app.set('trust proxy', 1);

const httpServer = createServer(app);
const relay = createRelay(httpServer, { allowedOrigins });
const startedAt = Date.now();

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    rooms: relay.registry.size,
    players: relay.registry.playerCount,
    sockets: relay.io.engine.clientsCount,
    dist: existsSync(INDEX),
  });
});

if (existsSync(INDEX)) {
  // Vite names assets with a content hash: cache forever. Everything else: revalidate.
  app.use('/assets', express.static(path.join(DIST, 'assets'), { immutable: true, maxAge: '1y', index: false }));
  app.use(express.static(DIST, { index: false, maxAge: 0 }));
  // Express 5 / path-to-regexp 8: the wildcard needs a name, braces make it match "/" too.
  app.get('/{*splat}', (req, res) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/socket.io/')) {
      res.status(404).type('text').send('not found');
      return;
    }
    res.sendFile(INDEX, { headers: { 'Cache-Control': 'no-store' } });
  });
} else {
  app.get('/{*splat}', (req, res) => {
    if (req.path.startsWith('/api/')) {
      res.status(404).type('text').send('not found');
      return;
    }
    res
      .status(503)
      .type('text')
      .send('dist/ is not built. Run `npm run build`, or open the Vite dev server on :5173 (it proxies /socket.io and /api to this relay).');
  });
}

httpServer.listen(PORT, HOST, () => {
  const addr = httpServer.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : PORT;
  console.log(`[relay] listening on http://${HOST}:${port} (dist: ${existsSync(INDEX) ? 'served' : 'missing, dev mode'})`);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`[relay] ${signal}: closing`);
  await relay.close();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
```

### 3.5 `src/net/identity.ts`

```ts
/**
 * Who am I? Phones keep a random token in localStorage; the same token rejoins the same slot.
 * The scene keeps its room code + scene token in sessionStorage so a reload re-claims the room.
 * Storage access is wrapped: Safari private mode and some kiosk setups throw on localStorage.
 */

const PLAYER_TOKEN_KEY = 'gr.playerToken';
const PLAYER_NAME_KEY = 'gr.playerName';
const SCENE_SESSION_KEY = 'gr.scene';

/**
 * crypto.randomUUID() exists only in secure contexts (MDN); a LAN http:// test page has none.
 * getRandomValues works everywhere, so build a v4 UUID by hand as the fallback.
 */
export function newUuid(): string {
  const c = globalThis.crypto;
  if (typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function read(storage: Storage | undefined, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(storage: Storage | undefined, key: string, value: string | null): void {
  try {
    if (value === null) storage?.removeItem(key);
    else storage?.setItem(key, value);
  } catch {
    /* private mode or quota: the session simply will not survive a reload */
  }
}

function local(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function session(): Storage | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

/** Stable per phone/browser profile. Created once, then reused for every room. */
export function getPlayerToken(): string {
  const existing = read(local(), PLAYER_TOKEN_KEY);
  if (existing && existing.length >= 8 && existing.length <= 64) return existing;
  const token = newUuid();
  write(local(), PLAYER_TOKEN_KEY, token);
  return token;
}

const NICKNAMES = ['Bepi', 'Nane', 'Toni', 'Gigio', 'Momi', 'Checo', 'Lele', 'Zane', 'Piero', 'Nico', 'Bortolo', 'Meneghina', 'Marieta', 'Catina', 'Gigia', 'Nina'];

/** A random Venetian nickname on first visit; the player's last edit afterwards. */
export function getPlayerName(): string {
  const saved = read(local(), PLAYER_NAME_KEY);
  if (saved && saved.trim().length > 0) return saved;
  const name = NICKNAMES[Math.floor(Math.random() * NICKNAMES.length)] ?? 'Gondoliere';
  write(local(), PLAYER_NAME_KEY, name);
  return name;
}

export function setPlayerName(name: string): void {
  write(local(), PLAYER_NAME_KEY, name);
}

export interface SceneSession {
  code: string;
  sceneToken: string;
}

export function loadSceneSession(): SceneSession | null {
  const raw = read(session(), SCENE_SESSION_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { code?: unknown }).code === 'string' &&
      typeof (parsed as { sceneToken?: unknown }).sceneToken === 'string'
    ) {
      return parsed as SceneSession;
    }
  } catch {
    /* corrupt value: start fresh */
  }
  return null;
}

export function saveSceneSession(s: SceneSession | null): void {
  write(session(), SCENE_SESSION_KEY, s === null ? null : JSON.stringify(s));
}
```

### 3.6 `src/net/client.ts` (phone)

```ts
/**
 * Phone-side socket client: connect, say hello, stream inputs at 30 Hz, receive HUD/lobby.
 *
 * Reconnect story (in order of what actually happens on an iPhone that slept 30 s):
 *   1. iOS freezes the page; the WebSocket dies. On wake, socket.io's throttled ping timer fires,
 *      the Manager reconnects with backoff (500 ms .. 3 s).
 *   2. On every `connect` we send `hello` again with the same token. The relay re-attaches the
 *      socket to the same pid and tells the scene `reconnected`. This does not depend on
 *      Socket.IO's connection-state-recovery; if that also succeeded, hello is a harmless no-op.
 *   3. On `visibilitychange` -> visible we check for a half-open link (no ping seen for 2 intervals)
 *      and force a fresh transport instead of waiting for the ping timeout.
 */
import { io, type Socket } from 'socket.io-client';
import {
  NET,
  PROTOCOL_VERSION,
  type ClientToServerEvents,
  type Err,
  type Evt,
  type Hud,
  type InputMsg,
  type InputSample,
  type Lobby,
  type Role,
  type RoomStatus,
  type ServerToClientEvents,
  type Welcome,
} from '@shared/protocol.ts';

export type RelayClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export type LinkState = 'connecting' | 'online' | 'offline';

/** One socket factory for both modes. Same-origin: Vite proxies /socket.io in dev, Express serves it in prod. */
export function connectSocket(): RelayClientSocket {
  return io({
    path: '/socket.io',
    // WebSocket first (tunnels and prod), HTTPS long-polling as the fallback for iOS on a
    // self-signed LAN certificate, where Safari accepts the page but refuses wss://.
    transports: ['websocket', 'polling'],
    tryAllTransports: true,
    auth: { v: PROTOCOL_VERSION },
    reconnectionDelay: 500,
    reconnectionDelayMax: 3000,
    randomizationFactor: 0.3,
    timeout: 8000,
  });
}

export interface PhoneHandlers {
  onLink(state: LinkState, detail?: string): void;
  onWelcome(w: Welcome): void;
  onLobby(l: Lobby): void;
  onHud(h: Hud): void;
  onEvt(e: Evt): void;
  onRoom(r: RoomStatus): void;
  onError(e: Err): void;
}

export class PhoneClient {
  readonly socket: RelayClientSocket;
  private seq = 0;
  private sampler: (() => InputSample | null) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastServerAt = Date.now();
  private joined = false;
  private readonly onVisibility = (): void => {
    if (document.visibilityState !== 'visible') return;
    if (!this.socket.connected) {
      this.socket.connect();
    } else if (Date.now() - this.lastServerAt > 2 * NET.pingIntervalMs) {
      // Half-open after sleep: drop the transport, the Manager reconnects at once.
      this.socket.io.engine.close();
    }
  };

  constructor(
    private readonly room: string,
    private readonly token: string,
    private name: string,
    private readonly h: PhoneHandlers,
  ) {
    this.socket = connectSocket();
    const touch = (): void => {
      this.lastServerAt = Date.now();
    };
    this.socket.io.on('ping', touch);
    this.socket.on('connect', () => {
      touch();
      this.h.onLink('online');
      void this.hello();
    });
    this.socket.on('disconnect', (reason) => {
      this.joined = false;
      this.h.onLink('offline', reason);
      // 'io server disconnect' means we were told to go (room closed/kicked): do not fight it.
    });
    this.socket.on('connect_error', (e) => {
      const data = (e as { data?: { code?: unknown } }).data;
      if (data?.code === 'bad_version') {
        this.h.onError({ t: 'err', code: 'bad_version', msg: 'Reload the page: the game was updated.' });
        this.socket.disconnect();
        return;
      }
      this.h.onLink('connecting', e.message);
    });
    this.socket.on('lobby', (m) => {
      touch();
      this.h.onLobby(m);
    });
    this.socket.on('hud', (m) => {
      touch();
      this.h.onHud(m);
    });
    this.socket.on('evt', (m) => {
      touch();
      this.h.onEvt(m);
    });
    this.socket.on('room', (m) => {
      touch();
      this.h.onRoom(m);
    });
    this.socket.on('err', (m) => {
      touch();
      if (m.code === 'room_closed' || m.code === 'kicked' || m.code === 'replaced') this.joined = false;
      this.h.onError(m);
    });
    document.addEventListener('visibilitychange', this.onVisibility);
    this.h.onLink('connecting');
  }

  get isJoined(): boolean {
    return this.joined;
  }

  private async hello(): Promise<void> {
    try {
      const res = await this.socket
        .timeout(5000)
        .emitWithAck('hello', { t: 'hello', v: PROTOCOL_VERSION, room: this.room, token: this.token, name: this.name });
      if (res.t === 'welcome') {
        this.joined = true;
        this.h.onWelcome(res);
      } else {
        this.h.onError(res);
      }
    } catch {
      // ack timeout: the socket will reconnect and hello runs again on 'connect'
      this.h.onLink('connecting', 'no answer from relay');
    }
  }

  /** Starts the 30 Hz loop. `sample` builds a packet from the current sensor/touch state, or null to skip. */
  startInputs(sample: () => InputSample | null): void {
    this.sampler = sample;
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      if (!this.joined || !this.socket.connected || !this.sampler) return;
      const s = this.sampler();
      if (!s) return;
      const msg: InputMsg = { ...s, seq: ++this.seq };
      // Volatile on WebSocket: one packet per tick, dropped rather than queued while the link is down.
      // On the polling fallback the transport is "not writable" for a whole round trip, so volatile
      // would throw most packets away; let polling batch them instead.
      if (this.socket.io.engine.transport.name === 'websocket') this.socket.volatile.emit('in', msg);
      else this.socket.emit('in', msg);
    }, 1000 / NET.inputHz);
  }

  stopInputs(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.sampler = null;
  }

  swap(team?: number, role?: Role): void {
    const msg: ClientToServerEvents['swap'] extends (m: infer M) => void ? M : never = { t: 'swap' };
    if (team !== undefined) msg.team = team;
    if (role !== undefined) msg.role = role;
    this.socket.emit('swap', msg);
  }

  ready(ready: boolean): void {
    this.socket.emit('ready', { t: 'ready', ready });
  }

  calibrated(): void {
    this.socket.emit('calibrate', { t: 'calibrate' });
  }

  rename(name: string): void {
    this.name = name;
    this.socket.emit('rename', { t: 'rename', name });
  }

  leave(): void {
    this.socket.emit('leave', { t: 'leave' });
    this.joined = false;
  }

  destroy(): void {
    this.stopInputs();
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.socket.disconnect();
  }
}
```

### 3.7 `src/net/sceneClient.ts`

```ts
/**
 * Scene-side socket client: create/re-claim the room, receive tagged inputs, push HUD/lobby.
 * The scene is the source of truth for teams, roles and the match; this file only moves bytes.
 */
import {
  NET,
  PROTOCOL_VERSION,
  type Calibrate,
  type Evt,
  type Gate,
  type HostMsg,
  type Hud,
  type InputMsg,
  type Lobby,
  type PlayerJoined,
  type PlayerLeft,
  type PlayerReconnected,
  type Ready,
  type Rename,
  type RoomCreated,
  type Swap,
} from '@shared/protocol.ts';
import { connectSocket, type LinkState, type RelayClientSocket } from './client.ts';
import { loadSceneSession, saveSceneSession } from './identity.ts';

export interface SceneHandlers {
  onLink(state: LinkState, detail?: string): void;
  onRoom(r: RoomCreated): void;
  onJoined(m: PlayerJoined): void;
  onLeft(m: PlayerLeft): void;
  onReconnected(m: PlayerReconnected): void;
  onInput(pid: string, m: InputMsg): void;
  onSwap(pid: string, m: Swap): void;
  onReady(pid: string, m: Ready): void;
  onCalibrate(pid: string, m: Calibrate): void;
  onRename(pid: string, m: Rename): void;
}

/** The URL the QR encodes. Override with VITE_PUBLIC_ORIGIN when the scene PC opens localhost but phones use a tunnel. */
export function joinUrl(code: string): string {
  const env = import.meta.env as Record<string, string | undefined>;
  const origin = env['VITE_PUBLIC_ORIGIN'] ?? window.location.origin;
  const url = new URL('/play', origin);
  url.searchParams.set('room', code);
  return url.toString();
}

export class SceneClient {
  readonly socket: RelayClientSocket;
  code: string | null = null;
  private hudTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly h: SceneHandlers) {
    this.socket = connectSocket();
    this.socket.on('connect', () => {
      this.h.onLink('online');
      void this.host();
    });
    this.socket.on('disconnect', (reason) => this.h.onLink('offline', reason));
    this.socket.on('connect_error', (e) => this.h.onLink('connecting', e.message));
    this.socket.on('joined', (m) => this.h.onJoined(m));
    this.socket.on('left', (m) => this.h.onLeft(m));
    this.socket.on('reconnected', (m) => this.h.onReconnected(m));
    this.socket.on('in', (pid, m) => this.h.onInput(pid, m));
    this.socket.on('swap', (pid, m) => this.h.onSwap(pid, m));
    this.socket.on('ready', (pid, m) => this.h.onReady(pid, m));
    this.socket.on('calibrate', (pid, m) => this.h.onCalibrate(pid, m));
    this.socket.on('rename', (pid, m) => this.h.onRename(pid, m));
    this.h.onLink('connecting');
  }

  /** Re-claims the saved room if the relay still has it (grace period), else creates a new one. */
  private async host(): Promise<void> {
    const saved = loadSceneSession();
    const msg: HostMsg = saved
      ? { t: 'host', v: PROTOCOL_VERSION, code: saved.code, sceneToken: saved.sceneToken }
      : { t: 'host', v: PROTOCOL_VERSION };
    try {
      const res = await this.socket.timeout(5000).emitWithAck('host', msg);
      if (res.t === 'room') {
        this.code = res.code;
        saveSceneSession({ code: res.code, sceneToken: res.sceneToken });
        this.h.onRoom(res);
        return;
      }
      if (res.code === 'no_room' && saved) {
        saveSceneSession(null);
        await this.host();
        return;
      }
      this.h.onLink('connecting', `relay refused: ${res.code}`);
    } catch {
      this.h.onLink('connecting', 'no answer from relay');
    }
  }

  /**
   * Reliable, not volatile: the HUD loop emits up to 18 packets in one tick and the browser transport
   * is "not writable" after the first write until the next tick, so volatile would keep only the first.
   * The relay turns each one into a volatile per-phone delivery.
   */
  sendHud(pid: string, hud: Hud): void {
    this.socket.emit('hud', pid, hud);
  }

  /** `pid` null = every phone in the room. */
  sendEvt(pid: string | null, evt: Evt): void {
    this.socket.emit('evt', pid, evt);
  }

  /** Reliable: the roster is sent on change, not on a timer. */
  sendLobby(lobby: Lobby): void {
    this.socket.emit('lobby', lobby);
  }

  setGate(gate: Omit<Gate, 't'>): void {
    this.socket.emit('gate', { t: 'gate', ...gate });
  }

  kick(pid: string): void {
    this.socket.emit('kick', pid);
  }

  /** Runs `collect` 10 times a second and sends one HUD per player. */
  startHudLoop(collect: () => Iterable<[pid: string, hud: Hud]>): void {
    if (this.hudTimer !== null) return;
    this.hudTimer = setInterval(() => {
      if (!this.socket.connected) return;
      for (const [pid, hud] of collect()) this.sendHud(pid, hud);
    }, 1000 / NET.hudHz);
  }

  stopHudLoop(): void {
    if (this.hudTimer !== null) clearInterval(this.hudTimer);
    this.hudTimer = null;
  }

  destroy(): void {
    this.stopHudLoop();
    this.socket.disconnect();
  }
}
```

### 3.8 `src/net/inputHold.ts` (scene-side hold, seq filter, aim re-basing)

```ts
/**
 * Scene-side input hold: the last packet per player, staleness, sequence filtering, and the
 * gunner aim re-basing that makes `yaw` + `ep` robust to dropped packets.
 *
 * The sim calls `offer()` from the socket handler and `read()` once per fixed step.
 */
import { NET, type GunnerIn, type InputMsg } from '@shared/protocol.ts';

export interface HeldInput {
  input: InputMsg;
  /** ms since the packet arrived */
  ageMs: number;
  /** true when no packet for NET.inputStaleMs: the HUD shows "phone dropped", the sim coasts. */
  dropped: boolean;
}

interface Slot {
  input: InputMsg;
  at: number;
  seq: number;
}

export class InputHold {
  private readonly slots = new Map<string, Slot>();

  constructor(private readonly now: () => number = () => performance.now()) {}

  /** Returns false for stale/out-of-order packets (seq not above the last applied one). */
  offer(pid: string, input: InputMsg): boolean {
    const slot = this.slots.get(pid);
    if (slot) {
      const reset = input.seq < slot.seq - NET.seqResetGap; // phone reloaded: its counter restarted
      if (!reset && input.seq <= slot.seq) return false;
      slot.input = input;
      slot.at = this.now();
      slot.seq = input.seq;
      return true;
    }
    this.slots.set(pid, { input, at: this.now(), seq: input.seq });
    return true;
  }

  read(pid: string): HeldInput | null {
    const slot = this.slots.get(pid);
    if (!slot) return null;
    const ageMs = this.now() - slot.at;
    return { input: slot.input, ageMs, dropped: ageMs > NET.inputStaleMs };
  }

  forget(pid: string): void {
    this.slots.delete(pid);
  }

  /** Every player whose phone is silent (for the HUD "phone dropped" badge). */
  droppedPids(): string[] {
    const t = this.now();
    const out: string[] = [];
    for (const [pid, s] of this.slots) if (t - s.at > NET.inputStaleMs) out.push(pid);
    return out;
  }
}

/**
 * World-space aim from gunner packets.
 *   aim = base + yaw, where base is set when the epoch changes (calibrate/recenter) or on respawn
 *   so that the aim lands behind the bow at that instant. The accumulated `yaw` is absolute, so a
 *   lost packet costs nothing; `dYaw` is only used as a turn-rate hint for aim assist.
 */
export class AimTracker {
  private base = 0;
  private ep = -1;
  private lastFc = 0;
  private lastUc = -1;

  /** Returns world aim in radians. `bowHeading` is the boat's current heading. */
  apply(pkt: GunnerIn, bowHeading: number): number {
    if (pkt.ep !== this.ep) {
      this.ep = pkt.ep;
      this.base = bowHeading - pkt.yaw;
    }
    return this.base + pkt.yaw;
  }

  /** Call on respawn (the spec resets the view behind the bow). */
  resetBehindBow(pkt: GunnerIn | null, bowHeading: number): void {
    this.base = bowHeading - (pkt?.yaw ?? 0);
    if (pkt) this.ep = pkt.ep;
  }

  /** True once per fire tap even if the packet carrying `fire: true` was lost. */
  takeFireTap(pkt: GunnerIn): boolean {
    if (pkt.fc === this.lastFc) return false;
    this.lastFc = pkt.fc;
    return true;
  }

  /** Engineer power use, applied exactly once per tap. */
  takeUse(uc: number, use: 0 | 1 | null): 0 | 1 | null {
    if (uc === this.lastUc || use === null) return null;
    this.lastUc = uc;
    return use;
  }
}
```

How the sim uses it (Track B glue, not part of this deliverable):

```ts
// src/scene/main.ts (sketch)
const hold = new InputHold();
const aim = new Map<string, AimTracker>();
scene = new SceneClient({ onInput: (pid, m) => void hold.offer(pid, m), /* ... */ });
// every fixed step:
for (const player of roster) {
  const held = hold.read(player.pid);
  if (!held) continue;
  if (held.input.role === 'gunner') {
    const tracker = aim.get(player.pid) ?? new AimTracker();
    aim.set(player.pid, tracker);
    const aimYaw = tracker.apply(held.input, sim.boatHeading(player.team));
    sim.applyInput(player.pid, { ...held.input, yaw: aimYaw }); // or pass aimYaw separately
    if (tracker.takeFireTap(held.input)) sim.fire(player.team);
  } else {
    sim.applyInput(player.pid, held.input);
  }
  hud.setDropped(player.pid, held.dropped);
}
```

### 3.9 `src/net/qr.ts`

```ts
/**
 * Join QR for the big screen, drawn in the browser with the `qrcode` package.
 * Vite resolves the package's "browser" field to qrcode/lib/browser.js (canvas renderer, no fs).
 */
import { toCanvas } from 'qrcode';
import { joinUrl } from './sceneClient.ts';

export interface JoinQr {
  url: string;
  canvas: HTMLCanvasElement;
}

/** Draws the QR for `/play?room=CODE` into `canvas` (created if omitted). `size` is CSS pixels. */
export async function renderJoinQr(code: string, canvas?: HTMLCanvasElement, size = 512): Promise<JoinQr> {
  const url = joinUrl(code);
  const target = canvas ?? document.createElement('canvas');
  await toCanvas(target, url, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: size,
    color: { dark: '#0b1a24ff', light: '#ffffffff' },
  });
  return { url, canvas: target };
}

/** True when the QR would point phones at an address they cannot reach (the scene opened on localhost). */
export function joinUrlLooksLocal(url: string): boolean {
  const { hostname, protocol } = new URL(url);
  return protocol !== 'https:' || hostname === 'localhost' || hostname === '127.0.0.1' || hostname.endsWith('.localhost');
}
```

### 3.10 `src/net/scanner.ts`

```ts
/**
 * Fallback in-app QR scanner (the normal path is the phone camera app opening /play?room=...).
 * qr-scanner 1.4.2 is an ES module; it loads its worker with `import("./qr-scanner-worker.min.js")`,
 * which Vite 8 bundles as a separate chunk automatically. Camera access needs HTTPS and a tap.
 */
import QrScanner from 'qr-scanner';
import { roomCodeFromText } from '@shared/protocol.ts';

export interface RoomScanner {
  /** Call from a tap handler: the camera permission prompt needs a user gesture. */
  start(): Promise<void>;
  stop(): void;
  destroy(): void;
}

/** Scans until a room code is found, then calls `onCode` once and stops. */
export function createRoomScanner(video: HTMLVideoElement, onCode: (code: string) => void, onError?: (msg: string) => void): RoomScanner {
  let done = false;
  const scanner = new QrScanner(
    video,
    (result) => {
      if (done) return;
      const code = roomCodeFromText(result.data);
      if (!code) return;
      done = true;
      scanner.stop();
      onCode(code);
    },
    {
      returnDetailedScanResult: true,
      preferredCamera: 'environment',
      highlightScanRegion: true,
      maxScansPerSecond: 8,
    },
  );
  return {
    async start(): Promise<void> {
      if (!(await QrScanner.hasCamera())) {
        onError?.('No camera found. Type the 4-letter code instead.');
        return;
      }
      try {
        await scanner.start();
      } catch (e) {
        onError?.(e instanceof Error ? e.message : 'Camera blocked. Type the 4-letter code instead.');
      }
    },
    stop(): void {
      scanner.stop();
    },
    destroy(): void {
      scanner.destroy();
    },
  };
}
```

### 3.11 `tests/relay.test.ts`

```ts
/**
 * Relay integration tests: a real socket.io server on port 0, real socket.io-client sockets.
 * No phones needed. Run with `npm test` (vitest 5, node environment).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as ioc, type Socket } from 'socket.io-client';
import { createRelay, type Relay } from '../server/relay.ts';
import { RoomRegistry } from '../server/rooms.ts';
import {
  PROTOCOL_VERSION,
  type ClientToServerEvents,
  type Hud,
  type InputMsg,
  type Lobby,
  type PlayerJoined,
  type PlayerLeft,
  type PlayerReconnected,
  type ServerToClientEvents,
  type Welcome,
  type Err,
  type RoomCreated,
} from '@shared/protocol.ts';

type C = Socket<ServerToClientEvents, ClientToServerEvents>;

let http: HttpServer;
let relay: Relay;
let url = '';
let now = 1_000_000;
const clients: C[] = [];

function connect(v: number = PROTOCOL_VERSION): C {
  const s: C = ioc(url, { transports: ['websocket'], forceNew: true, auth: { v }, reconnection: false });
  clients.push(s);
  return s;
}

function connected(s: C): Promise<void> {
  return new Promise((resolve, reject) => {
    s.once('connect', () => resolve());
    s.once('connect_error', (e) => reject(e));
  });
}

/** Resolves with the arguments of the next `ev` event. */
function next<Ev extends keyof ServerToClientEvents>(s: C, ev: Ev): Promise<Parameters<ServerToClientEvents[Ev]>> {
  return new Promise((resolve) => {
    const listener = (event: string, ...args: unknown[]): void => {
      if (event !== ev) return;
      s.offAny(listener);
      resolve(args as Parameters<ServerToClientEvents[Ev]>);
    };
    s.onAny(listener);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const hud: Hud = {
  t: 'hud', phase: 'battle', team: 0, role: 'pilot', kills: 1, deaths: 0, respawnIn: 0,
  weapon: 'cannon', ammo: 5, powers: [null, null], water: 0, alive: true,
};
const lobby: Lobby = { t: 'lobby', phase: 'lobby', teamSize: 2, teams: 1, members: [] };
const pilotIn = (seq: number): InputMsg => ({ t: 'in', seq, role: 'pilot', steer: 0.5, gas: true, brake: false });

async function hostRoom(scene: C): Promise<RoomCreated> {
  const res = await scene.emitWithAck('host', { t: 'host', v: PROTOCOL_VERSION });
  if (res.t !== 'room') throw new Error(`host refused: ${res.code}`);
  return res;
}

async function joinRoom(phone: C, room: string, token: string, name = 'Bepi'): Promise<Welcome | Err> {
  return phone.emitWithAck('hello', { t: 'hello', v: PROTOCOL_VERSION, room, token, name });
}

beforeEach(async () => {
  http = createServer();
  const registry = new RoomRegistry({ now: () => now, sceneGraceMs: 1000, playerGraceMs: 1000 });
  relay = createRelay(http, { registry, log: () => undefined, sweepIntervalMs: 50 });
  await new Promise<void>((r) => http.listen(0, r));
  url = `http://localhost:${(http.address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.disconnect();
  await relay.close();
});

describe('relay', () => {
  it('creates a room with a 4-letter code and refuses a bad protocol version', async () => {
    const scene = connect();
    await connected(scene);
    const room = await hostRoom(scene);
    expect(room.code).toMatch(/^[ABCDEFGHJKMNPRSTUVWXYZ]{4}$/);
    expect(room.reclaimed).toBe(false);
    expect(room.sceneToken.length).toBeGreaterThan(8);

    const old = connect(0);
    await expect(connected(old)).rejects.toMatchObject({ message: 'bad_version' });
  });

  it('forwards inputs to the scene tagged with the pid, and HUD to one phone only', async () => {
    const scene = connect();
    const p1 = connect();
    const p2 = connect();
    await Promise.all([connected(scene), connected(p1), connected(p2)]);
    const { code } = await hostRoom(scene);

    const joined1 = next(scene, 'joined');
    const w1 = await joinRoom(p1, code, 'token-1111', 'Bepi');
    const w2 = await joinRoom(p2, code, 'token-2222', 'Nane');
    expect(w1.t).toBe('welcome');
    expect(w2.t).toBe('welcome');
    const [j1] = await joined1;
    expect(j1).toMatchObject<Partial<PlayerJoined>>({ pid: 'p1', name: 'Bepi', queued: false });

    const got = next(scene, 'in');
    p1.volatile.emit('in', pilotIn(1));
    const [pid, msg] = await got;
    expect(pid).toBe('p1');
    expect(msg).toEqual(pilotIn(1));

    let p2Huds = 0;
    p2.on('hud', () => void p2Huds++);
    const hudP1 = next(p1, 'hud');
    scene.emit('hud', 'p1', hud);
    expect((await hudP1)[0]).toEqual(hud);

    const l1 = next(p1, 'lobby');
    const l2 = next(p2, 'lobby');
    scene.emit('lobby', lobby);
    expect((await l1)[0]).toEqual(lobby);
    expect((await l2)[0]).toEqual(lobby);
    expect(p2Huds).toBe(0);
  });

  it('clamps and drops malformed inputs', async () => {
    const scene = connect();
    const p1 = connect();
    await Promise.all([connected(scene), connected(p1)]);
    const { code } = await hostRoom(scene);
    await joinRoom(p1, code, 'token-1111');

    const received: InputMsg[] = [];
    scene.on('in', (_pid, m) => void received.push(m));
    p1.emit('in', { t: 'in', seq: 1, role: 'pilot', steer: 7, gas: 'yes', brake: false } as unknown as InputMsg);
    p1.emit('in', { t: 'in', seq: 2, role: 'pilot', steer: Number.NaN, gas: true, brake: false } as unknown as InputMsg);
    p1.emit('in', { t: 'in', seq: 3, role: 'gunner', dYaw: 0.1, yaw: 1, ep: 0, fire: true, fc: 1, recenter: false });
    await sleep(50);
    expect(received).toEqual([
      { t: 'in', seq: 1, role: 'pilot', steer: 1, gas: false, brake: false },
      { t: 'in', seq: 3, role: 'gunner', dYaw: 0.1, yaw: 1, ep: 0, fire: true, fc: 1, recenter: false },
    ]);
  });

  it('delivers a same-tick burst from one phone to the scene complete and in order', async () => {
    const scene = connect();
    const p1 = connect();
    await Promise.all([connected(scene), connected(p1)]);
    const { code } = await hostRoom(scene);
    await joinRoom(p1, code, 'token-1111');
    const seqs: number[] = [];
    scene.on('in', (_pid, m) => void seqs.push(m.seq));
    for (let i = 1; i <= 10; i++) p1.emit('in', pilotIn(i));
    await sleep(80);
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('fans one scene HUD loop out to every phone in the same tick', async () => {
    const scene = connect();
    const phones = [connect(), connect(), connect()];
    await Promise.all([connected(scene), ...phones.map(connected)]);
    const { code } = await hostRoom(scene);
    await Promise.all(phones.map((p, i) => joinRoom(p, code, `token-${i}${i}${i}${i}${i}${i}${i}${i}`)));
    const got = phones.map((p) => next(p, 'hud'));
    for (let i = 0; i < phones.length; i++) scene.emit('hud', `p${i + 1}`, { ...hud, team: i });
    const huds = await Promise.all(got);
    expect(huds.map((h) => h[0].team)).toEqual([0, 1, 2]);
  });

  it('rejoins the same slot with the same token and tells the scene', async () => {
    const scene = connect();
    const p1 = connect();
    await Promise.all([connected(scene), connected(p1)]);
    const { code } = await hostRoom(scene);
    const w1 = await joinRoom(p1, code, 'token-1111', 'Bepi');
    expect(w1).toMatchObject({ pid: 'p1', rejoined: false });

    const left = next(scene, 'left');
    p1.disconnect();
    expect((await left)[0]).toMatchObject<Partial<PlayerLeft>>({ pid: 'p1', reason: 'disconnect' });

    const again = connect();
    await connected(again);
    const re = next(scene, 'reconnected');
    const w2 = await joinRoom(again, code, 'token-1111', 'Bepi');
    expect(w2).toMatchObject({ pid: 'p1', rejoined: true });
    expect((await re)[0]).toMatchObject<Partial<PlayerReconnected>>({ pid: 'p1' });

    // a second device with the same token replaces the first
    const twin = connect();
    await connected(twin);
    const replaced = next(again, 'err');
    await joinRoom(twin, code, 'token-1111', 'Bepi');
    expect((await replaced)[0]).toMatchObject({ code: 'replaced' });
  });

  it('explicit leave frees the slot: the next hello is a fresh join', async () => {
    const scene = connect();
    const p1 = connect();
    await Promise.all([connected(scene), connected(p1)]);
    const { code } = await hostRoom(scene);
    await joinRoom(p1, code, 'token-1111');
    const left = next(scene, 'left');
    p1.emit('leave', { t: 'leave' });
    expect((await left)[0]).toMatchObject({ pid: 'p1', reason: 'leave' });
    const w = await joinRoom(p1, code, 'token-1111');
    expect(w).toMatchObject({ pid: 'p2', rejoined: false });
  });

  it('enforces the gate: full room and locked match', async () => {
    const scene = connect();
    await connected(scene);
    const { code } = await hostRoom(scene);
    scene.emit('gate', { t: 'gate', max: 1, locked: false, late: 'queue' });
    await sleep(20);
    const a = connect();
    const b = connect();
    await Promise.all([connected(a), connected(b)]);
    expect((await joinRoom(a, code, 'token-aaaa')).t).toBe('welcome');
    expect(await joinRoom(b, code, 'token-bbbb')).toMatchObject({ t: 'err', code: 'room_full' });

    scene.emit('gate', { t: 'gate', max: 18, locked: true, late: 'queue' });
    await sleep(20);
    expect(await joinRoom(b, code, 'token-bbbb')).toMatchObject({ t: 'welcome', queued: true });

    scene.emit('gate', { t: 'gate', max: 18, locked: true, late: 'reject' });
    await sleep(20);
    const c = connect();
    await connected(c);
    expect(await joinRoom(c, code, 'token-cccc')).toMatchObject({ t: 'err', code: 'match_running' });
    expect(await joinRoom(c, 'ZZZZ', 'token-cccc')).toMatchObject({ t: 'err', code: 'no_room' });
  });

  it('scene reload: phones see the big screen go away and come back, the room is re-claimed', async () => {
    const scene = connect();
    const p1 = connect();
    await Promise.all([connected(scene), connected(p1)]);
    const room = await hostRoom(scene);
    await joinRoom(p1, room.code, 'token-1111');

    const offline = next(p1, 'room');
    scene.disconnect();
    expect((await offline)[0]).toEqual({ t: 'room', sceneOnline: false });

    const scene2 = connect();
    await connected(scene2);
    const online = next(p1, 'room');
    const res = await scene2.emitWithAck('host', { t: 'host', v: PROTOCOL_VERSION, code: room.code, sceneToken: room.sceneToken });
    expect(res).toMatchObject({ t: 'room', code: room.code, reclaimed: true, players: [{ pid: 'p1', connected: true }] });
    expect((await online)[0]).toEqual({ t: 'room', sceneOnline: true });

    const got = next(scene2, 'in');
    p1.emit('in', pilotIn(1));
    expect((await got)[0]).toBe('p1');

    const wrong = connect();
    await connected(wrong);
    expect(await wrong.emitWithAck('host', { t: 'host', v: PROTOCOL_VERSION, code: room.code, sceneToken: 'not-the-token' })).toMatchObject({ code: 'no_room' });

    // a duplicated scene tab re-claims while scene2 is still live: scene2 is replaced and stops receiving inputs
    const scene3 = connect();
    await connected(scene3);
    const replaced = next(scene2, 'err');
    const res3 = await scene3.emitWithAck('host', { t: 'host', v: PROTOCOL_VERSION, code: room.code, sceneToken: room.sceneToken });
    expect(res3).toMatchObject({ t: 'room', reclaimed: true });
    expect((await replaced)[0]).toMatchObject({ code: 'replaced' });
    let scene2Inputs = 0;
    scene2.on('in', () => void scene2Inputs++);
    const got3 = next(scene3, 'in');
    p1.emit('in', pilotIn(2));
    expect((await got3)[0]).toBe('p1');
    expect(scene2Inputs).toBe(0);
  });

  it('closes the room after the scene grace period and tells the phones', async () => {
    const scene = connect();
    const p1 = connect();
    await Promise.all([connected(scene), connected(p1)]);
    const room = await hostRoom(scene);
    await joinRoom(p1, room.code, 'token-1111');
    const offline = next(p1, 'room');
    const closed = next(p1, 'err');
    scene.disconnect();
    await offline; // the relay has recorded sceneLeftAt; now let the fake clock pass the grace period
    now += 1001;
    expect((await closed)[0]).toMatchObject({ code: 'room_closed' });
    expect(relay.registry.get(room.code)).toBeUndefined();
    expect(await joinRoom(p1, room.code, 'token-1111')).toMatchObject({ code: 'no_room' });
  });
});
```

### 3.12 `tests/rooms.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { RoomRegistry } from '../server/rooms.ts';
import { ROOM_CODE_ALPHABET, normalizeRoomCode, parseInput, roomCodeFromText } from '@shared/protocol.ts';

describe('room codes', () => {
  it('are 4 letters from the look-alike-free alphabet, pronounceable, unique', () => {
    const reg = new RoomRegistry();
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const code = reg.create(`s${i}`, `tok-${i}`).code;
      expect(code).toMatch(/^[BCDFGHJKMNPRSTVWXYZ][AEU][BCDFGHJKMNPRSTVWXYZ][AEU]$/);
      for (const ch of code) expect(ROOM_CODE_ALPHABET).toContain(ch);
      expect(seen.has(code)).toBe(false);
      seen.add(code);
    }
  });

  it('falls back to random codes once the pronounceable space is exhausted', () => {
    const reg = new RoomRegistry({ rng: () => 0 }); // always "BABA"
    expect(reg.create('a', 't').code).toBe('BABA');
    expect(reg.create('b', 't').code).toBe('AAAA'); // first fallback pick with rng 0
  });

  it('normalizes user input and parses links', () => {
    expect(normalizeRoomCode(' dama ')).toBe('DAMA');
    expect(normalizeRoomCode('RIVA')).toBeNull(); // the spec's example contains I, which the alphabet drops
    expect(normalizeRoomCode('DAMO')).toBeNull(); // O is not in the alphabet either
    expect(roomCodeFromText('https://x.trycloudflare.com/play?room=dama')).toBe('DAMA');
    expect(roomCodeFromText('hello')).toBeNull();
  });
});

describe('registry', () => {
  it('keeps the slot for a token across disconnects and expires it after the grace period', () => {
    let now = 0;
    const reg = new RoomRegistry({ now: () => now, playerGraceMs: 100, sceneGraceMs: 100 });
    const room = reg.create('scene', 'tok');
    const j = reg.join(room.code, 'abcdefgh', 'Bepi', 'sock1');
    expect(j.ok && j.player.pid).toBe('p1');
    expect(reg.playerSocketLeft('abcdefgh', 'other-socket')).toBeNull();
    expect(reg.playerSocketLeft('abcdefgh', 'sock1')?.player.socketId).toBeNull();
    now = 50;
    expect(reg.sweep().expiredPlayers).toHaveLength(0);
    const again = reg.join(room.code, 'abcdefgh', 'Bepi', 'sock2');
    expect(again.ok && again.rejoined && again.player.pid === 'p1').toBe(true);
    reg.playerSocketLeft('abcdefgh', 'sock2');
    now = 200;
    expect(reg.sweep().expiredPlayers.map((e) => e.player.pid)).toEqual(['p1']);
    expect(reg.get(room.code)?.players.size).toBe(0);
  });

  it('closes a room whose scene stayed away, and a token moving rooms leaves the old one', () => {
    let now = 0;
    const reg = new RoomRegistry({ now: () => now, sceneGraceMs: 100 });
    const a = reg.create('sceneA', 'ta');
    const b = reg.create('sceneB', 'tb');
    reg.join(a.code, 'abcdefgh', 'Bepi', 's1');
    reg.join(b.code, 'abcdefgh', 'Bepi', 's1');
    expect(a.players.size).toBe(0);
    expect(b.players.size).toBe(1);
    reg.sceneLeft(a.code, 'sceneA');
    now = 99;
    expect(reg.sweep().closedRooms).toHaveLength(0);
    expect(reg.reclaim(a.code, 'ta', 'sceneA2')?.sceneLeftAt).toBeNull();
    reg.sceneLeft(a.code, 'sceneA2');
    now = 250;
    expect(reg.sweep().closedRooms.map((r) => r.code)).toEqual([a.code]);
    expect(reg.size).toBe(1);
  });
});

describe('parseInput', () => {
  it('rejects junk and clamps numbers', () => {
    expect(parseInput(null)).toBeNull();
    expect(parseInput({ t: 'in', role: 'pilot', steer: 0 })).toBeNull(); // no seq
    expect(parseInput({ t: 'in', seq: 1, role: 'engineer', use: 2, uc: 1, shake: 5 })).toEqual({
      t: 'in', seq: 1, role: 'engineer', use: null, uc: 1, shake: 1,
    });
    expect(parseInput({ t: 'in', seq: 1.7, role: 'pilot', steer: -3, gas: 1, brake: true })).toEqual({
      t: 'in', seq: 1, role: 'pilot', steer: -1, gas: false, brake: true,
    });
  });
});
```

### 3.13 `vite.config.ts` (patch: vitest import, `server.ws`, `allowedHosts`)

Replace the file with this version (typechecks and builds under Vite 8.3.4):

```ts
// `test` is a vitest key: defineConfig must come from 'vitest/config' or `tsc` rejects it (TS2769).
import { defineConfig } from 'vitest/config';
import type { PluginOption } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { fileURLToPath, URL } from 'node:url';

// One Vite app, three routes (/ , /scene, /play). Client-side routing on
// location.pathname; `appType: 'spa'` makes the dev server fall back to
// index.html for /scene and /play, and server/index.ts does the same in prod.
//
// HTTPS=1 enables a self-signed cert for LAN testing. Phones on iOS need a
// secure context for motion sensors; the recommended path is the tunnel
// (`npm run tunnel`), which terminates TLS for you. See docs/CHALLENGES.md.
const RELAY_PORT = Number(process.env.RELAY_PORT ?? 3000);
const useHttps = process.env.HTTPS === '1';
// Public hostname of the tunnel (e.g. abc-def.trycloudflare.com) when phones load the dev server
// through it. Only needed for HMR on the scene PC; phones never need HMR.
const TUNNEL_HOST = process.env.TUNNEL_HOST;

export default defineConfig({
  appType: 'spa',
  plugins: [useHttps ? (basicSsl() as PluginOption) : null].filter(Boolean) as PluginOption[],
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
    },
  },
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    proxy: {
      '/socket.io': {
        target: `http://localhost:${RELAY_PORT}`,
        ws: true,
        changeOrigin: true,
      },
      '/api': {
        target: `http://localhost:${RELAY_PORT}`,
        changeOrigin: true,
      },
    },
    // Vite 8: `server.hmr.{host,clientPort,protocol}` are deprecated (still synced); `server.ws` is current.
    // Through a Cloudflare/ngrok tunnel the browser reaches us on 443; HMR must connect back on that port.
    ...(TUNNEL_HOST ? { ws: { host: TUNNEL_HOST, clientPort: 443, protocol: 'wss' } } : {}),
    // Tunnel hostnames are random per run, so allow the two tunnel domains rather than `true`
    // (`true` disables the DNS-rebinding protection for every host).
    allowedHosts: ['.trycloudflare.com', '.ngrok-free.app', '.ngrok-free.dev', '.ngrok.app', '.ngrok.dev'],
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
  },
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts', 'shared/**/*.test.ts', 'server/**/*.test.ts'],
    environment: 'node',
  },
});
```

### 3.14 `package.json` (patch)

- Move `"tsx": "^4.23.15"` from `devDependencies` to `dependencies` so `npm start` works on a host that installs with `NODE_ENV=production`.
- Optional scripts: `"tunnel:ngrok": "ngrok http 5173"`, `"test:relay": "vitest run tests/relay.test.ts"`.
- Nothing else changes; `dev`, `build`, `start`, `tunnel`, `tunnel:prod`, `test`, `typecheck` already match this design.

### 3.15 Phone sampler sketch (Track A phone screens, for orientation)

```ts
// src/phone/pilot.ts (sketch): the net client calls this 30 times a second
let gas = false, brake = false, steer = 0; // updated by touch and devicemotion handlers
client.startInputs((): InputSample => ({ t: 'in', role: 'pilot', steer, gas, brake }));

// src/phone/gunner.ts (sketch)
let yaw = 0, lastSentYaw = 0, ep = 0, fire = false, fc = 0, recenterFlag = false;
onRecenterTap(() => { yaw = 0; ep++; recenterFlag = true; });
onFireStart(() => { fire = true; fc++; });
onFireEnd(() => { fire = false; });
client.startInputs((): InputSample => {
  const s: InputSample = { t: 'in', role: 'gunner', dYaw: yaw - lastSentYaw, yaw, ep, fire, fc, recenter: recenterFlag };
  lastSentYaw = yaw; recenterFlag = false;
  return s;
});
```

## 4. Edge cases and how each is handled

| # | Case | Handling |
|---|---|---|
| 1 | Phone sleeps 30 s (screen lock, app switch) | iOS kills the socket; on wake the throttled ping timer fires -> reconnect (500 ms..3 s backoff) -> `hello` with the same token -> `welcome {rejoined:true}` -> scene `reconnected` -> scene re-sends `lobby` and the next `hud`. `visibilitychange` forces a fresh transport if no ping was seen for 20 s. Inputs while away were volatile: nothing bursts. |
| 2 | Phone page reload / Safari tab killed | Token in `localStorage` -> same pid. `seq` restarts at 1; `InputHold` accepts the jump because it is > 1000 below the last seq. |
| 3 | Same token on two devices (duplicated tab) | Newest socket wins; old gets `err replaced` and leaves its rooms. Server-side `disconnect` of the old socket does not detach the slot because `player.socketId !== socket.id`. |
| 4 | Private browsing (no `localStorage`) | New token per load -> new slot per reload. Acceptable; phone shows its pid/team again. |
| 5 | Scene reload (Vite full reload, F5) | `sessionStorage` -> `host {code, sceneToken}` -> `reclaimed:true` with the player list; phones saw `room {sceneOnline:false}` then `{true}`. |
| 6 | Scene away longer than 90 s / scene PC crash | Room closed; phones get `err room_closed`, UI returns to the join screen; a scene that comes back gets `no_room`, creates a new room, shows a new QR. |
| 7 | Duplicated scene tab re-claims the room | Previous scene socket gets `err replaced` and leaves `CODE:scene`; inputs go to one scene only (tested). |
| 8 | Relay restart | All rooms gone (in-memory by design). Scene: `no_room` -> new room. Phones: `no_room` on hello -> "scan the new QR". Run the relay under `tsx watch` only in dev; in prod keep it in a terminal you do not touch. |
| 9 | Room full | `err room_full` from the gate (`max` set by the scene from team size x 6). |
| 10 | Join during a match | `welcome {queued:true}`; scene seats as spectator until the next lobby. With `late:'reject'`: `err match_running`. |
| 11 | Old cached phone page after a deploy | `auth.v` mismatch -> middleware error -> client `connect_error` with `data.code = 'bad_version'` -> "Reload the page". |
| 12 | Oversized or malformed message | > 8 KB closes the connection (ws code 1009, proven); junk fails the parsers and is dropped; NaN/Infinity rejected; numbers clamped. |
| 13 | Runaway client loop | Inputs above 45/s dropped silently (logged once per 300); control messages above 10/s answered `err rate_limited`. |
| 14 | Lost input packet | Last packet held; gas/steer are states, `yaw` is absolute, `ep`/`fc`/`uc` counters make recenter/fire/use idempotent. |
| 15 | No input for 1.5 s | `InputHold.read().dropped` -> HUD "phone dropped" badge; the sim keeps the last state. |
| 16 | Out-of-order / stale after reconnect | `seq` monotonic; `InputHold` ignores `seq <= last`. |
| 17 | iOS on self-signed LAN cert | Page is a secure context; `wss://` fails; `tryAllTransports` falls back to polling; inputs switch to reliable emits on polling. |
| 18 | Venue WiFi blocks WebSocket | Same fallback: HTTPS long-polling through the tunnel. |
| 19 | Scene PC opened on `localhost:5173` while phones use the tunnel | `joinUrl` would encode localhost; `joinUrlLooksLocal()` lets the scene UI warn; set `VITE_PUBLIC_ORIGIN=https://x.trycloudflare.com` or open the scene through the tunnel URL. |
| 20 | Tunnel URL changes between runs | QR is generated at runtime from `location.origin`; nothing is hard-coded. |
| 21 | ngrok interstitial | One "Visit Site" tap per phone per 7 days; socket traffic unaffected. |
| 22 | Cloudflare/ngrok idle timeout | 10 s server pings keep every socket active. |
| 23 | Cloudflare 200 in-flight request cap | 18 phones + 1 scene = 19 sockets (one upgrade request each); polling fallback adds one in-flight request per phone; far below 200. |
| 24 | Two scenes on one relay (two rooms) | Rooms are isolated by code; the registry is per server; codes unique. |
| 25 | `/api/typo` or `/socket.io/x` on prod | 404 from the fallback, never `index.html`. |
| 26 | Build missing in prod | 503 with the hint; `/api/health.dist === false`. |
| 27 | Name edits | `rename` updates the registry and the scene; names sanitised to 16 printable chars. |
| 28 | Kick from the scene UI | `kick(pid)` -> slot freed, phone gets `err kicked`, scene gets `left {reason:'kick'}`. |
| 29 | Explicit leave then re-scan | Slot freed; the next `hello` is a fresh join with a new pid. |

## 5. Day-one testing

### Without phones (automated and keyboard)

1. `npm test` runs `tests/rooms.test.ts` (codes, registry, parsers, 6 tests) and `tests/relay.test.ts` (real server on port 0 + real clients: create/version gate, fan-in with pid tag, HUD to one phone, lobby to all, validation, same-tick bursts, HUD fan-out, rejoin/replace, leave, gate, scene re-claim + replacement, grace close; 10 tests). Total 16, ~0.6 s.
2. `npm run typecheck` after applying 3.13 (before it, `tsc` fails on the `test` key).
3. `npm run dev`, open `http://localhost:5173/scene` in one tab and `http://localhost:5173/play?room=CODE` in a second tab (or a second browser profile for a second token). The second tab is a "phone": wire the keyboard harness to the same `PhoneClient.startInputs(sampler)` so arrow keys produce `PilotIn`; the scene must see `joined`, then `in` packets at 30 Hz, and `/api/health` must show `rooms: 1, players: 1`.
4. Load: `tsx loadtest.ts` (the script in the scratch mirror) or the vitest burst tests; expect 0 % loss and p99 < 10 ms on localhost.
5. Kill the relay while both tabs are open: both must reconnect; the scene creates a new room (new code) and the phone tab shows "no such room".

### With phones (Gate 1 checklist, in order)

1. `npm run build && npm start` (or `npm run dev`), then `npm run tunnel:prod` (or `npm run tunnel`). Wait for `Registered tunnel connection`, count to ten.
2. Open the **tunnel URL** `/scene` on the PC (not localhost), check the QR's URL text starts with the tunnel host.
3. iPhone camera -> QR -> Safari opens `/play?room=XXXX`; lobby shows the nickname and "Enable controls". Check `window.isSecureContext === true` in the debug footer.
4. Tap "Enable controls": `DeviceMotionEvent.requestPermission()` resolves `granted`; wake lock acquired; the scene shows the player as connected.
5. Tilt: the box boat turns on the TV. Measure RTT in the phone footer; expect 50-100 ms.
6. Lock the phone 30 s, unlock: the scene shows "phone dropped" within 1.5 s, "connected" again within ~5 s of unlock, same seat.
7. Reload the scene tab: phones show "Big screen reconnecting...", then recover; the boat still steers.
8. Android Chrome: repeat 3-6 (no permission prompt for motion; vibration works).
9. Optional LAN check: `HTTPS=1 npm run dev`, open `https://<lan-ip>:5173/play?room=...` on the iPhone, accept the warning: the join must work over polling (the footer shows transport `polling`); this proves the fallback before you need it.

## 6. Sources

- SPEC.md (repo), sections 1, 2, 3, 11, 12, 13, 14.
- Installed sources/typings read: `node_modules/socket.io/dist/{index,socket,socket-types,broadcast-operator,typed-events}.d.ts`, `socket.io/dist/{socket,client,namespace}.js`, `socket.io-adapter/dist/in-memory-adapter.js`, `engine.io/build/server.d.ts`, `engine.io/build/{socket,transports/websocket,transports/polling}.js`, `socket.io-client/build/esm/{index,socket,manager}.d.ts`, `socket.io-client/build/esm/socket.js`, `engine.io-client/build/esm/socket.d.ts`, `engine.io-client/build/esm/{socket,transports/websocket,transports/polling}.js`, `express/package.json`, `router/package.json`, `path-to-regexp/Readme.md`, `@types/express*`, `@types/serve-static`, `qrcode/package.json`, `qrcode/lib/browser.js`, `@types/qrcode/index.d.ts`, `qr-scanner/package.json`, `qr-scanner/types/qr-scanner.d.ts`, `qr-scanner/README.md`, `qr-scanner/qr-scanner.min.js`, `vite/dist/node/index.d.ts`, `vite/dist/node/chunks/node.js`, `vite/types/importMeta.d.ts`, `vitest/dist/config.d.ts`, `@vitejs/plugin-basic-ssl/dist/index.d.ts`.
- Socket.IO docs: server options https://socket.io/docs/v4/server-options/ ; client options https://socket.io/docs/v4/client-options/ ; connection state recovery https://socket.io/docs/v4/connection-state-recovery ; volatile events https://socket.io/docs/v4/emitting-events/ ; delivery guarantees https://socket.io/docs/v4/delivery-guarantees/ ; how it works (heartbeat) https://socket.io/docs/v4/how-it-works/ ; multiple nodes / sticky sessions https://socket.io/docs/v4/using-multiple-nodes/
- Express 5 migration (path syntax, `/{*splat}`): https://expressjs.com/en/guide/migrating-5.html
- Vite server options (`allowedHosts`, `server.ws`, `server.hmr` deprecation, proxy `ws`): https://vite.dev/config/server-options
- Cloudflare quick tunnels: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/ ; WebSockets on Cloudflare: https://developers.cloudflare.com/network/websockets/ ; cloudflared downloads (brew): https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/ ; quick tunnel guide with WebSocket/Vite notes and DNS timing: https://flaviocopes.com/cloudflare-quick-tunnels/ ; Cloudflare ~100 s idle timeout (third party): https://websocket.org/guides/troubleshooting/timeout/
- ngrok: interstitial error page https://ngrok.com/docs/errors/err_ngrok_6024 ; free plan limits https://ngrok.com/docs/pricing-limits/free-plan-limits ; free static domains https://ngrok.com/blog-post/free-static-domains-ngrok-users
- iOS / WebKit: `SecurityOrigin.cpp` https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/page/SecurityOrigin.cpp ; W3C Secure Contexts https://w3c.github.io/webappsec-secure-contexts/ ; iOS accepts https but not wss with self-signed certs https://www.hotelexistence.ca/ios-safaris-websockets-implementation-doesnt-work-with-self-signed-certs/ ; gist on self-signed WSS on iOS https://gist.github.com/apankrat/612dde3d7f01c4713c9579b0a94d9547 ; Apple forum iOS 26 beta WSS certificate error https://developer.apple.com/forums/thread/792842 ; WebKit bug 41419 (wss and untrusted certs) https://bugs.webkit.org/show_bug.cgi?id=41419 ; Safari background WebSocket behaviour https://developer.apple.com/forums/thread/696310
- MDN: `crypto.randomUUID()` secure context https://developer.mozilla.org/en-US/docs/Web/API/Crypto/randomUUID ; `getRandomValues()` insecure contexts https://developer.mozilla.org/en-US/docs/Web/API/Crypto/getRandomValues ; `DeviceMotionEvent.requestPermission()` https://developer.mozilla.org/en-US/docs/Web/API/DeviceMotionEvent/requestPermission_static
- mkcert README (mobile devices, iOS full trust): https://github.com/FiloSottile/mkcert ; iOS CA trust problem report https://developer.apple.com/forums/thread/89568?page=2
- Hosts: Render free tier https://render.com/docs/free and changelog https://render.com/changelog/free-web-services-now-remain-active-while-receiving-websocket-messages ; Railway pricing https://railway.com/pricing ; Fly.io pricing https://docs.fly.io/about/pricing
