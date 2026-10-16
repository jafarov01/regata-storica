// tests/sim/walls.test.ts — greedy rectangle merge and the static world built from the spec's sample map.
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import RAPIER from '@dimforge/rapier2d-compat';
import { initPhysics, Masks, PhysicsWorld } from '../../src/sim/physics';
import { buildStaticWorld, gridFromRows, mergeSolidCells, type CellRect, type GridLike } from '../../src/sim/walls';
import { cellToSim } from '../../src/sim/coords';

// The sample from SPEC.md section 7 (backslashes removed).
const SAMPLE = [
  'BBBBBBBBBBBBBBBBBBBBBBBB',
  'BBB~~BBBBB~~BBBBBBBBC~LL',
  'BBB~~BBBBB~~BBBBB~~~~~LL',
  '~~~~~~~~=~~~~~~~~~~~~~LL',
  '~~~S~~~~=~~~~C~~~~~~~SLL',
  'BBB~~BBBBBBBBB~~BBBB~~LL',
  'BBB==BBBTBBBBB~~BBBB~~LL',
  'BBB~~BBBBBBBBB~~BBBB~~LL',
];

function coverage(grid: GridLike, rects: CellRect[]): { cells: number; overlaps: number } {
  const seen = new Uint8Array(grid.cols * grid.rows);
  let overlaps = 0;
  let cells = 0;
  for (const r of rects) {
    for (let y = r.row; y < r.row + r.h; y++) {
      for (let x = r.col; x < r.col + r.w; x++) {
        expect(grid.isSolid(x, y)).toBe(true);
        const i = y * grid.cols + x;
        if (seen[i] === 1) overlaps++;
        seen[i] = 1;
        cells++;
      }
    }
  }
  return { cells, overlaps };
}

function solidCount(grid: GridLike): number {
  let n = 0;
  for (let y = 0; y < grid.rows; y++) for (let x = 0; x < grid.cols; x++) if (grid.isSolid(x, y)) n++;
  return n;
}

describe('mergeSolidCells', () => {
  it('merges a full block into one rectangle', () => {
    const rects = mergeSolidCells(gridFromRows(['BBB', 'BBB', 'BBB']));
    expect(rects).toEqual([{ col: 0, row: 0, w: 3, h: 3 }]);
  });

  it('splits an L shape into two rectangles, bridges and water are not solid', () => {
    const rects = mergeSolidCells(gridFromRows(['BB=~', 'B~~~', 'B~~~']));
    expect(rects).toEqual([
      { col: 0, row: 0, w: 2, h: 1 },
      { col: 0, row: 1, w: 1, h: 2 },
    ]);
  });

  it('covers every solid cell of the sample map exactly once, with far fewer colliders than cells', () => {
    const grid = gridFromRows(SAMPLE);
    const rects = mergeSolidCells(grid);
    const { cells, overlaps } = coverage(grid, rects);
    expect(overlaps).toBe(0);
    expect(cells).toBe(solidCount(grid));
    expect(rects.length).toBeLessThan(cells / 3);
  });
});

describe('buildStaticWorld', () => {
  let phys: PhysicsWorld;
  beforeAll(async () => {
    await initPhysics();
  });
  afterEach(() => phys.free());

  it('creates walls that block rays from water into buildings, and a border around the map', () => {
    phys = new PhysicsWorld();
    const grid = gridFromRows(SAMPLE);
    const built = buildStaticWorld(phys, grid, { poles: [{ x: 0, y: 0 }], moored: [], piles: [{ x: 5, y: 5 }] });
    expect(built.colliderCount).toBe(built.rects.length + 4 + 1 + 3);
    expect(phys.world.colliders.len()).toBe(built.colliderCount);

    // from the water cell (0,3) north into the building cell (0,2)
    const from = cellToSim(0, 3, grid.cols, grid.rows, 8, { x: 0, y: 0 });
    const to = cellToSim(0, 2, grid.cols, grid.rows, 8, { x: 0, y: 0 });
    const t = phys.wallHitFraction(from.x, from.y, to.x, to.y);
    expect(t).toBeGreaterThan(0.4);
    expect(t).toBeLessThan(0.6); // hits the cell boundary half-way
    expect(phys.hasLineOfSight(from.x, from.y, to.x, to.y)).toBe(false);

    // along the open canal row 3, east-west, nothing blocks
    const a = cellToSim(0, 3, grid.cols, grid.rows, 8, { x: 0, y: 0 });
    const b = cellToSim(20, 3, grid.cols, grid.rows, 8, { x: 0, y: 0 });
    expect(phys.hasLineOfSight(a.x, a.y, b.x, b.y)).toBe(true);

    // the ray's own membership must be accepted by the wall filter: a query with the wrong mask sees nothing
    const ray = new RAPIER.Ray({ x: from.x, y: from.y }, { x: to.x - from.x, y: to.y - from.y });
    expect(phys.world.castRay(ray, 1, true, undefined, Masks.queryCrates)).toBeNull();

    // the border: a ray shot far west ends on the border slab
    expect(phys.wallHitFraction(a.x, a.y, a.x - 1000, a.y)).toBeGreaterThan(0);
  });
});
