/**
 * src/scene/minimap.ts
 * Canvas 2D map used twice: the small shared minimap at the centre crossing (4 and 6 teams)
 * and the live overview map in the spare cell (3 and 5 teams). The static layer (water,
 * buildings, bridges, docks) is painted once into an offscreen canvas; per frame it is
 * blitted and crates, mines and REVEALED boats are drawn on top. A 5th top-down 3D render
 * would cost a full extra viewport; this costs well under a millisecond.
 */
import { cellAt, cellToWorld, type MapGrid } from '@shared/map.ts';
import type { RenderState } from '@shared/state.ts';

const COLOURS = {
  water: '#0c2f33',
  lagoon: '#114a50',
  building: '#b48c66',
  bridge: '#d9d2c3',
  dock: '#e9d9a5',
  tower: '#8a4b36',
  crateWeapon: '#ff4a3a',
  cratePower: '#3aa0ff',
  crateDead: 'rgba(255,255,255,0.18)',
  mine: '#111',
  frame: 'rgba(255,255,255,0.35)',
} as const;

export class MapPainter {
  private readonly base: HTMLCanvasElement;
  private readonly scale: number; // px per metre
  private readonly ox: number;
  private readonly oz: number;

  constructor(map: MapGrid, sizePx: number, private readonly dpr: number = 1) {
    const w = map.cols * map.cell;
    const d = map.rows * map.cell;
    this.scale = (sizePx * dpr) / Math.max(w, d);
    this.ox = (sizePx * dpr) / 2;
    this.oz = (sizePx * dpr) / 2;
    this.base = document.createElement('canvas');
    this.base.width = this.base.height = Math.round(sizePx * dpr);
    const ctx = this.base.getContext('2d');
    if (!ctx) throw new Error('2D canvas not available');
    ctx.fillStyle = COLOURS.water;
    ctx.fillRect(0, 0, this.base.width, this.base.height);
    const px = map.cell * this.scale;
    for (let r = 0; r < map.rows; r++) {
      for (let c = 0; c < map.cols; c++) {
        const ch = cellAt(map, c, r);
        const col = ch === 'B' ? COLOURS.building : ch === 'L' ? COLOURS.lagoon : ch === '=' ? COLOURS.bridge : ch === 'S' ? COLOURS.dock : ch === 'T' ? COLOURS.tower : null;
        if (!col) continue;
        const p = cellToWorld(map, c, r);
        ctx.fillStyle = col;
        ctx.fillRect(this.ox + (p.x - map.cell / 2) * this.scale, this.oz + (p.z - map.cell / 2) * this.scale, px + 0.5, px + 0.5);
      }
    }
  }

  get sizePx(): number {
    return this.base.width;
  }

  private sx(x: number): number {
    return this.ox + x * this.scale;
  }
  private sz(z: number): number {
    return this.oz + z * this.scale;
  }

  /** Draw into `ctx` (already sized to the painter's pixel size). `showAll` for countdown and results. */
  draw(ctx: CanvasRenderingContext2D, state: RenderState, showAll: boolean, time: number): void {
    ctx.drawImage(this.base, 0, 0);
    const r = Math.max(2, 1.2 * this.scale * this.dpr);
    for (const c of state.crates) {
      ctx.fillStyle = c.active ? (c.kind === 'weapon' ? COLOURS.crateWeapon : COLOURS.cratePower) : COLOURS.crateDead;
      ctx.beginPath();
      ctx.arc(this.sx(c.x), this.sz(c.z), r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = COLOURS.mine;
    for (const m of state.mines) {
      ctx.beginPath();
      ctx.arc(this.sx(m.x), this.sz(m.z), r * 0.7, 0, Math.PI * 2);
      ctx.fill();
    }
    const teamColour = new Map<number, number>();
    for (const t of state.teams) teamColour.set(t.id, t.colour);
    const len = Math.max(5, 5 * this.scale * this.dpr);
    for (const b of state.boats) {
      if (!b.alive) continue;
      if (!showAll && !b.revealed) continue;
      const colour = teamColour.get(b.team) ?? 0xffffff;
      const css = `#${colour.toString(16).padStart(6, '0')}`;
      const x = this.sx(b.x);
      const z = this.sz(b.z);
      ctx.save();
      ctx.translate(x, z);
      ctx.rotate(b.yaw);
      ctx.fillStyle = css;
      ctx.beginPath();
      ctx.moveTo(len, 0);
      ctx.lineTo(-len * 0.6, len * 0.55);
      ctx.lineTo(-len * 0.6, -len * 0.55);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      if (b.revealed && !showAll) {
        ctx.strokeStyle = css;
        ctx.lineWidth = 1.5 * this.dpr;
        ctx.beginPath();
        ctx.arc(x, z, len * (1.4 + 0.4 * Math.sin(time * 6)), 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.strokeStyle = COLOURS.frame;
    ctx.lineWidth = 2 * this.dpr;
    ctx.strokeRect(1, 1, this.base.width - 2, this.base.height - 2);
  }
}
