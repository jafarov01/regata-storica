// src/sim/walls.ts — static scenery from the ASCII map: merged building rectangles, border, poles, moored boats, piles.
import RAPIER, { type RigidBody } from '@dimforge/rapier2d-compat';
import { PHYSICS } from '@shared/config';
import { cellToSim, type Vec2 } from './coords';
import { Masks, type PhysicsWorld } from './physics';

/** Anything that can answer "is this cell solid for boats". shared/map.ts provides it. */
export interface GridLike {
  cols: number;
  rows: number;
  isSolid(col: number, row: number): boolean;
}

/** Legend: B building and T tower are solid; ~ water, L lagoon, S dock, C crate point, = bridge (water for physics). */
export function isSolidChar(ch: string): boolean {
  return ch === 'B' || ch === 'T';
}

export function gridFromRows(rows: readonly string[]): GridLike {
  const cols = rows.reduce((m, r) => Math.max(m, r.length), 0);
  return {
    cols,
    rows: rows.length,
    isSolid(col, row) {
      const line = rows[row];
      if (line === undefined) return false;
      const ch = line[col];
      return ch === undefined ? false : isSolidChar(ch);
    },
  };
}

export interface CellRect {
  col: number;
  row: number;
  w: number;
  h: number;
}

/**
 * Greedy rectangle merging: scan row-major; grow a run to the right, then grow it downward
 * while every cell of the next row under the run is solid and unvisited. O(cells), typically
 * turns ~1000 building cells into a few dozen cuboids.
 */
export function mergeSolidCells(grid: GridLike): CellRect[] {
  const { cols, rows } = grid;
  const visited = new Uint8Array(cols * rows);
  const out: CellRect[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (visited[r * cols + c] === 1 || !grid.isSolid(c, r)) continue;
      let w = 1;
      while (c + w < cols && grid.isSolid(c + w, r) && visited[r * cols + c + w] === 0) w++;
      let h = 1;
      grow: while (r + h < rows) {
        for (let k = 0; k < w; k++) {
          if (!grid.isSolid(c + k, r + h) || visited[(r + h) * cols + c + k] === 1) break grow;
        }
        h++;
      }
      for (let rr = r; rr < r + h; rr++) for (let cc = c; cc < c + w; cc++) visited[rr * cols + cc] = 1;
      out.push({ col: c, row: r, w, h });
    }
  }
  return out;
}

export interface MooredBoat {
  x: number;
  y: number;
  angle: number;
}

/** Positions in sim coordinates; shared/map.ts derives them from the grid so art and physics agree. */
export interface StaticProps {
  poles: readonly Vec2[];
  moored: readonly MooredBoat[];
  piles: readonly Vec2[];
}

export const POLE_RADIUS = 0.25;
export const PILE_RADIUS = 0.35;
const WALL_RESTITUTION = 0.4;
const WALL_FRICTION = 0;

export interface StaticWorld {
  body: RigidBody;
  rects: CellRect[];
  colliderCount: number;
}

/** One fixed body carries every static collider; collider translations are world positions. */
export function buildStaticWorld(
  phys: PhysicsWorld,
  grid: GridLike,
  props: StaticProps,
  cell: number = PHYSICS.cellSize,
): StaticWorld {
  const body = phys.createBody(RAPIER.RigidBodyDesc.fixed());
  const wallRef = { kind: 'wall', id: -1 } as const;
  const poleRef = { kind: 'pole', id: -1 } as const;
  const centre: Vec2 = { x: 0, y: 0 };
  let count = 0;

  const rects = mergeSolidCells(grid);
  for (const rc of rects) {
    cellToSim(rc.col + rc.w / 2 - 0.5, rc.row + rc.h / 2 - 0.5, grid.cols, grid.rows, cell, centre);
    phys.createCollider(
      RAPIER.ColliderDesc.cuboid((rc.w * cell) / 2, (rc.h * cell) / 2)
        .setTranslation(centre.x, centre.y)
        .setFriction(WALL_FRICTION)
        .setRestitution(WALL_RESTITUTION)
        .setCollisionGroups(Masks.wall),
      body,
      wallRef,
    );
    count++;
  }

  // Border: four slabs one cell thick hugging the outside of the grid.
  const hx = (grid.cols * cell) / 2;
  const hy = (grid.rows * cell) / 2;
  const t = cell / 2;
  const border: readonly [number, number, number, number][] = [
    [-hx - t, 0, t, hy + cell], // west
    [hx + t, 0, t, hy + cell], // east
    [0, hy + t, hx + cell, t], // north (sim +y = world -z)
    [0, -hy - t, hx + cell, t], // south
  ];
  for (const [x, y, ex, ey] of border) {
    phys.createCollider(
      RAPIER.ColliderDesc.cuboid(ex, ey)
        .setTranslation(x, y)
        .setFriction(WALL_FRICTION)
        .setRestitution(WALL_RESTITUTION)
        .setCollisionGroups(Masks.wall),
      body,
      wallRef,
    );
    count++;
  }

  for (const p of props.poles) {
    phys.createCollider(
      RAPIER.ColliderDesc.ball(POLE_RADIUS).setTranslation(p.x, p.y).setRestitution(0.5).setCollisionGroups(Masks.pole),
      body,
      poleRef,
    );
    count++;
  }
  for (const m of props.moored) {
    phys.createCollider(
      RAPIER.ColliderDesc.cuboid(PHYSICS.boat.width / 2, PHYSICS.boat.length / 2)
        .setTranslation(m.x, m.y)
        .setRotation(m.angle)
        .setRestitution(WALL_RESTITUTION)
        .setCollisionGroups(Masks.wall),
      body,
      wallRef,
    );
    count++;
  }
  // A pile cluster: three posts in a tight triangle (one collider each; they block shots like a wall).
  for (const p of props.piles) {
    for (let k = 0; k < 3; k++) {
      const ang = (k * 2 * Math.PI) / 3;
      phys.createCollider(
        RAPIER.ColliderDesc.ball(PILE_RADIUS)
          .setTranslation(p.x + Math.cos(ang) * 0.6, p.y + Math.sin(ang) * 0.6)
          .setRestitution(0.5)
          .setCollisionGroups(Masks.wall),
        body,
        wallRef,
      );
      count++;
    }
  }
  phys.commit(); // make the walls visible to ray queries before the first projectile
  return { body, rects, colliderCount: count };
}
