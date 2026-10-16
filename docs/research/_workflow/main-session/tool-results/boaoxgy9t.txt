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
BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB
BBBBBBBBBBBBBBBCBBBBBBBBBBBBBBBBBBBBBBBBBBLLLLLLLB
BBBBBBBBBBBBBBB~BBBBBBBBBBBBBBBBBBBBBBBBBBLLLLLLLB
BBBBBBB~~~~=~~~~~~~~S~~~~BBBBBBB~~~~~~~~~~LLCLLLLB
BBBBBBB~BBBBBBBBBBBBBBBB~BBBBBBB~BBBBBBBBBLLLLLLLB
BBBBBBB~BBBBBBBBBBBBBBBB~BBBBBBBCBBBBBBBBBLLLPLLLB
B~~~~~~~~=~~~~S~~~~~=~~~~~~~~~BB~BBBBBBBBBSLLLLLLB
B~~~~~~~~=~~~~~~~~C~=~~~~~~~~~BB~BBBBBBBBBLLLLLLLB
B~~~~~C~~=~~~~~~~~~~=~~~~~~~~~~~~~~~BBBBBBLLLLLLLB
B~~~~~~~~=~~~~~~~~~~=~~~~~~~~~BBBBB~BBBBBBLLLLCLLB
BBBBB~BBBBBB~BBBBBBBBBBBBB~~~SBBBBB~BBBBBBLLLLLLLB
BBBBB~BBBBBB~BBBBBBBBBBBB~~~~~BBBBB~BBBBBBLLLLLLLB
BBBBB~BBBBBB~BBBBBBBBBBB~~C~~BBBBBB~~~S~~~LLLLLLLB
BBBBB=BBBBBB~BBBBBBBBBBS~~~~BBBBBBBBBBBBBBLLLLLLLB
BBBBB~BBBB~~~BCBBBBBBB~~~~~~BBBBBBBBBBBBBBLCLLLLLB
BBBBB~BBBB~BBB~BBBBBB~~~~~B~BBBBBBBBBBBBBBLLLLLLLB
BBBBB~~S~B~BBB~BBBBB~~~~~BB~BBBBBBBBBBBBBBLLLLPLLB
BBBB~~BB~B~~~~~~~~B~~~~~BBB~C~~BBBBBBSLLLLLLLLLLLB
BBBB~BBB~BBBBBBBB~~~~~~BBBBBBB~BB~~~~LLLLLLLLLLLLB
BBBB~BBB~BBBBBBBB~~~C~BBBBBBBB~BB~BBBLLLLLLLLLLLLB
BBBB~BBB~~~~~BBB~~~~~BBBBBBBBB~BB~BBBLLCLLLLLLLLLB
BBBB~BBBBBBB~BB~~~~~BBBBBBBBBB~BB~BBBLLLLLLCLLLLLB
BBBB~~~~SBBB~B~~~~~TBBBBBBBBBB~BB~BBBLLLLLLLLLLLLB
BBBB~BBBBBBB~B~~~~~~~~~~~~RR~~~~~~~=SLLLLCLLLLLLLB
BBBB~BBBBBBB~~~~~~~~~~C~~~RR~~~~~~~=~LPLLLLLLCLLLB
BBBB~BBBBBBBB~~~~~~~~~~~~~RR~~~~~C~=~LLLLLLLLLLLLB
BBBB~BBBBBBBBB~S~~~~~~~~~~RR~~S~~~~=~LLCLLLLLLLLLB
BBBB~BBBBBBBBBBBBB~BBB~BBBBBBBB~BBBBBLLLLLLCLLLLLB
BBBB~BBBBBBBBBBBBB~BBB~BBBBBBBB~BBBBBLLLLLLLLLLLLB
BBBB~BBBBBBBBBBBBB~BBB~BBBBBBBB~~~~~~LLLLCLLLPLLLB
BBBB~BBBBBBBB~~~~~~BBB~~~~~BBBBBBBBBBLLLLLLLLLLLLB
BBBBCBBBBBBBB=BBBBBBBBBBBB~~~~~=~~~~~LSLLLLLLLLCLB
BBBB~BBBBBBBB~BBBBBBBBBBBBBBBBBBBBBBBBBBBBLLLLLLLB
BBBB~~~~~~S~~~~~BBBBBBB~~~S~~~~~BBBBBBBBBBLLCLLLLB
BBBBBBBBBBBBBBB~~~~~~~~~BBBBBBB~~~~~C~~~~~LLLLLLLB
BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBSLLLLLLB
BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBLLLLLLLB
BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB
```

Annotated rendering (column ruler on top and bottom, row numbers both sides; the second block shows `B` as `#`, canal water as space, lagoon as `.`):

