
## 4. Edge cases and how each is handled

| Case | Handling (where) |
|---|---|
| Team count 2..6 and the spare cell | `computeLayout` clamps to 2..6, spare index = first unused cell (3 teams -> cell 3, 5 teams -> cell 5); tested that cells + spare tile the canvas exactly for 1920x1080 and 1366x768. |
| Odd pixel widths, 3 columns in 1920 px | Edges at `round(i*W/3)` = 0, 640, 1280, 1920: no 1 px gaps or overlaps (test). |
| Minimap or scoreboard overlapping a cell's corner widgets | `placeWidget` slides the widget toward the cell centre (test: bottom-right cell's team name moves >= 108 + 14 px right). |
| Resize / fullscreen / projector plugged in late | `resize()` re-reads `canvas.clientWidth/Height`, `setSize(w, h, false)`; the scene recomputes the layout from the same numbers and calls `hud.setLayout`. Layout is otherwise fixed for the round (spec). |
| Non-integer DPR seams (`round` vs `floor`) | `setPixelRatio(1)` (or the quality tier's 0.75, which then applies to the whole canvas uniformly). |
| Shadow map rebuilt per viewport | `autoUpdate = false`; `needsUpdate` is reset by three at the end of the first shadow pass (`WebGLShadowMap.js:376`), so only one pass per frame even in dynamic mode. If no shadow-casting light is in the render (`lights.length === 0`, line 97) the flag stays set: harmless. Re-enabling shadows after a quality step sets `needsUpdate = true` again. |
| Camera inside a building in an 8 m side canal when the gunner looks sideways | `clampCameraToWater` grid march, min 2.5 m; `near = 0.5`. Fallback if it still clips: building materials are `FrontSide`, so from inside a block you see through its back faces instead of a black screen. |
| Kill-cam when the killer is also dead or unknown (mutual ram, mine owner respawned) | `updateRig` falls back to `follow` on the own (sinking) boat; the HUD shows "SUNK" without a team. |
| Kill-cam -> respawn cut | Mode change back to `follow` clears the smoothed position (`settled = false`), so the camera snaps to the respawn dock instead of flying through walls; the wake and crew are reset on `alive` rising edge or a > 20 m jump. |
| Interpolating across a respawn teleport | `GondolaView.update`: a jump > 20 m between `p*` and current uses `alpha = 1`. Angles use `lerpAngle` (shortest arc) from `shared/math.ts`. |
| Campanile beyond the fog | Linear fog reaches 100 % at 140 m; the campanile's material uses `weakenFog` (fog factor x 0.55) so it stays a 45 % silhouette anywhere on the map; it is never distance-culled; `camera.far = 450` covers the 500 m diagonal. |
| Lantern glow seen through walls | The glow sprite keeps `depthTest` on, so a building hides it, consistent with the hiding rule; it has `fog: false` so it reads at range in the open. |
| `gl_PointSize` limits per GPU | Capped at 256 px; the explosion column is a spray burst plus a glow burst rather than one giant point. |
| InstancedMesh pools and frustum culling | Dynamic pools set `frustumCulled = false`; static instanced meshes call `computeBoundingSphere()` once after the matrices are set. |
| `renderer.info` per render call | `autoReset = false`, one `reset()` per frame; the overlay divides calls by the viewport count. |
| HDRI missing, offline, or slow | The procedural `Sky` + PMREM is built synchronously on startup; `applyHdri` is fire-and-forget after frame 2 and catches errors. Nothing blocks Gate 1. |
| AudioContext suspended | Created lazily in `unlock()` from the Start click / Space keydown; `resume()` if suspended; missing sound files are silently skipped. |
| WebGL context lost | `webglcontextlost` logs and three's `render()` becomes a no-op (`_isContextLost` check at the top of `render()`); the scene shows a reload message. |
| Tab hidden / rAF paused | `Timer` clamps `dt` to 0.1 s in `render()`; the sim loop owns its own accumulator. |
| `scene.background` as a `Color` instead of a texture | `WebGLBackground.render` then force-clears inside the current scissor on every viewport: correct, slightly wasteful; with the PMREM texture no clear happens. |
| Transparent sorting with four cameras | three sorts the render list per `render()` call relative to that camera (`sortObjects`), so wakes, sprites and bubbles sort correctly per viewport. |
| 16-bit index overflow when merging | `BufferGeometry.setIndex` picks `Uint32BufferAttribute` when needed (`arrayNeedsUint32`); blocks are far below the limit anyway (4 boxes, 96 vertices). |
| Water plane edge visible | 1400 m plane, fog at 140 m: the edge is 500 m beyond the fog from any camera on the 400 x 300 map. |
| Shutters/windows cost when triangle-bound | 4.6 k windows x (frame + glass + 2 shutters) as boxes is ~220 k triangles per viewport; the "detail" cut hides them, or swap the box geometries for `PlaneGeometry` quads (12 -> 2 triangles each). |
| Upgrade to three r187 | The migration guide says `setViewport()/setScissor()` stop scaling by the pixel ratio when a render target is bound; our calls target the canvas, unaffected, but worth a re-test. |

## 5. Day-one testing, with and without phones

Without phones (keyboard harness, Track B):

1. `npm run dev`, open `/scene`, press F3 for the perf overlay. The scene main loop should run the sim at 60 Hz with an accumulator and call `renderer.render(state, events, layout, accumulator / dt)`.
2. Layout smoke test: a debug key (suggest `1`..`6`) sets the team count and rebuilds the layout; check borders, the spare-cell map for 3 and 5, the centre minimap for 2, 4, 6, and that the scoreboard band and minimap push the corner widgets.
3. Camera: drive a keyboard boat (WASD) and turn the aim (Q/E as the gyro stand-in): the crosshair stays centred, the horizon stays mid-cell, the bow arrow rotates, the boat sits in the lower part; drive into a side canal and look sideways: the camera pulls in instead of entering the wall.
4. Kill-cam: a debug key sinks the own boat with a chosen killer id; expect the glide to the killer, "SUNK by", a 5 s countdown, then a hard cut to the dock.
5. Shadows: toggle `dynamicShadows` from the perf tier; the overlay's draw calls should rise by one shadow pass only, never by four.
6. Performance gate (Gate 2 as the spec says): 4 teams, 4 keyboard boats, read the overlay: target >= 55 fps, <= 250 calls per viewport. If below: F4 steps the quality tier (cull distance, shadows, detail, pixel ratio) and the overlay confirms the drop.
7. Unit tests: `npm test` runs `tests/layout.test.ts`, `tests/camera.test.ts`, `tests/buildings.test.ts` (pure functions; 19 assertions pass in the scratch copy).
8. Procedural assets: nothing to download; the HDRI (`public/assets/textures/venice_sunset_1k.hdr`) and sounds (`public/assets/sounds/*.ogg`) are optional and lazy; confirm the console warns but the game runs when they are absent.

With phones (after Gate 1):

1. One iPhone steering through the tunnel: the boat should turn in the viewport with the camera following the boat (aim = yaw until a gunner joins).
2. A second phone as Gunner: the view turns while the boat keeps heading; the bow arrow shows the difference; recentre snaps the arrow to 0.
3. Fire: muzzle flash and boom at the firing boat, splash or explosion at the impact; crosshair flashes X on a kill; the kill feed and scoreboard update.
4. Pickup a crate: sparkle and chime; the crate hides and comes back after 8 s.
5. Hull water (Engineer): the boat sits lower and the water bar fills; shake to bail: the engineer swings the bucket.

## 6. Sources

Installed packages (read directly):

- three 0.186.1: `src/renderers/WebGLRenderer.js` (lines 206, 277, 285, 312, 565-567, 808-883, 965-1040, 1637-1660, 1687, 1731, 1737, 1760-1810, 1872-1874, 1890, 3041-3071), `src/renderers/webgl/WebGLShadowMap.js` (86-103, 160-180, 360-376), `src/renderers/webgl/WebGLBackground.js`, `src/renderers/webgl/WebGLEnvironments.js`, `src/renderers/webgl/WebGLMaterials.js` (25-36), `src/renderers/shaders/ShaderChunk/{fog_fragment,fog_vertex,fog_pars_fragment,normal_fragment_maps,normalmap_pars_fragment}.glsl.js`, `src/renderers/shaders/ShaderLib/meshphysical.glsl.js` (182-225), `src/math/Frustum.js` (`intersectsObject`), `src/objects/InstancedMesh.js`, `src/geometries/BoxGeometry.js` (76-81), `src/core/BufferGeometry.js` (234), `src/core/Clock.js`, `src/core/Timer.js`, `src/scenes/Scene.js`, `src/textures/Texture.js`, `src/math/ColorManagement.js`, `src/constants.js`, `src/materials/ShaderMaterial.js`, `src/materials/Material.js`, `examples/jsm/loaders/{HDRLoader,RGBELoader}.js`, `examples/jsm/objects/{Water,Water2,Sky}.js`, `examples/jsm/utils/{BufferGeometryUtils,SkeletonUtils}.js`, `package.json` (`exports["./addons/*"]`).
- @types/three 0.186.0: `WebGLRenderer.d.ts`, `WebGLShadowMap.d.ts`, `WebGLInfo.d.ts`, `WebGLCapabilities.d.ts`, `InstancedMesh.d.ts`, `BatchedMesh.d.ts`, `LOD.d.ts`, `ArrayCamera.d.ts`, `Camera.d.ts`, `OrthographicCamera.d.ts`, `LightShadow.d.ts`, `Material.d.ts`, `MeshStandardMaterial.d.ts`, `PointsMaterial.d.ts`, `SpriteMaterial.d.ts`, `Audio*.d.ts`, `AnimationMixer.d.ts`, `AnimationAction.d.ts`, `Timer.d.ts`, `DataUtils.d.ts`, `MathUtils.d.ts`, `Path.d.ts`, `ExtrudeGeometry.d.ts`, `LatheGeometry.d.ts`, `examples/jsm/loaders/{HDRLoader,RGBELoader,GLTFLoader}.d.ts`, `examples/jsm/objects/Sky.d.ts`, `examples/jsm/utils/{BufferGeometryUtils,SkeletonUtils}.d.ts`, `package.json` exports.

Web:

- three.js migration guide (r170-r187 entries on `RGBELoader` -> `HDRLoader` (r180), `PCFSoftShadowMap` (r182), `Clock` -> `Timer` (r183), `Timer` in core (r179), `WaterMesh.resolutionScale` (r181), r187 `setViewport/setScissor` with a bound render target): https://github.com/mrdoob/three.js/wiki/Migration-Guide
- three.js example `webgl_multiple_views` (r186 source: per-view `setViewport`, `setScissor`, `setScissorTest(true)`, `setClearColor`, `camera.aspect`, `updateProjectionMatrix`, `render`; `autoClear` untouched): https://raw.githubusercontent.com/mrdoob/three.js/r186/examples/webgl_multiple_views.html
- three.js example `webgl_shaders_ocean` (r186: `Sky` + `PMREMGenerator.fromScene(sceneEnv)` -> `scene.environment`; `Water` with a 512x512 render target): https://raw.githubusercontent.com/mrdoob/three.js/r186/examples/webgl_shaders_ocean.html
- MDN `WebGLRenderingContext.scissor` ("When the scissor test is enabled, only pixels within the scissor box can be modified by drawing commands", example comment "e.g. clear"): https://developer.mozilla.org/en-US/docs/Web/API/WebGLRenderingContext/scissor
- MDN `HTMLCanvasElement.getContext` (`powerPreference: "high-performance"`, `antialias`, `preserveDrawingBuffer`): https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/getContext
- MDN `Window.devicePixelRatio`: https://developer.mozilla.org/en-US/docs/Web/API/Window/devicePixelRatio
- MDN user activation (activation-triggering events: `keydown` except Esc and reserved shortcuts, `mousedown`, `pointerdown` (mouse), `pointerup` (non-mouse), `touchend`; `isTrusted` required): https://developer.mozilla.org/en-US/docs/Web/Security/User_activation
- Chrome autoplay policy for Web Audio (context created before a gesture is "suspended"; call `resume()` after a user gesture): https://developer.chrome.com/blog/autoplay
- Gaffer On Games, "Fix Your Timestep" (`alpha = accumulator / dt`, `state = current * alpha + previous * (1 - alpha)`): https://gafferongames.com/post/fix_your_timestep/
- Poly Haven licence (CC0, no attribution required): https://polyhaven.com/license ; "Venice Sunset" HDRI by Greg Zaal, 1K-16K, HDR/EXR (the 1K .hdr is the one to ship): https://polyhaven.com/a/venice_sunset
- Kenney "Impact Sounds" (130 files, CC0): https://kenney.nl/assets/impact-sounds ; Kenney packs on OpenGameArt listed CC0 (Sci-Fi Sounds, Interface Sounds): https://opengameart.org/content/sci-fi-sounds
- Freesound FAQ (CC0 / CC-BY / CC-BY-NC, licence filter in search): https://freesound.org/help/faq/
- Mixamo -> glTF pipeline (Don McCurdy: T-pose FBX, animations "without skin", Blender, glTF export): https://donmccurdy.com/2017/11/06/creating-animated-gltf-characters-with-mixamo-and-blender/ ; Mixamo is free with an Adobe account and exports FBX/Collada only (secondary sources; Adobe's FAQ returned 403 during research): https://app.cinevva.com/guides/free-character-animations-rigging

## Appendix: verification log

Scratch directory: `/private/tmp/claude-502/-Users-makhlugjafarov-cognitex-Documents-regata-storica/69884729-7585-4b5d-ad26-4af5e194adaa/scratchpad/research/render/` (`node_modules` symlinked to the repo's).

- `node proof-exports.mjs`: three REVISION 186; no missing core export among WebGLRenderer, PMREMGenerator, LOD, InstancedMesh, BatchedMesh, Points, Sprite, AudioListener, PositionalAudio, Fog, FogExp2, ACESFilmicToneMapping, SRGBColorSpace, LatheGeometry, ExtrudeGeometry, CapsuleGeometry, Timer, ...; `HDRLoader` is a function and `RGBELoader` extends it; `mergeGeometries` is a function and `mergeBufferGeometries` is undefined; `SkeletonUtils.clone`, `GLTFLoader`, `Sky` present; `ACESFilmicToneMapping === 4`; `ColorManagement.enabled === true`; `Fog` defaults near 1 far 1000, `FogExp2` density 0.00025; `mergeGeometries` of two boxes with groups gives 48 vertices / 24 triangles; a level `lookAt` yields forward `[0, 0, -1]`; `DirectionalLight.shadow.camera` is Orthographic with mapSize 512 default; `Texture` default colour space is `NoColorSpace`.
- `tsx proof-world.ts` (builds the world from the spec's sample grid in node with placeholder textures): 24x8 cells, 15 blocks, 2 bridge runs, 36 static meshes / 1524 triangles, 24 instanced meshes / 1928 instances / 24864 triangles / 466 windows; hull 520, trim 104, ferro 84 triangles; layouts: 2 teams 960x1080 (vfov 75), 3-4 teams 960x540 (vfov 54.5), 5-6 teams 640x540 (vfov 75); minimap 216x216 at (852, 432) or the spare cell inset; linear fog 40..140 gives 0.352 / 0.896 / 1.0 at 80 / 120 / 140 m; FogExp2 density for 90 % at 120 m is 0.01265 and 0.99995 at 250 m; shadow texel 0.254 m; boat centre 24.0 deg below the horizon against a 27.3 deg half-FOV.
- `tsc --noEmit -p tsconfig.json` (strict, noUncheckedIndexedAccess, noImplicitOverride, noUnusedLocals, noUnusedParameters, bundler resolution, `@shared/*` alias): clean.
- `vitest run`: 3 files, 19 tests passed (layout tiling, GL flip, widget pushing; camera FOV, position, level look, aim 1:1, bow arrow, wall clamp; block merge coverage, bridge runs, hull geometry).
