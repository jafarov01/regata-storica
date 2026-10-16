// src/sim/projectiles.ts — custom projectiles (no Rapier bodies): cannonball, torpedo, mortar, water cannon.
import { DEG, PHYSICS } from '@shared/config';
import { forwardSim, headingToPoint, wrapAngle, type Vec2 } from './coords';
import { pointInCone, pointObbDistance, segmentVsObb, type Obb } from './geom';
import type { PhysicsWorld } from './physics';

/** What a projectile can hit. The sim refreshes one per boat each step (no allocation). */
export interface Target {
  id: number;
  team: number;
  box: Obb;
  /** alive (sinking/dead hulls are ignored; shields and spawn protection are the rules' job) */
  hittable: boolean;
}

export type ProjectileKind = 'cannon' | 'torpedo' | 'mortar';

export interface Hit {
  kind: ProjectileKind;
  targetId: number;
  shooterId: number;
  team: number;
  /** impact point and unit direction of travel (for sinkBoat and VFX) */
  px: number;
  py: number;
  dx: number;
  dy: number;
}

export type HitSink = (hit: Hit) => void;
/** A miss: kind, where it landed, and whether it was a wall ('wall') or water ('water'). */
export type SplashSink = (kind: ProjectileKind, x: number, y: number, surface: 'wall' | 'water') => void;

export interface Cannonball {
  active: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  team: number;
  shooterId: number;
  ttl: number;
}

export interface Torpedo {
  active: boolean;
  x: number;
  y: number;
  angle: number;
  team: number;
  shooterId: number;
  ttl: number;
  /** locked target id, -1 when running straight */
  targetId: number;
}

export interface MortarShell {
  active: boolean;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  t: number;
  team: number;
  shooterId: number;
}

const CN = PHYSICS.cannon;
const TP = PHYSICS.torpedo;
const MO = PHYSICS.mortar;
const WC = PHYSICS.waterCannon;

const tmpF: Vec2 = { x: 0, y: 0 };
const tmpCone: Vec2 = { x: 0, y: 0 };
const hitScratch: Hit = { kind: 'cannon', targetId: -1, shooterId: -1, team: -1, px: 0, py: 0, dx: 0, dy: 0 };

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Nearest enemy whose centre lies within `halfAngle` of the aim line and within `range`. */
function nearestInCone(
  x: number,
  y: number,
  aim: number,
  halfAngle: number,
  range: number,
  team: number,
  targets: readonly Target[],
  needLos: boolean,
  phys: PhysicsWorld,
): Target | null {
  let best: Target | null = null;
  let bestDist = Infinity;
  for (const t of targets) {
    if (!t.hittable || t.team === team) continue;
    if (!pointInCone(x, y, aim, halfAngle, range, t.box.x, t.box.y, tmpCone)) continue;
    if (tmpCone.x >= bestDist) continue;
    if (needLos && !phys.hasLineOfSight(x, y, t.box.x, t.box.y)) continue;
    best = t;
    bestDist = tmpCone.x;
  }
  return best;
}

/** Aim assist: bend the shot up to assistMaxDeg toward the nearest enemy within assistCaptureDeg. */
export function assistedAim(x: number, y: number, aim: number, team: number, targets: readonly Target[], phys: PhysicsWorld): number {
  const t = nearestInCone(x, y, aim, CN.assistCaptureDeg * DEG, CN.range, team, targets, true, phys);
  if (t === null) return aim;
  const off = wrapAngle(headingToPoint(x, y, t.box.x, t.box.y) - aim);
  return aim + clamp(off, -CN.assistMaxDeg * DEG, CN.assistMaxDeg * DEG);
}

export class Projectiles {
  readonly cannonballs: Cannonball[] = [];
  readonly torpedoes: Torpedo[] = [];
  readonly shells: MortarShell[] = [];

  fireCannon(x: number, y: number, aim: number, team: number, shooterId: number, targets: readonly Target[], phys: PhysicsWorld): void {
    const a = assistedAim(x, y, aim, team, targets, phys);
    const f = forwardSim(a, tmpF);
    const b = this.cannonballs.find((c) => !c.active) ?? this.alloc(this.cannonballs, { active: false, x: 0, y: 0, vx: 0, vy: 0, team: 0, shooterId: 0, ttl: 0 });
    b.active = true;
    b.x = x;
    b.y = y;
    b.vx = f.x * CN.speed;
    b.vy = f.y * CN.speed;
    b.team = team;
    b.shooterId = shooterId;
    b.ttl = CN.range / CN.speed;
  }

