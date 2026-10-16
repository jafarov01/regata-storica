# Research: the Venice map (`shared/map.ts`)

Scratch folder with every artefact named below: `/private/tmp/claude-502/-Users-makhlugjafarov-cognitex-Documents-regata-storica/69884729-7585-4b5d-ad26-4af5e194adaa/scratchpad/research/map/` (`map.txt`, `validate.mjs`, `gen.mjs`, `annotate.mjs`, `ts/shared/map.ts`, `ts/shared/map.test.ts`, `ts/src/sim/mapPhysics.ts`, `ts/src/render/mapGeometry.ts`, `prove_apis.mjs`, `prove_rotation.mjs`). Nothing in the repo was touched.

## 1. The problem, in the words of the spec

SPEC.md section 7: "One compact, invented district that reads as Venice at a glance: about 400 m x 300 m, crossable in roughly 40 s at full speed." It needs a **main canal** ("a wide S-shaped canal, Canal Grande style, about 30 m wide, cutting across the map. The open fighting lane"), **side canals** ("a grid of about 8 narrow canals, 8 to 10 m wide, with tight bends and a few dead ends. One gondola fits easily, two scrape. Ambush territory"), a **lagoon basin** ("open water along one edge. Big open fights, and the densest cluster of crates, so it pulls teams into fights"), **bridges** ("6 to 8 arched stone bridges plus one large covered bridge at the centre as the main landmark, Rialto style. Boats pass under every bridge"), a **bell tower** ("tall enough to be seen from every viewport, for orientation") and **obstacles** ("wooden pile clusters in the lagoon").

"How the map is built. The whole map is one ASCII grid in shared/map.ts, 8 m per cell, about 50 x 38 cells. Physics builds its walls from the grid, and the renderer builds the buildings from the same grid." Legend: `B` building, `~` water, `=` bridge over water (visual only), `L` lagoon, `S` spawn dock, `C` crate point, `T` landmark tower. "Coordinates: metres, Y up, water surface at y = 0, map origin at the centre. The 2D physics uses (x, z) of the 3D world."

Rules from elsewhere in the spec that the map must serve: respawn "at a random dock ... at least 80 m from every enemy boat (about 16 docks around the map)" (section 5); "Wooden crates float at about 24 fixed points" (section 6); the minimap "shows an enemy only for 2 s after it fires, or while it is in the open lagoon" (section 7); top speed 10 m/s, 16 m/s with Boost (section 8); `shared/map.ts` is a contract file, "written together in the base phase, then read-only for every agent" (section 11).

## 2. Decisions, why, and what was rejected

