// src/sim/physics.ts — Rapier 2D world, collision groups, handle -> entity map, events, ray queries.
import RAPIER, {
  type Collider,
  type ColliderDesc,
  type EventQueue,
  type RigidBody,
  type RigidBodyDesc,
  type World,
} from '@dimforge/rapier2d-compat';
import { PHYSICS } from '@shared/config';

/** Call once (SCENE only) before any sim object is created. Decodes the inlined wasm. */
export async function initPhysics(): Promise<void> {
  await RAPIER.init();
}

export function physicsVersion(): string {
  return RAPIER.version();
}

// ---------------------------------------------------------------------------
// Collision groups. Rapier packs two 16-bit masks in one number:
//   (memberships << 16) | filter
// A pair interacts iff (A.memberships & B.filter) != 0 && (B.memberships & A.filter) != 0.
// The same two-way test is applied to the `filterGroups` argument of scene queries,
// so query masks use memberships 0xffff to pass the collider-side check.
// ---------------------------------------------------------------------------
export const Group = {
  BOAT: 1 << 0, // alive, unprotected hull
  WALL: 1 << 1, // buildings, border, moored gondolas, pile clusters
  POLE: 1 << 2, // mooring poles (thin: projectiles ignore them)
  CRATE: 1 << 3,
  MINE_BODY: 1 << 4, // small solid part of a mine (walls and crates only)
  MINE_TRIG: 1 << 5, // mine sensor (boats only)
  SINKING: 1 << 6, // sinking boat: collides with nothing
  PROTECTED: 1 << 7, // spawn-protected hull: like BOAT, but mines ignore it
} as const;

export function groupMask(memberships: number, filter: number): number {
  return ((memberships & 0xffff) << 16) | (filter & 0xffff);
}

const SOLIDS = Group.BOAT | Group.PROTECTED | Group.CRATE | Group.MINE_BODY;

export const Masks = {
  boat: groupMask(Group.BOAT, Group.WALL | Group.POLE | Group.BOAT | Group.PROTECTED | Group.CRATE | Group.MINE_TRIG),
  boatProtected: groupMask(Group.PROTECTED, Group.WALL | Group.POLE | Group.BOAT | Group.PROTECTED | Group.CRATE),
  boatSinking: groupMask(Group.SINKING, 0),
  wall: groupMask(Group.WALL, SOLIDS),
  pole: groupMask(Group.POLE, SOLIDS),
  crate: groupMask(Group.CRATE, Group.WALL | Group.POLE | SOLIDS),
  mineBody: groupMask(Group.MINE_BODY, Group.WALL | Group.POLE | Group.CRATE | Group.MINE_BODY),
  mineTrigger: groupMask(Group.MINE_TRIG, Group.BOAT),
  /** Scene-query masks (membership 0xffff so every collider's filter accepts the query). */
  queryWalls: groupMask(0xffff, Group.WALL),
  queryBoats: groupMask(0xffff, Group.BOAT | Group.PROTECTED),
  queryCrates: groupMask(0xffff, Group.CRATE),
} as const;

// ---------------------------------------------------------------------------
// Entities. Collider handles are opaque f64 numbers (index + generation bits), fine as
// Map keys but NOT array indices. The JS-side lookup (world.getCollider / colliders.get)
// ignores the generation, so a stale handle can alias a newer collider in the same slot:
// unregister on removal, never keep handles of removed objects.
// ---------------------------------------------------------------------------
export type EntityKind = 'boat' | 'wall' | 'pole' | 'crate' | 'mineBody' | 'mineTrigger';

export interface EntityRef {
  kind: EntityKind;
  /** Index into the owning array (boats[], crates[], mines[]); -1 for static scenery. */
  id: number;
}

export type CollisionHandler = (a: EntityRef, b: EntityRef, ca: Collider, cb: Collider, started: boolean) => void;

export interface ContactInfo {
  /** World normal from collider 1 to collider 2. */
  nx: number;
  ny: number;
  /** World impact point. */
  px: number;
  py: number;
}

export class PhysicsWorld {
  readonly world: World;
  readonly events: EventQueue;
  private readonly byCollider = new Map<number, EntityRef>();
  private readonly pendingRemoval: RigidBody[] = [];
  private draining = false;
  // reusable scratch objects (no per-step allocation)
  private readonly ray = new RAPIER.Ray({ x: 0, y: 0 }, { x: 0, y: 0 });
  private readonly tmpN = { x: 0, y: 0 };
  private readonly tmpP = { x: 0, y: 0 };

  constructor(dt: number = PHYSICS.dt) {
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

  lookup(handle: number): EntityRef | undefined {
    return this.byCollider.get(handle);
  }

  /** Forget the colliders now, remove the body after the current drain (safe inside event handlers). */
  removeBody(body: RigidBody): void {
    const n = body.numColliders();
    for (let i = 0; i < n; i++) this.byCollider.delete(body.collider(i).handle);
    if (this.draining) this.pendingRemoval.push(body);
    else this.world.removeRigidBody(body);
  }

  /** One fixed step: integrate, then drain collision events (sensors included) into the handler. */
  step(onCollision?: CollisionHandler): void {
    this.world.step(this.events);
    if (onCollision) {
      this.draining = true;
      this.events.drainCollisionEvents((h1, h2, started) => {
        const a = this.byCollider.get(h1);
        const b = this.byCollider.get(h2);
        if (a === undefined || b === undefined) return; // one side already removed this step
        const ca = this.world.colliders.get(h1);
        const cb = this.world.colliders.get(h2);
        if (ca === null || cb === null) return;
        onCollision(a, b, ca, cb, started);
      });
      this.draining = false;
    }
    for (const body of this.pendingRemoval) this.world.removeRigidBody(body);
    this.pendingRemoval.length = 0;
  }

  /**
   * Scene queries (castRay, intersectionsWithShape, ...) only see a collider after the next
   * world.step() inserts it into the broad phase; propagateModifiedBodyPositionsToColliders()
   * does not. Call this once after building the static world, before any boat exists, so the
   * first projectile of the round cannot fly through a wall.
   */
  commit(): void {
    this.world.step();
  }

  /** Contact normal (c1 -> c2) and first solver contact point of a touching pair. */
  contactInfo(c1: Collider, c2: Collider, out: ContactInfo): boolean {
    let found = false;
    this.world.contactPair(c1, c2, (manifold, flipped) => {
      if (found) return;
      const n = manifold.normal(this.tmpN);
      const sign = flipped ? -1 : 1;
      const p = manifold.solverContactPoint(0, this.tmpP);
      if (p === null) return;
      out.nx = n.x * sign;
      out.ny = n.y * sign;
      out.px = p.x;
      out.py = p.y;
      found = true;
    });
    return found;
  }

  /**
   * Fraction t in [0,1] along segment A->B where a wall blocks it, or -1 if clear.
   * solid=true: a segment starting inside a wall is blocked at t=0.
   */
  wallHitFraction(ax: number, ay: number, bx: number, by: number): number {
    this.ray.origin.x = ax;
    this.ray.origin.y = ay;
    this.ray.dir.x = bx - ax;
    this.ray.dir.y = by - ay;
    const hit = this.world.castRay(this.ray, 1, true, undefined, Masks.queryWalls);
    return hit === null ? -1 : hit.timeOfImpact;
  }

  /** Line of sight between two points, walls only. */
  hasLineOfSight(ax: number, ay: number, bx: number, by: number): boolean {
    return this.wallHitFraction(ax, ay, bx, by) < 0;
  }

  free(): void {
    this.events.free();
    this.world.free();
    this.byCollider.clear();
  }
}