```text
    0         1         2         3         4         
    01234567890123456789012345678901234567890123456789
 0  BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB   0
 1  BBBBBBBBBBBBBBBCBBBBBBBBBBBBBBBBBBBBBBBBBBLLLLLLLB   1
 2  BBBBBBBBBBBBBBB~BBBBBBBBBBBBBBBBBBBBBBBBBBLLLLLLLB   2
 3  BBBBBBB~~~~=~~~~~~~~S~~~~BBBBBBB~~~~~~~~~~LLCLLLLB   3
 4  BBBBBBB~BBBBBBBBBBBBBBBB~BBBBBBB~BBBBBBBBBLLLLLLLB   4
 5  BBBBBBB~BBBBBBBBBBBBBBBB~BBBBBBBCBBBBBBBBBLLLPLLLB   5
 6  B~~~~~~~~=~~~~S~~~~~=~~~~~~~~~BB~BBBBBBBBBSLLLLLLB   6
 7  B~~~~~~~~=~~~~~~~~C~=~~~~~~~~~BB~BBBBBBBBBLLLLLLLB   7
 8  B~~~~~C~~=~~~~~~~~~~=~~~~~~~~~~~~~~~BBBBBBLLLLLLLB   8
 9  B~~~~~~~~=~~~~~~~~~~=~~~~~~~~~BBBBB~BBBBBBLLLLCLLB   9
10  BBBBB~BBBBBB~BBBBBBBBBBBBB~~~SBBBBB~BBBBBBLLLLLLLB  10
11  BBBBB~BBBBBB~BBBBBBBBBBBB~~~~~BBBBB~BBBBBBLLLLLLLB  11
12  BBBBB~BBBBBB~BBBBBBBBBBB~~C~~BBBBBB~~~S~~~LLLLLLLB  12
13  BBBBB=BBBBBB~BBBBBBBBBBS~~~~BBBBBBBBBBBBBBLLLLLLLB  13
14  BBBBB~BBBB~~~BCBBBBBBB~~~~~~BBBBBBBBBBBBBBLCLLLLLB  14
15  BBBBB~BBBB~BBB~BBBBBB~~~~~B~BBBBBBBBBBBBBBLLLLLLLB  15
16  BBBBB~~S~B~BBB~BBBBB~~~~~BB~BBBBBBBBBBBBBBLLLLPLLB  16
17  BBBB~~BB~B~~~~~~~~B~~~~~BBB~C~~BBBBBBSLLLLLLLLLLLB  17
18  BBBB~BBB~BBBBBBBB~~~~~~BBBBBBB~BB~~~~LLLLLLLLLLLLB  18
19  BBBB~BBB~BBBBBBBB~~~C~BBBBBBBB~BB~BBBLLLLLLLLLLLLB  19
20  BBBB~BBB~~~~~BBB~~~~~BBBBBBBBB~BB~BBBLLCLLLLLLLLLB  20
21  BBBB~BBBBBBB~BB~~~~~BBBBBBBBBB~BB~BBBLLLLLLCLLLLLB  21
22  BBBB~~~~SBBB~B~~~~~TBBBBBBBBBB~BB~BBBLLLLLLLLLLLLB  22
23  BBBB~BBBBBBB~B~~~~~~~~~~~~RR~~~~~~~=SLLLLCLLLLLLLB  23
24  BBBB~BBBBBBB~~~~~~~~~~C~~~RR~~~~~~~=~LPLLLLLLCLLLB  24
25  BBBB~BBBBBBBB~~~~~~~~~~~~~RR~~~~~C~=~LLLLLLLLLLLLB  25
26  BBBB~BBBBBBBBB~S~~~~~~~~~~RR~~S~~~~=~LLCLLLLLLLLLB  26
27  BBBB~BBBBBBBBBBBBB~BBB~BBBBBBBB~BBBBBLLLLLLCLLLLLB  27
28  BBBB~BBBBBBBBBBBBB~BBB~BBBBBBBB~BBBBBLLLLLLLLLLLLB  28
29  BBBB~BBBBBBBBBBBBB~BBB~BBBBBBBB~~~~~~LLLLCLLLPLLLB  29
30  BBBB~BBBBBBBB~~~~~~BBB~~~~~BBBBBBBBBBLLLLLLLLLLLLB  30
31  BBBBCBBBBBBBB=BBBBBBBBBBBB~~~~~=~~~~~LSLLLLLLLLCLB  31
32  BBBB~BBBBBBBB~BBBBBBBBBBBBBBBBBBBBBBBBBBBBLLLLLLLB  32
33  BBBB~~~~~~S~~~~~BBBBBBB~~~S~~~~~BBBBBBBBBBLLCLLLLB  33
34  BBBBBBBBBBBBBBB~~~~~~~~~BBBBBBB~~~~~C~~~~~LLLLLLLB  34
35  BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBSLLLLLLB  35
36  BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBLLLLLLLB  36
37  BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB  37
    01234567890123456789012345678901234567890123456789
    0         1         2         3         4         

    0         1         2         3         4         
 0  ##################################################
 1  ###############C##########################.......#
 2  ############### ##########################.......#
 3  #######    =        S    #######          ..C....#
 4  ####### ################ ####### #########.......#
 5  ####### ################ #######C#########...P...#
 6  #        =    S     =         ## #########S......#
 7  #        =        C =         ## #########.......#
 8  #     C  =          =               ######.......#
 9  #        =          =         ##### ######....C..#
10  ##### ###### #############   S##### ######.......#
11  ##### ###### ############     ##### ######.......#
12  ##### ###### ###########  C  ######   S   .......#
13  #####=###### ##########S    ##############.......#
14  ##### ####   #C#######      ##############.C.....#
15  ##### #### ### ######     # ##############.......#
16  #####  S # ### #####     ## ##############....P..#
17  ####  ## #        #     ### C  ######S...........#
18  #### ### ########      ####### ##    ............#
19  #### ### ########   C ######## ## ###............#
20  #### ###     ###     ######### ## ###..C.........#
21  #### ####### ##     ########## ## ###......C.....#
22  ####    S### #     T########## ## ###............#
23  #### ####### #            RR       =S....C.......#
24  #### #######          C   RR       = .P......C...#
25  #### ########             RR     C = ............#
26  #### ######### S          RR  S    = ..C.........#
27  #### ############# ### ######## #####......C.....#
28  #### ############# ### ######## #####............#
29  #### ############# ### ########      ....C...P...#
30  #### ########      ###     ##########............#
31  ####C########=############     =     .S........C.#
32  #### ######## ############################.......#
33  ####      S     #######   S     ##########..C....#
34  ###############         #######     C     .......#
35  ##########################################S......#
36  ##########################################.......#
37  ##################################################
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
// shared/map.ts - the Venice district as one ASCII grid, plus the parser and the
// coordinate rules. Contract file: read-only for the track agents (SPEC.md section 11).
//
// Coordinates (metres, SPEC.md section 7): Y is up, the water surface is y = 0,
// the origin is the centre of the map. Row 0 of the text is the FAR side of the
// map at negative z (north); row H-1 is the near side at positive z (south).
// Column 0 is west (negative x). A cell (col, row) is centred at
//   x = (col - W/2 + 0.5) * CELL,  z = (row - H/2 + 0.5) * CELL
// and covers [x - CELL/2, x + CELL/2] x [z - CELL/2, z + CELL/2].
// The 2D physics plane is (x, z): Rapier's x is the world x and Rapier's y is
// the world z. A heading is the Rapier rotation angle: 0 = +x (east),
// +PI/2 = +z (south), PI = west, -PI/2 = north; forward = (cos h, sin h) in
// (x, z). To face a three.js mesh whose model forward is +x, use
// mesh.rotation.y = -heading (three's makeRotationY maps +x to (cos, 0, -sin)).

export const CELL = 8; // metres per cell

/** Radius of the physics circle for a pile cluster (P). */
export const PILE_RADIUS = 2.5;

export type Legend = 'B' | '~' | '=' | 'L' | 'S' | 'C' | 'T' | 'R' | 'P';

export const LEGEND: Readonly<Record<Legend, string>> = {
  B: 'building block, solid',
  '~': 'canal water',
  '=': 'arched stone bridge: water for physics, an arch for the renderer',
  L: 'lagoon water: open basin along one edge, boats here are always on the minimap',
  S: 'spawn dock: a water cell beside a quay (a B neighbour)',
  C: 'crate point: a water cell with a floating crate',
  T: 'bell tower (campanile), solid, one cell',
  R: 'covered bridge (Rialto style): water for physics, a roofed deck for the renderer',
  P: 'pile cluster in the lagoon: a small solid circle, see PILE_RADIUS',
};

const LEGEND_CHARS: ReadonlySet<string> = new Set(Object.keys(LEGEND));
/** Cells a boat can be on. */
const NAVIGABLE: ReadonlySet<Legend> = new Set<Legend>(['~', '=', 'L', 'S', 'C', 'R']);
/** Cells that become a wall rectangle. P is handled separately as a circle. */
const WALL: ReadonlySet<Legend> = new Set<Legend>(['B', 'T']);
/** Cells the lagoon mask floods through (open water plus markers sitting on it). */
const LAGOON_PASS: ReadonlySet<Legend> = new Set<Legend>(['L', 'C', 'S', 'P']);

export interface WallRect {
  /** centre, metres */
  x: number;
  z: number;
  /** full size along x and along z, metres */
  w: number;
  d: number;
}

export interface GridPoint {
  col: number;
  row: number;
  /** cell centre, metres */
  x: number;
  z: number;
}

export interface Dock extends GridPoint {
  /** radians, see the heading convention at the top of this file */
  heading: number;
}

export interface Bridge {
  /** centre of the deck, metres */
  x: number;
  z: number;
  /** 'ns': the deck runs north-south over an east-west canal; 'ew': the opposite */
  orientation: 'ns' | 'ew';
  /** span along the deck (across the water), metres */
  length: number;
  /** depth along the canal, metres (8 for an arch, 16..24 for the covered bridge) */
  width: number;
  kind: 'arch' | 'covered';
}

export type Edge = 'north' | 'south' | 'east' | 'west';

export interface VeniceMap {
  width: number;
  height: number;
  cell: number;
  /** row-major legend chars, index = row * width + col */
  cells: readonly Legend[];
  /** 1 where a boat may be, else 0; index as `cells` */
  navigable: Uint8Array;
  /** 1 inside the lagoon (the minimap reveal rule), else 0; index as `cells` */
  lagoon: Uint8Array;
  /** the border edge the lagoon hugs; the renderer draws that border as a breakwater, not houses */
  lagoonEdge: Edge;
  lagoonCells: readonly GridPoint[];
  walls: readonly WallRect[];
  docks: readonly Dock[];
  crates: readonly GridPoint[];
  bridges: readonly Bridge[];
  tower: GridPoint;
  piles: readonly GridPoint[];
}

export class MapError extends Error {
  override readonly name = 'MapError';
}

function isLegend(ch: string): ch is Legend {
  return LEGEND_CHARS.has(ch);
}

const N4: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** Parses the ASCII map. Lines starting with '#' and blank lines are ignored. Throws MapError. */
export function parseMap(text: string): VeniceMap {
  const lines = text
    .split('\n')
    .map((l) => l.replace(/\r$/, '').trimEnd())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
  const height = lines.length;
  const width = lines[0]?.length ?? 0;
  if (height < 8 || width < 8) throw new MapError(`map too small: ${width} x ${height}`);

  const cells: Legend[] = [];
  for (let r = 0; r < height; r++) {
    const line = lines[r] ?? '';
    if (line.length !== width) throw new MapError(`row ${r} has ${line.length} chars, expected ${width}`);
    for (let c = 0; c < width; c++) {
      const ch = line.charAt(c);
      if (!isLegend(ch)) throw new MapError(`row ${r} col ${c}: unknown char '${ch}'`);
      cells.push(ch);
    }
  }
  const idx = (c: number, r: number): number => r * width + c;
  const at = (c: number, r: number): Legend =>
    c < 0 || r < 0 || c >= width || r >= height ? 'B' : (cells[idx(c, r)] ?? 'B');
  const nav = (c: number, r: number): boolean => NAVIGABLE.has(at(c, r));
  const centreX = (c: number): number => (c - width / 2 + 0.5) * CELL;
  const centreZ = (r: number): number => (r - height / 2 + 0.5) * CELL;
  const point = (c: number, r: number): GridPoint => ({ col: c, row: r, x: centreX(c), z: centreZ(r) });

  // border
  for (let c = 0; c < width; c++) {
    if (at(c, 0) !== 'B' || at(c, height - 1) !== 'B') throw new MapError(`border must be B (col ${c})`);
  }
  for (let r = 0; r < height; r++) {
    if (at(0, r) !== 'B' || at(width - 1, r) !== 'B') throw new MapError(`border must be B (row ${r})`);
  }

  // navigable mask and one connected water region
  const navigable = new Uint8Array(width * height);
  const navList: Array<readonly [number, number]> = [];
  for (let r = 0; r < height; r++)
    for (let c = 0; c < width; c++)
      if (nav(c, r)) {
        navigable[idx(c, r)] = 1;
        navList.push([c, r]);
      }
  if (navList.length === 0) throw new MapError('no water');
  const flood = (seeds: ReadonlyArray<readonly [number, number]>, pass: (c: number, r: number) => boolean): Uint8Array => {
    const seen = new Uint8Array(width * height);
    const stack: Array<readonly [number, number]> = [];
    for (const [c, r] of seeds) {
      seen[idx(c, r)] = 1;
      stack.push([c, r]);
    }
    while (stack.length > 0) {
      const cur = stack.pop();
      if (cur === undefined) break;
      const [c, r] = cur;
      for (const [dc, dr] of N4) {
        const nc = c + dc;
        const nr = r + dr;
        if (nc < 0 || nr < 0 || nc >= width || nr >= height) continue;
        if (seen[idx(nc, nr)] === 1 || !pass(nc, nr)) continue;
        seen[idx(nc, nr)] = 1;
        stack.push([nc, nr]);
      }
    }
    return seen;
  };
  const first = navList[0];
  if (first === undefined) throw new MapError('no water');
  const reach = flood([first], nav);
  for (const [c, r] of navList) {
    if (reach[idx(c, r)] !== 1) throw new MapError(`water is not one region: (${c},${r}) is cut off`);
  }

  // lagoon mask: L cells plus the markers sitting on lagoon water
  const lSeeds = navList.filter(([c, r]) => at(c, r) === 'L');
  if (lSeeds.length === 0) throw new MapError('no lagoon (L) cells');
  const lagoon = flood(lSeeds, (c, r) => LAGOON_PASS.has(at(c, r)));
  const lagoonCells: GridPoint[] = [];
  for (let r = 0; r < height; r++) for (let c = 0; c < width; c++) if (lagoon[idx(c, r)] === 1) lagoonCells.push(point(c, r));
  const edgeCount: Record<Edge, number> = { north: 0, south: 0, east: 0, west: 0 };
  for (const [c, r] of lSeeds) {
    if (c === 1) edgeCount.west++;
    if (c === width - 2) edgeCount.east++;
    if (r === 1) edgeCount.north++;
    if (r === height - 2) edgeCount.south++;
  }
  let lagoonEdge: Edge = 'east';
  for (const e of ['north', 'south', 'east', 'west'] as const) if (edgeCount[e] > edgeCount[lagoonEdge]) lagoonEdge = e;
  if (edgeCount[lagoonEdge] === 0) throw new MapError('the lagoon must touch a border edge');

  // walls: greedy rectangle merge of B and T cells, row-major, extend right then down
  const walls: WallRect[] = [];
  const used = new Uint8Array(width * height);
  const isWall = (c: number, r: number): boolean => WALL.has(at(c, r)) && used[idx(c, r)] !== 1;
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      if (!isWall(c, r)) continue;
      let w = 1;
      while (c + w < width && isWall(c + w, r)) w++;
      let h = 1;
      let canGrow = true;
      while (canGrow && r + h < height) {
        for (let k = 0; k < w; k++) {
          if (!isWall(c + k, r + h)) {
            canGrow = false;
            break;
          }
        }
        if (canGrow) h++;
      }
      for (let dr = 0; dr < h; dr++) for (let dc = 0; dc < w; dc++) used[idx(c + dc, r + dr)] = 1;
      walls.push({
        x: (centreX(c) + centreX(c + w - 1)) / 2,
        z: (centreZ(r) + centreZ(r + h - 1)) / 2,
        w: w * CELL,
        d: h * CELL,
      });
    }
  }

  // point features
  const docks: Dock[] = [];
  const crates: GridPoint[] = [];
  const piles: GridPoint[] = [];
  const towers: GridPoint[] = [];
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const ch = at(c, r);
      if (ch === 'S') docks.push({ ...point(c, r), heading: dockHeading(c, r, at) });
      else if (ch === 'C') crates.push(point(c, r));
      else if (ch === 'P') piles.push(point(c, r));
      else if (ch === 'T') towers.push(point(c, r));
    }
  }
  const tower = towers[0];
  if (tower === undefined || towers.length !== 1) throw new MapError(`expected exactly one tower (T), found ${towers.length}`);
  if (docks.length < 2) throw new MapError(`expected at least 2 docks (S), found ${docks.length}`);
  for (const d of docks) {
    if (!N4.some(([dc, dr]) => at(d.col + dc, d.row + dr) === 'B')) throw new MapError(`dock (${d.col},${d.row}) has no quay`);
  }
  for (const p of piles) {
    if (!N4.every(([dc, dr]) => nav(p.col + dc, p.row + dr))) throw new MapError(`pile (${p.col},${p.row}) must be surrounded by water`);
  }

  // bridges: connected components of '=' (arch) and 'R' (covered)
  const bridges: Bridge[] = [];
  const seenB = new Uint8Array(width * height);
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const ch = at(c, r);
      if ((ch !== '=' && ch !== 'R') || seenB[idx(c, r)] === 1) continue;
      const comp: Array<readonly [number, number]> = [];
      const stack: Array<readonly [number, number]> = [[c, r]];
      seenB[idx(c, r)] = 1;
      while (stack.length > 0) {
        const cur = stack.pop();
        if (cur === undefined) break;
        comp.push(cur);
        for (const [dc, dr] of N4) {
          const nc = cur[0] + dc;
          const nr = cur[1] + dr;
          if (at(nc, nr) !== ch || seenB[idx(nc, nr)] === 1) continue;
          seenB[idx(nc, nr)] = 1;
          stack.push([nc, nr]);
        }
      }
      bridges.push(classifyBridge(comp, ch === 'R' ? 'covered' : 'arch', at, centreX, centreZ));
    }
  }
  if (bridges.filter((b) => b.kind === 'covered').length !== 1) throw new MapError('expected exactly one covered bridge (R)');

  return {
    width,
    height,
    cell: CELL,
    cells,
    navigable,
    lagoon,
    lagoonEdge,
    lagoonCells,
    walls,
    docks,
    crates,
    bridges,
    tower,
    piles,
  };
}

/**
 * Heading of a dock: away from its quay into open water.
 * 1. v = sum over B/T 4-neighbours of (dock - neighbour), i.e. a vector pointing away from the quays.
 * 2. Among the navigable 4-neighbours pick the one with the largest dot(dir, v).
 * 3. Ties (including v = 0, a dock in a 1-wide canal with quays on both sides) go to the
 *    direction with the most water ahead (up to 3 cells), then to the N4 order (E, W, S, N).
 */
function dockHeading(c: number, r: number, at: (c: number, r: number) => Legend): number {
  let vx = 0;
  let vz = 0;
  for (const [dc, dr] of N4) {
    const n = at(c + dc, r + dr);
    if (n === 'B' || n === 'T') {
      vx -= dc;
      vz -= dr;
    }
  }
  const clearance = (dc: number, dr: number): number => {
    let n = 0;
    for (let k = 1; k <= 3; k++) {
      if (NAVIGABLE.has(at(c + dc * k, r + dr * k))) n++;
      else break;
    }
    return n;
  };
  let best: readonly [number, number] | undefined;
  let bestScore = -Infinity;
  for (const dir of N4) {
    if (!NAVIGABLE.has(at(c + dir[0], r + dir[1]))) continue;
    const score = (dir[0] * vx + dir[1] * vz) * 10 + clearance(dir[0], dir[1]);
    if (score > bestScore) {
      bestScore = score;
      best = dir;
    }
  }
  if (best === undefined) throw new MapError(`dock (${c},${r}) is sealed`);
  return Math.atan2(best[1], best[0]);
}

function classifyBridge(
  comp: ReadonlyArray<readonly [number, number]>,
  kind: Bridge['kind'],
  at: (c: number, r: number) => Legend,
  centreX: (c: number) => number,
  centreZ: (r: number) => number,
): Bridge {
  let c0 = Infinity;
  let c1 = -Infinity;
  let r0 = Infinity;
  let r1 = -Infinity;
  for (const [c, r] of comp) {
    c0 = Math.min(c0, c);
    c1 = Math.max(c1, c);
    r0 = Math.min(r0, r);
    r1 = Math.max(r1, r);
  }
  const w = c1 - c0 + 1;
  const h = r1 - r0 + 1;
  if (comp.length !== w * h) throw new MapError(`bridge at (${c0},${r0}) is not a filled rectangle`);
  const nsEnds = at(c0, r0 - 1) === 'B' && at(c0, r1 + 1) === 'B';
  const ewEnds = at(c0 - 1, r0) === 'B' && at(c1 + 1, r0) === 'B';
  let orientation: Bridge['orientation'];
  if (nsEnds && !ewEnds) orientation = 'ns';
  else if (ewEnds && !nsEnds) orientation = 'ew';
  else if (nsEnds && ewEnds) orientation = h >= w ? 'ns' : 'ew';
  else throw new MapError(`bridge at (${c0},${r0}) has no building at both ends of its deck`);
  const span = orientation === 'ns' ? h : w;
  const depth = orientation === 'ns' ? w : h;
  return {
    x: (centreX(c0) + centreX(c1)) / 2,
    z: (centreZ(r0) + centreZ(r1)) / 2,
    orientation,
    length: span * CELL,
    width: depth * CELL,
    kind,
  };
}

// ---------- coordinate helpers ----------

/** Column of a world x (clamped into the grid). */
export function colOf(map: VeniceMap, x: number): number {
  return Math.min(map.width - 1, Math.max(0, Math.floor(x / map.cell + map.width / 2)));
}

/** Row of a world z (clamped into the grid). */
export function rowOf(map: VeniceMap, z: number): number {
  return Math.min(map.height - 1, Math.max(0, Math.floor(z / map.cell + map.height / 2)));
}

/** Legend char under a world position; outside the grid counts as building. */
export function cellAt(map: VeniceMap, x: number, z: number): Legend {
  const col = colOf(map, x);
  const row = rowOf(map, z);
  return map.cells[row * map.width + col] ?? 'B';
}

/** Centre of a cell in metres. */
export function cellCentre(map: VeniceMap, col: number, row: number): { x: number; z: number } {
  return { x: (col - map.width / 2 + 0.5) * map.cell, z: (row - map.height / 2 + 0.5) * map.cell };
}

/** Minimap rule: a boat in the open lagoon is always shown. */
export function isLagoon(map: VeniceMap, x: number, z: number): boolean {
  return map.lagoon[rowOf(map, z) * map.width + colOf(map, x)] === 1;
}

export function isNavigable(map: VeniceMap, x: number, z: number): boolean {
  return map.navigable[rowOf(map, z) * map.width + colOf(map, x)] === 1;
}

/** Half extents of the playable world in metres (the border walls sit at these limits). */
export function mapHalfSize(map: VeniceMap): { x: number; z: number } {
  return { x: (map.width * map.cell) / 2, z: (map.height * map.cell) / 2 };
}

// ---------- the district ----------
// 50 x 38 cells, 8 m each = 400 x 304 m. Validated by shared/map.test.ts.
// West-to-east: the Canal Grande enters at the west edge (rows 6-9), bends south at
// col 29, runs 45 degrees south-west to the hairpin at col 13, then east (rows 23-26)
// under the covered bridge (R, cols 26-27) into the bacino and the lagoon strip.
export const MAP_TEXT = `
# Gondola Royale - the district. Legend: B building ~ water = arch bridge L lagoon
# S dock C crate T bell tower R covered bridge P piles. Row 0 is north (negative z).
BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB
BBBBBBBBBBBBBBBCBBBBBBBBBBBBBBBBBBBBBBBBBBLLLLLLLB
BBBBBBBBBBBBBBB~BBBBBBBBBBBBBBBBBBBBBBBBBBLLLLLLLB
BBBBBBB~~~~=~~~~~~~~S~~~~BBBBBBB~~~~~~~~~~LLCLLLLB
BBBBBBB~BBBBBBBBBBBBBBBB~BBBBBBB~BBBBBBBBBLLLLLLLB
BBBBBBB~BBBBBBBBBBBBBBBB~BBBBBBBCBBBBBBBBBLLLPLLLB
B~~~~~~~~=~~~~S~~~~~=~~~~~~~~~BB~BBBBBBBBBSLLLLLLB
B~~~~~~~~=~~~~~~~~C~=~~~~~~~~~BB~BBBBBBBBBLLLLLLLB
B~~~~~C~~=~~~~~~~~~~=~~~~~~~~~~~~~~~BBBBBBLLLLLLLB
B~~~~~~~~=~~~~~~~~~~=~~~~~~~~~BBBBB~BBBBBBLLLLCLLB
BBBBB~BBBBBB~BBBBBBBBBBBBB~~~SBBBBB~BBBBBBLLLLLLLB
BBBBB~BBBBBB~BBBBBBBBBBBB~~~~~BBBBB~BBBBBBLLLLLLLB
BBBBB~BBBBBB~BBBBBBBBBBB~~C~~BBBBBB~~~S~~~LLLLLLLB
BBBBB=BBBBBB~BBBBBBBBBBS~~~~BBBBBBBBBBBBBBLLLLLLLB
BBBBB~BBBB~~~BCBBBBBBB~~~~~~BBBBBBBBBBBBBBLCLLLLLB
BBBBB~BBBB~BBB~BBBBBB~~~~~B~BBBBBBBBBBBBBBLLLLLLLB
BBBBB~~S~B~BBB~BBBBB~~~~~BB~BBBBBBBBBBBBBBLLLLPLLB
BBBB~~BB~B~~~~~~~~B~~~~~BBB~C~~BBBBBBSLLLLLLLLLLLB
BBBB~BBB~BBBBBBBB~~~~~~BBBBBBB~BB~~~~LLLLLLLLLLLLB
BBBB~BBB~BBBBBBBB~~~C~BBBBBBBB~BB~BBBLLLLLLLLLLLLB
BBBB~BBB~~~~~BBB~~~~~BBBBBBBBB~BB~BBBLLCLLLLLLLLLB
BBBB~BBBBBBB~BB~~~~~BBBBBBBBBB~BB~BBBLLLLLLCLLLLLB
BBBB~~~~SBBB~B~~~~~TBBBBBBBBBB~BB~BBBLLLLLLLLLLLLB
BBBB~BBBBBBB~B~~~~~~~~~~~~RR~~~~~~~=SLLLLCLLLLLLLB
BBBB~BBBBBBB~~~~~~~~~~C~~~RR~~~~~~~=~LPLLLLLLCLLLB
BBBB~BBBBBBBB~~~~~~~~~~~~~RR~~~~~C~=~LLLLLLLLLLLLB
BBBB~BBBBBBBBB~S~~~~~~~~~~RR~~S~~~~=~LLCLLLLLLLLLB
BBBB~BBBBBBBBBBBBB~BBB~BBBBBBBB~BBBBBLLLLLLCLLLLLB
BBBB~BBBBBBBBBBBBB~BBB~BBBBBBBB~BBBBBLLLLLLLLLLLLB
BBBB~BBBBBBBBBBBBB~BBB~BBBBBBBB~~~~~~LLLLCLLLPLLLB
BBBB~BBBBBBBB~~~~~~BBB~~~~~BBBBBBBBBBLLLLLLLLLLLLB
BBBBCBBBBBBBB=BBBBBBBBBBBB~~~~~=~~~~~LSLLLLLLLLCLB
BBBB~BBBBBBBB~BBBBBBBBBBBBBBBBBBBBBBBBBBBBLLLLLLLB
BBBB~~~~~~S~~~~~BBBBBBB~~~S~~~~~BBBBBBBBBBLLCLLLLB
BBBBBBBBBBBBBBB~~~~~~~~~BBBBBBB~~~~~C~~~~~LLLLLLLB
BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBSLLLLLLB
BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBLLLLLLLB
BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB
`;

/** The parsed district. Parsing throws at import time if the text is broken, so a bad edit fails fast. */
export const MAP: VeniceMap = parseMap(MAP_TEXT);
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
// shared/map.test.ts - design checks for the district (vitest). The structural checks
// (grid shape, legend, border, one water region, one tower, one covered bridge, quays)
// already run inside parseMap; a broken map throws at import time.
import { describe, expect, it } from 'vitest';
import { CELL, MAP, cellAt, cellCentre, colOf, isLagoon, parseMap, rowOf, type VeniceMap } from './map';

const N4: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

function at(map: VeniceMap, c: number, r: number): string {
  if (c < 0 || r < 0 || c >= map.width || r >= map.height) return 'B';
  return map.cells[r * map.width + c] ?? 'B';
}
function nav(map: VeniceMap, c: number, r: number): boolean {
  return map.navigable[r * map.width + c] === 1;
}
/** cells covered by at least one k x k all-water window */
function coveredBy(map: VeniceMap, k: number): Uint8Array {
  const m = new Uint8Array(map.width * map.height);
  for (let r = 0; r + k <= map.height; r++) {
    for (let c = 0; c + k <= map.width; c++) {
      let ok = true;
      for (let dr = 0; dr < k && ok; dr++) for (let dc = 0; dc < k && ok; dc++) if (!nav(map, c + dc, r + dr)) ok = false;
      if (ok) for (let dr = 0; dr < k; dr++) for (let dc = 0; dc < k; dc++) m[(r + dr) * map.width + c + dc] = 1;
    }
  }
  return m;
}
function bfs(map: VeniceMap, starts: ReadonlyArray<readonly [number, number]>): Int32Array {
  const dist = new Int32Array(map.width * map.height).fill(-1);
  const queue: Array<readonly [number, number]> = [];
  for (const [c, r] of starts) {
    dist[r * map.width + c] = 0;
    queue.push([c, r]);
  }
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    if (cur === undefined) break;
    const d = dist[cur[1] * map.width + cur[0]] ?? 0;
    for (const [dc, dr] of N4) {
      const nc = cur[0] + dc;
      const nr = cur[1] + dr;
      if (nc < 0 || nr < 0 || nc >= map.width || nr >= map.height) continue;
      if (!nav(map, nc, nr) || (dist[nr * map.width + nc] ?? -1) >= 0) continue;
      dist[nr * map.width + nc] = d + 1;
      queue.push([nc, nr]);
    }
  }
  return dist;
}

describe('shared/map', () => {
  const map = MAP;
  const water: Array<readonly [number, number]> = [];
  for (let r = 0; r < map.height; r++) for (let c = 0; c < map.width; c++) if (nav(map, c, r)) water.push([c, r]);

  it('is about 50 x 38 cells of 8 m', () => {
    expect(map.width).toBe(50);
    expect(map.height).toBe(38);
    expect(CELL).toBe(8);
  });

  it('maps coordinates with the origin at the centre, row 0 at negative z', () => {
    expect(cellCentre(map, 0, 0)).toEqual({ x: -196, z: -148 });
    expect(cellCentre(map, 49, 37)).toEqual({ x: 196, z: 148 });
    expect(colOf(map, -196)).toBe(0);
    expect(rowOf(map, -148)).toBe(0);
    expect(colOf(map, 3.9)).toBe(25);
    expect(colOf(map, -0.1)).toBe(24);
    expect(colOf(map, 10_000)).toBe(49);
    expect(cellAt(map, 10_000, 10_000)).toBe('B');
    const t = map.tower;
    expect(cellAt(map, t.x, t.z)).toBe('T');
  });

  it('has one lagoon along the east edge, visible on the minimap', () => {
    expect(map.lagoonEdge).toBe('east');
    const l = map.lagoonCells.length;
    expect(l).toBeGreaterThanOrEqual(150);
    expect(l).toBeLessThanOrEqual(420);
    const some = map.lagoonCells[0];
    expect(some).toBeDefined();
    if (some) expect(isLagoon(map, some.x, some.z)).toBe(true);
    expect(isLagoon(map, -190, 0)).toBe(false);
  });

  it('has a wide S-shaped main canal from the west edge into the lagoon', () => {
    const thick3 = coveredBy(map, 3);
    const thick4 = coveredBy(map, 4);
    const main = water.filter(([c, r]) => thick3[r * map.width + c] === 1 && map.lagoon[r * map.width + c] !== 1);
    expect(main.length).toBeGreaterThanOrEqual(180);
    expect(main.filter(([c]) => c === 1).length).toBeGreaterThanOrEqual(3);
    const rows = main.map(([, r]) => r);
    expect(Math.min(...rows)).toBeLessThanOrEqual(map.height / 3);
    expect(Math.max(...rows)).toBeGreaterThanOrEqual((2 * map.height) / 3);
    const wide = main.filter(([c, r]) => thick4[r * map.width + c] === 1).length / main.length;
    expect(wide).toBeGreaterThanOrEqual(0.6);
  });

  it('has about 8 narrow side canals with tight bends and at most 4 dead ends', () => {
    const wide2 = coveredBy(map, 2);
    const thin = water.filter(([c, r]) => wide2[r * map.width + c] !== 1 && map.lagoon[r * map.width + c] !== 1);
    expect(thin.length).toBeGreaterThanOrEqual(120);
    const deadEnds = thin.filter(([c, r]) => N4.filter(([dc, dr]) => nav(map, c + dc, r + dr)).length === 1);
    expect(deadEnds.length).toBeGreaterThanOrEqual(2);
    expect(deadEnds.length).toBeLessThanOrEqual(4);
    // networks of 1-wide water
    const thinSet = new Set(thin.map(([c, r]) => r * map.width + c));
    const seen = new Set<number>();
    let networks = 0;
    for (const [c, r] of thin) {
      if (seen.has(r * map.width + c)) continue;
      networks++;
      const stack = [[c, r] as const];
      seen.add(r * map.width + c);
      while (stack.length > 0) {
        const cur = stack.pop();
        if (cur === undefined) break;
        for (const [dc, dr] of N4) {
          const k = (cur[1] + dr) * map.width + cur[0] + dc;
          if (!thinSet.has(k) || seen.has(k)) continue;
          seen.add(k);
          stack.push([cur[0] + dc, cur[1] + dr]);
        }
      }
    }
    expect(networks).toBeGreaterThanOrEqual(6);
    expect(networks).toBeLessThanOrEqual(12);
  });

  it('has 6 to 8 arch bridges and one covered bridge near the centre', () => {
    const arches = map.bridges.filter((b) => b.kind === 'arch');
    const covered = map.bridges.filter((b) => b.kind === 'covered');
    expect(arches.length).toBeGreaterThanOrEqual(6);
    expect(arches.length).toBeLessThanOrEqual(8);
    expect(covered.length).toBe(1);
    const r = covered[0];
    expect(r).toBeDefined();
    if (r) {
      expect(Math.hypot(r.x, r.z)).toBeLessThanOrEqual(80);
      expect(r.width).toBeGreaterThanOrEqual(16);
      expect(r.width).toBeLessThanOrEqual(24);
      expect(r.length).toBeGreaterThanOrEqual(24);
    }
    for (const b of arches) expect(b.width).toBe(CELL);
  });

  it('keeps the bell tower central', () => {
    expect(Math.hypot(map.tower.x, map.tower.z)).toBeLessThanOrEqual(100);
  });

  it('has about 16 docks, spread out, never adjacent, each with a quay and a heading into water', () => {
    expect(map.docks.length).toBeGreaterThanOrEqual(12);
    expect(map.docks.length).toBeLessThanOrEqual(20);
    for (const a of map.docks) {
      expect(N4.some(([dc, dr]) => at(map, a.col + dc, a.row + dr) === 'B')).toBe(true);
      const ahead = cellCentre(map, a.col + Math.round(Math.cos(a.heading)), a.row + Math.round(Math.sin(a.heading)));
      expect(cellAt(map, ahead.x, ahead.z)).not.toBe('B');
      for (const b of map.docks) {
        if (a === b) continue;
        expect(Math.max(Math.abs(a.col - b.col), Math.abs(a.row - b.row))).toBeGreaterThanOrEqual(2);
      }
    }
    const q = [0, 0, 0, 0];
    for (const d of map.docks) q[(d.x < 0 ? 0 : 1) + (d.z < 0 ? 0 : 2)] = (q[(d.x < 0 ? 0 : 1) + (d.z < 0 ? 0 : 2)] ?? 0) + 1;
    for (const n of q) expect(n).toBeGreaterThanOrEqual(2);
    // the respawn rule (a dock >= 80 m from every enemy) must find a candidate for random 5-enemy layouts
    let seed = 12345;
    const rnd = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    let ok = 0;
    const trials = 1000;
    for (let t = 0; t < trials; t++) {
      const enemies: Array<{ x: number; z: number }> = [];
      for (let e = 0; e < 5; e++) {
        const cell = water[Math.floor(rnd() * water.length)];
        if (cell) enemies.push(cellCentre(map, cell[0], cell[1]));
      }
      if (map.docks.some((d) => enemies.every((en) => Math.hypot(d.x - en.x, d.z - en.z) >= 80))) ok++;
    }
    expect(ok / trials).toBeGreaterThanOrEqual(0.97);
  });

  it('has about 24 crates, the densest cluster in the lagoon, all reachable from every dock', () => {
    expect(map.crates.length).toBeGreaterThanOrEqual(20);
    expect(map.crates.length).toBeLessThanOrEqual(28);
    const inLagoon = map.crates.filter((c) => map.lagoon[c.row * map.width + c.col] === 1).length;
    const lagoonCells = map.lagoonCells.length;
    expect(inLagoon / lagoonCells).toBeGreaterThan((map.crates.length - inLagoon) / (water.length - lagoonCells));
    const dist = bfs(map, map.docks.map((d) => [d.col, d.row] as const));
    for (const c of map.crates) {
      const d = dist[c.row * map.width + c.col] ?? -1;
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d * CELL).toBeLessThanOrEqual(160);
    }
  });

  it('can be crossed in about a minute: longest shortest path at most 640 m', () => {
    let diameter = 0;
    for (const s of water) {
      const dist = bfs(map, [s]);
      for (const [c, r] of water) diameter = Math.max(diameter, dist[r * map.width + c] ?? 0);
    }
    expect(diameter * CELL).toBeLessThanOrEqual(640);
    expect(diameter * CELL).toBeGreaterThanOrEqual(320);
  });

  it('merges walls into few rectangles that cover every solid cell exactly once', () => {
    expect(map.walls.length).toBeLessThan(120);
    const solid = map.cells.filter((ch) => ch === 'B' || ch === 'T').length;
    const covered = map.walls.reduce((a, w) => a + (w.w / CELL) * (w.d / CELL), 0);
    expect(covered).toBe(solid);
    for (const p of map.piles) expect(map.lagoon[p.row * map.width + p.col]).toBe(1);
  });

  it('rejects broken maps', () => {
    expect(() => parseMap('BBBB\nB~~B\nBBBB')).toThrow();
    expect(() => parseMap(MAP_TEXT_WITH_ISLAND)).toThrow(/not one region/);
  });
});

const MAP_TEXT_WITH_ISLAND = [
  'BBBBBBBBBB',
  'B~~~~~~LLB',
  'B~~~~~~LLB',
  'BBBBBBBBBB',
  'B~~BBBBBBB',
  'B~~BBBBBBB',
  'BBBBBBBBBB',
  'BBBBBBBBBB',
].join('\n');
```