| Decision | Why | Rejected |
|---|---|---|
| **Grid 50 x 38, 8 m cells = 400 x 304 m.** The border is one ring of `B`. | Exactly the spec's size. The border ring gives the physics a closed box for free. | A separate "world bounds" collider: one more thing to keep in step with the grid. |
| **Legend extended with `R` (covered bridge, water for physics) and `P` (pile cluster, solid circle).** | The spec asks for a Rialto-style covered bridge and pile clusters but has no chars for them. `R` as a 2 x 4 block gives the renderer a roofed deck 16 m deep spanning the full 32 m canal; `P` is a 2.5 m-radius ball so boats slip around it. | Encoding the Rialto as `=` cells: the renderer could not tell it apart. A full solid `P` cell (8 x 8 m) is a block, not a cluster of poles. |
| **Main canal 4 cells (32 m) wide on the straights, a reversed S like the real Canal Grande:** west mouth (rows 6-9) east to col 29, a 45-degree run south-west to a hairpin at col 13, then east (rows 23-26) under the covered bridge into the bacino. | "About 30 m" and the real canal is 30-90 m wide (Wikipedia). The 45-degree run is painted 5 cells tall per column: every cell of it is inside a 3 x 3 all-water window, so the perpendicular width never drops below 24 m (5/sqrt 2 = 3.5 cells = 28 m). The hairpin gives the long lane two blind corners. | 90-degree stair bends: the inside corner cuts to 24 m and reads as a staircase. A main canal running north-south: with the lagoon on one side the long sides of the map should carry the lane. |
| **Lagoon along the east edge: a 7-cell strip (56 m) for the full height plus a 5 x 15 bacino bulge in front of the canal mouth** (307 `L` cells, 328 with the markers on it). | "Open water along one edge". The bulge is where the Canal Grande meets the bacino in Venice; 12 cells (96 m) of open water at the mouth is where the big fights go. The border column behind it is still `B` (physics) but `lagoonEdge: 'east'` tells the renderer to draw it as a breakwater, not houses. | A lagoon along the south edge under the hairpin: it would make the quiet SW quarter the hot zone and put the covered bridge next to open water. |
| **Eight side-canal networks, 215 cells (1.7 km), 31 tight bends, 19 mouths, 3 dead ends.** All 1 cell (8 m) wide: a 6 m x 1.4 m gondola "fits easily, two scrape". | Each rio links two different thick-water places (so hunters can loop, nobody is forced to turn around in 8 m), except three spurs that end in a pocket with a crate or a quiet dock. | 2-cell rii (16 m): two boats pass, the ambush feel is gone; the validator refuses any 2-wide water outside the main canal and lagoon. More than 4 dead ends: boats respawning or fleeing into them get cornered too often. |
| **Covered bridge `R` at cols 26-27, rows 23-26** (centre x = 16 m, z = 48 m, 51 m from the origin): deck north-south, span 32 m, depth 16 m. **Tower `T` at (19, 22)** (x = -44 m, z = 28 m), on the tip of the wedge between the diagonal and the lower arm, water on three sides. | Both central; both on the lower arm so a boat coming out of the hairpin sees the tower and then passes under the Rialto. The real Rialto spans about 28.8 m and is about 22.9 m wide (Structurae), so 32 x 16 m at 8 m resolution reads right. | Tower inside a block: it would be visible but no boat could pass it closely. |
| **16 docks** (4 / 4 / 3 / 5 per quadrant), never adjacent, each beside a `B` quay, heading derived (section 3.3). | Monte Carlo (4000 random 5-enemy layouts) shows 100 % always have a dock 80 m or more from every enemy, 7.3 candidates on average; the farthest water cell from any dock is 96 m. | Docks only along the main canal: the respawn rule then fails whenever a fight sits mid-canal. |
| **24 crates: 12 in the lagoon (7 of them in one 40 m cluster in the bacino), 6 on the main canal, 6 in the rii and dead-end pockets.** | Lagoon density 3.66 per 100 cells vs 2.47 elsewhere, and the biggest cluster is in the bacino: the pull the spec wants. Every crate is at most 136 m of water from the nearest dock. | Equal spread: nothing pulls teams into the open. |
| **Walls = greedy rectangle merge of `B` and `T` cells** (69 rectangles for 1082 solid cells, 15.7 cells each); `P` = ball colliders. | 69 cuboids instead of 1082 keeps the broad phase trivial and gives the renderer 69 blocks to decorate. Merging `T` into a block is correct for physics; the tower position is exported separately for the renderer. | Per-cell colliders: 1082 cuboids and visible "seams" in the bounce. A trimesh from the water outline: more code, and Rapier trimeshes are hollow, boats inside would not be pushed out. |
| **Coordinates: origin at the centre, row 0 at negative z (north, the far side), col 0 at negative x (west). Heading = Rapier rotation angle, 0 = +x, +PI/2 = +z.** | One rule for everybody: Rapier's (x, y) is the world's (x, z), so `body.rotation()` is the heading and `mesh.rotation.y = -heading` (three.js `makeRotationY` maps +x to (cos, 0, -sin), proved in `prove_apis.mjs`). | Row 0 at positive z: then the text on screen is upside down compared to the top-down minimap. |
| **Parsing throws `MapError` at import time for structural breakage** (ragged lines, unknown chars, border, water in more than one region, missing tower/lagoon/R, a dock without a quay, a pile not in water); **the design checks live in `shared/map.test.ts`** (vitest). | A broken edit by any track fails `npm run dev` and `npm test` within a second. The heavy checks (diameter, density, Monte Carlo) cost about 100 ms, too much for import. | Only a test: a bad merge would reach the demo PC. |

