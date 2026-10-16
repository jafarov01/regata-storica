/**
 * src/sim/items.ts: crates, inventory, powers and mines (SPEC section 6).
 *
 * Crates are light Rapier balls (docs/research/physics items.ts): a hull with
 * a free slot takes one on touch, a hull with full power slots shoves it away.
 * Contents are rolled at pickup with the weights in shared/config.ts among the
 * items enabled by TIERS. Inventory rules from docs/research/rules (items.ts):
 * same weapon tops up, another weapon replaces it, the last shot brings back
 * the Water Cannon, two power slots fill in order, death wipes everything.
 * Mines are plain state (no body): they drift to a stop, arm after
 * MINE.armDelaySec and sink the first enemy hull within MINE.radius.
 */
import RAPIER, { type RigidBody } from '@dimforge/rapier2d-compat';
import { BOOST, CRATES, MATCH, MINE, POWERS, SHIELD, SMOKE, TIERS, WAVE, WEAPONS, enabledPowers, enabledWeapons } from '@shared/config.ts';
import type { PowerId, WeaponId } from '@shared/config.ts';
import { dirFromYaw } from '@shared/map.ts';
import type { CrateCategory, CrateState, GameState } from '@shared/state.ts';
import { isLive, type SimCtx } from './ctx.ts';
import { hullObb, pointObbDistance, type Obb } from './geom.ts';
import { Masks, toSim } from './physics.ts';
import { isProtected, isTargetable, resolveHit, type MatchMemory } from './rules.ts';
import { TUNING } from './tuning.ts';

const C = TUNING.crate;
const box: Obb = { x: 0, z: 0, yaw: 0, hw: 0, hl: 0 };
const tmp = { x: 0, y: 0 };

/** Spread the weapon share evenly over the crate points (0.5 = every other point). */
export function crateCategory(index: number, share: number = CRATES.weaponShare): CrateCategory {
  return Math.floor((index + 1) * share) > Math.floor(index * share) ? 'weapon' : 'power';
}

function weighted<T extends { weight: number }>(items: readonly T[], rng: () => number): T | undefined {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let r = rng() * total;
  for (const i of items) {
    r -= i.weight;
    if (r < 0) return i;
  }
  return items[items.length - 1];
}

export function rollWeapon(rng: () => number): WeaponId {
  return weighted(enabledWeapons(), rng)?.id ?? 'cannon';
}

export function rollPower(rng: () => number): PowerId {
  return weighted(enabledPowers(), rng)?.id ?? 'shield';
}

export function freePowerSlot(powers: readonly (PowerId | null)[]): 0 | 1 | null {
  return powers[0] === null ? 0 : powers[1] === null ? 1 : null;
}

/** Final-minute frenzy (Stretch): crates respawn faster. */
export function isFrenzy(state: GameState): boolean {
  return TIERS.frenzy && state.phase === 'battle' && state.phaseEndsAt - state.time <= MATCH.frenzyLastSec;
}

// ---------------------------------------------------------------------------
// Crates
// ---------------------------------------------------------------------------

export class Crates {
  private readonly bodies: RigidBody[] = [];

  constructor(private readonly ctx: SimCtx) {
    ctx.state.crates.forEach((crate, i) => {
      toSim(crate.x, crate.z, tmp);
      const body = ctx.phys.createBody(
        RAPIER.RigidBodyDesc.dynamic().setTranslation(tmp.x, tmp.y).setLinearDamping(C.linearDamping).setAngularDamping(C.angularDamping).setCanSleep(true),
      );
      ctx.phys.createCollider(RAPIER.ColliderDesc.ball(C.radius).setMass(C.mass).setRestitution(0.5).setCollisionGroups(Masks.crate), body, { kind: 'crate', id: i });
      this.bodies.push(body);
    });
  }

  /** Every crate back home and active (match start). */
  reset(): void {
    const { state, map } = this.ctx;
    state.crates.forEach((crate, i) => {
      const home = map.crates[i];
      if (home) this.home(crate, i, home.x, home.z);
    });
  }

  private home(crate: CrateState, i: number, x: number, z: number): void {
    const body = this.bodies[i];
    crate.x = x;
    crate.z = z;
    crate.yaw = 0;
    crate.active = true;
    crate.respawnAt = 0;
    if (!body) return;
    body.setEnabled(true);
    body.setTranslation(toSim(x, z, tmp), true);
    body.setRotation(0, true);
    tmp.x = 0;
    tmp.y = 0;
    body.setLinvel(tmp, true);
    body.setAngvel(0, true);
  }

