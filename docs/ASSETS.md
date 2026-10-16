# Assets: sounds to download, images to generate

Everything lives under `public/assets/`. The filenames below are the ones the code should load; keep them so Track C's loaders and the agents agree. Prefer CC0 sources (no attribution needed on the big screen).

## Status (updated 2026-10-16)

| Group | State | Files |
|---|---|---|
| Textures (walls, stone, wood, water, pole, laundry, window) | **In the repo** (`public/assets/textures/`), generated with ChatGPT, resized and cut out | 14 files, see the table in "Textures" below |
| HDRI sky | To download | `public/assets/textures/sky.hdr` |
| UI icons, crosshairs, logo, podium, favicon, lobby background, team flags, SUNK, glow, foam, roof tiles, shutters | **To generate** (Track C) | use the brief in "ChatGPT brief for Track C" below |
| Sounds | To download or generate | `public/assets/sounds/`, tables below |

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

## Sounds (download, CC0)

Put them in `public/assets/sounds/`, OGG or MP3, mono, 44.1 kHz, trimmed, normalised to about -3 dB.

| File | Used for | Where to get it (search terms) |
|---|---|---|
| `water-lapping.ogg` | ambient loop on the scene | freesound.org "water lapping gentle loop" (CC0 filter); or Kenney "Nature Sounds" pack |
| `seagulls.ogg` | ambient, sparse | freesound.org "seagulls distant" CC0 |
| `bells-distant.ogg` | ambient, every 60 to 90 s | freesound.org "church bells distant" CC0 |
| `cannon.ogg` | Cannon shot | freesound.org "cannon shot" CC0, or Kenney "Impact Sounds" |
| `torpedo-launch.ogg` | Torpedo launch | freesound.org "whoosh underwater" CC0 |
| `mortar-launch.ogg`, `firework-burst.ogg` | Mortar | freesound.org "firework launch", "firework explosion" CC0 |
| `water-cannon.ogg` | stream loop while FIRE is held | freesound.org "hose spray loop" CC0 |
| `splash-small.ogg`, `splash-big.ogg` | cannonball splash, sinking | freesound.org "water splash" CC0 |
| `explosion-water.ogg` | lethal hit | freesound.org "explosion water" CC0 |
| `shield-up.ogg`, `shield-hit.ogg` | Shield | Kenney "Sci-fi Sounds" (CC0) |
| `pickup.ogg` | crate collected | Kenney "Digital Audio" pack |
| `wood-scrape.ogg`, `wood-bump.ogg` | wall scrape, boat bump | freesound.org "wood creak", "boat hull bump" CC0 |
| `horn.ogg` | round start | freesound.org "ship horn" CC0 |
| `beep.ogg` | countdown 3-2-1 | Kenney "UI Audio" |
| `lobby-loop.ogg` | accordion or mandolin loop in the lobby | freemusicarchive.org or pixabay.com music, "italian accordion" (check the licence allows public performance) |
| `win-fanfare.ogg` | podium | pixabay.com sound effects "fanfare" |

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

## ChatGPT brief for Track C (the images still to make)

Paste this whole block into one ChatGPT (or Gemini) chat, then ask for the images one at a time ("next image"). Save each with the exact file name, then drop them in the folder shown. ChatGPT often returns JPEG on a grey background even when asked for transparency: that is fine, send the files to whoever has the repo and the background is cut out the same way the window and laundry were (or use remove.bg).

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
| `podium-bg.png` (1920x1080) | "Venetian palace facade at golden hour with a red carpet dock and three wooden podium steps on the water, wide shot, warm light, no people, no text" |
| `phone-bg-pilot.png` etc. (optional) | the phone screens use plain CSS in the team colour; images are not needed |

## More images to generate