### Measured numbers (from `validate.mjs`, section 5 has the full output)

- Water 814 cells (43 %): main canal 275 cells (81 % of it inside a 4 x 4 water window; 24 m minimum by construction), rii 215 cells = 1720 m, lagoon 307 `L` (mask 328).
- Side canal networks 8 (lengths 24, 30, 95, 20, 11, 8, 19, 8 cells); bends 31; mouths 19; dead ends 3 at (15,1), (14,14), (8,22).
- Bridges: 7 arches (3 over the main canal at cols 9, 20 and 35; 4 over rii) + 1 covered. Tower 52 m from the centre.
- Docks 16, crates 24 (12 in the lagoon), piles 4.
- Longest shortest water path (network diameter): 77 cells = 616 m = 62 s at 10 m/s, between the west mouth (1,6) and the lagoon's far corner (48,36). That is exactly the Manhattan distance between the grid's opposite corners (47 + 30), so no shorter network is possible without shrinking the map. The main canal itself is 64 cells (512 m, 51 s) from west mouth to lagoon mouth; the quickest west-to-lagoon crossing uses the N2 rio: 45 cells = 360 m = 36 s, which is the spec's "roughly 40 s".
- Wall rectangles 69, plus 4 pile circles.

## 3. The map, the parser and the algorithms

### 3.1 The map (`map.txt`, 38 lines of 50 chars; the same text sits in `MAP_TEXT` in `shared/map.ts`)

```text
<<MAP>>
```

Annotated rendering (column ruler on top and bottom, row numbers both sides; the second block shows `B` as `#`, canal water as space, lagoon as `.`):

```text
<<ANNOTATED>>
```

**Reading it as a district.** The Canal Grande enters at the west (rows 6-9, under two arches at cols 9 and 20), bends south at col 29 past the bend dock (29,10), runs 45 degrees south-west past the dock at (23,13) and the crate at (26,12), reaches the hairpin at col 13-15 (the quietest part of the lane, with the dock (15,26)) and heads east along rows 23-26, past the campanile at (19,22), under the covered bridge (cols 26-27) and the arch at col 35, into the bacino (cols 37-41, rows 17-31) and the lagoon strip.

Named rii (all 8 m wide; the names are only for the design notes):

| Network | Cells | Route | Role |
|---|---|---|---|
| N1 Rio Nord | (7,5)-(7,3)-(24,3)-(24,5), spur (15,2)-(15,1) | loop north of the upper arm, two mouths into it, arch at (11,3), dock (20,3), crate in the dead end (15,1) | a bypass: overtake or ambush anyone fighting in the upper arm |
| N2 + N3 Rio dei Greci | (30,8)-(35,8)-(35,12)-(41,12) and (41,3)-(32,3)-(32,7) | from the bend to the lagoon, with a second loop round the NE block, dock (38,12), crate (32,5) | the fastest route west mouth to lagoon (36 s); the loop lets a chased boat circle |
| W1 Rio di San Polo | (5,10)-(5,16)-(8,16)-(8,20)-(12,20)-(12,24) | upper arm to the hairpin tip, 4 bends, arch (5,13), dock (7,16) | shortcut across the S; the mouth at (12,24) looks straight at the tower |
| W2 Rio dei Mendicanti | (12,10)-(12,14)-(10,14)-(10,17)-(17,17)-(17,18), spur (14,14)-(14,16) | upper arm to the diagonal, crate in the pocket (14,14) | second shortcut, the pocket is a hiding spot with bait |
| W3 + S1 + S4 (one network, 95 cells) | (4,17)-(4,33)-(13,33)-(13,30)-(18,30)-(18,27); link (5,17); spur (5,22)-(8,22); S4 (41,34)-...-(14,33) | the west and south ring: docks (8,22) in the quiet spur, (10,33), (26,33); arches (13,31); crates (4,31), (36,34) | the long way round the back; where respawns land when the lagoon is hot |
| S2 Rio dei Tolentini | (22,27)-(22,30)-(26,30)-(26,31)-(36,31) | lower arm to the bacino, arch (31,31) | ambush exit onto the bacino crate cluster |
| S3 Rio Corto | (31,27)-(31,29)-(36,29) | lower arm to the bacino | a 9-cell dash to the lagoon |
| E1 Rio del Campanile | (27,14)-(27,17)-(30,17)-(30,22) | diagonal to the lower arm, crate (28,17) | cuts the corner of the S |
| E2 Rio dell'Arsenale | (36,18)-(33,18)-(33,22) | bacino to the lower arm | second mouth onto the bacino next to dock (36,23) |

