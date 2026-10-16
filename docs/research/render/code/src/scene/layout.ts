/**
 * src/scene/layout.ts
 * Split-screen layout for 2..6 teams on one canvas (SPEC section 2 table).
 * All rects are CSS pixels, origin top-left, y down (what the DOM HUD needs).
 * Use toGlViewport() to get the lower-left-origin rect that WebGLRenderer.setViewport wants.
 * Pure functions, no three.js import, unit-testable.
 */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface Layout {
  readonly width: number;
  readonly height: number;
  readonly cols: number;
  readonly rows: number;
  /** One rect per team, in team order (index = team slot). */
  readonly cells: readonly Rect[];
  /** The unused grid cell (3 and 5 teams): the live overview map. */
  readonly spare: Rect | null;
  /** Where the shared minimap draws: the spare cell, or a square at the centre crossing. */
  readonly minimap: Rect;
  /** Timer + scoreboard + kill feed band, top centre. */
  readonly scoreboard: Rect;
  /** Team-colour border width in px; the 3D viewport is inset by this. */
  readonly border: number;
}

export const LAYOUT = {
  /** Border width as a fraction of the shorter screen side (6 px at 1080p). */
  borderFrac: 6 / 1080,
  /** Minimap side as a fraction of the shorter screen side (216 px at 1080p). */
  minimapFrac: 0.2,
  scoreboardWidthFrac: 0.34,
  scoreboardHeightFrac: 0.16,
} as const;

export function gridFor(teams: number): { cols: number; rows: number } {
  if (teams <= 2) return { cols: 2, rows: 1 };
  if (teams <= 4) return { cols: 2, rows: 2 };
  return { cols: 3, rows: 2 };
}

/** Integer cell edges with no gaps and no overlaps, even when W is not divisible. */
function edge(i: number, n: number, size: number): number {
  return Math.round((i * size) / n);
}

export function computeLayout(teams: number, width: number, height: number): Layout {
  const n = Math.max(2, Math.min(6, Math.floor(teams)));
  const { cols, rows } = gridFor(n);
  const cells: Rect[] = [];
  let spare: Rect | null = null;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = edge(c, cols, width);
      const x1 = edge(c + 1, cols, width);
      const y0 = edge(r, rows, height);
      const y1 = edge(r + 1, rows, height);
      const rect: Rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      const i = r * cols + c;
      if (i < n) cells.push(rect);
      else if (spare === null) spare = rect; // 3 teams -> index 3, 5 teams -> index 5
    }
  }
  const short = Math.min(width, height);
  const border = Math.max(2, Math.round(short * LAYOUT.borderFrac));
  const side = Math.round(short * LAYOUT.minimapFrac);
  const minimap: Rect =
    spare !== null
      ? inset(spare, border)
      : { x: Math.round(width / 2 - side / 2), y: Math.round(height / 2 - side / 2), w: side, h: side };
  const sbW = Math.round(width * LAYOUT.scoreboardWidthFrac);
  const scoreboard: Rect = { x: Math.round(width / 2 - sbW / 2), y: 0, w: sbW, h: Math.round(height * LAYOUT.scoreboardHeightFrac) };
  return { width, height, cols, rows, cells, spare, minimap, scoreboard, border };
}

export function inset(r: Rect, by: number): Rect {
  return { x: r.x + by, y: r.y + by, w: Math.max(1, r.w - 2 * by), h: Math.max(1, r.h - 2 * by) };
}

/** CSS rect (y down) -> WebGL viewport/scissor rect (y up from the bottom of the canvas). */
export function toGlViewport(r: Rect, canvasHeight: number): Rect {
  return { x: r.x, y: canvasHeight - (r.y + r.h), w: r.w, h: r.h };
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export type Corner = 'tl' | 'tr' | 'bl' | 'br' | 'bc';

/**
 * Position of a HUD widget of size (w, h) anchored at a corner of a cell, pushed
 * toward the cell centre until it no longer overlaps any reserved rect
 * (the scoreboard band, the minimap). Returns the widget's top-left in CSS px.
 */
export function placeWidget(cell: Rect, corner: Corner, w: number, h: number, margin: number, reserved: readonly Rect[]): { x: number; y: number } {
  let x: number;
  let y: number;
  switch (corner) {
    case 'tl':
      x = cell.x + margin;
      y = cell.y + margin;
      break;
    case 'tr':
      x = cell.x + cell.w - margin - w;
      y = cell.y + margin;
      break;
    case 'bl':
      x = cell.x + margin;
      y = cell.y + cell.h - margin - h;
      break;
    case 'br':
      x = cell.x + cell.w - margin - w;
      y = cell.y + cell.h - margin - h;
      break;
    case 'bc':
      x = cell.x + cell.w / 2 - w / 2;
      y = cell.y + cell.h - margin - h;
      break;
  }
  const cx = cell.x + cell.w / 2;
  const cy = cell.y + cell.h / 2;
  for (let pass = 0; pass < 2; pass++) {
    for (const res of reserved) {
      const box: Rect = { x, y, w, h };
      if (!intersects(box, res)) continue;
      // minimal push along x or y, toward the cell centre
      const pushX = x + w / 2 < cx ? res.x + res.w + margin - x : res.x - margin - (x + w);
      const pushY = y + h / 2 < cy ? res.y + res.h + margin - y : res.y - margin - (y + h);
      if (Math.abs(pushX) <= Math.abs(pushY)) x += pushX;
      else y += pushY;
    }
  }
  return { x: Math.round(x), y: Math.round(y) };
}
