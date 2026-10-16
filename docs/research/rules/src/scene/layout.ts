/**
 * Split-screen rectangles for 2..6 teams (SPEC section 2), fixed for the round.
 * Rects are normalised (0..1) with the origin at the TOP-LEFT (CSS/HUD
 * convention). Three.js setViewport/setScissor want pixels from the
 * BOTTOM-LEFT: use toGlPixels().
 */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type SpareUse = 'overview' | 'none';

export interface Layout {
  teams: number;
  cols: number;
  rows: number;
  /** One rect per team, team index order: left to right, then top to bottom. */
  cells: Rect[];
  /** Spare grid cell (3 and 5 teams): live overview map. */
  spare: Rect | null;
  /** Where the minimap goes: the spare cell, or a square where the cells meet. */
  minimap: Rect;
  /** Translucent bar over the top centre: round timer + live scoreboard, kill feed under it. */
  topBar: Rect;
  /** Border thickness as a fraction of screen height (team colour). */
  borderFrac: number;
}

const SCREEN_ASPECT = 16 / 9;

function grid(cols: number, rows: number): Rect[] {
  const out: Rect[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) out.push({ x: c / cols, y: r / rows, w: 1 / cols, h: 1 / rows });
  }
  return out;
}

/** A square of `heightFrac` of the screen height, centred at (cx, cy), in normalised units. */
export function centredSquare(cx: number, cy: number, heightFrac: number, aspect: number = SCREEN_ASPECT): Rect {
  const h = heightFrac;
  const w = heightFrac / aspect;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

export function layoutFor(teams: number, aspect: number = SCREEN_ASPECT): Layout {
  const n = Math.max(1, Math.min(6, Math.floor(teams)));
  const topBar: Rect = { x: 0.28, y: 0, w: 0.44, h: 0.075 };
  const borderFrac = 0.006;
  switch (n) {
    case 1: {
      const cell: Rect = { x: 0, y: 0, w: 1, h: 1 };
      return { teams: 1, cols: 1, rows: 1, cells: [cell], spare: null, minimap: { x: 0.8, y: 0.72, w: 0.18, h: 0.26 }, topBar, borderFrac };
    }
    case 2: {
      const cells = grid(2, 1);
      // no spare cell: a small minimap bottom-centre, straddling the seam
      return { teams: 2, cols: 2, rows: 1, cells, spare: null, minimap: centredSquare(0.5, 0.84, 0.26, aspect), topBar, borderFrac };
    }
    case 3: {
      const g = grid(2, 2);
      const spare = g[3] ?? { x: 0.5, y: 0.5, w: 0.5, h: 0.5 };
      return { teams: 3, cols: 2, rows: 2, cells: g.slice(0, 3), spare, minimap: inset(spare, 0.04), topBar, borderFrac };
    }
    case 4: {
      return { teams: 4, cols: 2, rows: 2, cells: grid(2, 2), spare: null, minimap: centredSquare(0.5, 0.5, 0.24, aspect), topBar, borderFrac };
    }
    case 5: {
      const g = grid(3, 2);
      const spare = g[5] ?? { x: 2 / 3, y: 0.5, w: 1 / 3, h: 0.5 };
      return { teams: 5, cols: 3, rows: 2, cells: g.slice(0, 5), spare, minimap: inset(spare, 0.04), topBar, borderFrac };
    }
    default: {
      return { teams: 6, cols: 3, rows: 2, cells: grid(3, 2), spare: null, minimap: centredSquare(0.5, 0.5, 0.22, aspect), topBar, borderFrac };
    }
  }
}

export function inset(r: Rect, pad: number): Rect {
  return { x: r.x + pad, y: r.y + pad, w: r.w - 2 * pad, h: r.h - 2 * pad };
}

/** Pixels with the origin at the TOP-LEFT (CSS overlays, 2D canvas HUD). */
export function toCssPixels(r: Rect, width: number, height: number): PixelRect {
  return { x: Math.round(r.x * width), y: Math.round(r.y * height), w: Math.round(r.w * width), h: Math.round(r.h * height) };
}

/** Pixels with the origin at the BOTTOM-LEFT, for WebGLRenderer.setViewport / setScissor. */
export function toGlPixels(r: Rect, width: number, height: number): PixelRect {
  const x = Math.round(r.x * width);
  const w = Math.round(r.w * width);
  const h = Math.round(r.h * height);
  const yTop = Math.round(r.y * height);
  return { x, y: height - yTop - h, w, h };
}

export function rectAspect(r: Rect, width: number, height: number): number {
  return (r.w * width) / (r.h * height);
}

/** Does any pair of cells overlap (should never happen)? */
export function cellsOverlap(cells: readonly Rect[]): boolean {
  for (let i = 0; i < cells.length; i++) {
    for (let j = i + 1; j < cells.length; j++) {
      const a = cells[i];
      const b = cells[j];
      if (!a || !b) continue;
      const eps = 1e-9;
      if (a.x + a.w > b.x + eps && b.x + b.w > a.x + eps && a.y + a.h > b.y + eps && b.y + b.h > a.y + eps) return true;
    }
  }
  return false;
}
