/**
 * src/sim/weapons.ts: firing, projectiles, the Water Cannon and the aim
 * helpers (SPEC sections 4 and 6).
 *
 * Adapted from docs/research/physics (projectiles.ts) and docs/research/rules
 * (aim.ts), in world (x, z) and world yaw:
 *   - Cannon: fast flat shot, segment-vs-hull test each step, Rapier ray for
 *     walls, bent up to AIM.assistMaxBendDeg toward the enemy nearest the aim line.
 *   - Torpedo: locks the nearest enemy in the cone ahead of the aim (line of
 *     sight needed), homes at TORPEDO.turnRate, runs straight once the lock is lost.
 *   - Mortar: auto-ranged lob onto the nearest enemy near the aim line (walls
 *     ignored), else MORTAR default range ahead; splash on landing.
 *   - Water Cannon: a stream, not projectiles. Every enemy hull in the cone
 *     with line of sight is pushed and takes water. Never lethal.
 * Projectiles are plain objects in state.projectiles; no Rapier bodies.
 */
import { AIM, CANNON, MORTAR, TORPEDO, WATER_CANNON, WEAPONS, type WeaponId } from '@shared/config.ts';
import { DEG, clamp, turnToward } from '@shared/math.ts';
import { dirFromYaw, yawFromDir } from '@shared/map.ts';
import type { KillCause, ProjectileKind, ProjectileState } from '@shared/state.ts';
import { isLive, type SimCtx } from './ctx.ts';
import { bearingOffset, hullObb, pointObbDistance, segmentVsObb, type Obb } from './geom.ts';
import { endProtection, isTargetable, resolveHit, type MatchMemory } from './rules.ts';
import { TUNING } from './tuning.ts';

const box: Obb = { x: 0, z: 0, yaw: 0, hw: 0, hl: 0 };

interface ProjectileExtra {
  playerId: string | null;
  /** Seconds left before a cannonball or torpedo splashes down. */
  ttl: number;
  /** Launch point (the Mortar lerps from it to its target). */
  x0: number;
  z0: number;
}

export interface AimFacts {
  /** Enemy team under the crosshair, or null. */
  underCrosshair: number | null;
  /** Enemy a Torpedo would lock right now, or null. */
  lock: number | null;
}

export class Weapons {
  private readonly lastShotAt = new Map<number, number>();
  private readonly pendingTaps = new Map<number, number>();
  private readonly streamUntil = new Map<number, number>();
  private readonly lastStreamCue = new Map<number, number>();
  private readonly lastStreamHit = new Map<string, number>();
  /** Sim time each boat last took water from a stream. */
  private readonly soakedAt = new Map<number, number>();
  private readonly extra = new Map<number, ProjectileExtra>();
  private nextId = 1;

  constructor(
    private readonly ctx: SimCtx,
    private readonly mem: MatchMemory,
    /** Smoke: hidden teams are ignored by assist, crosshair and locks. */
    private readonly hidden: (team: number) => boolean,
  ) {}

  reset(): void {
    this.ctx.state.projectiles = [];
    this.extra.clear();
    this.lastShotAt.clear();
    this.pendingTaps.clear();
    this.streamUntil.clear();
    this.soakedAt.clear();
  }

  /** A fire tap from the Gunner (counted by `fc`, never lost). */
  tap(team: number): void {
    this.pendingTaps.set(team, Math.min(2, (this.pendingTaps.get(team) ?? 0) + 1));
  }

  clearTeam(team: number): void {
    const { state } = this.ctx;
    for (const p of state.projectiles) if (p.team === team) this.extra.delete(p.id);
    state.projectiles = state.projectiles.filter((p) => p.team !== team);
    this.pendingTaps.delete(team);
  }

  // ---------------------------------------------------------------- aim helpers

  private enemies(team: number): number[] {
    const { state } = this.ctx;
    const out: number[] = [];
    for (const b of state.boats) if (b.team !== team && isTargetable(state, b.team) && !this.hidden(b.team)) out.push(b.team);
    return out;
  }