### 3.5 Consumers (typechecked with the same tsconfig; paste when the tracks start)

`src/sim/mapPhysics.ts` (track B):

```ts
// src/sim/mapPhysics.ts - builds the static Rapier colliders from the parsed map.
// Rapier's (x, y) plane is the world's (x, z) plane (see shared/map.ts).
import type * as RAPIER from '@dimforge/rapier2d-compat';
import { MAP, PILE_RADIUS, type VeniceMap } from '@shared/map';

export interface MapPhysicsOptions {
  /** bounce of a boat against a wall; SPEC: "bounce and scrape sparks, no damage" */
  wallRestitution: number;
  wallFriction: number;
}

const DEFAULTS: MapPhysicsOptions = { wallRestitution: 0.3, wallFriction: 0.2 };

/**
 * One fixed body carries every wall rectangle (cuboid colliders, half extents in
 * metres) and every pile cluster (ball colliders). Returns that body so the caller
 * can tag its colliders with a collision group for the water-cannon / mortar filters.
 */
export function buildMapColliders(
  R: typeof RAPIER,
  world: RAPIER.World,
  map: VeniceMap = MAP,
  opts: MapPhysicsOptions = DEFAULTS,
): RAPIER.RigidBody {
  const ground = world.createRigidBody(R.RigidBodyDesc.fixed());
  for (const w of map.walls) {
    world.createCollider(
      R.ColliderDesc.cuboid(w.w / 2, w.d / 2)
        .setTranslation(w.x, w.z)
        .setFriction(opts.wallFriction)
        .setRestitution(opts.wallRestitution),
      ground,
    );
  }
  for (const p of map.piles) {
    world.createCollider(R.ColliderDesc.ball(PILE_RADIUS).setTranslation(p.x, p.z).setRestitution(opts.wallRestitution), ground);
  }
  return ground;
}

/** Spawn transform for a boat at dock i: position + Rapier rotation angle. */
export function dockSpawn(map: VeniceMap, i: number): { x: number; z: number; heading: number } {
  const d = map.docks[i];
  if (d === undefined) throw new RangeError(`dock ${i} does not exist (${map.docks.length} docks)`);
  return { x: d.x, z: d.z, heading: d.heading };
}

/** Docks at least minDist metres (SPEC: 80) from every enemy boat; falls back to the farthest dock. */
export function respawnCandidates(
  map: VeniceMap,
  enemies: ReadonlyArray<{ x: number; z: number }>,
  minDist: number,
): number[] {
  const far: number[] = [];
  let bestI = 0;
  let bestD = -1;
  map.docks.forEach((d, i) => {
    let nearest = Infinity;
    for (const e of enemies) nearest = Math.min(nearest, Math.hypot(d.x - e.x, d.z - e.z));
    if (nearest >= minDist) far.push(i);
    if (nearest > bestD) {
      bestD = nearest;
      bestI = i;
    }
  });
  return far.length > 0 ? far : [bestI];
}
```

