/**
 * src/sim/physics.ts: the Rapier 2D world, collision groups, the collider ->
 * entity registry, collision events and wall ray queries.
 *
 * Lifted from docs/research/physics (physics.ts, coords.ts). The Rapier plane
 * is the research one: sim.x = world.x, sim.y = -world.z, body angle = world
 * yaw (the mirror keeps handedness, so no sign flips). Everything outside this
 * file and boat.ts speaks world (x, z) and goes through toSim / fromSim.
 */
import RAPIER, { type Collider, type ColliderDesc, type EventQueue, type RigidBody, type RigidBodyDesc, type World } from '@dimforge/rapier2d-compat';
import { SIM } from '@shared/config.ts';

let ready: Promise<void> | null = null;

/** Decodes the inlined wasm once. Every sim is created after this resolves. */
export function initPhysics(): Promise<void> {
  ready ??= RAPIER.init();
  return ready;
}

// ---------------------------------------------------------------------------
// Coordinates
// ---------------------------------------------------------------------------

export interface V2 {
  x: number;
  y: number;
}

/** World (x, z) -> Rapier plane. */
export function toSim(x: number, z: number, out: V2): V2 {
  out.x = x;
  out.y = -z;
  return out;
}

// ---------------------------------------------------------------------------
// Collision groups: (memberships << 16) | filter. A pair interacts iff each
// side's memberships intersect the other side's filter.
// ---------------------------------------------------------------------------

export const Group = {
  BOAT: 1 << 0,
  WALL: 1 << 1,
  CRATE: 1 << 3,
  SINKING: 1 << 6,
  PROTECTED: 1 << 7,
} as const;

export function groupMask(memberships: number, filter: number): number {
  return ((memberships & 0xffff) << 16) | (filter & 0xffff);
}

export const Masks = {
  boat: groupMask(Group.BOAT, Group.WALL | Group.BOAT | Group.PROTECTED | Group.CRATE),
  boatProtected: groupMask(Group.PROTECTED, Group.WALL | Group.BOAT | Group.PROTECTED | Group.CRATE),
  /** Sinking or off-water hull: collides with nothing and is invisible to queries. */
  boatSinking: groupMask(Group.SINKING, 0),
  wall: groupMask(Group.WALL, Group.BOAT | Group.PROTECTED | Group.CRATE),
  crate: groupMask(Group.CRATE, Group.WALL | Group.BOAT | Group.PROTECTED | Group.CRATE),
  /** Scene-query mask: membership 0xffff so every collider's filter accepts the query. */
  queryWalls: groupMask(0xffff, Group.WALL),
} as const;

export type EntityKind = 'boat' | 'wall' | 'crate';

export interface EntityRef {
  kind: EntityKind;
  /** Team for boats, crate index for crates, -1 for scenery. */
  id: number;
}

export type CollisionHandler = (a: EntityRef, b: EntityRef, ca: Collider, cb: Collider) => void;

export interface ContactInfo {
  /** Normal from collider 1 to collider 2, Rapier plane. */
  nx: number;
  ny: number;
  /** Impact point, Rapier plane. */
  px: number;
  py: number;
}

export class PhysicsWorld {
  readonly world: World;
  private readonly events: EventQueue;
  private readonly byCollider = new Map<number, EntityRef>();
  private readonly ray = new RAPIER.Ray({ x: 0, y: 0 }, { x: 0, y: 0 });
  private readonly tmpN = { x: 0, y: 0 };
  private readonly tmpP = { x: 0, y: 0 };

  constructor(dt: number = SIM.dt) {
    this.world = new RAPIER.World({ x: 0, y: 0 });
    this.world.timestep = dt;
    this.events = new RAPIER.EventQueue(true);
  }

  createBody(desc: RigidBodyDesc): RigidBody {
    return this.world.createRigidBody(desc);
  }

  createCollider(desc: ColliderDesc, body: RigidBody, ref: EntityRef): Collider {
    const collider = this.world.createCollider(desc, body);
    this.byCollider.set(collider.handle, ref);
    return collider;
  }

  removeBody(body: RigidBody): void {
    const n = body.numColliders();
    for (let i = 0; i < n; i++) this.byCollider.delete(body.collider(i).handle);
    this.world.removeRigidBody(body);
  }

  /** One fixed step, then every collision that *started* this step goes to the handler. */
  step(onCollision: CollisionHandler): void {
    this.world.step(this.events);
    this.events.drainCollisionEvents((h1, h2, started) => {
      if (!started) return;
      const a = this.byCollider.get(h1);
      const b = this.byCollider.get(h2);
      if (a === undefined || b === undefined) return;
      const ca = this.world.colliders.get(h1);
      const cb = this.world.colliders.get(h2);
      if (ca === null || cb === null) return;
      onCollision(a, b, ca, cb);
    });
  }

  /** Ray queries only see colliders after one step inserts them in the broad phase. */
  commit(): void {
    this.world.step();
  }

  /** Contact normal (c1 -> c2) and first solver contact point of a touching pair. */
  contactInfo(c1: Collider, c2: Collider, out: ContactInfo): boolean {
    let found = false;
    this.world.contactPair(c1, c2, (manifold, flipped) => {
      if (found) return;
      const n = manifold.normal(this.tmpN);
      const p = manifold.solverContactPoint(0, this.tmpP);
      if (p === null) return;
      const sign = flipped ? -1 : 1;
      out.nx = n.x * sign;
      out.ny = n.y * sign;
      out.px = p.x;
      out.py = p.y;
      found = true;
    });
    return found;
  }

  /**
   * Fraction t in [0, 1] along the world segment A->B where a wall blocks it,
   * or -1 when clear. A segment that starts inside a wall is blocked at 0.
   */
  wallHitFraction(ax: number, az: number, bx: number, bz: number): number {
    this.ray.origin.x = ax;
    this.ray.origin.y = -az;
    this.ray.dir.x = bx - ax;
    this.ray.dir.y = -(bz - az);
    const hit = this.world.castRay(this.ray, 1, true, undefined, Masks.queryWalls);
    return hit === null ? -1 : hit.timeOfImpact;
  }

  hasLineOfSight(ax: number, az: number, bx: number, bz: number): boolean {
    return this.wallHitFraction(ax, az, bx, bz) < 0;
  }

  free(): void {
    this.events.free();
    this.world.free();
    this.byCollider.clear();
  }
}
