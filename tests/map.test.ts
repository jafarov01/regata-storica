import { describe, expect, it } from 'vitest';
import { CELL, dirFromYaw, getMap, parseMap, reachableWaterCells, yawFromDir } from '../shared/map.ts';

const map = getMap();

describe('map grid', () => {
  it('is 28 x 22 cells of 8 m (224 x 176 m) with a solid border', () => {
    expect(map.width).toBe(28);
    expect(map.height).toBe(22);
    expect(map.cell).toBe(CELL);
    for (let c = 0; c < map.width; c++) {
      expect(map.cellAt(c, 0)).toBe('B');
      expect(map.cellAt(c, map.height - 1)).toBe('B');
    }
    for (let r = 0; r < map.height; r++) {
      expect(map.cellAt(0, r)).toBe('B');
      expect(map.cellAt(map.width - 1, r)).toBe('B');
    }
  });

  it('has one connected water region', () => {
    const first = map.docks[0];
    expect(first).toBeDefined();
    if (!first) return;
    expect(reachableWaterCells(map, first.col, first.row)).toBe(map.waterCellCount);
  });

  it('has the compact counts: 8 docks, 11 crates, 2 arch bridges + 1 covered, 1 tower', () => {
    expect(map.docks).toHaveLength(8);
    expect(map.crates).toHaveLength(11);
    expect(map.bridges.filter((b) => !b.covered)).toHaveLength(2);
    expect(map.bridges.filter((b) => b.covered)).toHaveLength(1);
    expect(map.tower).not.toBeNull();
    expect(map.piles.length).toBeGreaterThan(0);
  });

  it('puts the densest crate cluster in the lagoon', () => {
    const inLagoon = map.crates.filter((c) => c.lagoon).length;
    expect(inLagoon).toBeGreaterThanOrEqual(4);
    expect(inLagoon).toBeLessThan(map.crates.length);
  });

  it('docks sit against a quay, never adjacent to each other, and face open water', () => {
    for (const d of map.docks) {
      let quay = false;
      for (const [dc, dr] of [
        [0, -1],
        [1, 0],
        [0, 1],
        [-1, 0],
      ] as const) {
        const ch = map.cellAt(d.col + dc, d.row + dr);
        if (ch === 'B' || ch === 'T') quay = true;
      }
      expect(quay, `dock ${d.id} at ${d.col},${d.row} has no quay`).toBe(true);
      for (const o of map.docks) {
        if (o === d) continue;
        expect(Math.max(Math.abs(o.col - d.col), Math.abs(o.row - d.row))).toBeGreaterThan(1);
      }
      const dir = dirFromYaw(d.yaw);
      const ahead = map.cellAtWorld(d.x + dir.x * CELL, d.z + dir.z * CELL);
      expect(ahead, `dock ${d.id} faces a wall`).not.toBe('B');
    }
  });

  it('merges walls into few rectangles that cover every solid cell exactly once', () => {
    expect(map.walls.length).toBeLessThan(120);
    const covered: number[] = new Array<number>(map.width * map.height).fill(0);
    for (const w of map.walls) {
      for (let r = 0; r < w.rows; r++) for (let c = 0; c < w.cols; c++) covered[(w.row + r) * map.width + w.col + c] = (covered[(w.row + r) * map.width + w.col + c] ?? 0) + 1;
    }
    for (let r = 0; r < map.height; r++) {
      for (let c = 0; c < map.width; c++) {
        const ch = map.cellAt(c, r);
        expect(covered[r * map.width + c]).toBe(ch === 'B' || ch === 'T' ? 1 : 0);
      }
    }
  });
});

describe('coordinates', () => {
  it('round-trips world <-> cell with the origin at the centre', () => {
    const centre = map.toWorld(map.width / 2, map.height / 2);
    expect(centre.x).toBeCloseTo(CELL / 2);
    expect(centre.z).toBeCloseTo(CELL / 2);
    const p = map.toWorld(8, 3);
    expect(map.toCell(p.x, p.z)).toEqual({ col: 8, row: 3 });
    expect(map.toCell(p.x + 3.9, p.z - 3.9)).toEqual({ col: 8, row: 3 });
    expect(map.isWaterAt(p.x, p.z)).toBe(true);
  });

  it('yaw 0 points to -z and positive yaw turns left (toward -x)', () => {
    expect(dirFromYaw(0)).toEqual({ x: -0, z: -1 });
    const left = dirFromYaw(Math.PI / 2);
    expect(left.x).toBeCloseTo(-1);
    expect(left.z).toBeCloseTo(0);
    expect(yawFromDir(0, -1)).toBeCloseTo(0);
    expect(yawFromDir(-1, 0)).toBeCloseTo(Math.PI / 2);
    expect(yawFromDir(1, 0)).toBeCloseTo(-Math.PI / 2);
  });

  it('rejects malformed maps', () => {
    expect(() => parseMap('BBB\nB~B\nBB')).toThrow();
    expect(() => parseMap('BBB\nB~X\nBBB')).toThrow();
    expect(() => parseMap('BBB\n~~B\nBBB')).toThrow();
  });
});