`src/render/mapGeometry.ts` (track C; placeholder boxes, instanced):

```ts
// src/render/mapGeometry.ts - placeholder district from the parsed map: one instanced
// box per wall rectangle, a tower, bridge decks and pile clusters. The art track
// replaces the materials and adds facades; the positions and sizes come from here.
import { BoxGeometry, CylinderGeometry, Group, InstancedMesh, Mesh, MeshStandardMaterial, Object3D } from 'three';
import { MAP, PILE_RADIUS, type VeniceMap } from '@shared/map';

const FLOOR_HEIGHT = 3.2; // metres; SPEC: 3 to 5 floors
const PILES_PER_CLUSTER = 5;

export function buildDistrict(map: VeniceMap = MAP): Group {
  const group = new Group();
  const unitBox = new BoxGeometry(1, 1, 1);
  const plaster = new MeshStandardMaterial({ color: 0xd9b48f, roughness: 0.9 });
  const stone = new MeshStandardMaterial({ color: 0xcfc8b8, roughness: 0.8 });
  const wood = new MeshStandardMaterial({ color: 0x5a3a22, roughness: 0.9 });

  // walls: three.js rotation.y is never needed here, the rectangles are axis aligned
  const walls = new InstancedMesh(unitBox, plaster, map.walls.length);
  const dummy = new Object3D();
  map.walls.forEach((w, i) => {
    const floors = 3 + ((i * 7) % 3); // deterministic 3..5 floors per block
    const h = floors * FLOOR_HEIGHT;
    dummy.position.set(w.x, h / 2, w.z);
    dummy.scale.set(w.w, h, w.d);
    dummy.updateMatrix();
    walls.setMatrixAt(i, dummy.matrix);
  });
  walls.instanceMatrix.needsUpdate = true;
  group.add(walls);

  // campanile: one cell footprint, 60 m tall, visible from every viewport
  const tower = new Mesh(new BoxGeometry(map.cell, 60, map.cell), stone);
  tower.position.set(map.tower.x, 30, map.tower.z);
  group.add(tower);

  // bridges: the deck runs along z for 'ns', along x for 'ew'; clearance 4 m above the water
  for (const b of map.bridges) {
    const alongX = b.orientation === 'ew';
    const covered = b.kind === 'covered';
    const deck = new Mesh(
      new BoxGeometry(alongX ? b.length : b.width, covered ? 7 : 0.8, alongX ? b.width : b.length),
      stone,
    );
    deck.position.set(b.x, covered ? 4 + 3.5 : 4 + 0.4, b.z);
    group.add(deck);
  }

  // piles: a ring of posts per cluster
  const post = new CylinderGeometry(0.25, 0.25, 4, 6);
  const piles = new InstancedMesh(post, wood, map.piles.length * PILES_PER_CLUSTER);
  let k = 0;
  for (const p of map.piles) {
    for (let j = 0; j < PILES_PER_CLUSTER; j++) {
      const a = (j / PILES_PER_CLUSTER) * Math.PI * 2;
      dummy.position.set(p.x + Math.cos(a) * PILE_RADIUS * 0.7, 1, p.z + Math.sin(a) * PILE_RADIUS * 0.7);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      piles.setMatrixAt(k++, dummy.matrix);
    }
  }
  piles.instanceMatrix.needsUpdate = true;
  group.add(piles);
  return group;
}

/** three.js yaw for a mesh whose model forward is +x, from a sim heading (see shared/map.ts). */
export function yawFromHeading(heading: number): number {
  return -heading;
}
```

