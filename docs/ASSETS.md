# Assets: sounds and images

Everything lives under `public/assets/`. The filenames below are the ones the code should load; keep them so Track C's loaders and the agents agree. Prefer CC0 sources (no attribution needed on the big screen).

## Status (updated 2026-10-16)

| Group | State | Files |
|---|---|---|
| Textures (walls, stone, wood, water, pole, laundry, window) | **In the repo** (`public/assets/textures/`), generated with ChatGPT, resized and cut out | 13 files, see the table in "Textures" below |
| HDRI sky | **Available locally** (CC0 Poly Haven Venice Sunset, 2K) | `public/assets/textures/sky.hdr`, provenance in `sky-license.md` |
| UI icons, crosshairs, logo, podium, favicon, lobby background, team flags, SUNK, glow, foam, roof tiles, shutters | **Generated locally** with built-in image_gen | 30 new images: 25 under `public/assets/ui/`, 4 under `public/assets/textures/`, and `public/favicon.png` |
| Sounds | **In the repo and playing** (`public/assets/sounds/`, 22 MP3 files, synthesised by `scripts/generate-sounds.py`, wired in `src/render/audio.ts`) | replace any file with a recording under the same name; see "Sounds" below |

The 30-image generation pass is complete. Exact prompts and selected source images
are recorded in `public/assets/image-generation-prompts.json`; dimensions and alpha
checks are in `public/assets/image-audit.json`. All 30 images have the specified
dimensions; the 26 transparent PNGs have an alpha channel. Icons were reviewed at
64 px, logo/SUNK text visually checked, and foam/roof previews reviewed in repeat.
Open `/assets/image-catalog.html` on the development server to review the images.

Generation does not automatically wire these images into the game's HUD or
renderer. Their consuming code is still a separate Track C/C6 integration task.
The filename table in the generation brief below is authoritative: podium, foam
and roof tiles are JPEG; transparent assets are PNG. No duplicate PNG versions
are required for those three JPEG files. Optional phone backgrounds and lobby
video remain unnecessary for the planned game.

Notes for the code (Track C):
- Opaque textures are **JPEG** (`.jpg`), not PNG: same look, a tenth of the size. Cut-outs with transparency are PNG.
- Load colour textures with `texture.colorSpace = SRGBColorSpace`; the two water normal maps stay linear (no colour space).
- `pole-stripes.jpg` does **not** repeat cleanly top to bottom (the spiral jumps at the seam): map it once per pole height, or regenerate it.
- `water-normal-1/2.jpg` are already normal maps (blue-purple); scroll them in two directions at different speeds.

## How to generate (read first)

- **Who:** Module 3 (Teammate C) owns `public/assets/`; anyone with a spare ChatGPT or Gemini window can generate in parallel and drop files in.
- **Style line for every image**, append it to each prompt so the set looks like one game: *"golden-hour Venice, warm and slightly stylised, clean readable shapes, no text, no watermark, no people"* (drop "no text" for the logo).
- **Sizes and format:** PNG; textures 1024x1024 unless stated; UI icons 512x512 with a transparent background. If the tool cannot do transparency, ask for a pure #00FF00 background and remove it (remove.bg, or Photoshop/Preview "instant alpha").
- **Check before committing:** tiles have no seams (place two copies side by side), icons read at 64 px, file names exactly as below (the code loads these names).
- **Priority:** Gate 2 needs nothing (the game runs on placeholders). For Gate 3: `sky.hdr`, the plaster/stone/water textures, the HUD icons and the sounds marked MVP first; logo and podium last.

## Sounds (in the repo, generated)

All 22 sounds are **in `public/assets/sounds/` as MP3** and play in the game. They are synthesised by `scripts/generate-sounds.py` (numpy + ffmpeg; `python3 scripts/generate-sounds.py`, or name files to rebuild only those), so there is nothing to download and no licence to track. `src/render/audio.ts` loads them after the host's first click or key press and plays them from the game events.

