import { describe, expect, it } from 'vitest';
import { findBridgeRuns, mergeBlocks } from '../src/render/buildings.ts';
import { buildHullGeometry, buildTrimGeometry, buildFerroGeometry } from '../src/render/gondola.ts';
import { cellAt, parseMap, SAMPLE_MAP } from '../shared/map.ts';

describe('map to meshes', () => {
  const map = parseMap(SAMPLE_MAP);
  it('parses the spec sample grid', () => {
    expect(map.cols).toBe(24);
    expect(map.rows).toBe(8);
    expect(cellAt(map, 8, 6)).toBe('T');
  });
  it('merges every B cell into rectangles exactly once', () => {
    const blocks = mergeBlocks(map);
    const covered = new Set<string>();
    let bCells = 0;
    for (let r = 0; r < map.rows; r++) for (let c = 0; c < map.cols; c++) if (cellAt(map, c, r) === 'B') bCells++;
    for (const b of blocks)
      for (let r = b.r; r < b.r + b.d; r++)
        for (let c = b.c; c < b.c + b.w; c++) {
          expect(cellAt(map, c, r)).toBe('B');
          const key = `${c},${r}`;
          expect(covered.has(key)).toBe(false);
          covered.add(key);
        }
    expect(covered.size).toBe(bCells);
    expect(blocks.length).toBeLessThan(bCells / 2);
  });
  it('finds the bridge runs with their orientation', () => {
    const runs = findBridgeRuns(map);
    // "BBB==BBB" on row 6 is one run of 2 along X; the '=' at column 8 rows 3-4 is one run of 2 along Z
    const alongX = runs.filter((r) => r.alongX);
    const alongZ = runs.filter((r) => !r.alongX);
    expect(alongX.map((r) => r.len)).toEqual([2]);
    expect(alongZ.map((r) => r.len)).toEqual([2]);
  });
});

describe('gondola geometry', () => {
  it('builds a closed hull with normals and a modest triangle count', () => {
    const hull = buildHullGeometry();
    expect(hull.getAttribute('normal')).toBeDefined();
    const tris = (hull.index?.count ?? 0) / 3;
    expect(tris).toBeGreaterThan(400);
    expect(tris).toBeLessThan(700);
    expect(buildTrimGeometry().index?.count).toBeGreaterThan(0);
    expect(buildFerroGeometry().getAttribute('position').count).toBeGreaterThan(20);
  });
});