### 3.6 The standalone validator (`validate.mjs`, plain Node, no dependencies)

Kept outside the repo as a design tool; the vitest file is the in-repo version of the same checks. Run with `node validate.mjs path/to/map.txt`.

```js
#!/usr/bin/env node
// validate.mjs - parses an ASCII Venice map (Gondola Royale, SPEC.md section 7)
// and asserts every design constraint. Usage: node validate.mjs [map.txt]
// Exit code 0 = every check passed. Prints measured numbers for the research notes.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CELL = 8; // metres per cell
const here = dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] ?? resolve(here, 'map.txt');
const text = readFileSync(file, 'utf8');

// ---------- parse ----------
const lines = text
  .split('\n')
  .map((l) => l.replace(/\r$/, ''))
  .filter((l) => l.length > 0 && !l.startsWith('#'));
const H = lines.length;
const W = lines[0]?.length ?? 0;
const LEGEND = new Set(['B', '~', '=', 'L', 'S', 'C', 'T', 'R', 'P']);
const NAV = new Set(['~', '=', 'L', 'S', 'C', 'R']); // water for physics
const SOLID = new Set(['B', 'T', 'P']);

const failures = [];
const notes = [];
function check(cond, msg) {
  if (!cond) failures.push(msg);
  return cond;
}
function note(msg) {
  notes.push(msg);
}

check(W >= 46 && W <= 54, `width ${W} should be about 50`);
check(H >= 34 && H <= 42, `height ${H} should be about 38`);
for (let r = 0; r < H; r++) {
  check(lines[r].length === W, `row ${r} has ${lines[r].length} chars, expected ${W}`);
  for (let c = 0; c < W; c++) check(LEGEND.has(lines[r][c]), `row ${r} col ${c}: unknown char '${lines[r][c]}'`);
}
const at = (c, r) => (c < 0 || r < 0 || c >= W || r >= H ? 'B' : lines[r][c]);
const nav = (c, r) => NAV.has(at(c, r));
const idx = (c, r) => r * W + c;
const N4 = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

// border
for (let c = 0; c < W; c++) {
  check(at(c, 0) === 'B', `top border col ${c} is '${at(c, 0)}'`);
  check(at(c, H - 1) === 'B', `bottom border col ${c} is '${at(c, H - 1)}'`);
}
for (let r = 0; r < H; r++) {
  check(at(0, r) === 'B', `left border row ${r} is '${at(0, r)}'`);
  check(at(W - 1, r) === 'B', `right border row ${r} is '${at(W - 1, r)}'`);
}

// counts by char
const counts = {};
for (const ch of LEGEND) counts[ch] = 0;
for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) counts[at(c, r)]++;
const navCells = [];
for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) if (nav(c, r)) navCells.push([c, r]);
const waterCount = navCells.length;

// ---------- connectivity: one navigable region ----------
function flood(start, pass) {
  const seen = new Uint8Array(W * H);
  const stack = [...start];
  for (const [c, r] of start) seen[idx(c, r)] = 1;
  let n = 0;
  while (stack.length) {
    const [c, r] = stack.pop();
    n++;
    for (const [dc, dr] of N4) {
      const nc = c + dc;
      const nr = r + dr;
      if (nc < 0 || nr < 0 || nc >= W || nr >= H) continue;
      if (seen[idx(nc, nr)] || !pass(nc, nr)) continue;
      seen[idx(nc, nr)] = 1;
      stack.push([nc, nr]);
    }
  }
  return { seen, n };
}
{
  const first = navCells[0];
  const { n } = flood([first], nav);
  check(n === waterCount, `water is not one region: reached ${n} of ${waterCount} cells`);
}

// ---------- lagoon ----------
const lagoonSeed = navCells.filter(([c, r]) => at(c, r) === 'L');
check(lagoonSeed.length > 0, 'no L cells');
const lagoonMask = flood(lagoonSeed, (c, r) => 'LCSP'.includes(at(c, r))).seen; // minimap "in the lagoon" mask
{
  // all L cells connected to each other through L/C/S/P
  let lCount = 0;
  for (const [c, r] of lagoonSeed) if (lagoonMask[idx(c, r)]) lCount++;
  const one = flood([lagoonSeed[0]], (c, r) => 'LCSP'.includes(at(c, r)));
  let lInOne = 0;
  for (const [c, r] of lagoonSeed) if (one.seen[idx(c, r)]) lInOne++;
  check(lInOne === lagoonSeed.length, `lagoon L cells form ${lagoonSeed.length - lInOne} extra islands`);
  // hugs exactly one border edge: that edge is mostly lagoon, the opposite edge has none,
  // the two perpendicular edges are touched only at the corners (at most 10 cells each)
  const edges = { west: 0, east: 0, north: 0, south: 0 };
  for (const [c, r] of lagoonSeed) {
    if (c === 1) edges.west++;
    if (c === W - 2) edges.east++;
    if (r === 1) edges.north++;
    if (r === H - 2) edges.south++;
  }
  const opposite = { west: 'east', east: 'west', north: 'south', south: 'north' };
  const [hug, hugCount] = Object.entries(edges).sort((a, b) => b[1] - a[1])[0];
  const hugLen = hug === 'west' || hug === 'east' ? H - 2 : W - 2;
  check(hugCount >= 0.5 * hugLen, `lagoon covers only ${hugCount} of ${hugLen} cells of its ${hug} edge`);
  check(edges[opposite[hug]] === 0, `lagoon also touches the ${opposite[hug]} edge`);
  for (const [k, n] of Object.entries(edges)) if (k !== hug && k !== opposite[hug]) check(n <= 10, `lagoon runs ${n} cells along the ${k} edge, expected a corner only`);
  note(`lagoon edge: ${hug} (${hugCount}/${hugLen} border cells); L cells ${counts.L}; lagoon mask cells ${lagoonMask.reduce((a, b) => a + b, 0)}`);
  check(counts.L >= 150 && counts.L <= 420, `lagoon size ${counts.L} cells outside 150..420`);
  check(lCount === lagoonSeed.length, 'internal: lagoon mask lost L cells');
}

// ---------- width classes: thick (3x3), medium (2x2), thin ----------
function coveredBy(k) {
  const m = new Uint8Array(W * H);
  for (let r = 0; r + k <= H; r++)
    for (let c = 0; c + k <= W; c++) {
      let ok = true;
      for (let dr = 0; dr < k && ok; dr++) for (let dc = 0; dc < k && ok; dc++) if (!nav(c + dc, r + dr)) ok = false;
      if (ok) for (let dr = 0; dr < k; dr++) for (let dc = 0; dc < k; dc++) m[idx(c + dc, r + dr)] = 1;
    }
  return m;
}
const thick3 = coveredBy(3);
const thick4 = coveredBy(4);
const wide2 = coveredBy(2);
// main canal = closure of (thick3 minus lagoon) plus adjacent 2x2-covered cells (rounded corners)
const main = new Uint8Array(W * H);
for (const [c, r] of navCells) if (thick3[idx(c, r)] && !lagoonMask[idx(c, r)]) main[idx(c, r)] = 1;
let grew = true;
while (grew) {
  grew = false;
  for (const [c, r] of navCells) {
    const i = idx(c, r);
    if (main[i] || lagoonMask[i] || !wide2[i]) continue;
    if (N4.some(([dc, dr]) => nav(c + dc, r + dr) && main[idx(c + dc, r + dr)])) {
      main[i] = 1;
      grew = true;
    }
  }
}
const mainCells = navCells.filter(([c, r]) => main[idx(c, r)]);
const thinCells = navCells.filter(([c, r]) => !wide2[idx(c, r)] && !lagoonMask[idx(c, r)]);
{
  const bad = navCells.filter(([c, r]) => !main[idx(c, r)] && !lagoonMask[idx(c, r)] && wide2[idx(c, r)]);
  check(bad.length === 0, `2-wide water outside the main canal at: ${bad.slice(0, 10).map(([c, r]) => `(${c},${r})`).join(' ')}`);
  const inLagoonThin = navCells.filter(([c, r]) => lagoonMask[idx(c, r)] && !wide2[idx(c, r)]);
  check(inLagoonThin.length === 0, `1-wide cells inside the lagoon mask: ${inLagoonThin.length}`);
  // main canal connected
  const f = flood([mainCells[0]], (c, r) => main[idx(c, r)] === 1);
  check(f.n === mainCells.length, `main canal is ${mainCells.length - f.n} cells short of connected`);
  const westMouth = mainCells.filter(([c]) => c === 1);
  check(westMouth.length >= 3, `main canal must reach the west border (col 1): ${westMouth.length} cells`);
  const lagoonMouth = mainCells.filter(([c, r]) => N4.some(([dc, dr]) => lagoonMask[idx(c + dc, r + dr)] && nav(c + dc, r + dr)));
  check(lagoonMouth.length >= 3, `main canal must open into the lagoon: ${lagoonMouth.length} mouth cells`);
  const m4 = mainCells.filter(([c, r]) => thick4[idx(c, r)]).length;
  const ratio = m4 / mainCells.length;
  check(ratio >= 0.6, `only ${(ratio * 100).toFixed(0)}% of the main canal is 4 cells (32 m) wide`);
  check(mainCells.length >= 180 && mainCells.length <= 420, `main canal has ${mainCells.length} cells, expected 180..420`);
  note(`main canal cells ${mainCells.length}; share covered by a 4x4 water window ${(ratio * 100).toFixed(0)}%; min width 3 cells (24 m) by construction`);
  // S-shape: the canal must occupy both the north third and the south third of the map
  const rows = mainCells.map(([, r]) => r);
  const minR = Math.min(...rows);
  const maxR = Math.max(...rows);
  check(minR <= H / 3 && maxR >= (2 * H) / 3, `main canal rows ${minR}..${maxR}: not an S spanning the map`);
  note(`main canal rows ${minR}..${maxR}`);
}

// ---------- side canals ----------
const thinMask = new Uint8Array(W * H);
for (const [c, r] of thinCells) thinMask[idx(c, r)] = 1;
const thinComponents = [];
{
  const seen = new Uint8Array(W * H);
  for (const [c, r] of thinCells) {
    if (seen[idx(c, r)]) continue;
    const comp = [];
    const stack = [[c, r]];
    seen[idx(c, r)] = 1;
    while (stack.length) {
      const [x, y] = stack.pop();
      comp.push([x, y]);
      for (const [dc, dr] of N4) {
        const nx = x + dc;
        const ny = y + dr;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        if (!thinMask[idx(nx, ny)] || seen[idx(nx, ny)]) continue;
        seen[idx(nx, ny)] = 1;
        stack.push([nx, ny]);
      }
    }
    thinComponents.push(comp);
  }
}
const deadEnds = thinCells.filter(([c, r]) => N4.filter(([dc, dr]) => nav(c + dc, r + dr)).length === 1);
const bends = thinCells.filter(([c, r]) => {
  const open = N4.filter(([dc, dr]) => nav(c + dc, r + dr));
  return open.length === 2 && open[0][0] !== -open[1][0];
});
const mouths = thinCells.filter(([c, r]) => N4.some(([dc, dr]) => nav(c + dc, r + dr) && !thinMask[idx(c + dc, r + dr)]));
{
  check(thinComponents.length >= 6 && thinComponents.length <= 12, `side canal networks: ${thinComponents.length}, expected 6..12 (about 8)`);
  check(thinCells.length >= 120 && thinCells.length <= 320, `side canal cells ${thinCells.length}, expected 120..320`);
  check(deadEnds.length >= 2 && deadEnds.length <= 4, `dead ends: ${deadEnds.length}, expected 2..4`);
  check(bends.length >= 12, `tight bends in side canals: ${bends.length}, expected >= 12`);
  check(mouths.length >= 10, `side canal mouths: ${mouths.length}, expected >= 10`);
  note(
    `side canal networks ${thinComponents.length} (lengths ${thinComponents.map((c) => c.length).join(',')}); cells ${thinCells.length} = ${thinCells.length * CELL} m; bends ${bends.length}; mouths ${mouths.length}; dead ends ${deadEnds.length} at ${deadEnds.map(([c, r]) => `(${c},${r})`).join(' ')}`,
  );
  for (const comp of thinComponents) {
    const touches = comp.some(([c, r]) => N4.some(([dc, dr]) => nav(c + dc, r + dr) && !thinMask[idx(c + dc, r + dr)]));
    check(touches, `side canal network starting at (${comp[0][0]},${comp[0][1]}) never reaches the main canal or lagoon`);
  }
}

// ---------- bridges ----------
function components(chars) {
  const seen = new Uint8Array(W * H);
  const out = [];
  for (let r = 0; r < H; r++)
    for (let c = 0; c < W; c++) {
      if (!chars.includes(at(c, r)) || seen[idx(c, r)]) continue;
      const comp = [];
      const stack = [[c, r]];
      seen[idx(c, r)] = 1;
      while (stack.length) {
        const [x, y] = stack.pop();
        comp.push([x, y]);
        for (const [dc, dr] of N4) {
          const nx = x + dc;
          const ny = y + dr;
          if (!chars.includes(at(nx, ny)) || seen[idx(nx, ny)]) continue;
          seen[idx(nx, ny)] = 1;
          stack.push([nx, ny]);
        }
      }
      out.push(comp);
    }
  return out;
}
// A bridge component must be a straight line; its deck axis is the one with B at both ends;
// every cell has water on both sides across the deck (the canal passes under).
function classifyBridge(comp, label) {
  const cs = comp.map(([c]) => c);
  const rs = comp.map(([, r]) => r);
  const c0 = Math.min(...cs), c1 = Math.max(...cs), r0 = Math.min(...rs), r1 = Math.max(...rs);
  const w = c1 - c0 + 1, h = r1 - r0 + 1;
  if (comp.length !== w * h) return check(false, `${label} at (${c0},${r0}) is not a filled rectangle`), null;
  // deck axis: 'ns' means the deck runs north-south (the canal under it runs east-west)
  const nsEnds = at(c0, r0 - 1) === 'B' && at(c0, r1 + 1) === 'B';
  const ewEnds = at(c0 - 1, r0) === 'B' && at(c1 + 1, r0) === 'B';
  let axis = null;
  if (nsEnds && !ewEnds) axis = 'ns';
  else if (ewEnds && !nsEnds) axis = 'ew';
  else if (nsEnds && ewEnds) axis = h >= w ? 'ns' : 'ew';
  if (!check(axis !== null, `${label} at (${c0},${r0}) has no building at both ends of its deck`)) return null;
  const span = axis === 'ns' ? h : w; // cells of water crossed
  const depth = axis === 'ns' ? w : h; // cells along the canal
  for (const [c, r] of comp) {
    const sideA = axis === 'ns' ? [c - 1, r] : [c, r - 1];
    const sideB = axis === 'ns' ? [c + 1, r] : [c, r + 1];
    const okA = nav(...sideA), okB = nav(...sideB);
    check(okA && okB, `${label} cell (${c},${r}) must have water on both sides across the deck`);
  }
  for (let i = 0; i < span; i++) {
    const c = axis === 'ns' ? c0 : c0 + i;
    const r = axis === 'ns' ? r0 + i : r0;
    void c; void r;
  }
  // all end abutments along the deck must be B for every column/row of the deck
  if (axis === 'ns') for (let c = c0; c <= c1; c++) check(at(c, r0 - 1) === 'B' && at(c, r1 + 1) === 'B', `${label} abutment missing at col ${c}`);
  else for (let r = r0; r <= r1; r++) check(at(c0 - 1, r) === 'B' && at(c1 + 1, r) === 'B', `${label} abutment missing at row ${r}`);
  return { c0, r0, c1, r1, axis, span, depth };
}
const archBridges = components('=').map((comp, i) => classifyBridge(comp, `bridge '=' #${i + 1}`)).filter(Boolean);
check(archBridges.length >= 6 && archBridges.length <= 8, `arch bridges: ${archBridges.length}, expected 6..8`);
for (const b of archBridges) check(b.depth === 1, `arch bridge at (${b.c0},${b.r0}) is ${b.depth} cells deep, expected 1`);
const covered = components('R').map((comp, i) => classifyBridge(comp, `covered bridge 'R' #${i + 1}`)).filter(Boolean);
check(covered.length === 1, `covered bridge R components: ${covered.length}, expected 1`);
const CX = W / 2, CY = H / 2;
const cellX = (c) => (c - W / 2 + 0.5) * CELL;
const cellZ = (r) => (r - H / 2 + 0.5) * CELL;
if (covered.length === 1) {
  const b = covered[0];
  check(b.depth >= 2 && b.depth <= 3, `covered bridge depth ${b.depth} cells, expected 2..3`);
  check(b.span >= 3 && b.span <= 5, `covered bridge span ${b.span} cells, expected the main canal width 3..5`);
  const allMain = Array.from({ length: b.r1 - b.r0 + 1 }, (_, i) => b.r0 + i).every((r) => Array.from({ length: b.c1 - b.c0 + 1 }, (_, j) => b.c0 + j).every((c) => main[idx(c, r)]));
  check(allMain, 'covered bridge must sit on the main canal');
  const bx = (cellX(b.c0) + cellX(b.c1)) / 2, bz = (cellZ(b.r0) + cellZ(b.r1)) / 2;
  check(Math.hypot(bx, bz) <= 80, `covered bridge centre is ${Math.hypot(bx, bz).toFixed(0)} m from the map centre, expected <= 80`);
  note(`covered bridge: cols ${b.c0}..${b.c1} rows ${b.r0}..${b.r1}, deck ${b.axis}, span ${b.span} cells (${b.span * CELL} m), depth ${b.depth} cells; centre (${bx.toFixed(0)}, ${bz.toFixed(0)}) m`);
}
note(`arch bridges ${archBridges.length}: ${archBridges.map((b) => `(${b.c0},${b.r0}) ${b.axis} span ${b.span}`).join('; ')}`);
const mainBridges = archBridges.filter((b) => b.span >= 3).length;
check(mainBridges >= 2, `arch bridges over the main canal: ${mainBridges}, expected >= 2`);