  /** After the physics step: mirror positions, respawn collected crates, hand out pickups. */
  update(): void {
    const { state, map } = this.ctx;
    const crates = state.crates;
    for (let i = 0; i < crates.length; i++) {
      const crate = crates[i] as CrateState;
      const body = this.bodies[i];
      if (crate.active) {
        if (body) {
          const p = body.translation();
          crate.x = p.x;
          crate.z = -p.y;
          crate.yaw = body.rotation();
        }
        continue;
      }
      if (state.time >= crate.respawnAt) {
        const home = map.crates[i];
        if (home) this.home(crate, i, home.x, home.z);
      }
    }
    if (!isLive(state)) return;
    for (const boat of state.boats) {
      if (!isTargetable(state, boat.team)) continue;
      hullObb(boat.pose, box);
      for (let i = 0; i < crates.length; i++) {
        const crate = crates[i] as CrateState;
        if (!crate.active) continue;
        const touching = pointObbDistance(crate.x, crate.z, box) <= C.radius + 0.25 || Math.hypot(crate.x - boat.pose.x, crate.z - boat.pose.z) <= CRATES.pickupRadius;
        if (touching && this.give(boat.team, crate)) this.collect(crate, i);
      }
    }
  }

  private collect(crate: CrateState, i: number): void {
    const { state } = this.ctx;
    crate.active = false;
    crate.respawnAt = state.time + CRATES.respawnSec / (isFrenzy(state) ? CRATES.frenzyRespawnMultiplier : 1);
    this.bodies[i]?.setEnabled(false);
  }

  /** Inventory rules. Returns false when the crate stays in the water (both power slots full). */
  give(team: number, crate: CrateState): boolean {
    const { state, rng } = this.ctx;
    const boat = state.boats[team];
    if (!boat) return false;
    if (crate.category === 'weapon') {
      const weapon = rollWeapon(rng);
      boat.weapon = weapon;
      boat.ammo = WEAPONS[weapon].ammo;
      this.ctx.emit({ kind: 'pickup', team, category: 'weapon', item: weapon, x: crate.x, z: crate.z });
      return true;
    }
    const slot = freePowerSlot(boat.powers);
    if (slot === null) return false;
    const power = rollPower(rng);
    boat.powers[slot] = power;
    this.ctx.emit({ kind: 'pickup', team, category: 'power', item: power, x: crate.x, z: crate.z });
    return true;
  }
}

// ---------------------------------------------------------------------------
// Powers
// ---------------------------------------------------------------------------

interface MineExtra {
  vx: number;
  vz: number;
  owner: string | null;
}

export class Powers {
  private readonly mineExtra = new Map<number, MineExtra>();
  private nextMineId = 1;
  private nextPuffId = 1;
  private readonly lastPuffAt = new Map<number, number>();

  constructor(
    private readonly ctx: SimCtx,
    private readonly mem: MatchMemory,
  ) {}

  reset(): void {
    this.ctx.state.mines = [];
    this.ctx.state.smoke = [];
    this.mineExtra.clear();
    this.lastPuffAt.clear();
  }

  /** Remove a team's mines and smoke (sudden death eliminations). */
  clearTeam(team: number): void {
    const { state } = this.ctx;
    for (const m of state.mines) if (m.team === team) this.mineExtra.delete(m.id);
    state.mines = state.mines.filter((m) => m.team !== team);
    state.smoke = state.smoke.filter((s) => s.team !== team);
  }

  /** Engineer (or Gunner in teams of 2) tapped a power slot. */
  use(team: number, slot: 0 | 1, playerId: string | null): void {
    const { state } = this.ctx;
    const boat = state.boats[team];
    if (!boat || !isTargetable(state, team) || !isLive(state)) return;
    const power = boat.powers[slot];
    if (!power || !POWERS[power]) return;
    boat.powers[slot] = null;
    const t = state.time;
    switch (power) {
      case 'shield':
        boat.shieldUntil = t + SHIELD.durationSec;
        break;
      case 'boost':
        boat.boostUntil = t + BOOST.durationSec;
        break;
      case 'mine':
        this.dropMine(team, playerId);
        break;
      case 'smoke':
        boat.smokeUntil = t + SMOKE.durationSec;
        break;
      case 'wave':
        this.wave(team);
        break;
    }
    this.ctx.emit({ kind: 'power', team, power, x: boat.pose.x, z: boat.pose.z });
  }

