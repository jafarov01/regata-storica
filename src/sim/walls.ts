/**
 * src/sim/walls.ts: static scenery from shared/map.ts on one fixed body.
 *
 * Adapted from docs/research/physics (walls.ts). The map already merges solid
 * cells into rectangles (`map.walls`); this file turns them into cuboids, adds
 * four border slabs and one ball per pile cluster. Bridges are water.
 * Walls have zero friction so a hull scrapes along instead of sticking.
 */
import RAPIER from '@dimforge/rapier2d-compat';
import type { ParsedMap } from '@shared/map.ts';
import { Masks, toSim, type PhysicsWorld } from './physics.ts';

const WALL_RESTITUTION = 0.4;
const WALL_FRICTION = 0;

export function buildStaticWorld(phys: PhysicsWorld, map: ParsedMap): number {
  const body = phys.createBody(RAPIER.RigidBodyDesc.fixed());
  const ref = { kind: 'wall', id: -1 } as const;
  const c = { x: 0, y: 0 };
  let count = 0;
  const box = (x: number, z: number, hx: number, hz: number): void => {
    toSim(x, z, c);
    phys.createCollider(
      RAPIER.ColliderDesc.cuboid(hx, hz).setTranslation(c.x, c.y).setFriction(WALL_FRICTION).setRestitution(WALL_RESTITUTION).setCollisionGroups(Masks.wall),
      body,
      ref,
    );
    count++;
  };

  for (const w of map.walls) box(w.x, w.z, w.w / 2, w.d / 2);

  // Border slabs one cell thick around the grid, so nothing ever leaves the map.
  const hx = map.worldW / 2;
  const hz = map.worldD / 2;
  const t = map.cell / 2;
  box(-hx - t, 0, t, hz + map.cell);
  box(hx + t, 0, t, hz + map.cell);
  box(0, -hz - t, hx + map.cell, t);
  box(0, hz + t, hx + map.cell, t);

  for (const p of map.piles) {
    toSim(p.x, p.z, c);
    phys.createCollider(RAPIER.ColliderDesc.ball(p.radius).setTranslation(c.x, c.y).setRestitution(0.5).setCollisionGroups(Masks.wall), body, ref);
    count++;
  }

  phys.commit();
  return count;
}
