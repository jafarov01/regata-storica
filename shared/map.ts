/**
 * shared/map.ts: the Venice district as one ASCII grid, its legend, parser and
 * coordinate rules.
 *
 * CONTRACT FILE. Physics (src/sim) builds its walls from `parseMap().walls`;
 * the renderer (src/render) builds buildings, bridges and the lagoon from the
 * same cells. Nobody else needs to agree on anything but this file.
 *
 * Coordinate rules
 * ----------------
 * - 8 m per cell, 28 x 22 cells = 224 x 176 m (cut down from the 50 x 38 district on
 *   2026-10-16: a compact basin for crews of 2; lagoon east, covered bridge, side canals).
 * - Metres, Three.js world frame, Y up, water surface at y = 0.
 * - Map origin at the centre: x = (col - W/2 + 0.5) * 8, z = (row - H/2 + 0.5) * 8.
 *   Row 0 is the far side (negative z); col 0 is the west side (negative x).
 * - The 2D sim uses (x, z). Yaw is Object3D.rotation.y: forward = (-sin yaw, -cos yaw),
 *   yaw 0 points toward -z (up on this map), yaw +PI/2 toward -x (left), positive
 *   yaw turns left. `yawFromDir` and `dirFromYaw` below are the only conversions.
 *
 * Legend
 * ------
 *   B  building (solid wall, 3 to 5 floors)        ~  canal water
 *   =  arched stone bridge (water for physics)     R  the big covered bridge (water for physics)
 *   L  lagoon water (open basin; minimap always reveals boats here)
 *   S  spawn dock (water, next to a quay)          C  crate point (water)
 *   T  bell tower, the campanile (solid)           P  wooden pile cluster (solid, small)
 */

export const CELL = 8;

export const MAP_TEXT = `
BBBBBBBBBBBBBBBBBBBBBBBBBBBB
BBBBBBBBBB~~~SBBBBBBBLLLLLLB
BBBBBBBBB~~~~~BBBBBBBLLCLLLB
BBBBBBBB~~C~~BBBBBBBBLLLLLLB
BBBBBBBS~~~~BBBBBBBBSLLLPLLB
BCBBBB~~~~~~BBBBBBBB~LLLLLLB
B~BBB~~~~~B~BBBBBBBB~LLLLLLB
B~~~~~~~~BB~C~~~~~~~~LLCLLLB
BBB~~~~~BBBBBBBBBB~BBSLLLLLB
BBB~~C~BBBBBBBBBBB~BBLLLLLLB
BB~~~~~BBBBBBBBBBB~BBLLLLCLB
B~~~~~TBBBBBBBBBBB~BBLLLLLLB
B~~~~~~~~~~RR~~~~~~~=LLLLLLB
B~~~~~~C~~~RR~~~~~~~=LLPLLLB
B~~~~~~~~~~RR~~~C~~~=LLLLLLB
B~S~~~~~~~~RR~~S~~~~=LLLCLLB
BBBB~BBB~BBBBBBBB~BBBLLLLLLB
BBBB~BBB~BBBBBBBB~BBBLLLLLLB
BBBB~BBB~BBBBBBBB~~~~LLLLCLB
BS~~~BBB~~~~~BBBBBBBBLLLLLLB
BBBBBBBBBBBB~~~~=~~~~LSLLLLB
BBBBBBBBBBBBBBBBBBBBBBBBBBBB
`.trim();

export type Cell = 'B' | '~' | '=' | 'R' | 'L' | 'S' | 'C' | 'T' | 'P';

export const LEGEND: Record<Cell, string> = {
  B: 'building',
  '~': 'water',
  '=': 'bridge',
  R: 'covered bridge',
  L: 'lagoon',
  S: 'spawn dock',
  C: 'crate point',
  T: 'bell tower',
  P: 'pile cluster',
};

