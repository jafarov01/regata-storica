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

@@FILE shared/protocol.ts@@

### 3.2 `server/rooms.ts`

@@FILE server/rooms.ts@@

### 3.3 `server/relay.ts`

@@FILE server/relay.ts@@

### 3.4 `server/index.ts`

@@FILE server/index.ts@@

### 3.5 `src/net/identity.ts`

@@FILE src/net/identity.ts@@

### 3.6 `src/net/client.ts` (phone)

@@FILE src/net/client.ts@@

### 3.7 `src/net/sceneClient.ts`

@@FILE src/net/sceneClient.ts@@

### 3.8 `src/net/inputHold.ts` (scene-side hold, seq filter, aim re-basing)

@@FILE src/net/inputHold.ts@@

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

@@FILE src/net/qr.ts@@

### 3.10 `src/net/scanner.ts`

@@FILE src/net/scanner.ts@@

### 3.11 `tests/relay.test.ts`

@@FILE tests/relay.test.ts@@

### 3.12 `tests/rooms.test.ts`

@@FILE tests/rooms.test.ts@@

### 3.13 `vite.config.ts` (patch: vitest import, `server.ws`, `allowedHosts`)

Replace the file with this version (typechecks and builds under Vite 8.3.4):

@@FILE vite.config.ts@@

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