  /** Locks the nearest enemy in the 40 deg cone ahead with line of sight; otherwise runs straight. */
  fireTorpedo(x: number, y: number, aim: number, team: number, shooterId: number, targets: readonly Target[], phys: PhysicsWorld): number {
    const lock = nearestInCone(x, y, aim, (TP.lockConeDeg / 2) * DEG, TP.lockRange, team, targets, true, phys);
    const t = this.torpedoes.find((c) => !c.active) ?? this.alloc(this.torpedoes, { active: false, x: 0, y: 0, angle: 0, team: 0, shooterId: 0, ttl: 0, targetId: -1 });
    t.active = true;
    t.x = x;
    t.y = y;
    t.angle = aim;
    t.team = team;
    t.shooterId = shooterId;
    t.ttl = TP.range / TP.speed;
    t.targetId = lock === null ? -1 : lock.id;
    return t.targetId;
  }

  /** Smoke etc.: drop every lock on this target. */
  breakLocks(targetId: number): void {
    for (const t of this.torpedoes) if (t.active && t.targetId === targetId) t.targetId = -1;
  }

  /** Auto-ranged lob: lands on the nearest enemy within 10 deg and 60 m (walls ignored), else 40 m ahead. */
  fireMortar(x: number, y: number, aim: number, team: number, shooterId: number, targets: readonly Target[], phys: PhysicsWorld): void {
    const target = nearestInCone(x, y, aim, MO.targetConeDeg * DEG, MO.targetRange, team, targets, false, phys);
    const s = this.shells.find((c) => !c.active) ?? this.alloc(this.shells, { active: false, x0: 0, y0: 0, x1: 0, y1: 0, t: 0, team: 0, shooterId: 0 });
    s.active = true;
    s.x0 = x;
    s.y0 = y;
    if (target === null) {
      const f = forwardSim(aim, tmpF);
      s.x1 = x + f.x * MO.defaultRange;
      s.y1 = y + f.y * MO.defaultRange;
    } else {
      s.x1 = target.box.x;
      s.y1 = target.box.y;
    }
    s.t = 0;
    s.team = team;
    s.shooterId = shooterId;
  }

  /** One fixed step for every projectile. */
  step(dt: number, phys: PhysicsWorld, targets: readonly Target[], onHit: HitSink, onSplash: SplashSink): void {
    for (const b of this.cannonballs) {
      if (!b.active) continue;
      const nx = b.x + b.vx * dt;
      const ny = b.y + b.vy * dt;
      if (this.resolveSegment('cannon', b.x, b.y, nx, ny, CN.radius, b.team, b.shooterId, phys, targets, onHit, onSplash)) {
        b.active = false;
        continue;
      }
      b.x = nx;
      b.y = ny;
      b.ttl -= dt;
      if (b.ttl <= 0) {
        b.active = false;
        onSplash('cannon', b.x, b.y, 'water');
      }
    }

    for (const t of this.torpedoes) {
      if (!t.active) continue;
      if (t.targetId >= 0) {
        const target = findTarget(targets, t.targetId);
        if (target === null || !target.hittable || !this.canTrack(t, target, phys)) {
          t.targetId = -1; // lock lost: run straight from here on
        } else {
          const desired = headingToPoint(t.x, t.y, target.box.x, target.box.y);
          const maxTurn = TP.turnRateDeg * DEG * dt;
          t.angle = wrapAngle(t.angle + clamp(wrapAngle(desired - t.angle), -maxTurn, maxTurn));
        }
      }
      const f = forwardSim(t.angle, tmpF);
      const nx = t.x + f.x * TP.speed * dt;
      const ny = t.y + f.y * TP.speed * dt;
      if (this.resolveSegment('torpedo', t.x, t.y, nx, ny, TP.radius, t.team, t.shooterId, phys, targets, onHit, onSplash)) {
        t.active = false;
        continue;
      }
      t.x = nx;
      t.y = ny;
      t.ttl -= dt;
      if (t.ttl <= 0) {
        t.active = false;
        onSplash('torpedo', t.x, t.y, 'water');
      }
    }

    for (const s of this.shells) {
      if (!s.active) continue;
      s.t += dt;
      if (s.t < MO.flightTime) continue;
      s.active = false;
      let any = false;
      for (const target of targets) {
        if (!target.hittable || target.team === s.team) continue;
        if (pointObbDistance(s.x1, s.y1, target.box) > MO.splashRadius) continue;
        const dx = target.box.x - s.x1;
        const dy = target.box.y - s.y1;
        const len = Math.hypot(dx, dy) || 1;
        hitScratch.kind = 'mortar';
        hitScratch.targetId = target.id;
        hitScratch.shooterId = s.shooterId;
        hitScratch.team = s.team;
        hitScratch.px = s.x1;
        hitScratch.py = s.y1;
        hitScratch.dx = dx / len;
        hitScratch.dy = dy / len;
        onHit(hitScratch);
        any = true;
      }
      if (!any) onSplash('mortar', s.x1, s.y1, 'water');
    }
  }

