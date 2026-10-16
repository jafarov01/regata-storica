// src/sim/items.ts — crates (light solid bodies, collected on first touch) and mines (drifting sensor + solid core).
import RAPIER, { type Collider, type RigidBody } from '@dimforge/rapier2d-compat';
import { PHYSICS } from '@shared/config';
import { forwardSim, type Vec2 } from './coords';
import { Masks, type PhysicsWorld } from './physics';
import { copyTransform, makeTransform, type Transform2 } from './loop';

export type CrateCategory = 'weapon' | 'power';

export interface Crate {
  readonly id: number;
  readonly category: CrateCategory;
  readonly body: RigidBody;
  readonly collider: Collider;
  /** Fixed spawn point (sim coords). */
  readonly homeX: number;
  readonly homeY: number;
  active: boolean;
  respawnT: number;
  readonly prev: Transform2;
  readonly curr: Transform2;
}

const C = PHYSICS.crate;
const M = PHYSICS.mine;
const tmpV: Vec2 = { x: 0, y: 0 };
const tmpF: Vec2 = { x: 0, y: 0 };

export function createCrate(phys: PhysicsWorld, id: number, category: CrateCategory, x: number, y: number): Crate {
  const body = phys.createBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, y)
      .setLinearDamping(C.linearDamping)
      .setAngularDamping(C.angularDamping)
      .setCanSleep(true),
  );
  const collider = phys.createCollider(
    RAPIER.ColliderDesc.ball(C.radius)
      .setMass(C.mass)
      .setRestitution(0.5)
      .setCollisionGroups(Masks.crate)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
    body,
    { kind: 'crate', id },
  );
  return {
    id,
    category,
    body,
    collider,
    homeX: x,
    homeY: y,
    active: true,
    respawnT: 0,
    prev: makeTransform(x, y, 0),
    curr: makeTransform(x, y, 0),
  };
}

/** Rules decided the boat takes it: hide the body, respawn in 8 s at the home point. */
export function collectCrate(crate: Crate): void {
  if (!crate.active) return;
  crate.active = false;
  crate.respawnT = C.respawn;
  crate.body.setEnabled(false);
}

export function updateCrates(crates: Iterable<Crate>, dt: number): void {
  for (const crate of crates) {
    if (crate.active) {
      copyTransform(crate.curr, crate.prev);
      const p = crate.body.translation(tmpV);
      crate.curr.x = p.x;
      crate.curr.y = p.y;
      crate.curr.angle = crate.body.rotation();
      continue;
    }
    crate.respawnT -= dt;
    if (crate.respawnT <= 0) {
      tmpV.x = crate.homeX;
      tmpV.y = crate.homeY;
      crate.body.setTranslation(tmpV, true);
      tmpV.x = 0;
      tmpV.y = 0;
      crate.body.setLinvel(tmpV, true);
      crate.body.setAngvel(0, true);
      crate.body.setEnabled(true);
      crate.active = true;
      crate.curr.x = crate.homeX;
      crate.curr.y = crate.homeY;
      crate.curr.angle = 0;
      copyTransform(crate.curr, crate.prev);
    }
  }
}

export interface Mine {
  readonly id: number;
  readonly ownerTeam: number;
  readonly body: RigidBody;
  readonly solid: Collider;
  readonly trigger: Collider;
  /** Seconds until armed (<= 0 when armed). */
  armT: number;
  /** Seconds until it disappears. */
  lifeT: number;
  /** Set once exploded or expired; the body is already scheduled for removal. */
  gone: boolean;
  readonly prev: Transform2;
  readonly curr: Transform2;
}

/** Drop behind the boat with half its velocity. Two colliders: a solid core (walls/crates) and a boat-only sensor. */
export function dropMine(
  phys: PhysicsWorld,
  id: number,
  ownerTeam: number,
  boatX: number,
  boatY: number,
  boatAngle: number,
  boatVx: number,
  boatVy: number,
): Mine {
  const f = forwardSim(boatAngle, tmpF);
  const x = boatX - f.x * M.dropBehind;
  const y = boatY - f.y * M.dropBehind;
  const body = phys.createBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, y)
      .setLinvel(boatVx * M.dropSpeedMul, boatVy * M.dropSpeedMul)
      .setLinearDamping(M.linearDamping)
      .setAngularDamping(M.angularDamping)
      .setCanSleep(true),
  );
  const solid = phys.createCollider(
    RAPIER.ColliderDesc.ball(M.solidRadius).setMass(M.mass).setCollisionGroups(Masks.mineBody),
    body,
    { kind: 'mineBody', id },
  );
  // density 0: a sensor would otherwise add mass to the body
  const trigger = phys.createCollider(
    RAPIER.ColliderDesc.ball(M.triggerRadius)
      .setSensor(true)
      .setDensity(0)
      .setCollisionGroups(Masks.mineTrigger)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
    body,
    { kind: 'mineTrigger', id },
  );
  return {
    id,
    ownerTeam,
    body,
    solid,
    trigger,
    armT: M.armDelay,
    lifeT: M.lifetime,
    gone: false,
    prev: makeTransform(x, y, 0),
    curr: makeTransform(x, y, 0),
  };
}

export function isMineArmed(mine: Mine): boolean {
  return !mine.gone && mine.armT <= 0;
}

/** From the collision handler: an alive, unprotected hull entered the trigger. */
export function mineShouldExplode(mine: Mine, boatTeam: number): boolean {
  return isMineArmed(mine) && boatTeam !== mine.ownerTeam;
}

export function removeMine(phys: PhysicsWorld, mine: Mine): void {
  if (mine.gone) return;
  mine.gone = true;
  phys.removeBody(mine.body);
}

/**
 * Timers, snapshots, and the arming poll: a hull already sitting inside the sensor when the
 * mine arms produces no new "started" event, so we ask the intersection graph once at that moment.
 * `teamOf` maps a boat id to its team; returns -1 for boats that cannot be hit.
 */
export function updateMines(
  phys: PhysicsWorld,
  mines: Iterable<Mine>,
  dt: number,
  teamOf: (boatId: number) => number,
  onExplode: (mine: Mine, boatId: number) => void,
): void {
  for (const mine of mines) {
    if (mine.gone) continue;
    copyTransform(mine.curr, mine.prev);
    const p = mine.body.translation(tmpV);
    mine.curr.x = p.x;
    mine.curr.y = p.y;
    mine.curr.angle = mine.body.rotation();

    mine.lifeT -= dt;
    if (mine.lifeT <= 0) {
      removeMine(phys, mine);
      continue;
    }
    if (mine.armT > 0) {
      mine.armT -= dt;
      if (mine.armT <= 0) {
        let victim = -1;
        phys.world.intersectionPairsWith(mine.trigger, (other) => {
          if (victim >= 0) return;
          const ref = phys.lookup(other.handle);
          if (ref === undefined || ref.kind !== 'boat') return;
          const team = teamOf(ref.id);
          if (team >= 0 && team !== mine.ownerTeam) victim = ref.id;
        });
        if (victim >= 0) onExplode(mine, victim);
      }
    }
  }
}