  private los(team: number, other: number): boolean {
    const a = this.ctx.state.boats[team];
    const b = this.ctx.state.boats[other];
    return !!a && !!b && this.ctx.phys.hasLineOfSight(a.pose.x, a.pose.z, b.pose.x, b.pose.z);
  }

  /** Nearest (by distance) enemy inside a cone around `yaw`; optional line of sight. */
  private nearestInCone(team: number, yaw: number, halfAngle: number, range: number, needLos: boolean): number | null {
    const me = this.ctx.state.boats[team];
    if (!me) return null;
    let best: number | null = null;
    let bestD = Infinity;
    for (const e of this.enemies(team)) {
      const b = this.ctx.state.boats[e];
      if (!b) continue;
      const d = Math.hypot(b.pose.x - me.pose.x, b.pose.z - me.pose.z);
      if (d > range || d >= bestD) continue;
      if (Math.abs(bearingOffset(me.pose.x, me.pose.z, yaw, b.pose.x, b.pose.z)) > halfAngle) continue;
      if (needLos && !this.los(team, e)) continue;
      best = e;
      bestD = d;
    }
    return best;
  }

  /** Cannon aim assist: smallest angular offset inside the assist cone wins; bend by at most assistMaxBendDeg. */
  assistedYaw(team: number, yaw: number): number {
    const me = this.ctx.state.boats[team];
    if (!me) return yaw;
    let bestOff: number | null = null;
    for (const e of this.enemies(team)) {
      const b = this.ctx.state.boats[e];
      if (!b) continue;
      const d = Math.hypot(b.pose.x - me.pose.x, b.pose.z - me.pose.z);
      if (d > AIM.assistRange) continue;
      const off = bearingOffset(me.pose.x, me.pose.z, yaw, b.pose.x, b.pose.z);
      if (Math.abs(off) > AIM.assistConeDeg * DEG) continue;
      if (bestOff !== null && Math.abs(off) >= Math.abs(bestOff)) continue;
      if (!this.los(team, e)) continue;
      bestOff = off;
    }
    if (bestOff === null) return yaw;
    const bend = AIM.assistMaxBendDeg * DEG;
    return yaw + clamp(bestOff, -bend, bend);
  }

  /** Enemy on the aim line: the cone widens for close boats so a hull filling the view still counts. */
  aimFacts(team: number): AimFacts {
    const me = this.ctx.state.boats[team];
    if (!me) return { underCrosshair: null, lock: null };
    let under: number | null = null;
    let underD = Infinity;
    for (const e of this.enemies(team)) {
      const b = this.ctx.state.boats[e];
      if (!b) continue;
      const d = Math.hypot(b.pose.x - me.pose.x, b.pose.z - me.pose.z);
      if (d > AIM.underCrosshairRange || d >= underD) continue;
      const half = Math.max(AIM.underCrosshairDeg * DEG, Math.atan2(TUNING.aim.hullRadius, Math.max(d, 1e-3)));
      if (Math.abs(bearingOffset(me.pose.x, me.pose.z, me.aimYaw, b.pose.x, b.pose.z)) > half) continue;
      if (!this.los(team, e)) continue;
      under = e;
      underD = d;
    }
    const lock = me.weapon === 'torpedo' ? this.nearestInCone(team, me.aimYaw, (AIM.torpedoLockConeDeg / 2) * DEG, AIM.torpedoLockRange, true) : null;
    return { underCrosshair: under, lock };
  }

  /** Crosshair state and targets for the HUD, once per step. */
  updateAim(team: number): void {
    const { state } = this.ctx;
    const boat = state.boats[team];
    if (!boat) return;
    if (boat.status !== 'alive' || !isLive(state)) {
      boat.crosshair = 'neutral';
      boat.aimTarget = null;
      boat.lockTarget = null;
      return;
    }
    const facts = this.aimFacts(team);
    boat.aimTarget = facts.underCrosshair;
    boat.lockTarget = facts.lock;
    if (state.time - boat.lastHitAt < TUNING.aim.hitFlashSec && boat.lastHitAt > 0) boat.crosshair = 'hit';
    else if (facts.lock !== null) boat.crosshair = 'lock';
    else if (facts.underCrosshair !== null) boat.crosshair = 'enemy';
    else boat.crosshair = 'neutral';
  }

