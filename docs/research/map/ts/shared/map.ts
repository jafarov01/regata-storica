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
