// src/sim/boat.ts — the gondola rigid body: thrust, brake, keel, drift, steering, ram, sink, respawn.
import RAPIER, { type Collider, type RigidBody } from '@dimforge/rapier2d-compat';
import { PHYSICS } from '@shared/config';
import { forwardSim, rightSim, type Vec2 } from './coords';
import type { Obb } from './geom';
import { Masks, type ContactInfo, type PhysicsWorld } from './physics';
import { copyTransform, makeTransform, type Transform2 } from './loop';

/** Mirrors PilotIn from shared/protocol.ts. */
export interface BoatInput {
  /** -1 (full left) .. 1 (full right) */
  steer: number;
  gas: boolean;
  brake: boolean;
}

export type BoatPhase = 'alive' | 'sinking' | 'dead';

export interface Boat {
  readonly id: number;
  readonly team: number;
  readonly body: RigidBody;
  readonly collider: Collider;
  phase: BoatPhase;
  /** Seconds spent in the current phase. */
  phaseT: number;
  boosted: boolean;
  /** Remaining spawn protection, seconds (0 = none). */
  protectedT: number;
  /** Hull water 0..100. */
  water: number;
  drifting: boolean;
  /** Forward speed (m/s, negative when reversing) read at the last control update. */
  speed: number;
  /** Linear velocity captured right before the last world.step (ram detection). */
  readonly prevVel: Vec2;
  /** Interpolation snapshots for the renderer. */
  readonly prev: Transform2;
  readonly curr: Transform2;
}

export interface RamResult {
  rammer: Boat;
  target: Boat;
  px: number;
  py: number;
  /** Unit normal from rammer to target. */
  nx: number;
  ny: number;
}

const B = PHYSICS.boat;
export const BOAT_HALF_WIDTH = B.width / 2;
export const BOAT_HALF_LENGTH = B.length / 2;
const CORNER = 0.15;

/** Thrust whose terminal velocity under Rapier damping is `topSpeed`: v_inf = F / (m * d). */
export function thrustFor(topSpeed: number): number {
  return B.mass * B.linearDamping * topSpeed;
}

// scratch (module-level, never allocated per step)
const tmpF: Vec2 = { x: 0, y: 0 };
const tmpR: Vec2 = { x: 0, y: 0 };
const tmpV: Vec2 = { x: 0, y: 0 };
const tmpW: Vec2 = { x: 0, y: 0 };
const tmpContact: ContactInfo = { nx: 0, ny: 0, px: 0, py: 0 };

