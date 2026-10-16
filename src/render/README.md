# Track C — C1–C5 + crew integration

The renderer now consumes the official `ParsedMap`, `GameState`, `Layout` and
`CameraView` contracts. Research geometry, water, sky and camera ideas are adapted
locally; no shared contracts, physics, networking or HUD files were changed.

## Included

- Venetian buildings, masonry/algae bands, alpha-cut windows and laundry, docks,
  striped poles, arch bridges (including the covered bridge) and one campanile.
- All 13 existing image assets, asynchronous loading with procedural fallback,
  sRGB colour textures and two linear scrolling water normal maps.
- `sky.hdr`: CC0 Poly Haven Venice Sunset, 2K; provenance in the adjacent licence file.
- Procedural asymmetric gondolas, team lanterns, independent cannon aim,
  sinking/respawn visibility and shield/spawn-protection bubbles.
- Growing instance pools for crates, shells, torpedoes, mortars, mines and water
  streams; torpedo wakes. Animation is driven by simulation time and stops on pause.
- The character picker is connected to animated role-based crew on each gondola;
  their turning, rowing, aiming, bailing, sinking and victory animations use sim time.
- The shared game audio engine plays the 22 sounds added upstream, with first-gesture
  unlocking, event-driven effects, ambience and M to mute.
- One WebGL renderer, scissor viewports, DPR 1 and one shadow update per frame.

## Verify

Run `npm run check`, then `npm run dev` and open `/scene`.
Add four bot teams with the lobby button (or O four times from an empty lobby),
then press Enter. F3 toggles FPS, render CPU time, total calls/average per view,
triangle count and asset loading status. P pauses; Esc returns to the lobby.

Existing developer hooks remain available:

```js
gr.sim.debug.giveWeapon(0, 'torpedo');
gr.sim.debug.givePower(0, 'mine');
gr.sim.debug.sink(0, 1);
gr.sim.debug.teleport(0, 120, 40, 0);
gr.renderer.setDebug({ stats: true, showColliders: true });
```

Target acceptance is 60 fps with four viewports at 1920×1080 on the projector PC;
measure that machine before declaring the hardware performance gate complete.
Render CPU time is not GPU time. Total draw calls include the single shared shadow
pass; the displayed per-view figure is an average, not an independent view budget.

Validated locally on 2026-10-16: `npm run check` passed (99 tests), browser layouts
for 2–6 teams rendered without WebGL errors, all 13 image assets loaded, and four
views at 1920×1080 reported about 120 fps during bot combat (roughly 80 calls/view,
including the shared shadow pass in the average). Pause and window resizing were
also exercised. These measurements are specific to this machine/browser.

## Deferred

Remaining work: full combat particle effects, quality presets/LOD and podium.
`freeCamera` retains its previous placeholder behaviour. Missing
optional media must not block rendering.