**Fight flow.** The lagoon holds half the crates (12, with 7 within 40 m of each other in the bacino), so every life starts with a run to the open water; the bacino is where 4 to 6 boats meet with nowhere to hide and where the minimap shows everyone. The lower arm (rows 23-26) is the second lane: it feeds the bacino through its mouth, through S2, S3 and E2, so a team leaving the lagoon has four exits to choose and four doors to watch. The upper arm is the sniper lane (240 m straight, two arches to duck behind); N1 above it is the counter: a boat in N1 pops out of either mouth behind a boat camping the arm. The diagonal with the tower is the connecting hall; W1, W2 and E1 are the ambush rii across it, each with a bend that hides the boat until the last 16 m. Dead ends are deliberate traps: a pocket with a crate at (15,1) and (14,14) and the quiet dock spur at (8,22). The far west and south (W3/S1/S4) is where the respawn rule puts boats when the fight is in the east: 4 docks there are 160 m or more from the bacino.

### 3.2 Parser: `shared/map.ts` (typechecks under the repo's tsconfig with `noUnusedLocals`/`noUnusedParameters` added)

```ts
<<MAP_TS>>
```

### 3.3 Algorithms in words

**Coordinates.** `x = (col - W/2 + 0.5) * 8`, `z = (row - H/2 + 0.5) * 8`; the inverse is `col = floor(x / 8 + W/2)`, `row = floor(z / 8 + H/2)`, clamped. Cell (0,0) is centred at (-196, -148), cell (49,37) at (196, 148). Y is up, the water is y = 0, row 0 is north = negative z (the far side of the default camera). A boat's cell is taken from its centre; a 6 m boat is always within one cell of its centre cell.

**Heading convention.** `heading` is the Rapier 2D rotation angle: forward = (cos h, sin h) in (x, z), so 0 = east, +PI/2 = south, PI = west, -PI/2 = north. Proof: a collider placed 1 m along the body's local +x ends up at (cos 0.7, sin 0.7) after `RigidBodyDesc.fixed().setRotation(0.7)` (`prove_rotation.mjs`). For three.js, `mesh.rotation.y = -heading` (`makeRotationY(t)` sends +x to (cos t, 0, -sin t), `prove_apis.mjs`).

**Dock heading (face away from the quay into open water).**
1. `v = sum over B/T 4-neighbours of (dock - neighbour)`: a vector pointing away from the quays. A dock with the quay to its south gets v = (0, -1) = north.
2. Among the navigable 4-neighbours pick the direction with the largest `dot(dir, v)`.
3. Ties, including v = 0 (a dock in a 1-wide rio with quays on both sides), go to the direction with the most water ahead (count up to 3 cells), then to the fixed order E, W, S, N. Example: dock (7,16) in W1 has quays north and south, water 2 cells to the west and 1 to the east, so it faces west (180 degrees). Result for all 16 docks: `(20,3) 0, (14,6) 90, (42,6) 0, (29,10) 180, (38,12) 0, (23,13) 0, (7,16) 180, (37,17) 0, (8,22) 180, (36,23) 90, (15,26) -90, (30,26) -90, (38,31) -90, (10,33) 0, (26,33) 0, (42,35) 0` degrees. The test checks the cell one step along the heading is never a building.