/** Cells a boat can be on. Bridges count: boats pass under every bridge. */
export const WATER_CELLS: ReadonlySet<Cell> = new Set<Cell>(['~', '=', 'R', 'L', 'S', 'C']);
/** Cells that become wall rectangles. Piles are separate round obstacles. */
export const WALL_CELLS: ReadonlySet<Cell> = new Set<Cell>(['B', 'T']);

export interface WallRect {
  /** Centre in metres. */
  x: number;
  z: number;
  /** Full size in metres along x and z. */
  w: number;
  d: number;
  /** Grid extent, handy for the renderer. */
  col: number;
  row: number;
  cols: number;
  rows: number;
}

export interface Dock {
  id: number;
  x: number;
  z: number;
  /** Faces away from the quay into open water. */
  yaw: number;
  col: number;
  row: number;
}

export interface CratePoint {
  id: number;
  x: number;
  z: number;
  col: number;
  row: number;
  /** True for crate points in the lagoon basin. */
  lagoon: boolean;
}

export interface Bridge {
  x: number;
  z: number;
  /** Deck direction: 'ns' runs along z (spans an east-west canal), 'ew' runs along x. */
  deck: 'ns' | 'ew';
  /** Deck length in cells (the canal width it spans). */
  span: number;
  /** Deck width in cells (1 for arch bridges, 2 for the covered bridge). */
  width: number;
  covered: boolean;
  cells: { col: number; row: number }[];
}

export interface Pile {
  x: number;
  z: number;
  radius: number;
}

export interface ParsedMap {
  width: number;
  height: number;
  cell: number;
  /** World size in metres. */
  worldW: number;
  worldD: number;
  rows: readonly string[];
  walls: WallRect[];
  docks: Dock[];
  crates: CratePoint[];
  bridges: Bridge[];
  tower: { x: number; z: number; col: number; row: number } | null;
  piles: Pile[];
  /** Number of navigable water cells (tests and the overview map). */
  waterCellCount: number;
  cellAt(col: number, row: number): Cell | null;
  cellAtWorld(x: number, z: number): Cell | null;
  isWater(col: number, row: number): boolean;
  isWaterAt(x: number, z: number): boolean;
  isLagoonAt(x: number, z: number): boolean;
  toWorld(col: number, row: number): { x: number; z: number };
  toCell(x: number, z: number): { col: number; row: number };
}

// ---------------------------------------------------------------------------
// Direction helpers (the only place yaw <-> vector conversions live).
// ---------------------------------------------------------------------------

/** Unit direction for a world yaw: forward = (-sin yaw, -cos yaw). */
export function dirFromYaw(yaw: number): { x: number; z: number } {
  return { x: -Math.sin(yaw), z: -Math.cos(yaw) };
}

/** World yaw that points along (dx, dz). */
export function yawFromDir(dx: number, dz: number): number {
  return Math.atan2(-dx, -dz);
}