  // ---------------------------------------------------------------- firing

  /**
   * Before the physics step: the Water Cannon stream (forces must be added
   * before world.step) and the shots of every other weapon.
   */
  fire(team: number, held: boolean, gunnerId: string | null, dt: number, autoAll = false): void {
    const { state } = this.ctx;
    const boat = state.boats[team];
    if (!boat) return;
    const t = state.time;
    if (boat.status !== 'alive' || !isLive(state)) {
      boat.firing = false;
      this.pendingTaps.delete(team);
      return;
    }
    const def = WEAPONS[boat.weapon];
    const taps = this.pendingTaps.get(team) ?? 0;

    if (boat.weapon === 'watercannon') {
      if (taps > 0) {
        this.streamUntil.set(team, t + TUNING.waterCannon.tapStreamSec);
        this.pendingTaps.delete(team);
      }
      const streaming = held || t < (this.streamUntil.get(team) ?? 0);
      boat.firing = streaming;
      if (streaming) this.stream(team, dt);
      return;
    }

    boat.firing = held;
    const wants = taps > 0 || (held && (def.autoFire || autoAll));
    if (!wants || t - (this.lastShotAt.get(team) ?? -Infinity) < def.fireInterval) return;
    if (taps > 0) this.pendingTaps.set(team, taps - 1);
    this.lastShotAt.set(team, t);
    this.shoot(team, boat.weapon, gunnerId);
  }

  private shoot(team: number, weapon: WeaponId, gunnerId: string | null): void {
    const { state } = this.ctx;
    const boat = state.boats[team];
    if (!boat) return;
    const t = state.time;
    boat.ammo -= 1;
    if (boat.ammo <= 0) {
      boat.weapon = 'watercannon';
      boat.ammo = WEAPONS.watercannon.ammo;
    }
    boat.lastFireAt = t;
    endProtection(this.ctx, team);
    const { x, z } = boat.pose;
    let yaw = boat.aimYaw;
    let kind: ProjectileKind = 'cannon';
    let speed: number = CANNON.speed;
    let ttl: number = CANNON.range / CANNON.speed;
    let targetX = 0;
    let targetZ = 0;
    let lock: number | null = null;
    if (weapon === 'cannon') {
      yaw = this.assistedYaw(team, yaw);
    } else if (weapon === 'torpedo') {
      kind = 'torpedo';
      speed = TORPEDO.speed;
      ttl = TORPEDO.lifetimeSec;
      lock = this.nearestInCone(team, yaw, (AIM.torpedoLockConeDeg / 2) * DEG, AIM.torpedoLockRange, true);
    } else if (weapon === 'mortar') {
      kind = 'mortar';
      speed = 0;
      ttl = MORTAR.flightSec;
      const target = this.nearestInCone(team, yaw, AIM.mortarConeDeg * DEG, AIM.mortarRange, false);
      const tb = target !== null ? state.boats[target] : undefined;
      if (tb) {
        targetX = tb.pose.x;
        targetZ = tb.pose.z;
      } else {
        const f = dirFromYaw(yaw);
        targetX = x + f.x * AIM.mortarDefaultRange;
        targetZ = z + f.z * AIM.mortarDefaultRange;
      }
      yaw = yawFromDir(targetX - x, targetZ - z);
    }
    const f = dirFromYaw(yaw);
    const id = this.nextId++;
    state.projectiles.push({
      id,
      kind,
      team,
      x,
      z,
      prevX: x,
      prevZ: z,
      vx: f.x * speed,
      vz: f.z * speed,
      yaw,
      y: kind === 'cannon' ? TUNING.cannon.muzzleHeight : 0,
      targetX,
      targetZ,
      progress: 0,
      lockTarget: lock,
      spawnedAt: t,
    });
    this.extra.set(id, { playerId: gunnerId, ttl, x0: x, z0: z });
    this.ctx.emit({ kind: 'fired', team, weapon, x, z, yaw });
  }

