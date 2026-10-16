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