  /** Render-only pose of a shell in flight: horizontal lerp plus a parabola with the given apex height. */
  static mortarPose(s: MortarShell, out: { x: number; y: number; height: number }): void {
    const u = clamp(s.t / MO.flightTime, 0, 1);
    out.x = s.x0 + (s.x1 - s.x0) * u;
    out.y = s.y0 + (s.y1 - s.y0) * u;
    out.height = 4 * MO.apexHeight * u * (1 - u);
  }

  private canTrack(t: Torpedo, target: Target, phys: PhysicsWorld): boolean {
    const dx = target.box.x - t.x;
    const dy = target.box.y - t.y;
    if (dx * dx + dy * dy > TP.lockRange * TP.lockRange * 1.5) return false;
    const off = Math.abs(wrapAngle(headingToPoint(t.x, t.y, target.box.x, target.box.y) - t.angle));
    if (off > Math.PI / 2) return false; // target got behind us
    return phys.hasLineOfSight(t.x, t.y, target.box.x, target.box.y);
  }

  /**
   * Moves a projectile along A->B: nearest enemy hull hit (segment vs OBB, inflated by the radius)
   * versus the nearest wall (Rapier ray). Returns true when the projectile is consumed.
   */
  private resolveSegment(
    kind: ProjectileKind,
    ax: number,
    ay: number,
    bx: number,
    by: number,
    radius: number,
    team: number,
    shooterId: number,
    phys: PhysicsWorld,
    targets: readonly Target[],
    onHit: HitSink,
    onSplash: SplashSink,
  ): boolean {
    let bestT = -1;
    let bestTarget: Target | null = null;
    for (const t of targets) {
      if (!t.hittable || t.team === team) continue;
      const tt = segmentVsObb(ax, ay, bx, by, t.box, radius);
      if (tt >= 0 && (bestTarget === null || tt < bestT)) {
        bestT = tt;
        bestTarget = t;
      }
    }
    const tWall = phys.wallHitFraction(ax, ay, bx, by);
    if (bestTarget !== null && (tWall < 0 || bestT <= tWall)) {
      const len = Math.hypot(bx - ax, by - ay) || 1;
      hitScratch.kind = kind;
      hitScratch.targetId = bestTarget.id;
      hitScratch.shooterId = shooterId;
      hitScratch.team = team;
      hitScratch.px = ax + (bx - ax) * bestT;
      hitScratch.py = ay + (by - ay) * bestT;
      hitScratch.dx = (bx - ax) / len;
      hitScratch.dy = (by - ay) / len;
      onHit(hitScratch);
      return true;
    }
    if (tWall >= 0) {
      onSplash(kind, ax + (bx - ax) * tWall, ay + (by - ay) * tWall, 'wall');
      return true;
    }
    return false;
  }

  private alloc<T>(pool: T[], item: T): T {
    pool.push(item);
    return item;
  }
}

function findTarget(targets: readonly Target[], id: number): Target | null {
  for (const t of targets) if (t.id === id) return t;
  return null;
}

/**
 * Water cannon, held: every enemy hull centre inside the cone with line of sight gets a push force
 * along the stream and hull water at `waterPerSecond`. Never the shooter's own team. The sim applies
 * the force with body.addForce and adds the water.
 */
export function applyWaterCannon(
  phys: PhysicsWorld,
  x: number,
  y: number,
  aim: number,
  team: number,
  targets: readonly Target[],
  dt: number,
  apply: (targetId: number, fx: number, fy: number, waterAdd: number) => void,
): void {
  const f = forwardSim(aim, tmpF);
  const fx = f.x * WC.pushForce;
  const fy = f.y * WC.pushForce;
  const half = WC.halfAngleDeg * DEG;
  for (const t of targets) {
    if (!t.hittable || t.team === team) continue;
    if (!pointInCone(x, y, aim, half, WC.range, t.box.x, t.box.y, tmpCone)) continue;
    if (!phys.hasLineOfSight(x, y, t.box.x, t.box.y)) continue;
    apply(t.id, fx, fy, WC.waterPerSecond * dt);
  }
}
