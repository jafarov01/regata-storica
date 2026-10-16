/**
 * Trivial bot: drives toward crates or enemies, fires when lined up, uses
 * powers now and then, bails. It only reads GameState and emits the same
 * packets a phone would, so it tests the whole input path.
 */
import { CONFIG } from '@shared/config.ts';
import type { GameConfig } from '@shared/config.ts';
import { angleDiff, clamp, DEG } from '@shared/math.ts';
import type { EngIn, GunnerIn, PilotIn } from '@shared/protocol.ts';
import type { BoatState, GameState } from '@shared/state.ts';

export interface BotMemory {
  waypoint: { x: number; y: number } | null;
  stuckSince: number;
  reverseUntil: number;
  nextPowerAt: number;
}

export interface BotFrame {
  pilot: PilotIn;
  gunner: GunnerIn;
  engineer: EngIn;
  mem: BotMemory;
}

export function createBot(): BotMemory {
  return { waypoint: null, stuckSince: -1, reverseUntil: 0, nextPowerAt: 0 };
}

function idleFrame(mem: BotMemory): BotFrame {
  return {
    pilot: { t: 'in', role: 'pilot', steer: 0, gas: false, brake: false },
    gunner: { t: 'in', role: 'gunner', dYaw: 0, fire: false, recenter: false },
    engineer: { t: 'in', role: 'engineer', use: null, shake: 0 },
    mem,
  };
}

function nearestEnemy(state: GameState, me: BoatState): BoatState | null {
  let best: BoatState | null = null;
  let bestD = Infinity;
  for (const b of state.boats) {
    if (b.team === me.team || b.status !== 'alive') continue;
    const d = Math.hypot(b.pose.x - me.pose.x, b.pose.y - me.pose.y);
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best;
}

function nearestCrate(state: GameState, me: BoatState, category: 'weapon' | 'power' | null): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestD = Infinity;
  for (const c of state.crates) {
    if (c.contents === null || (category && c.category !== category)) continue;
    const d = Math.hypot(c.x - me.pose.x, c.y - me.pose.y);
    if (d < bestD) {
      bestD = d;
      best = { x: c.x, y: c.y };
    }
  }
  return best;
}

export function botThink(
  state: GameState,
  team: number,
  memIn: BotMemory,
  dt: number,
  rng: () => number,
  cfg: GameConfig = CONFIG,
): BotFrame {
  const me = state.boats[team];
  const mem: BotMemory = { ...memIn };
  if (!me || me.status !== 'alive' || (state.phase !== 'battle' && state.phase !== 'overtime')) {
    return idleFrame({ ...mem, waypoint: null, stuckSince: -1 });
  }
  const now = state.simTime;
  const b = cfg.bots;
  const enemy = nearestEnemy(state, me);
  const enemyDist = enemy ? Math.hypot(enemy.pose.x - me.pose.x, enemy.pose.y - me.pose.y) : Infinity;

  // --- waypoint: a weapon crate when unarmed, otherwise the enemy, otherwise any crate
  const reached = mem.waypoint && Math.hypot(mem.waypoint.x - me.pose.x, mem.waypoint.y - me.pose.y) < b.waypointReached;
  if (!mem.waypoint || reached || rng() < dt * 0.1) {
    mem.waypoint = (me.weapon ? null : nearestCrate(state, me, 'weapon')) ?? (enemy ? { x: enemy.pose.x, y: enemy.pose.y } : null) ?? nearestCrate(state, me, null);
  }

  // --- stuck detection: slow for stuckSeconds -> reverse for reverseSeconds with the wheel flipped
  if (me.speed < b.stuckSpeed) {
    if (mem.stuckSince < 0) mem.stuckSince = now;
    else if (now - mem.stuckSince > b.stuckSeconds && now >= mem.reverseUntil) {
      mem.reverseUntil = now + b.reverseSeconds;
      mem.stuckSince = -1;
      mem.waypoint = null;
    }
  } else {
    mem.stuckSince = -1;
  }

  // --- pilot
  let steer = 0;
  let gas = false;
  let brake = false;
  if (mem.waypoint) {
    const want = Math.atan2(mem.waypoint.y - me.pose.y, mem.waypoint.x - me.pose.x);
    const diff = angleDiff(me.pose.angle, want);
    steer = clamp(diff / (30 * DEG), -1, 1);
    gas = Math.abs(diff) < 110 * DEG;
    brake = !gas;
  }
  if (now < mem.reverseUntil) {
    steer = -steer;
    gas = false;
    brake = true;
  }

  // --- gunner: turn the aim toward the enemy, fire when lined up and in range
  let dYaw = 0;
  let fire = false;
  if (enemy) {
    const want = Math.atan2(enemy.pose.y - me.pose.y, enemy.pose.x - me.pose.x);
    const diff = angleDiff(me.aimYaw, want);
    const step = b.turnRateDegPerSec * DEG * dt;
    dYaw = clamp(diff, -step, step) * cfg.aim.gyroSign; // undo the sim's sign so the bot turns the right way
    const range = me.weapon ? b.fireRange : cfg.weapons.waterCannon.range;
    fire = enemyDist <= range && Math.abs(diff) <= b.fireHalfAngleDeg * DEG && now >= me.fireReadyAt;
  }

  // --- engineer: a power every few seconds when it makes sense, shake whenever there is water
  let use: 0 | 1 | null = null;
  if (now >= mem.nextPowerAt) {
    const slot = me.powers[0] ? 0 : me.powers[1] ? 1 : null;
    if (slot !== null) {
      const power = me.powers[slot];
      const wantIt =
        (power === 'shield' && enemyDist < 30) ||
        (power === 'boost' && enemyDist < 45) ||
        (power === 'mine' && enemyDist < 25) ||
        power === 'smoke' ||
        power === 'wave';
      if (wantIt) {
        use = slot;
        mem.nextPowerAt = now + b.powerUseInterval;
      }
    }
  }

  return {
    pilot: { t: 'in', role: 'pilot', steer: steer * cfg.steer.sign, gas, brake },
    gunner: { t: 'in', role: 'gunner', dYaw, fire, recenter: false },
    engineer: { t: 'in', role: 'engineer', use, shake: me.water > 0 ? 1 : 0 },
    mem,
  };
}