**Lagoon mask (minimap reveal).** Flood fill from every `L` through `L`, `C`, `S`, `P`. Crates and docks that sit on lagoon water are lagoon cells (the crate at (43,21) is `C` in the text but `isLagoon` is true there); a dock at the canal mouth such as (36,23), adjacent to the bacino, counts as lagoon too, which is right for a spawn with 3 s of protection. `isLagoon(x, z)` is one array read.

**Greedy wall merge.** Scan row-major; at the first unused `B`/`T` cell extend right while cells are solid and unused (width w), then extend down while the whole w-wide strip is solid and unused (height h); mark the rectangle used; emit centre + full size in metres. It is not the minimum rectangle cover but it covers every solid cell exactly once (the test sums the areas: 1082 cells) and yields 69 rectangles, the largest 24 x 168 m (the west border strip) and 400 x 8 m (the north border). Rapier wants half extents: `ColliderDesc.cuboid(w / 2, d / 2).setTranslation(x, z)` (verified in the installed `rapier.d.ts`: `cuboid(hx, hy)`, "half-width along its local x/y axis").

**Bridges.** Connected components of `=` and of `R`. A component must be a filled rectangle. The deck axis is the one with `B` at both ends (for a 1-cell arch over a rio that is unambiguous; a 1 x 4 column over the main canal has `B` above and below). `length` = span across the water in metres, `width` = depth along the canal. The renderer puts the deck 4 m above the water so a gondola with its bow lantern passes under.

**Width classes (validator and test).** `thick` = inside a 3 x 3 all-water window, `wide2` = inside a 2 x 2 window, `thin` = not inside any 2 x 2 window. Main canal = thick cells outside the lagoon mask, plus 2 x 2-covered cells touching it (the rounded hairpin tip). Side canals = thin cells. Any other water (2-wide blobs) is a design error and fails the check. Dead end = thin cell with exactly one navigable neighbour. Bend = thin cell with two perpendicular navigable neighbours.

**Distances.** Breadth-first search over 4-connected water, 8 m per step; the diameter is the maximum over all 814 sources (814 x 814 is instant). Monte Carlo for the respawn rule: 4000 layouts of 5 enemies on random water cells, count docks 80 m or more from all five (Euclidean, cell centres).

### 3.4 Design tests: `shared/map.test.ts` (vitest; 12 tests, 205 ms)

```ts
<<MAP_TEST_TS>>
```

### 3.5 Consumers (typechecked with the same tsconfig; paste when the tracks start)

`src/sim/mapPhysics.ts` (track B):

```ts
<<MAP_PHYSICS_TS>>
```

`src/render/mapGeometry.ts` (track C; placeholder boxes, instanced):

```ts
<<MAP_GEOMETRY_TS>>
```

### 3.6 The standalone validator (`validate.mjs`, plain Node, no dependencies)

Kept outside the repo as a design tool; the vitest file is the in-repo version of the same checks. Run with `node validate.mjs path/to/map.txt`.

```js
<<VALIDATE_MJS>>
```

## 4. Edge cases and how they are handled

