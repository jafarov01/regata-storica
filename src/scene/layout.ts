/**
 * Split-screen rectangles for 1..6 teams (SPEC section 2), fixed for the round.
 * Adapted from docs/research/rules (layout.ts). Rects are CSS pixels with the
 * origin at the top-left, as `Layout` in shared/api.ts says; WebGL needs y
 * flipped (toGl below).
 *
 *   teams  grid  spare cell
 *   1      1x1   none (dev only)
 *   2      2x1   none, minimap bottom-centre on the seam
 *   3      2x2   bottom-right: overview map
 *   4      2x2   none, minimap where the cells meet
 *   5      3x2   bottom-right: overview map
 *   6      3x2   none, minimap where the cells meet
 */
import type { Layout, Rect } from '@shared/api.ts';

interface NRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function grid(cols: number, rows: number): NRect[] {
  const out: NRect[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) out.push({ x: c / cols, y: r / rows, w: 1 / cols, h: 1 / rows });
  }
  return out;
}

/** A square `heightFrac` of the screen height, centred at (cx, cy), in normalised units. */
function centredSquare(cx: number, cy: number, heightFrac: number, aspect: number): NRect {
  const w = heightFrac / aspect;
  return { x: cx - w / 2, y: cy - heightFrac / 2, w, h: heightFrac };
}

function inset(r: NRect, pad: number): NRect {
  return { x: r.x + pad, y: r.y + pad, w: r.w - 2 * pad, h: r.h - 2 * pad };
}

function px(r: NRect, width: number, height: number): Rect {
  const x = Math.round(r.x * width);
  const y = Math.round(r.y * height);
  return { x, y, w: Math.round((r.x + r.w) * width) - x, h: Math.round((r.y + r.h) * height) - y };
}

export function computeLayout(teams: number, width: number, height: number): Layout {
  const n = Math.max(1, Math.min(6, Math.floor(teams)));
  const aspect = width / Math.max(1, height);
  let cells: NRect[];
  let spare: NRect | null = null;
  let minimap: NRect;
  switch (n) {
    case 1:
      cells = [{ x: 0, y: 0, w: 1, h: 1 }];
      minimap = { x: 0.8, y: 0.72, w: 0.18 / (aspect / (16 / 9)), h: 0.26 };
      break;
    case 2:
      cells = grid(2, 1);
      minimap = centredSquare(0.5, 0.83, 0.3, aspect);
      break;
    case 3: {
      const g = grid(2, 2);
      cells = g.slice(0, 3);
      spare = g[3] ?? null;
      minimap = spare ? inset(spare, 0.04) : centredSquare(0.75, 0.75, 0.4, aspect);
      break;
    }
    case 4:
      cells = grid(2, 2);
      minimap = centredSquare(0.5, 0.5, 0.3, aspect);
      break;
    case 5: {
      const g = grid(3, 2);
      cells = g.slice(0, 5);
      spare = g[5] ?? null;
      minimap = spare ? inset(spare, 0.04) : centredSquare(0.83, 0.75, 0.4, aspect);
      break;
    }
    default:
      cells = grid(3, 2);
      minimap = centredSquare(0.5, 0.5, 0.27, aspect);
  }
  return {
    width,
    height,
    cells: cells.map((c) => px(c, width, height)),
    spare: spare ? px(spare, width, height) : null,
    minimap: px(minimap, width, height),
  };
}

/** WebGL setViewport/setScissor rect (origin bottom-left) for a CSS rect. */
export function toGl(r: Rect, canvasHeight: number): Rect {
  return { x: r.x, y: canvasHeight - r.y - r.h, w: r.w, h: r.h };
}