| File | Where it goes | Prompt (paste as is, then the style line) |
|---|---|---|
| `public/favicon.png` (512x512, alpha) | browser tab and phone home screen | "Square app icon: a black Venetian gondola with a glowing golden lantern on a deep teal circle, bold simple shapes, flat vector style, transparent background" |
| `ui/lobby-bg.jpg` (1920x1080) | behind the QR in the lobby | "Wide view of a Venetian canal at golden hour, gondolas moored, warm haze, soft focus, darker on the left third so white text on top stays readable" |
| `ui/team-rosso.png` ... `team-arancio.png` (512x512, alpha) | lobby roster and results | "A Venetian pennant flag with a winged lion emblem, colour #e04a3a, flat vector style, transparent background" (repeat with the team hex: Azzurro #3a8fe0, Verde #3fbf5f, Oro #f2b544, Viola #9b5de5, Arancio #ff8a2a) |
| `ui/sunk.png` (1024x512, alpha) | SUNK overlay on the big screen and phones | "The word SUNK in chunky wooden carnival letters, splashed with water, transparent background" (this one keeps its text) |
| `textures/lantern-glow.png` (256x256, alpha) | glow sprite on bow lanterns and crates | "Soft round warm light glow, white centre fading to fully transparent edges, no hard rim, on a black background" (then use the brightness as alpha) |
| `textures/foam.png` (tileable, 512x512) | wake foam behind boats | "Seamless tileable texture of white sea foam and bubbles on dark water, top-down, flat lighting" |
| `textures/roof-tiles.png` (tileable) | building roofs | "Seamless tileable texture of old terracotta Venetian roof tiles, top-down orthographic, flat lighting" |
| `textures/shutters-green.png` (512x1024, alpha) | instanced window shutters | "Pair of weathered green wooden Venetian shutters, open, front view, flat lighting, transparent background" |

## Sound effects by prompt (alternative to downloading)

If downloading takes too long, generate them with an AI sound-effect tool (for example ElevenLabs Sound Effects). Keep each under 3 s unless it is a loop; export OGG or MP3, mono.

| File | Prompt |
|---|---|
| `cannon.ogg` (MVP) | "Old ship cannon firing, deep boom with a short wooden rattle, outdoors over water, 1.5 seconds" |
| `water-cannon.ogg` (MVP) | "Strong water hose spraying in a steady stream, loopable, 2 seconds" |
| `splash-small.ogg` (MVP) | "Cannonball dropping into a canal, single splash, 1 second" |
| `explosion-water.ogg` (MVP) | "Underwater explosion lifting a column of water, then debris splashing down, 2.5 seconds" |
| `pickup.ogg` (MVP) | "Cheerful wooden crate pickup chime, short and bright, 0.5 seconds" |
| `horn.ogg` (MVP) | "Venetian ship horn, one long low blast, 2 seconds" |
| `beep.ogg` (MVP) | "Single clean countdown beep, game UI, 0.3 seconds" |
| `torpedo-launch.ogg` | "Torpedo launched from a small boat, mechanical thunk then bubbling whoosh, 1.5 seconds" |
| `shield-up.ogg`, `shield-hit.ogg` | "Magical bubble shield powering up, shimmering hum, 1 second" / "Energy shield absorbing an impact, glassy zap, 0.8 seconds" |
| `wood-bump.ogg` | "Wooden boat hull bumping a stone wall, dull knock and creak, 0.8 seconds" |
| `water-lapping.ogg` | "Gentle canal water lapping against stone walls, calm, seamless loop, 20 seconds" |
| `seagulls.ogg`, `bells-distant.ogg` | "Distant seagulls over a lagoon, sparse calls, 10 seconds" / "Distant Venetian church bells, two slow rings, 6 seconds" |
| `lobby-loop.ogg` | "Light Italian accordion waltz, cheerful, seamless loop, 30 seconds" |
| `win-fanfare.ogg` | "Short festive brass fanfare for a winner, 3 seconds" |

## Optional videos (Gemini Veo or ChatGPT Sora) for the lobby screen

Not needed for the game; if you want a 10 s loop behind the QR code: "Slow cinematic drone shot over Venice canals at golden hour, gondolas moving, warm haze, loop-friendly, no text, no logos, 10 seconds, 1080p". Save as `public/assets/ui/lobby-loop.mp4`, muted, and keep it under 10 MB.

## 3D models (if you choose GLB crew)

Mixamo (free with an Adobe account): pick "Y Bot" or a casual character, animations "Rowing", "Sitting Idle", "Sitting Aim", "Scooping" (bail), "Hit Reaction", "Falling", "Victory"; export FBX, convert to GLB with Blender (one file per animation, same rig). Put them in `public/assets/models/crew/`. The gondola itself is generated in code (Track C); a free "gondola" GLB from Sketchfab (CC0 filter) is an optional upgrade.
