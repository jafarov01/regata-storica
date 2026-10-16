/**
 * src/sim/boat.ts: the gondola rigid body. Thrust, brake, reverse, keel grip,
 * drift, speed-dependent steering, ram detection, sink impulse, teleport.
 *
 * Lifted from docs/research/physics (boat.ts) and moved onto the repo's BOAT
 * block (400 kg, thrust = mass * linearDamping * topSpeed, steering torque =
 * base + perSpeed * speed). Rapier damping gives top speed = thrust / (m * d),
 * so Boost and hull water scale the thrust and the top speed follows.
 */
import RAPIER, { type Collider, type RigidBody } from '@dimforge/rapier2d-compat';
import { BOAT } from '@shared/config.ts';
import { clamp } from '@shared/math.ts';
import type { BoatState, Pose } from '@shared/state.ts';
import { HULL_HALF_LENGTH, HULL_HALF_WIDTH } from './geom.ts';
import { Masks, toSim, type ContactInfo, type PhysicsWorld, type V2 } from './physics.ts';
import { TUNING } from './tuning.ts';

const T = TUNING.boat;

export interface HullInput {
  /** -1 full left .. 1 full right. */
  steer: number;
  gas: boolean;
  brake: boolean;
}

export type HullMode = 'alive' | 'protected' | 'off';

const tmpV: V2 = { x: 0, y: 0 };
const tmpW: V2 = { x: 0, y: 0 };
const tmpP: V2 = { x: 0, y: 0 };
const contact: ContactInfo = { nx: 0, ny: 0, px: 0, py: 0 };

export class Hull {
  readonly body: RigidBody;
  readonly collider: Collider;
  /** Velocity carried into the last world.step (Rapier plane), for ram detection. */
  readonly prevVel: V2 = { x: 0, y: 0 };
  mode: HullMode = 'alive';

  constructor(
    phys: PhysicsWorld,
    readonly team: number,
    pose: Pose,
  ) {
    toSim(pose.x, pose.z, tmpP);
    this.body = phys.createBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(tmpP.x, tmpP.y)
        .setRotation(pose.yaw)
        .setLinearDamping(BOAT.linearDamping)
        .setAngularDamping(BOAT.angularDamping)
        .setCanSleep(false),
    );
    // roundCuboid(hx, hy, r) has effective half extents (hx + r, hy + r).
    this.collider = phys.createCollider(
      RAPIER.ColliderDesc.roundCuboid(HULL_HALF_WIDTH - T.cornerRadius, HULL_HALF_LENGTH - T.cornerRadius, T.cornerRadius)
        .setMass(BOAT.mass)
        .setFriction(BOAT.friction)
        .setRestitution(BOAT.restitution)
        .setCollisionGroups(Masks.boat)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
      this.body,
      { kind: 'boat', id: team },
    );
  }

  /** Alive hulls collide with everything, protected ones too (mines ignore them), off hulls with nothing. */
  setMode(mode: HullMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.collider.setCollisionGroups(mode === 'alive' ? Masks.boat : mode === 'protected' ? Masks.boatProtected : Masks.boatSinking);
  }

  setEnabled(on: boolean): void {
    if (this.body.isEnabled() !== on) this.body.setEnabled(on);
  }

  /** Teleport and stop. */
  place(pose: Pose): void {
    toSim(pose.x, pose.z, tmpP);
    this.body.setTranslation(tmpP, true);
    this.body.setRotation(pose.yaw, true);
    tmpV.x = 0;
    tmpV.y = 0;
    this.body.setLinvel(tmpV, true);
    this.body.setAngvel(0, true);
    this.body.resetForces(true);
    this.body.resetTorques(true);
    this.prevVel.x = 0;
    this.prevVel.y = 0;
  }

  /**
   * Per-step control, before world.step. Forces are rebuilt every step (Rapier
   * keeps added forces until resetForces), so a silent phone leaves no ghost thrust.
   * Returns true while drifting.
   */
  drive(input: HullInput, boosted: boolean, water: number, dt: number): boolean {
    const body = this.body;
    body.resetForces(false);
    body.resetTorques(false);
    const a = body.rotation();
    const fx = -Math.sin(a);
    const fy = Math.cos(a);
    const rx = Math.cos(a);
    const ry = Math.sin(a);
    const v = body.linvel();
    const vf = v.x * fx + v.y * fy;
    const vr = v.x * rx + v.y * ry;

    const hullMul = 1 - (BOAT.waterSlowFactor * clamp(water, 0, 100)) / 100;
    const thrustMax = BOAT.thrust * hullMul * (boosted ? BOAT.boostSpeed / BOAT.topSpeed : 1);
    // A NaN from the network would poison the body for the rest of the match.
    const steer = Number.isFinite(input.steer) ? clamp(input.steer, -1, 1) : 0;
    const drifting = input.brake && Math.abs(steer) >= T.driftMinSteer && vf >= BOAT.driftMinSpeed;

    let fwd = 0;
    if (drifting) fwd = -T.driftDrag * BOAT.mass * vf;
    else if (input.gas && !input.brake) fwd = thrustMax;
    else if (input.brake) fwd = vf > 0.5 ? -T.brakeForce : input.gas ? 0 : -BOAT.reverseFactor * thrustMax;
    if (fwd !== 0) {
      tmpW.x = fx * fwd;
      tmpW.y = fy * fwd;
      body.addForce(tmpW, true);
    }

    // Keel: exponential decay of the lateral velocity, exact and frame-rate independent.
    const vr2 = vr * Math.exp(-(drifting ? BOAT.driftGrip : BOAT.keelGrip) * dt);
    if (vr2 !== vr) {
      tmpW.x = fx * vf + rx * vr2;
      tmpW.y = fy * vf + ry * vr2;
      body.setLinvel(tmpW, true);
    }

    // Steering: steer > 0 is right, positive angle turns left, so the torque is -steer.
    if (steer !== 0) {
      const torque = BOAT.steerTorqueBase * T.steerTorqueBaseMul + BOAT.steerTorquePerSpeed * Math.min(Math.abs(vf), BOAT.topSpeed);
      body.addTorque(-steer * torque * (drifting ? T.driftTurnMul : 1), true);
    }
    const w = body.angvel();
    if (Math.abs(w) > BOAT.maxTurnRate) body.setAngvel(Math.sign(w) * BOAT.maxTurnRate, true);
    return drifting;
  }

  /** World force (N) along (fx, fz), e.g. the Water Cannon push. */
  push(fx: number, fz: number): void {
    tmpW.x = fx;
    tmpW.y = -fz;
    this.body.addForce(tmpW, true);
  }

  /** World impulse (N s) along (dx, dz) at world point (px, pz). */
  impulseAt(dx: number, dz: number, px: number, pz: number, magnitude: number): void {
    tmpW.x = dx * magnitude;
    tmpW.y = -dz * magnitude;
    toSim(px, pz, tmpP);
    this.body.applyImpulseAtPoint(tmpW, tmpP, true);
  }

  cacheVelocity(): void {
    this.body.linvel(this.prevVel);
  }

  /** Mirror the body into the contract state. */
  read(boat: BoatState): void {
    const p = this.body.translation();
    const a = this.body.rotation();
    const v = this.body.linvel();
    boat.pose.x = p.x;
    boat.pose.z = -p.y;
    boat.pose.yaw = a;
    boat.vx = v.x;
    boat.vz = -v.y;
    boat.speed = v.x * -Math.sin(a) + v.y * Math.cos(a);
    boat.angVel = this.body.angvel();
  }

  /** Lethal hit: stop colliding and spin from an impulse at the impact point. */
  sink(px: number, pz: number, dx: number, dz: number): void {
    this.setMode('off');
    this.body.resetForces(false);
    this.body.resetTorques(false);
    this.impulseAt(dx, dz, px, pz, T.sinkImpulse);
  }
}