| File | When it plays |
|---|---|
| `cannon`, `torpedo-launch`, `mortar-launch` | a Gunner fires that weapon |
| `water-cannon` (loop) | while any crew holds FIRE on the Water Cannon; louder with more crews |
| `explosion-water` | a lethal hit, a lethal ram |
| `splash-small` / `splash-big` | Water Cannon hits, misses, sinking, the Wave power |
| `firework-burst` | the Mortar's splash |
| `shield-up` / `shield-hit` | Shield picked up / a hit absorbed |
| `pickup`, `respawn`, `boost` | crate collected, boat back at a dock, Boost used |
| `wood-bump`, `wood-scrape` | hitting walls (louder with speed), rams, dropping a Mine |
| `beep`, `horn` | countdown 3-2-1, battle (and sudden death) starts |
| `lobby-loop` (loop) | lobby and results; fades out for the match. Replaced by the background song when `public/assets/music/background.mp3` exists (git-ignored, see that folder's README): the song plays in every phase, quieter during the match |
| `win-fanfare` | the winner is decided |
| `water-lapping` (loop), `seagulls`, `bells-distant` | ambience all the time; gulls every 15 to 30 s, bells every 50 to 90 s |

Controls: **M** mutes and unmutes on the scene PC (remembered). Dev console: `grAudio.status()`, `grAudio.play('cannon')`.

To use a real recording instead: export it as MP3 (mono, 44.1 kHz, trimmed, peak about -1 dB, loops cut on a zero crossing) and save it under the same name; no code change. Download options if you want recordings:

| File | Used for | Where to get it (search terms) |
|---|---|---|
| `water-lapping.mp3` | ambient loop on the scene | freesound.org "water lapping gentle loop" (CC0 filter); or Kenney "Nature Sounds" pack |
| `seagulls.mp3` | ambient, sparse | freesound.org "seagulls distant" CC0 |
| `bells-distant.mp3` | ambient, every 60 to 90 s | freesound.org "church bells distant" CC0 |
| `cannon.mp3` | Cannon shot | freesound.org "cannon shot" CC0, or Kenney "Impact Sounds" |
| `torpedo-launch.mp3` | Torpedo launch | freesound.org "whoosh underwater" CC0 |
| `mortar-launch.mp3`, `firework-burst.mp3` | Mortar | freesound.org "firework launch", "firework explosion" CC0 |
| `water-cannon.mp3` | stream loop while FIRE is held | freesound.org "hose spray loop" CC0 |
| `splash-small.mp3`, `splash-big.mp3` | cannonball splash, sinking | freesound.org "water splash" CC0 |
| `explosion-water.mp3` | lethal hit | freesound.org "explosion water" CC0 |
| `shield-up.mp3`, `shield-hit.mp3` | Shield | Kenney "Sci-fi Sounds" (CC0) |
| `pickup.mp3` | crate collected | Kenney "Digital Audio" pack |
| `wood-scrape.mp3`, `wood-bump.mp3` | wall scrape, boat bump | freesound.org "wood creak", "boat hull bump" CC0 |
| `horn.mp3` | round start | freesound.org "ship horn" CC0 |
| `beep.mp3` | countdown 3-2-1 | Kenney "UI Audio" |
| `lobby-loop.mp3` | accordion or mandolin loop in the lobby | freemusicarchive.org or pixabay.com music, "italian accordion" (check the licence allows public performance) |
| `win-fanfare.mp3` | podium | pixabay.com sound effects "fanfare" |

Kenney packs: https://kenney.nl/assets (all CC0). Freesound: https://freesound.org (filter licence = Creative Commons 0). Pixabay: https://pixabay.com/sound-effects/ (Pixabay licence, free).

## HDRI (download)

`public/assets/textures/sky.hdr`: Poly Haven, CC0, 2K is enough: "venice_sunset" (literally Venice at golden hour), or "kloppenheim_06" / "spruit_sunrise" as alternatives. https://polyhaven.com/hdris

## Textures (generated, in the repo)

Save as PNG, 1024x1024 unless stated, in `public/assets/textures/`. Ask for **seamless / tileable** where marked; check the tile by placing two copies side by side. Normal maps are better generated from the albedo with a tool (for example https://cpetry.github.io/NormalMap-Online/) than asked from an image model.

| File | Prompt (paste as is) |
|---|---|
| `plaster-ochre.jpg` ✅ (tileable, 1024) | "Seamless tileable texture of weathered Venetian plaster wall, warm ochre colour, flaking paint, faint salt stains, flat even lighting, no shadows, no objects, photographic, top-down orthographic, 1024x1024" |
| `plaster-terracotta.jpg` ✅, `plaster-rose.jpg` ✅, `plaster-cream.jpg` ✅ (tileable, 1024) | same prompt with "terracotta red", "dusty rose pink", "pale cream" |
| `stone-istrian.jpg` ✅ (tileable, 1024) | "Seamless tileable texture of white Istrian limestone blocks with thin mortar joints, slightly worn, flat lighting, orthographic, 1024x1024" |
| `algae-band.jpg` ✅ (tileable horizontally, 1024x256) | "Seamless horizontally tileable strip texture of a canal waterline on a stone wall: dark green algae and black moss fading upward into pale stone, flat lighting, 1024x256" |
| `water-normal-1.jpg` ✅, `water-normal-2.jpg` ✅ (tileable normal maps, 1024) | generated as normal maps directly; the grey ripple albedos they came from are not needed in the game |
| `wood-crate.jpg` ✅ (1024) | "Old wooden shipping crate texture, dark oak planks, iron corner brackets, rope, flat lighting, square, 1024x1024" |
| `wood-dark.jpg` ✅ (tileable, 1024) | "Seamless tileable texture of dark aged wood planks, boat deck, flat lighting, 1024x1024" |
| `pole-stripes.jpg` ✅ (256x1024, cropped to the pole; **not seamless vertically**) | "Seamless vertically tileable texture of a Venetian mooring pole with spiral white and blue stripes, peeling paint, flat lighting, 256x1024" |
| `laundry.png` ✅ (transparent, 2048x452) | "A clothesline with colourful laundry (shirts, sheets, trousers) hanging, front view, isolated on a transparent background, flat lighting, PNG with alpha, 2048x512" |
| `window-gothic.png` ✅ (transparent, 607x1024) | "Venetian gothic arched window with white stone frame, dark glass, green wooden shutters open, front view, isolated on a transparent background, PNG with alpha, 512x1024" |

Tip for both ChatGPT and Gemini: add "no text, no watermark, no people" and, for tiles, "edges must wrap seamlessly". If a tile shows a seam, ask "make the left and right edges, and the top and bottom edges, match exactly".

## ChatGPT brief for Track C (completed image set; prompts for future regeneration)

All 30 files below have now been generated. Keep this brief for future variants;
do not regenerate or replace existing images unless a replacement is requested.
The selected PNGs have real transparency. The original outputs are preserved in
the generator's output directory, with project copies resized to the dimensions
below. The selected logo was simplified to retain the wordmark and one gondola.

```
You are making image assets for a browser party game called Gondola Royale: armed gondolas fight in a stylised 3D Venice at golden hour, seen on a big projector screen.
Style for every image: golden-hour Venice, warm and slightly stylised, clean readable shapes, no watermark, no people, no text unless the item says so.
Icons: flat white shapes with thick strokes, centred, 10% padding, on a fully transparent background (if you cannot do transparency, use a flat pure #00FF00 background).
Give me one image per message, at the size given, and tell me the file name.

1. icon-pilot.png, 512x512: a gondolier with an oar.
2. icon-gunner.png, 512x512: a swivel cannon.
3. icon-engineer.png, 512x512: a bucket with water splashing out.
4. icon-watercannon.png, 512x512: a water hose nozzle with a spray.
5. icon-cannon.png, 512x512: an old ship cannon.
6. icon-torpedo.png, 512x512: a torpedo.
7. icon-mortar.png, 512x512: a fireworks mortar tube with a spark.
8. icon-shield.png, 512x512: a round bubble shield.
9. icon-mine.png, 512x512: a spiked naval mine.
10. icon-boost.png, 512x512: a speed arrow with motion lines.
11. icon-smoke.png, 512x512: a smoke cloud.
12. icon-wave.png, 512x512: a curling wave.
13. crosshair-neutral.png, 256x256: thin white ring with four short ticks.
14. crosshair-enemy.png, 256x256: red diamond outline.
15. crosshair-lock.png, 256x256: double white ring with four corner brackets.
16. logo.png, 2048x1024, transparent: the words GONDOLA ROYALE in bold Venetian carnival lettering, gold with a dark red outline, a small black gondola silhouette under the text (this one has text).
17. favicon.png, 512x512, transparent: square app icon, a black gondola with a glowing golden lantern on a deep teal circle, flat vector style.
18. lobby-bg.jpg, 1920x1080: wide view of a Venetian canal at golden hour, gondolas moored, warm haze, soft focus, darker on the left third so white text stays readable.
19. podium-bg.jpg, 1920x1080: Venetian palace facade at golden hour with a red carpet dock and three wooden podium steps on the water, wide shot.
20. sunk.png, 1024x512, transparent: the word SUNK in chunky wooden carnival letters splashed with water (this one has text).
21-26. team-rosso.png, team-azzurro.png, team-verde.png, team-oro.png, team-viola.png, team-arancio.png, 512x512, transparent: a Venetian pennant flag with a winged lion emblem, flat vector style, in #e04a3a, #3a8fe0, #3fbf5f, #f2b544, #9b5de5, #ff8a2a respectively.
27. lantern-glow.png, 256x256: soft round warm light glow, white centre fading to black edges, no hard rim, on pure black.
28. foam.jpg, 512x512, seamless tileable: white sea foam and bubbles on dark water, top-down, flat lighting.
29. roof-tiles.jpg, 1024x1024, seamless tileable: old terracotta Venetian roof tiles, top-down orthographic, flat lighting.
30. shutters-green.png, 512x1024, transparent: a pair of weathered green wooden Venetian shutters, open, front view, flat lighting.
```

Where each file goes:

| Files | Folder |
|---|---|
| 1 to 16, 18 to 26 (icons, crosshairs, logo, backgrounds, SUNK, team flags) | `public/assets/ui/` |
| 17 `favicon.png` | `public/` |
| 27 to 30 (glow, foam, roof tiles, shutters) | `public/assets/textures/` |

Check before committing: icons read clearly at 64 px, tiles show no seam when two copies sit side by side, transparent PNGs have no grey or green fringe.

## UI and branding images

Save in `public/assets/ui/`.

| File | Prompt |
|---|---|
| `logo.png` (alpha, 2048x1024) | "Game logo text 'GONDOLA ROYALE' in bold Venetian carnival style lettering, gold with dark red outline, a small black gondola silhouette under the text, transparent background, PNG with alpha, no other text" |
| `icon-pilot.png`, `icon-gunner.png`, `icon-engineer.png` (alpha, 512x512) | "Flat white icon on transparent background, simple thick lines, of: a gondolier with an oar / a swivel cannon / a bucket; game HUD style, no text" |
| `icon-cannon.png`, `icon-torpedo.png`, `icon-mortar.png`, `icon-watercannon.png` (alpha, 512x512) | "Flat white icon on transparent background, thick lines, game HUD style, no text, of: a cannon / a torpedo / a fireworks mortar tube / a water hose nozzle" |
| `icon-shield.png`, `icon-mine.png`, `icon-boost.png`, `icon-smoke.png`, `icon-wave.png` (alpha, 512x512) | same style: "a round bubble shield / a spiked naval mine / a speed arrow with motion lines / a smoke cloud / a wave" |
| `crosshair-neutral.png`, `crosshair-enemy.png`, `crosshair-lock.png` (alpha, 256x256) | "Flat white game crosshair on transparent background, thin ring with four short ticks" / "red diamond outline" / "double ring with four corner brackets", no text |
| `podium-bg.jpg` (1920x1080) | "Venetian palace facade at golden hour with a red carpet dock and three wooden podium steps on the water, wide shot, warm light, no people, no text" |
| `phone-bg-pilot.png` etc. (optional) | the phone screens use plain CSS in the team colour; images are not needed |

## Additional images (generated)

| File | Where it goes | Prompt (paste as is, then the style line) |
|---|---|---|
| `public/favicon.png` (512x512, alpha) | browser tab and phone home screen | "Square app icon: a black Venetian gondola with a glowing golden lantern on a deep teal circle, bold simple shapes, flat vector style, transparent background" |
| `ui/lobby-bg.jpg` (1920x1080) | behind the QR in the lobby | "Wide view of a Venetian canal at golden hour, gondolas moored, warm haze, soft focus, darker on the left third so white text on top stays readable" |
| `ui/team-rosso.png` ... `team-arancio.png` (512x512, alpha) | lobby roster and results | "A Venetian pennant flag with a winged lion emblem, colour #e04a3a, flat vector style, transparent background" (repeat with the team hex: Azzurro #3a8fe0, Verde #3fbf5f, Oro #f2b544, Viola #9b5de5, Arancio #ff8a2a) |
| `ui/sunk.png` (1024x512, alpha) | SUNK overlay on the big screen and phones | "The word SUNK in chunky wooden carnival letters, splashed with water, transparent background" (this one keeps its text) |
| `textures/lantern-glow.png` (256x256, alpha) | glow sprite on bow lanterns and crates | "Soft round warm light glow, white centre fading to fully transparent edges, no hard rim, on a black background" (then use the brightness as alpha) |
| `textures/foam.jpg` (tileable, 512x512) | wake foam behind boats | "Seamless tileable texture of white sea foam and bubbles on dark water, top-down, flat lighting" |
| `textures/roof-tiles.jpg` (tileable) | building roofs | "Seamless tileable texture of old terracotta Venetian roof tiles, top-down orthographic, flat lighting" |
| `textures/shutters-green.png` (512x1024, alpha) | instanced window shutters | "Pair of weathered green wooden Venetian shutters, open, front view, flat lighting, transparent background" |

## Sound effects by prompt (alternative to downloading)

If downloading takes too long, generate them with an AI sound-effect tool (for example ElevenLabs Sound Effects). Keep each under 3 s unless it is a loop; export MP3, mono.

| File | Prompt |
|---|---|
| `cannon.mp3` (MVP) | "Old ship cannon firing, deep boom with a short wooden rattle, outdoors over water, 1.5 seconds" |
| `water-cannon.mp3` (MVP) | "Strong water hose spraying in a steady stream, loopable, 2 seconds" |
| `splash-small.mp3` (MVP) | "Cannonball dropping into a canal, single splash, 1 second" |
| `explosion-water.mp3` (MVP) | "Underwater explosion lifting a column of water, then debris splashing down, 2.5 seconds" |
| `pickup.mp3` (MVP) | "Cheerful wooden crate pickup chime, short and bright, 0.5 seconds" |
| `horn.mp3` (MVP) | "Venetian ship horn, one long low blast, 2 seconds" |
| `beep.mp3` (MVP) | "Single clean countdown beep, game UI, 0.3 seconds" |
| `torpedo-launch.mp3` | "Torpedo launched from a small boat, mechanical thunk then bubbling whoosh, 1.5 seconds" |
| `shield-up.mp3`, `shield-hit.mp3` | "Magical bubble shield powering up, shimmering hum, 1 second" / "Energy shield absorbing an impact, glassy zap, 0.8 seconds" |
| `wood-bump.mp3` | "Wooden boat hull bumping a stone wall, dull knock and creak, 0.8 seconds" |
| `water-lapping.mp3` | "Gentle canal water lapping against stone walls, calm, seamless loop, 20 seconds" |
| `seagulls.mp3`, `bells-distant.mp3` | "Distant seagulls over a lagoon, sparse calls, 10 seconds" / "Distant Venetian church bells, two slow rings, 6 seconds" |
| `lobby-loop.mp3` | "Light Italian accordion waltz, cheerful, seamless loop, 30 seconds" |
| `win-fanfare.mp3` | "Short festive brass fanfare for a winner, 3 seconds" |

## Optional videos (Gemini Veo or ChatGPT Sora) for the lobby screen

Not needed for the game; if you want a 10 s loop behind the QR code: "Slow cinematic drone shot over Venice canals at golden hour, gondolas moving, warm haze, loop-friendly, no text, no logos, 10 seconds, 1080p". Save as `public/assets/ui/lobby-loop.mp4`, muted, and keep it under 10 MB.

## 3D models (if you choose GLB crew)

Mixamo (free with an Adobe account): pick "Y Bot" or a casual character, animations "Rowing", "Sitting Idle", "Sitting Aim", "Scooping" (bail), "Hit Reaction", "Falling", "Victory"; export FBX, convert to GLB with Blender (one file per animation, same rig). Put them in `public/assets/models/crew/`. The gondola itself is generated in code (Track C); a free "gondola" GLB from Sketchfab (CC0 filter) is an optional upgrade.
