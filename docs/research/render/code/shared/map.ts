/**
 * ASSUMED CONTRACT (to be reconciled with the real shared/map.ts written in the base phase).
 * The renderer needs exactly these helpers. Coordinates: metres, Y up, water at y = 0,
 * map origin at the centre; ASCII column -> world X, ASCII row -> world Z (row 0 = -Z edge).
 */
export const CELL = 8; // metres per ASCII cell (SPEC section 7)

export type CellChar = 'B' | '~' | '=' | 'L' | 'S' | 'C' | 'T';

export interface MapGrid {
  readonly cols: number;
  readonly rows: number;
  readonly cell: number;
  /** One string per row, every row padded to `cols` characters. */
  readonly lines: readonly string[];
}

export const SAMPLE_MAP = `
BBBBBBBBBBBBBBBBBBBBBBBB
BBB~~BBBBB~~BBBBBBBBC~LL
BBB~~BBBBB~~BBBBB~~~~~LL
~~~~~~~~=~~~~~~~~~~~~~LL
~~~S~~~~=~~~~C~~~~~~~SLL
BBB~~BBBBBBBBB~~BBBB~~LL
BBB==BBBTBBBBB~~BBBB~~LL
BBB~~BBBBBBBBB~~BBBB~~LL
`;

export function parseMap(text: string, cell: number = CELL): MapGrid {
  const raw = text
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.length > 0 && !l.startsWith('#'));
  const cols = raw.reduce((m, l) => Math.max(m, l.length), 0);
  const lines = raw.map((l) => l.padEnd(cols, '~'));
  return { cols, rows: lines.length, cell, lines };
}

export function cellAt(map: MapGrid, c: number, r: number): CellChar | undefined {
  if (c < 0 || r < 0 || c >= map.cols || r >= map.rows) return undefined;
  const ch = map.lines[r]?.[c];
  return ch === undefined ? undefined : (ch as CellChar);
}

export function worldToCell(map: MapGrid, x: number, z: number): { c: number; r: number } {
  return {
    c: Math.floor(x / map.cell + map.cols / 2),
    r: Math.floor(z / map.cell + map.rows / 2),
  };
}

/** Centre of a cell in world metres. */
export function cellToWorld(map: MapGrid, c: number, r: number): { x: number; z: number } {
  return { x: (c + 0.5 - map.cols / 2) * map.cell, z: (r + 0.5 - map.rows / 2) * map.cell };
}

/** True for building cells and for anything outside the grid (the world edge is a wall). */
export function isWall(map: MapGrid, x: number, z: number): boolean {
  const { c, r } = worldToCell(map, x, z);
  const ch = cellAt(map, c, r);
  return ch === undefined || ch === 'B' || ch === 'T';
}

export function mapWidth(map: MapGrid): number {
  return map.cols * map.cell;
}
export function mapDepth(map: MapGrid): number {
  return map.rows * map.cell;
}
