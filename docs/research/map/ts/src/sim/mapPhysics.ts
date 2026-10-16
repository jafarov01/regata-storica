// src/sim/mapPhysics.ts - builds the static Rapier colliders from the parsed map.
// Rapier's (x, y) plane is the world's (x, z) plane (see shared/map.ts).
import type * as RAPIER from '@dimforge/rapier2d-compat';
import { MAP, PILE_RADIUS, type VeniceMap } from '@shared/map';

export interface MapPhysicsOptions {
  /** bounce of a boat against a wall; SPEC: "bounce and scrape sparks, no damage" */
  wallRestitution: number;
  wallFriction: number;
}

const DEFAULTS: MapPhysicsOptions = { wallRestitution: 0.3, wallFriction: 0.2 };

/**
 * One fixed body carries every wall rectangle (cuboid colliders, half extents in
 * metres) and every pile cluster (ball colliders). Returns that body so the caller
 * can tag its colliders with a collision group for the water-cannon / mortar filters.
 */
export function buildMapColliders(
  R: typeof RAPIER,
  world: RAPIER.World,
  map: VeniceMap = MAP,
  opts: MapPhysicsOptions = DEFAULTS,
): RAPIER.RigidBody {
  const ground = world.createRigidBody(R.RigidBodyDesc.fixed());
  for (const w of map.walls) {
    world.createCollider(
      R.ColliderDesc.cuboid(w.w / 2, w.d / 2)
        .setTranslation(w.x, w.z)
        .setFriction(opts.wallFriction)
        .setRestitution(opts.wallRestitution),
      ground,
    );
  }
  for (const p of map.piles) {
    world.createCollider(R.ColliderDesc.ball(PILE_RADIUS).setTranslation(p.x, p.z).setRestitution(opts.wallRestitution), ground);
  }
  return ground;
}

/** Spawn transform for a boat at dock i: position + Rapier rotation angle. */
export function dockSpawn(map: VeniceMap, i: number): { x: number; z: number; heading: number } {
  const d = map.docks[i];
  if (d === undefined) throw new RangeError(`dock ${i} does not exist (${map.docks.length} docks)`);
  return { x: d.x, z: d.z, heading: d.heading };
}

/** Docks at least minDist metres (SPEC: 80) from every enemy boat; falls back to the farthest dock. */
export function respawnCandidates(
  map: VeniceMap,
  enemies: ReadonlyArray<{ x: number; z: number }>,
  minDist: number,
): number[] {
  const far: number[] = [];
  let bestI = 0;
  let bestD = -1;
  map.docks.forEach((d, i) => {
    let nearest = Infinity;
    for (const e of enemies) nearest = Math.min(nearest, Math.hypot(d.x - e.x, d.z - e.z));
    if (nearest >= minDist) far.push(i);
    if (nearest > bestD) {
      bestD = nearest;
      bestI = i;
    }
  });
  return far.length > 0 ? far : [bestI];
}
