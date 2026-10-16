# Module 1: Phones & network (Teammate A)

**Owns:** `src/phone/`, `src/net/`, `src/landing/`, `server/`. **Reads:** `shared/protocol.ts` (what you send and receive), `shared/config.ts` (`PHONE`), `ARCHITECTURE.md` section 4.

**Already done (base):** relay with rooms, reconnect, rate limits and SPA serving; phone and scene socket clients; the full sensor stack (iOS/Android permission flow, steering from gravity, gyro aim, shake, wake lock, desktop simulator); 30 Hz sender with running totals; join screen, lobby, Enable controls; role screens with wheel (Pilot), compass (Gunner), water meter (Engineer); one-line status strip. Research: `docs/research/sensors/final.md`, `docs/research/netcode/final.md`.

**Test without a phone:** `/play?room=CODE&sim=1` (A/D tilt, arrows turn, Space shake). Several desktop "phones" need different origins (localhost, 127.0.0.1, your LAN IP), because the player token lives in localStorage.

## MVP (by Gate 2)

- [ ] **A1 Real-phone check (with everyone, first).** Tunnel, iPhone + Android: Enable controls, CALIBRATE, tilt steers the right way, Gunner turn direction matches the screen, shake registers. Fix signs in `sensors.ts` if needed. *Done when:* both phones drive and aim correctly; note the results in the merge message.
- [ ] **A2 Invert-aim toggle and a lobby controls test.** A small toggle in the lobby (`saveInvertAim`), and after Enable controls show the role graphic in the lobby too so players can try steering before the match. *Done when:* the wheel turns in the lobby and the toggle flips the Gunner direction.
- [ ] **A3 Gunner screen.** Big weapon name + ammo from `Hud.weapon` / `Hud.ammo`, red flash on hit (`Evt hit`), crosshair-on-target cue (`Hud.onTarget`, `Hud.locked`), RECENTER feedback. *Done when:* `gr.sim.debug.giveWeapon(0, 'cannon')` on the scene shows "CANNON 5" on the Gunner phone within 0.2 s.
- [ ] **A4 Engineer screen.** The two buttons show the held powers (`Hud.powers`, greyed when empty), SHAKE TO BAIL prompt with the water meter when `Hud.bail`. *Done when:* a power appears on the button and tapping it sends `uc + 1` (check `gr.hold.read(pid)` on the scene).
- [ ] **A5 Sunk and results screens.** `Hud.alive === false`: full-screen "SUNK by Azzurro" + countdown from `Hud.respawnIn`; `phase === 'results'`: final team score and "rematch coming". *Done when:* `gr.sim.debug.sink(0)` (once Module 2 has it) shows the sunk screen on every crew phone.

## Should (by Gate 3)

- [ ] **A6 Resume after sleep or reload.** Phone locked 30 s, unlocked: back in the same slot within 5 s. After a page reload the controller needs a new tap (iOS rule): show one big "Tap to resume controls" instead of the lobby when a match is running.
- [ ] **A7 Haptics and team look.** Android vibration on fire and hit, iOS red flash (`wake.ts haptic` is ready); team colour background, role name in large type; respect the "rotate your phone" overlay for Pilot and Gunner.
- [ ] **A8 Join polish.** PLAYER highlighted on phones, the fallback scanner tested on iOS and Android, a clear error when the room code is wrong or the room is full.
- [ ] **A9 Backup host.** Deploy the relay to Render (or Railway/Fly): `npm run build`, start command `npm start`, websockets on. Document the URL and `VITE_PUBLIC_ORIGIN` in `HANDOFF.md`. *Done when:* a phone joins a room on the hosted URL.
- [ ] **A10 Stale-phone warning.** When `Hud.stale` is true show "the big screen can't hear you, check your connection"; test by turning wifi off for 3 s.

## Day-one checks (SPEC.md section 14)

1. iPhone through the tunnel: Enable controls, motion events flow, a boat turns on the TV.
2. Android: same, plus vibration.
3. Lock the phone and unlock: back in the same slot within 5 s.