export interface RamResult {
  rammer: number;
  target: number;
  /** Closing speed along the contact normal, m/s. */
  speed: number;
  x: number;
  z: number;
  /** Unit direction rammer -> target, world. */
  dx: number;
  dz: number;
}

/**
 * Boat-boat contact that just started. Uses the velocities cached before the
 * step (the solver has already resolved the impact) and the manifold normal.
 * A ram needs a boosted rammer, a bow facing the target, enough closing speed,
 * and a target that is not boosted itself (two boosted boats just bounce).
 */
export function detectRam(
  phys: PhysicsWorld,
  a: Hull,
  b: Hull,
  ca: Collider,
  cb: Collider,
  boostedA: boolean,
  boostedB: boolean,
  out: RamResult,
): boolean {
  if (boostedA === boostedB) return false;
  if (!phys.contactInfo(ca, cb, contact)) {
    const pa = a.body.translation();
    const pb = b.body.translation();
    const dx = pb.x - pa.x;
    const dy = pb.y - pa.y;
    const len = Math.hypot(dx, dy) || 1;
    contact.nx = dx / len;
    contact.ny = dy / len;
    contact.px = (pa.x + pb.x) / 2;
    contact.py = (pa.y + pb.y) / 2;
  }
  const nx = contact.nx;
  const ny = contact.ny;
  const closing = (a.prevVel.x - b.prevVel.x) * nx + (a.prevVel.y - b.prevVel.y) * ny;
  if (closing < BOAT.ramMinClosingSpeed) return false;
  const angA = a.body.rotation();
  const angB = b.body.rotation();
  const aBow = -Math.sin(angA) * nx + Math.cos(angA) * ny;
  const bBow = -(-Math.sin(angB) * nx + Math.cos(angB) * ny);
  const aRams = boostedA && aBow >= T.ramBowCos;
  const bRams = boostedB && bBow >= T.ramBowCos;
  if (!aRams && !bRams) return false;
  out.rammer = aRams ? a.team : b.team;
  out.target = aRams ? b.team : a.team;
  out.speed = closing;
  out.x = contact.px;
  out.z = -contact.py;
  out.dx = aRams ? nx : -nx;
  out.dz = aRams ? -ny : ny;
  return true;
}