/** The 4 grid directions as (dcol, drow). */
const DIRS: readonly { dc: number; dr: number }[] = [
  { dc: 0, dr: -1 }, // north (-z)
  { dc: 1, dr: 0 }, // east (+x)
  { dc: 0, dr: 1 }, // south (+z)
  { dc: -1, dr: 0 }, // west (-x)
];

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export function parseMap(text: string = MAP_TEXT): ParsedMap {
  const rows = text
    .split('\n')
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
  const height = rows.length;
  const width = rows[0]?.length ?? 0;
  if (width === 0 || height === 0) throw new Error('map: empty');
  for (let r = 0; r < height; r++) {
    const row = rows[r];
    if (!row || row.length !== width) throw new Error(`map: row ${r} has length ${row?.length ?? 0}, expected ${width}`);
    for (let c = 0; c < width; c++) {
      const ch = row[c] as string;
      if (!(ch in LEGEND)) throw new Error(`map: unknown cell '${ch}' at row ${r} col ${c}`);
      const border = r === 0 || c === 0 || r === height - 1 || c === width - 1;
      if (border && ch !== 'B') throw new Error(`map: border must be B, found '${ch}' at row ${r} col ${c}`);
    }
  }

  const cellAt = (col: number, row: number): Cell | null => {
    if (col < 0 || row < 0 || col >= width || row >= height) return null;
    return (rows[row] as string)[col] as Cell;
  };
  const isWater = (col: number, row: number): boolean => {
    const c = cellAt(col, row);
    return c !== null && WATER_CELLS.has(c);
  };
  const toWorld = (col: number, row: number) => ({
    x: (col - width / 2 + 0.5) * CELL,
    z: (row - height / 2 + 0.5) * CELL,
  });
  const toCell = (x: number, z: number) => ({
    col: Math.floor(x / CELL + width / 2),
    row: Math.floor(z / CELL + height / 2),
  });
  const cellAtWorld = (x: number, z: number): Cell | null => {
    const { col, row } = toCell(x, z);
    return cellAt(col, row);
  };

  // Walls: greedy rectangle merge of solid cells (B and T), row-major.
  const walls: WallRect[] = [];
  const used = new Uint8Array(width * height);
  const solid = (c: number, r: number) => {
    const ch = cellAt(c, r);
    return ch !== null && WALL_CELLS.has(ch);
  };
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      if (used[r * width + c] || !solid(c, r)) continue;
      let cols = 1;
      while (c + cols < width && solid(c + cols, r) && !used[r * width + c + cols]) cols++;
      let rowsN = 1;
      outer: while (r + rowsN < height) {
        for (let k = 0; k < cols; k++) {
          if (!solid(c + k, r + rowsN) || used[(r + rowsN) * width + c + k]) break outer;
        }
        rowsN++;
      }
      for (let rr = 0; rr < rowsN; rr++) for (let k = 0; k < cols; k++) used[(r + rr) * width + c + k] = 1;
      const tl = toWorld(c, r);
      walls.push({
        x: tl.x - CELL / 2 + (cols * CELL) / 2,
        z: tl.z - CELL / 2 + (rowsN * CELL) / 2,
        w: cols * CELL,
        d: rowsN * CELL,
        col: c,
        row: r,
        cols,
        rows: rowsN,
      });
    }
  }

  // Docks, crates, tower, piles, lagoon.
  const docks: Dock[] = [];
  const crates: CratePoint[] = [];
  const piles: Pile[] = [];
  let tower: ParsedMap['tower'] = null;
  let waterCellCount = 0;
  const lagoonIdx = new Uint8Array(width * height);
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const ch = cellAt(c, r) as Cell;
      if (WATER_CELLS.has(ch)) waterCellCount++;
      const p = toWorld(c, r);
      switch (ch) {
        case 'S':
          docks.push({ id: docks.length, x: p.x, z: p.z, yaw: 0, col: c, row: r });
          break;
        case 'C':
          crates.push({ id: crates.length, x: p.x, z: p.z, col: c, row: r, lagoon: false });
          break;
        case 'T':
          tower = { x: p.x, z: p.z, col: c, row: r };
          break;
        case 'P':
          piles.push({ x: p.x, z: p.z, radius: 1.6 });
          break;
        case 'L':
          lagoonIdx[r * width + c] = 1;
          break;
        default:
          break;
      }
    }
  }
  // The lagoon basin also covers docks and crates inside it: flood from L cells through S/C only.
  const lagoonQueue: number[] = [];
  for (let i = 0; i < lagoonIdx.length; i++) if (lagoonIdx[i]) lagoonQueue.push(i);
  while (lagoonQueue.length) {
    const i = lagoonQueue.pop() as number;
    const c = i % width;
    const r = (i - c) / width;
    for (const d of DIRS) {
      const nc = c + d.dc;
      const nr = r + d.dr;
      const ch = cellAt(nc, nr);
      if ((ch === 'S' || ch === 'C' || ch === 'L') && !lagoonIdx[nr * width + nc]) {
        lagoonIdx[nr * width + nc] = 1;
        lagoonQueue.push(nr * width + nc);
      }
    }
  }
  for (const cr of crates) cr.lagoon = lagoonIdx[cr.row * width + cr.col] === 1;
  const isLagoonAt = (x: number, z: number): boolean => {
    const { col, row } = toCell(x, z);
    if (col < 0 || row < 0 || col >= width || row >= height) return false;
    return lagoonIdx[row * width + col] === 1;
  };

  // Dock headings: face the direction with the longest run of open water.
  for (const dock of docks) {
    let best = DIRS[0] as { dc: number; dr: number };
    let bestRun = -1;
    for (const d of DIRS) {
      let run = 0;
      while (isWater(dock.col + d.dc * (run + 1), dock.row + d.dr * (run + 1))) run++;
      if (run > bestRun) {
        bestRun = run;
        best = d;
      }
    }
    dock.yaw = yawFromDir(best.dc, best.dr);
  }

  // Bridges: connected groups of '=' or 'R' cells.
  const bridges: Bridge[] = [];
  const seen = new Uint8Array(width * height);
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const ch = cellAt(c, r);
      if ((ch !== '=' && ch !== 'R') || seen[r * width + c]) continue;
      const cells: { col: number; row: number }[] = [];
      const stack = [{ col: c, row: r }];
      seen[r * width + c] = 1;
      while (stack.length) {
        const cur = stack.pop() as { col: number; row: number };
        cells.push(cur);
        for (const d of DIRS) {
          const nc = cur.col + d.dc;
          const nr = cur.row + d.dr;
          if (cellAt(nc, nr) === ch && !seen[nr * width + nc]) {
            seen[nr * width + nc] = 1;
            stack.push({ col: nc, row: nr });
          }
        }
      }
      const minC = Math.min(...cells.map((k) => k.col));
      const maxC = Math.max(...cells.map((k) => k.col));
      const minR = Math.min(...cells.map((k) => k.row));
      const maxR = Math.max(...cells.map((k) => k.row));
      const colsN = maxC - minC + 1;
      const rowsN = maxR - minR + 1;
      const deck: Bridge['deck'] = rowsN >= colsN ? 'ns' : 'ew';
      const centre = toWorld(minC + (colsN - 1) / 2, minR + (rowsN - 1) / 2);
      bridges.push({
        x: centre.x,
        z: centre.z,
        deck,
        span: deck === 'ns' ? rowsN : colsN,
        width: deck === 'ns' ? colsN : rowsN,
        covered: ch === 'R',
        cells,
      });
    }
  }

  return {
    width,
    height,
    cell: CELL,
    worldW: width * CELL,
    worldD: height * CELL,
    rows,
    walls,
    docks,
    crates,
    bridges,
    tower,
    piles,
    waterCellCount,
    cellAt,
    cellAtWorld,
    isWater,
    isWaterAt: (x, z) => {
      const { col, row } = toCell(x, z);
      return isWater(col, row);
    },
    isLagoonAt,
    toWorld,
    toCell,
  };
}

let cached: ParsedMap | null = null;

/** The default map, parsed once. */
export function getMap(): ParsedMap {
  if (!cached) cached = parseMap(MAP_TEXT);
  return cached;
}

/** Flood fill from one water cell; returns the number of reachable water cells (tests, validation). */
export function reachableWaterCells(map: ParsedMap, startCol: number, startRow: number): number {
  if (!map.isWater(startCol, startRow)) return 0;
  const seen = new Uint8Array(map.width * map.height);
  const stack = [startRow * map.width + startCol];
  seen[stack[0] as number] = 1;
  let count = 0;
  while (stack.length) {
    const i = stack.pop() as number;
    count++;
    const c = i % map.width;
    const r = (i - c) / map.width;
    for (const d of DIRS) {
      const nc = c + d.dc;
      const nr = r + d.dr;
      if (map.isWater(nc, nr) && !seen[nr * map.width + nc]) {
        seen[nr * map.width + nc] = 1;
        stack.push(nr * map.width + nc);
      }
    }
  }
  return count;
}