  /** Water Cannon: push and fill every enemy hull in the cone with line of sight. */
  private stream(team: number, dt: number): void {
    const { state } = this.ctx;
    const me = state.boats[team];
    if (!me) return;
    const t = state.time;
    const f = dirFromYaw(me.aimYaw);
    if (t - (this.lastStreamCue.get(team) ?? -Infinity) >= TUNING.waterCannon.cueIntervalSec) {
      this.lastStreamCue.set(team, t);
      this.ctx.emit({ kind: 'fired', team, weapon: 'watercannon', x: me.pose.x, z: me.pose.z, yaw: me.aimYaw });
    }
    for (const b of state.boats) {
      if (b.team === team || !isTargetable(state, b.team)) continue;
      const d = Math.hypot(b.pose.x - me.pose.x, b.pose.z - me.pose.z);
      if (d > WATER_CANNON.range) continue;
      if (Math.abs(bearingOffset(me.pose.x, me.pose.z, me.aimYaw, b.pose.x, b.pose.z)) > WATER_CANNON.halfAngleDeg * DEG) continue;
      if (!this.ctx.phys.hasLineOfSight(me.pose.x, me.pose.z, b.pose.x, b.pose.z)) continue;
      this.ctx.hulls[b.team]?.push(f.x * WATER_CANNON.pushForce, f.z * WATER_CANNON.pushForce);
      b.water = Math.min(100, b.water + WATER_CANNON.fillPerSec * dt);
      this.soakedAt.set(b.team, t);
      const key = `${team}>${b.team}`;
      if (t - (this.lastStreamHit.get(key) ?? -Infinity) >= TUNING.waterCannon.cueIntervalSec) {
        this.lastStreamHit.set(key, t);
        me.lastHitAt = t;
        this.ctx.emit({ kind: 'hit', team, victim: b.team, cause: 'watercannon', x: b.pose.x, z: b.pose.z });
      }
    }
  }

  /** Under a stream right now (this step or the last few). */
  soaking(team: number): boolean {
    return this.ctx.state.time - (this.soakedAt.get(team) ?? -Infinity) < 0.25;
  }

  // ---------------------------------------------------------------- projectiles

  /** After the physics step, against the fresh hull poses. */
  step(dt: number): void {
    const { state } = this.ctx;
    if (!isLive(state)) {
      if (state.projectiles.length) this.reset();
      return;
    }
    const keep: ProjectileState[] = [];
    for (const p of state.projectiles) {
      p.prevX = p.x;
      p.prevZ = p.z;
      const alive = p.kind === 'mortar' ? this.stepMortar(p) : this.stepRunner(p, dt);
      if (alive) keep.push(p);
      else this.extra.delete(p.id);
    }
    state.projectiles = keep;
  }

  private stepRunner(p: ProjectileState, dt: number): boolean {
    const extra = this.extra.get(p.id);
    if (!extra) return false;
    if (p.kind === 'torpedo') this.steerTorpedo(p, dt);
    const nx = p.x + p.vx * dt;
    const nz = p.z + p.vz * dt;
    const radius = p.kind === 'torpedo' ? TUNING.torpedo.radius : TUNING.cannon.radius;
    if (this.resolveSegment(p, nx, nz, radius, extra.playerId)) return false;
    p.x = nx;
    p.z = nz;
    extra.ttl -= dt;
    const total = p.kind === 'torpedo' ? TORPEDO.lifetimeSec : CANNON.range / CANNON.speed;
    p.progress = clamp(1 - extra.ttl / total, 0, 1);
    if (p.kind === 'cannon') {
      const u = p.progress;
      p.y = TUNING.cannon.muzzleHeight * (1 - u) + 4 * CANNON.arcHeight * u * (1 - u);
    }
    if (extra.ttl <= 0) {
      this.ctx.emit({ kind: 'splash', x: p.x, z: p.z, size: p.kind === 'torpedo' ? 2 : 1 });
      return false;
    }
    return true;
  }