// ---------- tower ----------
const towers = [];
for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) if (at(c, r) === 'T') towers.push([c, r]);
check(towers.length === 1, `towers: ${towers.length}, expected 1`);
if (towers.length === 1) {
  const [c, r] = towers[0];
  const d = Math.hypot(cellX(c), cellZ(r));
  check(d <= 100, `tower is ${d.toFixed(0)} m from the centre, expected <= 100`);
  check(N4.some(([dc, dr]) => at(c + dc, r + dr) === 'B'), 'tower must touch a building block');
  check(N4.some(([dc, dr]) => nav(c + dc, r + dr)), 'tower should stand at the water edge so it is visible from the canal');
  note(`tower at (${c},${r}) = (${cellX(c)}, ${cellZ(r)}) m, ${d.toFixed(0)} m from centre`);
}

// ---------- piles ----------
const piles = [];
for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) if (at(c, r) === 'P') piles.push([c, r]);
check(piles.length <= 8, `piles: ${piles.length}, expected <= 8`);
for (const [c, r] of piles) {
  check(N4.every(([dc, dr]) => nav(c + dc, r + dr)), `pile (${c},${r}) must be surrounded by water`);
  check(lagoonMask[idx(c, r)] === 1, `pile (${c},${r}) must be in the lagoon`);
  for (const [c2, r2] of piles) if ((c2 !== c || r2 !== r) && Math.max(Math.abs(c2 - c), Math.abs(r2 - r)) < 2) check(false, `piles (${c},${r}) and (${c2},${r2}) are adjacent`);
}