| Case | Handling |
|---|---|
| A line in `MAP_TEXT` is shorter or longer (a dropped char in a merge) | `parseMap` throws `MapError: row r has n chars, expected 50` at import time; `npm run dev` fails to load the scene and `npm test` fails. |
| Unknown char (tab, `O` for `0`, Windows `\r`) | `\r` is stripped and trailing spaces trimmed; any other char throws with row/col. |
| Comment lines and blank lines inside the literal | Lines starting with `#` and empty lines are skipped, so the legend can stay in the text. |
| A `B` painted in the border breaks it, or a water cell on the border | Border must be all `B`; a water cell on the border would let a boat leave the world. Throws. |
| Two water regions (an edit seals a rio) | Flood fill from one water cell must reach all 814; throws naming the first cut-off cell. A crate or dock in a sealed region would be unreachable otherwise. |
| A dock with no `B` neighbour (floating in the canal) | Throws: no quay, no heading. A dock next to a `T` counts the tower as a quay for the heading but still needs a `B` neighbour (the design rule). |
| A dock sealed on all sides | `dockHeading` throws before that (no navigable neighbour). |
| Dock in a 1-wide rio with quays both sides (`v = 0`) | Tie-break by water ahead, then E, W, S, N; it always faces along the rio. |
| Dock at a dead end (8,22) | Quays on three sides; `v` points out of the pocket, so the boat spawns facing the exit, reverse never needed. |
| Two docks adjacent, a crate next to a dock | Not a parse error (the sim could tolerate it) but a design error: the test asserts Chebyshev distance >= 2 between docks; the validator also checks crates vs docks and crates vs crates. |
| Respawn rule finds no dock 80 m from every enemy | Possible only in adversarial layouts (Monte Carlo found none in 4000 random ones, minimum 1 candidate). `respawnCandidates` falls back to the single farthest dock so the sim never stalls. |
| Boat centre exactly on a cell edge (x = -0.1 vs 3.9) | `floor` puts -0.1 in col 24 and 3.9 in col 25; the test pins both. |
| Position outside the grid (a physics explosion) | `colOf`/`rowOf` clamp; `cellAt` returns `B`; `isLagoon` false; the sim should also clamp the body, the border colliders normally prevent it. |
| Crate or dock on lagoon water is `C`/`S` in the text, not `L` | The lagoon mask floods through `C`, `S`, `P`, so `isLagoon` is still true there. A crate at a rio mouth touching the bacino counts as lagoon: acceptable (it is in the open). |
| Bridge `=` over the main canal must span the full width | Each column of a bridge component needs `B` at both ends; a 3-cell bridge over a 4-cell canal fails ("abutment missing"). |
| Bridge touching another bridge | They would merge into one component and fail the rectangle/abutment rule; keep one cell of water between them. |
| `R` deeper than 3 cells or narrower than the canal | Design check: depth 2..3, span 3..5, every `R` cell inside the main canal, centre within 80 m of the origin. |
| A `P` touching a building or outside the lagoon | Throws at parse (surrounded by water) and the test checks the lagoon mask; two adjacent `P` fail the validator. |
| `T` painted on water, or two towers | Exactly one `T`; the generator refuses to paint `T` on water; a `T` that touches no `B` is flagged by the validator (a tower needs a block). |
| The renderer draws the east border as a wall of houses behind the lagoon | `lagoonEdge: 'east'`: the track C code draws that border column as a breakwater/diga and extends the water plane beyond it; physics keeps the `B` ring. |
| Boats in the 45-degree run see "stair" walls | Each step is 8 m; at 10 m/s that is 0.8 s per step, the same cadence as the real canal's facades. The renderer may chamfer the steps (a diagonal facade per step cell) without touching the physics rectangles. |
| 2-wide water sneaks in (a rio drawn next to another) | Validator and test: every water cell outside lagoon/main must be thin; the rounded hairpin tip is the only allowed 2 x 2 island because it touches the thick canal. |
| Side-canal count changes when a link is added (components merge) | Expected: W3+S1+S4 are one 95-cell network by design; the test allows 6..12 networks and checks length, bends and dead ends instead of an exact count. |
| Crates respawn with drift ("light bodies that drift") | Crate spawn points are cells; the sim respawns at the cell centre and may clamp the body back into the cell when it drifts more than 4 m, so a crate cannot drift under a bridge abutment. |
| Map size other than 50 x 38 (an alternative map for a rematch) | `parseMap` is size-agnostic (>= 8 x 8); all helpers read `map.width/height/cell`; only the test pins 50 x 38 for this district. |

## 5. How to test on day one

**Without phones (and before the sim exists):**

1. `node validate.mjs` in the scratch folder (or `npm test` once `shared/map.test.ts` is in). Expected output today:

```text
<<VALIDATE_OUT>>
```