  private dropMine(team: number, playerId: string | null): void {
    const { state } = this.ctx;
    const boat = state.boats[team];
    if (!boat) return;
    const f = dirFromYaw(boat.pose.yaw);
    let x = boat.pose.x - f.x * MINE.dropBehind;
    let z = boat.pose.z - f.z * MINE.dropBehind;
    if (!this.ctx.map.isWaterAt(x, z)) {
      x = boat.pose.x;
      z = boat.pose.z;
    }
    const id = this.nextMineId++;
    state.mines.push({ id, team, x, z, armedAt: state.time + MINE.armDelaySec, expiresAt: state.time + MINE.lifetimeSec });
    this.mineExtra.set(id, { vx: boat.vx * TUNING.mine.dropSpeedMul, vz: boat.vz * TUNING.mine.dropSpeedMul, owner: playerId });
  }

  /** Stretch: shove every other boat within WAVE.radius away from this one. */
  private wave(team: number): void {
    const { state } = this.ctx;
    const me = state.boats[team];
    if (!me) return;
    for (const b of state.boats) {
      if (b.team === team || b.status !== 'alive') continue;
      const dx = b.pose.x - me.pose.x;
      const dz = b.pose.z - me.pose.z;
      const d = Math.hypot(dx, dz);
      if (d > WAVE.radius || d < 1e-6) continue;
      this.ctx.hulls[b.team]?.impulseAt(dx / d, dz / d, b.pose.x, b.pose.z, WAVE.impulse);
    }
  }

  /** Is this team hidden by its own smoke (no assist, no diamond, no lock)? */
  hidden(team: number): boolean {
    const { state } = this.ctx;
    const boat = state.boats[team];
    if (!boat) return false;
    if (state.time < boat.smokeUntil) return true;
    return false;
  }

  /** Mine drift, arming, triggers and expiry; smoke puffs. After the physics step. */
  update(dt: number): void {
    const { state, map } = this.ctx;
    const t = state.time;
    const drag = Math.exp(-TUNING.mine.drag * dt);
    // A copy because a trigger removes the mine; no copy on the usual step without mines.
    for (const mine of state.mines.length ? [...state.mines] : state.mines) {
      const extra = this.mineExtra.get(mine.id);
      if (extra) {
        const nx = mine.x + extra.vx * dt;
        const nz = mine.z + extra.vz * dt;
        if (map.isWaterAt(nx, nz)) {
          mine.x = nx;
          mine.z = nz;
        } else {
          extra.vx = 0;
          extra.vz = 0;
        }
        extra.vx *= drag;
        extra.vz *= drag;
      }
      if (t >= mine.expiresAt) {
        this.removeMine(mine.id);
        continue;
      }
      if (t < mine.armedAt) continue;
      for (const boat of state.boats) {
        if (boat.team === mine.team || !isTargetable(state, boat.team) || isProtected(state, boat.team)) continue;
        if (pointObbDistance(mine.x, mine.z, hullObb(boat.pose, box)) > MINE.radius) continue;
        this.removeMine(mine.id);
        this.ctx.emit({ kind: 'hit', team: mine.team, victim: boat.team, cause: 'mine', x: mine.x, z: mine.z });
        this.ctx.emit({ kind: 'splash', x: mine.x, z: mine.z, size: 3 });
        const dx = boat.pose.x - mine.x;
        const dz = boat.pose.z - mine.z;
        const len = Math.hypot(dx, dz) || 1;
        resolveHit(this.ctx, this.mem, boat.team, { team: mine.team, playerId: extra?.owner ?? null, cause: 'mine' }, mine.x, mine.z, dx / len, dz / len);
        break;
      }
    }

    // Smoke: a puff at the stern every puffEverySec while active.
    for (const boat of state.boats) {
      if (boat.status !== 'alive' || t >= boat.smokeUntil) continue;
      const last = this.lastPuffAt.get(boat.team) ?? -Infinity;
      if (t - last < SMOKE.puffEverySec) continue;
      this.lastPuffAt.set(boat.team, t);
      const f = dirFromYaw(boat.pose.yaw);
      state.smoke.push({ id: this.nextPuffId++, team: boat.team, x: boat.pose.x - f.x * 3, z: boat.pose.z - f.z * 3, until: t + SMOKE.puffLifetimeSec });
    }
    if (state.smoke.length) state.smoke = state.smoke.filter((p) => p.until > t);
  }

  private removeMine(id: number): void {
    this.ctx.state.mines = this.ctx.state.mines.filter((m) => m.id !== id);
    this.mineExtra.delete(id);
  }
}