// ---------- docks ----------
const docks = [];
for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) if (at(c, r) === 'S') docks.push([c, r]);
check(docks.length >= 12 && docks.length <= 20, `docks: ${docks.length}, expected 12..20 (about 16)`);
function dockHeading(c, r) {
  // away from the quay: sum of unit vectors from each B neighbour to the dock
  let vx = 0, vz = 0;
  for (const [dc, dr] of N4) if (at(c + dc, r + dr) === 'B' || at(c + dc, r + dr) === 'T') { vx -= dc; vz -= dr; }
  const open = N4.filter(([dc, dr]) => nav(c + dc, r + dr));
  if (open.length === 0) return null;
  // clearance two cells ahead in each open direction, to break ties (and the v = 0 case)
  const clearance = ([dc, dr]) => {
    let n = 0;
    for (let k = 1; k <= 3; k++) if (nav(c + dc * k, r + dr * k)) n++; else break;
    return n;
  };
  open.sort((a, b) => {
    const da = a[0] * vx + a[1] * vz, db = b[0] * vx + b[1] * vz;
    if (db !== da) return db - da;
    return clearance(b) - clearance(a);
  });
  const [dc, dr] = open[0];
  return Math.atan2(dr, dc); // 0 = +x (east), +pi/2 = +z (south), -pi/2 = north
}
for (const [c, r] of docks) {
  check(N4.some(([dc, dr]) => at(c + dc, r + dr) === 'B'), `dock (${c},${r}) has no quay (B neighbour)`);
  check(N4.some(([dc, dr]) => nav(c + dc, r + dr)), `dock (${c},${r}) is sealed`);
  check(dockHeading(c, r) !== null, `dock (${c},${r}) has no heading`);
  check(!lagoonMask[idx(c, r)] || true, '');
  for (const [c2, r2] of docks) if ((c2 !== c || r2 !== r) && Math.max(Math.abs(c2 - c), Math.abs(r2 - r)) < 2) check(false, `docks (${c},${r}) and (${c2},${r2}) are adjacent`);
}
{
  // coverage: every water cell within 110 m of some dock
  let worst = 0;
  for (const [c, r] of navCells) {
    let best = Infinity;
    for (const [dc, dr] of docks) best = Math.min(best, Math.hypot(cellX(dc) - cellX(c), cellZ(dr) - cellZ(r)));
    worst = Math.max(worst, best);
  }
  check(worst <= 112, `farthest water cell from any dock is ${worst.toFixed(0)} m, expected <= 112`);
  note(`dock coverage: farthest water cell from a dock ${worst.toFixed(0)} m`);
  // respawn rule Monte Carlo: 5 enemy boats on random water cells, dock must be >= 80 m from all
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const trials = 4000;
  let withCandidate = 0;
  let total = 0;
  let minC = Infinity;
  for (let t = 0; t < trials; t++) {
    const enemies = [];
    for (let e = 0; e < 5; e++) enemies.push(navCells[Math.floor(rnd() * navCells.length)]);
    let n = 0;
    for (const [dc, dr] of docks) {
      if (enemies.every(([ec, er]) => Math.hypot(cellX(dc) - cellX(ec), cellZ(dr) - cellZ(er)) >= 80)) n++;
    }
    if (n > 0) withCandidate++;
    total += n;
    minC = Math.min(minC, n);
  }
  check(withCandidate / trials >= 0.97, `respawn rule: only ${((withCandidate / trials) * 100).toFixed(1)}% of random 5-enemy layouts leave a dock >= 80 m away`);
  note(`respawn Monte Carlo (${trials} trials, 5 enemies): ${((withCandidate / trials) * 100).toFixed(1)}% have a candidate dock, mean candidates ${(total / trials).toFixed(1)}, min ${minC}`);
  // dock distribution per quadrant
  const q = [0, 0, 0, 0];
  for (const [c, r] of docks) q[(c < CX ? 0 : 1) + (r < CY ? 0 : 2)]++;
  check(q.every((n) => n >= 2), `docks per quadrant NW,NE,SW,SE = ${q.join(',')}, expected >= 2 each`);
  note(`docks ${docks.length}; per quadrant NW,NE,SW,SE = ${q.join(',')}; headings: ${docks.map(([c, r]) => `(${c},${r}) ${((dockHeading(c, r) * 180) / Math.PI).toFixed(0)}deg`).join(' ')}`);
}