2. `npx tsx -e "import('./shared/map.ts').then(m => console.log(m.MAP.walls.length, m.MAP.docks.length))"` from the repo root prints `69 16` (tsx is installed; the alias is not needed for a relative import).
3. In the scene's keyboard harness (SPEC section 1, "every role can be played from the scene PC keyboard"): a debug key `M` toggles a top-down orthographic camera over the whole map with the wall rectangles drawn as wireframe boxes, docks as arrows along their heading, crates as dots, and the lagoon mask tinted. One glance confirms orientation (row 0 far/north), the headings, and that no rectangle overlaps water. The placeholder `buildDistrict()` is enough for this; no textures needed.
4. Drive a box boat with the keyboard: from dock (15,26) (x = -76, z = 60, heading north) gas forward: the boat must hit the north wall of the lower arm after about 4 cells (32 m) and bounce (restitution 0.3). Turn east and drive under the covered bridge at x = 16: no collision (R is water for physics). Enter the rio at (22,27) (x = -20, z = 68): the walls are 8 m apart, the 1.4 m boat passes and scrapes on turns.
5. Run `respawnCandidates(MAP, enemies, 80)` with enemies parked in the bacino at (41,24): candidates must exclude docks (36,23), (37,17), (38,31) and include every western dock.
6. Minimap rule: `isLagoon(MAP, 140, -100)` (dock (42,6)) is true, `isLagoon(MAP, -190, 0)` false.
7. Frame-rate budget for track C: 69 instanced boxes + 8 bridges + 20 posts is one draw call each; measure with 4 viewports as the spec demands before adding facades.

**With phones (Gate 1 and after):** nothing map-specific changes; the pilot steering test uses the same keyboard-harness scene with the map loaded. For Gate 2 (4 teams, 5-minute match) watch three map numbers on the scoreboard overlay: average time from respawn to first crate (target under 10 s; the farthest crate from a dock is 136 m = 14 s), share of kills in the lagoon mask (target 40-60 %; if higher, move two crates out of the bacino), and respawns that used the fallback dock (target 0). Tune by editing `MAP_TEXT` and re-running `npm test`; the map is data, not code.

## 6. Sources

- SPEC.md sections 5, 6, 7, 8, 11 (`/Users/makhlugjafarov_cognitex/Documents/regata-storica/SPEC.md`).
- Installed typings read for every API claim: `node_modules/@dimforge/rapier2d-compat/dist/init.d.ts` (`init(): Promise<void>`), `dist/geometry/collider.d.ts` lines 681-833 (`ColliderDesc.ball(radius)`, `ColliderDesc.cuboid(hx, hy)` "half-width", `setTranslation(x, y)`, `setRotation(rot: Rotation)`, `setFriction`, `setRestitution`), `dist/dynamics/rigid_body.d.ts` (`RigidBodyDesc.fixed()`, `.dynamic()`, `.setTranslation(x, y)`, `.setRotation(rot)`, `RigidBody.rotation(): number`, `setLinvel`), `dist/pipeline/world.d.ts` (`new World(gravity)`, `createRigidBody`, `createCollider(desc, parent?)`, `step()`), `dist/math.d.ts` line 26 (`export declare type Rotation = number`). three 0.186.1: `src/math/Matrix4.js` `makeRotationY` (c, 0, s / -s, 0, c), `build/three.core.js` `InstancedMesh.setMatrixAt`, `BoxGeometry`.
- Proof scripts run with node 24.15 against the installed packages: `prove_apis.mjs` (Rapier 0.21.0 init, fixed cuboid wall stops a 10 m/s ball at x = 2.78 m; three `makeRotationY(0.5)` sends (1,0,0) to (0.8776, 0, -0.4794)); `prove_rotation.mjs` (collider 1 m along local +x of a body with rotation 0.7 lands at (0.7648, 0.6442) = (cos, sin)).
- Rapier user guide, rigid bodies (JavaScript): 2D rotation is a single number, angular velocity in rad/s: https://rapier.rs/docs/user_guides/javascript/rigid_bodies
- Grand Canal width 30 to 90 m: https://en.wikipedia.org/wiki/Grand_Canal_(Venice) ; Britannica gives 30 to 70 m and places the Rialto at the narrowest point: https://www.britannica.com/print/article/502009
- Rialto Bridge main span 28.80 m, deck width 22.90 m: https://structurae.net/en/structures/rialto-bridge ; https://en.wikipedia.org/wiki/Rialto_Bridge
