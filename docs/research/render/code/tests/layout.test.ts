import { describe, expect, it } from 'vitest';
import { computeLayout, placeWidget, toGlViewport, type Rect } from '../src/scene/layout.ts';

describe('computeLayout', () => {
  for (const [teams, cols, rows, spare] of [
    [2, 2, 1, false],
    [3, 2, 2, true],
    [4, 2, 2, false],
    [5, 3, 2, true],
    [6, 3, 2, false],
  ] as const) {
    it(`${teams} teams -> ${cols}x${rows}, spare=${spare}`, () => {
      const l = computeLayout(teams, 1920, 1080);
      expect(l.cols).toBe(cols);
      expect(l.rows).toBe(rows);
      expect(l.cells).toHaveLength(teams);
      expect(l.spare !== null).toBe(spare);
      // cells tile the canvas: total area equals W*H and no cell overlaps another
      const all = [...l.cells, ...(l.spare ? [l.spare] : [])];
      expect(all.reduce((s, r) => s + r.w * r.h, 0)).toBe(1920 * 1080);
      for (let i = 0; i < all.length; i++)
        for (let j = i + 1; j < all.length; j++) {
          const a = all[i]!;
          const b = all[j]!;
          const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
          expect(overlap).toBe(false);
        }
    });
  }
  it('minimap sits at the centre crossing for 4 teams and in the spare cell for 3', () => {
    const l4 = computeLayout(4, 1920, 1080);
    expect(l4.minimap.x + l4.minimap.w / 2).toBe(960);
    expect(l4.minimap.y + l4.minimap.h / 2).toBe(540);
    expect(l4.minimap.w).toBe(216);
    const l3 = computeLayout(3, 1920, 1080);
    expect(l3.spare).toEqual({ x: 960, y: 540, w: 960, h: 540 });
    expect(l3.minimap).toEqual({ x: 966, y: 546, w: 948, h: 528 });
  });
  it('handles odd widths without gaps (1366x768)', () => {
    const l = computeLayout(5, 1366, 768);
    const all = [...l.cells, l.spare!];
    expect(all.reduce((s, r) => s + r.w * r.h, 0)).toBe(1366 * 768);
  });
  it('converts to a GL viewport with the origin at the bottom left', () => {
    const r: Rect = { x: 0, y: 0, w: 960, h: 540 };
    expect(toGlViewport(r, 1080)).toEqual({ x: 0, y: 540, w: 960, h: 540 });
  });
});

describe('placeWidget', () => {
  it('pushes a corner widget away from the centre minimap', () => {
    const l = computeLayout(4, 1920, 1080);
    const cell = l.cells[3]!; // bottom-right: its top-left corner touches the minimap
    const local = [l.minimap].map((r) => ({ x: r.x - cell.x, y: r.y - cell.y, w: r.w, h: r.h }));
    const p = placeWidget({ x: 0, y: 0, w: cell.w, h: cell.h }, 'tl', 260, 80, 14, local);
    expect(p.x).toBeGreaterThanOrEqual(108 + 14);
    expect(p.y).toBe(14);
  });
  it('leaves an unobstructed corner alone', () => {
    const p = placeWidget({ x: 0, y: 0, w: 960, h: 540 }, 'tl', 260, 80, 14, []);
    expect(p).toEqual({ x: 14, y: 14 });
  });
});
