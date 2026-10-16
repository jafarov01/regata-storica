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