// ---------- crates ----------
const crates = [];
for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) if (at(c, r) === 'C') crates.push([c, r]);
check(crates.length >= 20 && crates.length <= 28, `crates: ${crates.length}, expected 20..28 (about 24)`);
for (const [c, r] of crates) {
  for (const [c2, r2] of crates) if ((c2 !== c || r2 !== r) && Math.max(Math.abs(c2 - c), Math.abs(r2 - r)) < 2) check(false, `crates (${c},${r}) and (${c2},${r2}) are adjacent`);
  for (const [c2, r2] of docks) if (Math.max(Math.abs(c2 - c), Math.abs(r2 - r)) < 2) check(false, `crate (${c},${r}) touches dock (${c2},${r2})`);
}
{
  const inLagoon = crates.filter(([c, r]) => lagoonMask[idx(c, r)]);
  const lagoonCells = lagoonMask.reduce((a, b) => a + b, 0);
  const densL = inLagoon.length / lagoonCells;
  const densRest = (crates.length - inLagoon.length) / (waterCount - lagoonCells);
  check(inLagoon.length >= 7, `crates in the lagoon: ${inLagoon.length}, expected >= 7`);
  check(densL > densRest, `crate density in lagoon ${densL.toFixed(4)} must exceed the rest ${densRest.toFixed(4)}`);
  // largest cluster (crates within 40 m of each other) must be in the lagoon
  const parent = crates.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < crates.length; i++)
    for (let j = i + 1; j < crates.length; j++) {
      const d = Math.hypot(cellX(crates[i][0]) - cellX(crates[j][0]), cellZ(crates[i][1]) - cellZ(crates[j][1]));
      if (d <= 40) parent[find(i)] = find(j);
    }
  const sizes = new Map();
  crates.forEach((_, i) => sizes.set(find(i), (sizes.get(find(i)) ?? 0) + 1));
  let bigRoot = -1, big = 0;
  for (const [root, n] of sizes) if (n > big) { big = n; bigRoot = root; }
  const bigInLagoon = crates.filter((_, i) => find(i) === bigRoot).every(([c, r]) => lagoonMask[idx(c, r)]);
  check(bigInLagoon, 'the densest crate cluster must be in the lagoon');
  note(`crates ${crates.length}; in lagoon ${inLagoon.length}; density lagoon ${(densL * 100).toFixed(2)} per 100 cells vs rest ${(densRest * 100).toFixed(2)}; largest 40 m cluster ${big} crates, in lagoon: ${bigInLagoon}`);
}

// ---------- distances ----------
function bfs(starts, pass) {
  const dist = new Int32Array(W * H).fill(-1);
  const queue = [];
  for (const [c, r] of starts) { dist[idx(c, r)] = 0; queue.push([c, r]); }
  let head = 0;
  while (head < queue.length) {
    const [c, r] = queue[head++];
    const d = dist[idx(c, r)];
    for (const [dc, dr] of N4) {
      const nc = c + dc, nr = r + dr;
      if (nc < 0 || nr < 0 || nc >= W || nr >= H || !pass(nc, nr) || dist[idx(nc, nr)] >= 0) continue;
      dist[idx(nc, nr)] = d + 1;
      queue.push([nc, nr]);
    }
  }
  return dist;
}
{
  // diameter: longest shortest path over all water cells (4-connected, 8 m per step)
  let diameter = 0, pair = null;
  for (const s of navCells) {
    const dist = bfs([s], nav);
    for (const [c, r] of navCells) if (dist[idx(c, r)] > diameter) { diameter = dist[idx(c, r)]; pair = [s, [c, r]]; }
  }
  check(diameter * CELL >= 320 && diameter * CELL <= 640, `network diameter ${diameter * CELL} m, expected 320..640 m (40..80 s at 10 m/s)`);
  note(`longest shortest path (diameter) ${diameter} cells = ${diameter * CELL} m = ${(diameter * CELL / 10).toFixed(0)} s at 10 m/s, between (${pair[0]}) and (${pair[1]})`);
  // main canal length: west mouth to lagoon mouth along main-canal cells only
  const westMouth = mainCells.filter(([c]) => c === 1);
  const dist = bfs(westMouth, (c, r) => main[idx(c, r)] === 1);
  let mouthD = Infinity;
  for (const [c, r] of mainCells) if (N4.some(([dc, dr]) => nav(c + dc, r + dr) && lagoonMask[idx(c + dc, r + dr)])) mouthD = Math.min(mouthD, dist[idx(c, r)]);
  note(`main canal west mouth to lagoon mouth ${mouthD} cells = ${mouthD * CELL} m = ${(mouthD * CELL / 10).toFixed(0)} s at 10 m/s`);
  // crates reachable from every dock (already implied by connectivity) and farthest crate from its nearest dock
  const dd = bfs(docks, nav);
  let far = 0;
  for (const [c, r] of crates) far = Math.max(far, dd[idx(c, r)]);
  note(`farthest crate from the nearest dock by water: ${far} cells = ${far * CELL} m`);
  check(far * CELL <= 160, `a crate is ${far * CELL} m by water from the nearest dock, expected <= 160`);
}

// ---------- wall rectangles (greedy merge) for the physics count ----------
{
  const used = new Uint8Array(W * H);
  const rects = [];
  for (let r = 0; r < H; r++)
    for (let c = 0; c < W; c++) {
      if (used[idx(c, r)] || !'BT'.includes(at(c, r))) continue;
      let w = 1;
      while (c + w < W && !used[idx(c + w, r)] && 'BT'.includes(at(c + w, r))) w++;
      let h = 1;
      outer: while (r + h < H) {
        for (let k = 0; k < w; k++) if (used[idx(c + k, r + h)] || !'BT'.includes(at(c + k, r + h))) break outer;
        h++;
      }
      for (let dr = 0; dr < h; dr++) for (let dc = 0; dc < w; dc++) used[idx(c + dc, r + dr)] = 1;
      rects.push({ c, r, w, h });
    }
  const solid = counts.B + counts.T;
  note(`wall rectangles after greedy merge: ${rects.length} (from ${solid} solid cells, ${(solid / rects.length).toFixed(1)} cells each); plus ${piles.length} pile circles`);
}

// ---------- report ----------
console.log(`map ${W} x ${H} cells = ${W * CELL} x ${H * CELL} m, ${CELL} m per cell`);
console.log(`char counts: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ')}; water (navigable) ${waterCount} = ${((waterCount / (W * H)) * 100).toFixed(0)}%`);
for (const n of notes) console.log(`- ${n}`);
if (failures.length) {
  console.log(`\nFAILED ${failures.length} check(s):`);
  for (const f of failures) console.log(`  x ${f}`);
  process.exit(1);
}
console.log('\nALL CHECKS PASSED');
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
map 50 x 38 cells = 400 x 304 m, 8 m per cell
char counts: B=1081 ~=443 ==16 L=307 S=16 C=24 T=1 R=8 P=4; water (navigable) 814 = 43%
- lagoon edge: east (36/36 border cells); L cells 307; lagoon mask cells 328
- main canal cells 275; share covered by a 4x4 water window 81%; min width 3 cells (24 m) by construction
- main canal rows 6..26
- side canal networks 8 (lengths 24,30,95,20,11,8,19,8); cells 215 = 1720 m; bends 31; mouths 19; dead ends 3 at (15,1) (14,14) (8,22)
- covered bridge: cols 26..27 rows 23..26, deck ns, span 4 cells (32 m), depth 2 cells; centre (16, 48) m
- arch bridges 7: (11,3) ns span 1; (9,6) ns span 4; (20,6) ns span 4; (5,13) ew span 1; (35,23) ns span 4; (13,31) ew span 1; (31,31) ns span 1
- tower at (19,22) = (-44, 28) m, 52 m from centre
- dock coverage: farthest water cell from a dock 96 m
- respawn Monte Carlo (4000 trials, 5 enemies): 100.0% have a candidate dock, mean candidates 7.3, min 1
- docks 16; per quadrant NW,NE,SW,SE = 4,4,3,5; headings: (20,3) 0deg (14,6) 90deg (42,6) 0deg (29,10) 180deg (38,12) 0deg (23,13) 0deg (7,16) 180deg (37,17) 0deg (8,22) 180deg (36,23) 90deg (15,26) -90deg (30,26) -90deg (38,31) -90deg (10,33) 0deg (26,33) 0deg (42,35) 0deg
- crates 24; in lagoon 12; density lagoon 3.66 per 100 cells vs rest 2.47; largest 40 m cluster 9 crates, in lagoon: true
- longest shortest path (diameter) 77 cells = 616 m = 62 s at 10 m/s, between (1,6) and (48,36)
- main canal west mouth to lagoon mouth 64 cells = 512 m = 51 s at 10 m/s
- farthest crate from the nearest dock by water: 17 cells = 136 m
- wall rectangles after greedy merge: 69 (from 1082 solid cells, 15.7 cells each); plus 4 pile circles

ALL CHECKS PASSED
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
