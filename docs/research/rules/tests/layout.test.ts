import { describe, expect, it } from 'vitest';
import { cellsOverlap, layoutFor, rectAspect, toCssPixels, toGlPixels } from '../src/scene/layout.ts';

describe('split-screen layouts (SPEC section 2 table)', () => {
  it('2 teams: two side-by-side halves, no spare', () => {
    const l = layoutFor(2);
    expect(l.cells).toEqual([
      { x: 0, y: 0, w: 0.5, h: 1 },
      { x: 0.5, y: 0, w: 0.5, h: 1 },
    ]);
    expect(l.spare).toBeNull();
  });
  it('3 teams: 2x2 with the spare cell as overview', () => {
    const l = layoutFor(3);
    expect(l.cells.length).toBe(3);
    expect(l.spare).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
    expect(l.minimap.x).toBeGreaterThan(0.5);
  });
  it('4 teams: 2x2, minimap centred where the cells meet', () => {
    const l = layoutFor(4);
    expect(l.cells.length).toBe(4);
    expect(l.spare).toBeNull();
    expect(l.minimap.x + l.minimap.w / 2).toBeCloseTo(0.5);
    expect(l.minimap.y + l.minimap.h / 2).toBeCloseTo(0.5);
    expect(rectAspect(l.minimap, 1920, 1080)).toBeCloseTo(1); // a square on a 16:9 screen
  });
  it('5 teams: 3x2 with a spare; 6 teams: 3x2 full', () => {
    const l5 = layoutFor(5);
    expect(l5.cells.length).toBe(5);
    expect(l5.spare).toEqual({ x: 2 / 3, y: 0.5, w: 1 / 3, h: 0.5 });
    const l6 = layoutFor(6);
    expect(l6.cells.length).toBe(6);
    expect(l6.spare).toBeNull();
  });
  it('cells never overlap, stay inside the screen and cover it with the spare', () => {
    for (let n = 1; n <= 6; n++) {
      const l = layoutFor(n);
      expect(cellsOverlap(l.cells), `n=${n}`).toBe(false);
      const area = l.cells.reduce((s, c) => s + c.w * c.h, 0) + (l.spare ? l.spare.w * l.spare.h : 0);
      expect(area).toBeCloseTo(1);
      for (const c of l.cells) {
        expect(c.x).toBeGreaterThanOrEqual(0);
        expect(c.y).toBeGreaterThanOrEqual(0);
        expect(c.x + c.w).toBeLessThanOrEqual(1 + 1e-9);
        expect(c.y + c.h).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });
  it('clamps to 1..6', () => {
    expect(layoutFor(0).cells.length).toBe(1);
    expect(layoutFor(9).cells.length).toBe(6);
  });
});

describe('pixel conversion', () => {
  it('GL rects flip y (bottom-left origin) and CSS rects do not', () => {
    const l = layoutFor(4);
    const tl = l.cells[0]!;
    expect(toCssPixels(tl, 1920, 1080)).toEqual({ x: 0, y: 0, w: 960, h: 540 });
    expect(toGlPixels(tl, 1920, 1080)).toEqual({ x: 0, y: 540, w: 960, h: 540 });
    const br = l.cells[3]!;
    expect(toGlPixels(br, 1920, 1080)).toEqual({ x: 960, y: 0, w: 960, h: 540 });
    expect(rectAspect(tl, 1920, 1080)).toBeCloseTo(16 / 9);
    expect(rectAspect(layoutFor(2).cells[0]!, 1920, 1080)).toBeCloseTo(8 / 9);
  });
});