export function createBoat(phys: PhysicsWorld, id: number, team: number, x: number, y: number, angle: number): Boat {
  const body = phys.createBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, y)
      .setRotation(angle)
      .setLinearDamping(B.linearDamping)
      .setAngularDamping(B.angularDamping)
      .setCanSleep(false),
  );
  // roundCuboid(hx, hy, r) has effective half extents (hx + r, hy + r): 0.7 x 3.0.
  // Rounded corners slide over seams between merged wall rectangles instead of catching.
  const collider = phys.createCollider(
    RAPIER.ColliderDesc.roundCuboid(BOAT_HALF_WIDTH - CORNER, BOAT_HALF_LENGTH - CORNER, CORNER)
      .setMass(B.mass)
      .setFriction(B.friction)
      .setRestitution(B.restitution)
      .setCollisionGroups(Masks.boat)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
    body,
    { kind: 'boat', id },
  );
  return {
    id,
    team,
    body,
    collider,
    phase: 'alive',
    phaseT: 0,
    boosted: false,
    protectedT: 0,
    water: 0,
    drifting: false,
    speed: 0,
    prevVel: { x: 0, y: 0 },
    prev: makeTransform(x, y, angle),
    curr: makeTransform(x, y, angle),
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Per-step control. Call before world.step. Forces are rebuilt every step
 * (Rapier keeps added forces until resetForces).
 */
export function applyBoatControls(boat: Boat, input: BoatInput, dt: number): void {
  if (boat.phase !== 'alive') return;
  const body = boat.body;
  body.resetForces(false);
  body.resetTorques(false);

  const a = body.rotation();
  const f = forwardSim(a, tmpF);
  const r = rightSim(a, tmpR);
  const v = body.linvel(tmpV);
  const vf = v.x * f.x + v.y * f.y; // forward speed
  const vr = v.x * r.x + v.y * r.y; // lateral (starboard) speed
  boat.speed = vf;

  const hullMul = 1 - B.hullWaterSlowdown * clamp(boat.water, 0, 100) / 100;
  const thrustMax = thrustFor(B.topSpeed) * hullMul * (boat.boosted ? B.boostMul : 1);
  // Network input: a NaN steer would poison the body state for good, so sanitise here.
  const steer = Number.isFinite(input.steer) ? clamp(input.steer, -1, 1) : 0;

  // Drift: BRAKE while steering at speed. No thrust, little grip, extra drag, sharper torque.
  const drifting = input.brake && Math.abs(steer) >= B.driftMinSteer && vf >= B.driftMinSpeed;
  boat.drifting = drifting;

  let fwdForce = 0;
  if (drifting) {
    fwdForce = -B.driftDrag * B.mass * vf;
  } else if (input.gas && !input.brake) {
    fwdForce = thrustMax;
  } else if (input.brake) {
    // brake while moving forward, else reverse at 40 %
    fwdForce = vf > 0.5 ? -B.brakeForce : input.gas ? 0 : -B.reverseMul * thrustMax;
  }
  if (fwdForce !== 0) {
    tmpW.x = f.x * fwdForce;
    tmpW.y = f.y * fwdForce;
    body.addForce(tmpW, true);
  }

  // Keel: exponential decay of the lateral component, exact and frame-rate independent.
  const grip = drifting ? B.driftGrip : B.keelGrip;
  const vr2 = vr * Math.exp(-grip * dt);
  if (vr2 !== vr) {
    tmpW.x = f.x * vf + r.x * vr2;
    tmpW.y = f.y * vf + r.y * vr2;
    body.setLinvel(tmpW, true);
  }

  // Steering: torque sized for a steady-state turn rate, omega_ss = torque / (I * angularDamping).
  if (steer !== 0) {
    const speedFactor = clamp(Math.abs(vf) / B.topSpeed, 0, 1);
    const rate = B.turnRateRest + (B.turnRateFull - B.turnRateRest) * speedFactor;
    const torque = -steer * rate * body.principalInertia() * B.angularDamping * (drifting ? B.driftTurnMul : 1);
    body.addTorque(torque, true);
  }
  const w = body.angvel();
  if (Math.abs(w) > B.maxAngvel) body.setAngvel(Math.sign(w) * B.maxAngvel, true);
}

/** Call right before world.step: the velocity the boat carries into the step. */
export function cacheVelocity(boat: Boat): void {
  boat.body.linvel(boat.prevVel);
}

/** Call before each step: curr becomes prev. */
export function snapshotBoat(boat: Boat): void {
  copyTransform(boat.curr, boat.prev);
}

/** Call after each step: read the body into curr. */
export function readBoatTransform(boat: Boat): void {
  const p = boat.body.translation(tmpV);
  boat.curr.x = p.x;
  boat.curr.y = p.y;
  boat.curr.angle = boat.body.rotation();
}

/** The boat as an oriented box for projectile tests. */
export function boatObb(boat: Boat, out: Obb): Obb {
  out.x = boat.curr.x;
  out.y = boat.curr.y;
  out.angle = boat.curr.angle;
  out.hw = BOAT_HALF_WIDTH;
  out.hl = BOAT_HALF_LENGTH;
  return out;
}

/**
 * Lethal hit: the hull stops colliding, keeps drifting for `sinkTime`, and gets an impulse at the
 * impact point so it spins in 2D. The 3D flip (pitch/roll/submerge) is render-only from phase + phaseT.
 */
export function sinkBoat(boat: Boat, px: number, py: number, dx: number, dy: number): void {
  if (boat.phase !== 'alive') return;
  boat.phase = 'sinking';
  boat.phaseT = 0;
  boat.boosted = false;
  boat.drifting = false;
  boat.protectedT = 0;
  boat.collider.setCollisionGroups(Masks.boatSinking);
  boat.body.resetForces(false);
  boat.body.resetTorques(false);
  tmpW.x = dx * B.sinkImpulse;
  tmpW.y = dy * B.sinkImpulse;
  tmpV.x = px;
  tmpV.y = py;
  boat.body.applyImpulseAtPoint(tmpW, tmpV, true);
}

/** Phase timers. Sinking -> dead (body disabled) after sinkTime; protection counts down. */
export function updateBoatPhase(boat: Boat, dt: number): void {
  boat.phaseT += dt;
  if (boat.phase === 'sinking' && boat.phaseT >= B.sinkTime) {
    boat.phase = 'dead';
    boat.phaseT = 0;
    boat.body.setLinvel(zero(), false);
    boat.body.setAngvel(0, false);
    boat.body.setEnabled(false);
  } else if (boat.phase === 'alive' && boat.protectedT > 0) {
    boat.protectedT -= dt;
    if (boat.protectedT <= 0) setProtected(boat, false);
  }
}

const ZERO: Vec2 = { x: 0, y: 0 };
function zero(): Vec2 {
  ZERO.x = 0;
  ZERO.y = 0;
  return ZERO;
}

/** Teleport to a dock, wipe state, start spawn protection. Snapshots are reset so nothing interpolates across the jump. */
export function respawnBoat(boat: Boat, x: number, y: number, angle: number): void {
  const body = boat.body;
  body.setEnabled(true);
  tmpV.x = x;
  tmpV.y = y;
  body.setTranslation(tmpV, true);
  body.setRotation(angle, true);
  body.setLinvel(zero(), true);
  body.setAngvel(0, true);
  body.resetForces(true);
  body.resetTorques(true);
  boat.phase = 'alive';
  boat.phaseT = 0;
  boat.water = 0;
  boat.boosted = false;
  boat.drifting = false;
  boat.speed = 0;
  boat.prevVel.x = 0;
  boat.prevVel.y = 0;
  boat.curr.x = x;
  boat.curr.y = y;
  boat.curr.angle = angle;
  copyTransform(boat.curr, boat.prev);
  setProtected(boat, true);
}

/** Spawn protection on/off (also called early when the Gunner fires). Mines ignore protected hulls. */
export function setProtected(boat: Boat, on: boolean): void {
  boat.protectedT = on ? B.spawnProtection : 0;
  boat.collider.setCollisionGroups(on ? Masks.boatProtected : Masks.boat);
}

/**
 * Called on a boat-boat collision *started* event. Uses the velocities cached before the step
 * (post-step velocities are already resolved by the solver) and the manifold normal.
 */
export function detectRam(phys: PhysicsWorld, a: Boat, b: Boat, ca: Collider, cb: Collider, out: RamResult): boolean {
  if (a.team === b.team) return false;
  if (a.phase !== 'alive' || b.phase !== 'alive') return false;
  if (!phys.contactInfo(ca, cb, tmpContact)) {
    // no manifold yet: fall back to centre-to-centre
    const dx = b.curr.x - a.curr.x;
    const dy = b.curr.y - a.curr.y;
    const len = Math.hypot(dx, dy) || 1;
    tmpContact.nx = dx / len;
    tmpContact.ny = dy / len;
    tmpContact.px = (a.curr.x + b.curr.x) / 2;
    tmpContact.py = (a.curr.y + b.curr.y) / 2;
  }
  const nx = tmpContact.nx;
  const ny = tmpContact.ny;
  // closing speed of a toward b along the normal (same number seen from b)
  const closing = (a.prevVel.x - b.prevVel.x) * nx + (a.prevVel.y - b.prevVel.y) * ny;
  if (closing < B.ramMinSpeed) return false;
  const fa = forwardSim(a.curr.angle, tmpF);
  const aBow = fa.x * nx + fa.y * ny;
  const fb = forwardSim(b.curr.angle, tmpR);
  const bBow = -(fb.x * nx + fb.y * ny);
  const aRams = a.boosted && aBow >= B.ramBowCos;
  const bRams = b.boosted && bBow >= B.ramBowCos;
  if (aRams === bRams) return false; // neither, or both boosted: they just bounce
  out.rammer = aRams ? a : b;
  out.target = aRams ? b : a;
  out.px = tmpContact.px;
  out.py = tmpContact.py;
  out.nx = aRams ? nx : -nx;
  out.ny = aRams ? ny : -ny;
  return true;
}