  private steerTorpedo(p: ProjectileState, dt: number): void {
    const { state } = this.ctx;
    if (p.lockTarget !== null) {
      const target = state.boats[p.lockTarget];
      let keep = !!target && isTargetable(state, p.lockTarget) && !this.hidden(p.lockTarget);
      if (keep && target) {
        const d = Math.hypot(target.pose.x - p.x, target.pose.z - p.z);
        const off = Math.abs(bearingOffset(p.x, p.z, p.yaw, target.pose.x, target.pose.z));
        keep = d <= AIM.torpedoLockRange * 1.5 && off <= Math.PI / 2 && this.ctx.phys.hasLineOfSight(p.x, p.z, target.pose.x, target.pose.z);
        if (keep) p.yaw = turnToward(p.yaw, yawFromDir(target.pose.x - p.x, target.pose.z - p.z), TORPEDO.turnRate * dt);
      }
      if (!keep) p.lockTarget = null;
    }
    const f = dirFromYaw(p.yaw);
    p.vx = f.x * TORPEDO.speed;
    p.vz = f.z * TORPEDO.speed;
  }

  /** Nearest enemy hull vs the nearest wall along A->B. Returns true when the projectile is spent. */
  private resolveSegment(p: ProjectileState, bx: number, bz: number, radius: number, playerId: string | null): boolean {
    const { state } = this.ctx;
    let bestT = -1;
    let best: number | null = null;
    for (const b of state.boats) {
      if (b.team === p.team || !isTargetable(state, b.team)) continue;
      const tt = segmentVsObb(p.x, p.z, bx, bz, hullObb(b.pose, box), radius);
      if (tt >= 0 && (best === null || tt < bestT)) {
        bestT = tt;
        best = b.team;
      }
    }
    const tWall = this.ctx.phys.wallHitFraction(p.x, p.z, bx, bz);
    if (best !== null && (tWall < 0 || bestT <= tWall)) {
      const len = Math.hypot(bx - p.x, bz - p.z) || 1;
      const hx = p.x + (bx - p.x) * bestT;
      const hz = p.z + (bz - p.z) * bestT;
      this.land(p.team, best, p.kind, playerId, hx, hz, (bx - p.x) / len, (bz - p.z) / len);
      return true;
    }
    if (tWall >= 0) {
      this.ctx.emit({ kind: 'splash', x: p.x + (bx - p.x) * tWall, z: p.z + (bz - p.z) * tWall, size: 1 });
      return true;
    }
    return false;
  }

  private stepMortar(p: ProjectileState): boolean {
    const { state } = this.ctx;
    const extra = this.extra.get(p.id);
    if (!extra) return false;
    const u = clamp((state.time - p.spawnedAt) / MORTAR.flightSec, 0, 1);
    p.progress = u;
    p.y = 4 * MORTAR.arcHeight * u * (1 - u);
    if (u < 1) {
      p.x = extra.x0 + (p.targetX - extra.x0) * u;
      p.z = extra.z0 + (p.targetZ - extra.z0) * u;
      return true;
    }
    p.x = p.targetX;
    p.z = p.targetZ;
    let any = false;
    for (const b of state.boats) {
      if (b.team === p.team || !isTargetable(state, b.team)) continue;
      if (pointObbDistance(p.x, p.z, hullObb(b.pose, box)) > MORTAR.splashRadius) continue;
      const dx = b.pose.x - p.x;
      const dz = b.pose.z - p.z;
      const len = Math.hypot(dx, dz) || 1;
      this.land(p.team, b.team, 'mortar', extra.playerId, p.x, p.z, dx / len, dz / len);
      any = true;
    }
    this.ctx.emit({ kind: 'splash', x: p.x, z: p.z, size: any ? 3 : MORTAR.splashRadius / 2 });
    return false;
  }

  /** A lethal projectile reached an enemy hull. */
  private land(team: number, victim: number, cause: KillCause, playerId: string | null, x: number, z: number, dx: number, dz: number): void {
    const shooter = this.ctx.state.boats[team];
    if (shooter) shooter.lastHitAt = this.ctx.state.time;
    this.ctx.emit({ kind: 'hit', team, victim, cause, x, z });
    resolveHit(this.ctx, this.mem, victim, { team, playerId, cause }, x, z, dx, dz);
  }
}
