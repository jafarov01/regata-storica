/**
 * src/sim/bot.ts: bot crews that actually play, so 4 to 6 viewports can be
 * tested without people (TASKS-B B9).
 *
 * Based on docs/research/rules (bot.ts), with a grid path instead of driving
 * straight at the goal (the canals are a maze): a breadth-first distance field
 * over water cells from the goal, refreshed about once a second, and the pilot
 * steers at a point a few cells down that field. Unarmed bots loot a red
 * crate, armed bots hunt the nearest enemy. The gunner turns at a human-like
 * rate and fires when lined up. Powers are used when they make sense.
 */
import { BOOST, DEFAULT_WEAPON, SIM, WATER_CANNON, type WeaponId } from '@shared/config.ts';
import { DEG, clamp, makeRng, turnToward, wrapAngle } from '@shared/math.ts';
import { yawFromDir, type ParsedMap } from '@shared/map.ts';
import type { BoatState, GameState } from '@shared/state.ts';
import type { HullInput } from './boat.ts';
import { isLive } from './ctx.ts';
import { isBotId } from './roster.ts';
import { isTargetable } from './rules.ts';

export interface BotFrame {
  pilot: HullInput;
  /** Target world aim; the sim turns the boat's aim toward it. */
  aimYaw: number;
  fire: boolean;
  use: 0 | 1 | null;
  shake: number;
}

const FIRE_RANGE: Record<WeaponId, number> = { watercannon: WATER_CANNON.range - 1, cannon: 70, torpedo: 75, mortar: 55 };
/** Gunner turn rate, rad/s (about a person turning a phone). */
const AIM_RATE = 2.4;
const GOAL_REFRESH = 1;
const STUCK_SPEED = 1;
const STUCK_SEC = 1.5;
const REVERSE_SEC = 1.2;
/** Cells walked down the path when looking for a straight line. */
const LOOKAHEAD = 6;
/** Half the beam plus a margin, for the side rays. */
const HULL_CLEARANCE = 1.2;

interface Brain {
  goalCol: number;
  goalRow: number;
  field: Int16Array | null;
  /** Storage behind `field`, kept across goals so a replan allocates nothing. */
  fieldBuf: Int16Array | null;
  nextGoalAt: number;
  stuckSince: number;
  reverseUntil: number;
  /** Unjam direction: forward when it was stuck backing up, else reverse. */
  reverseGas: boolean;
  stuckCount: number;
  /** Backing up to turn round. */
  backing: boolean;
  nextPowerAt: number;
  /** Small per-bot aim error so bots miss sometimes. */
  aimError: number;
  /** Reused every step: think() allocates nothing. */
  frame: BotFrame;
}

/** Returned for boats that are not fighting; reset on every use. */
const IDLE: BotFrame = { pilot: { steer: 0, gas: false, brake: false }, aimYaw: 0, fire: false, use: null, shake: 0 };
const SLOTS = [0, 1] as const;

export class Bots {
  private readonly brains = new Map<number, Brain>();
  private readonly rng = makeRng(7);
  /** Breadth-first queue shared by every brain (one goal search at a time). */
  private queue: Int32Array | null = null;

  constructor(private readonly map: ParsedMap) {}

  reset(): void {
    this.brains.clear();
  }

  /** A team is a bot team when every member is a bot. */
  static isBotTeam(state: GameState, team: number): boolean {
    const t = state.teams[team];
    return !!t && t.members.length > 0 && t.members.every(isBotId);
  }

  think(state: GameState, team: number, los: (ax: number, az: number, bx: number, bz: number) => boolean): BotFrame {
    const me = state.boats[team];
    if (!me || me.status !== 'alive' || !isLive(state)) {
      IDLE.pilot.steer = 0;
      IDLE.pilot.gas = false;
      IDLE.pilot.brake = false;
      IDLE.aimYaw = me?.aimYaw ?? 0;
      IDLE.fire = false;
      IDLE.use = null;
      IDLE.shake = 0;
      return IDLE;
    }
    const brain = this.brain(team);
    const t = state.time;

    const enemy = this.nearestEnemy(state, me);
    const enemyDist = enemy ? Math.hypot(enemy.pose.x - me.pose.x, enemy.pose.z - me.pose.z) : Infinity;
    const enemyVisible = !!enemy && enemyDist < 90 && los(me.pose.x, me.pose.z, enemy.pose.x, enemy.pose.z);

    // ---- goal: a weapon crate when unarmed, else the enemy, else any crate
    if (t >= brain.nextGoalAt || !brain.field) {
      brain.nextGoalAt = t + GOAL_REFRESH;
      const goal = (me.weapon === DEFAULT_WEAPON ? this.nearestCrate(state, me, 'weapon') : null) ?? (enemy ? enemy.pose : null) ?? this.nearestCrate(state, me, null);
      if (goal) this.setGoal(brain, goal.x, goal.z);
    }

    // ---- pilot: steer at the farthest point down the distance field the hull can see
    const pilot: HullInput = brain.frame.pilot;
    pilot.steer = 0;
    pilot.gas = false;
    pilot.brake = false;
    const target = this.lookahead(brain, me.pose.x, me.pose.z, los);
    if (target) {
      const want = yawFromDir(target.x - me.pose.x, target.z - me.pose.z);
      const diff = wrapAngle(want - me.pose.yaw);
      const turn = Math.abs(diff);
      // steer > 0 is right; a positive yaw difference is to the left.
      pilot.steer = clamp(-diff / (25 * DEG), -1, 1);
      // Facing away: back up while turning (the torque turns the same way in reverse)
      // until the bow is within 50 deg of the path, then drive. Hysteresis stops the dithering.
      if (turn > 100 * DEG) brain.backing = true;
      else if (turn < 50 * DEG) brain.backing = false;
      if (brain.backing) pilot.brake = true;
      else if (turn < 40 * DEG) pilot.gas = true;
      else if (me.speed > 5) pilot.brake = true; // drift through the corner
      else pilot.gas = true;
    }
    const wantsToMove = pilot.gas || pilot.brake;
    if (Math.abs(me.speed) < STUCK_SPEED && wantsToMove && t >= brain.reverseUntil) {
      if (brain.stuckSince < 0) brain.stuckSince = t;
      else if (t - brain.stuckSince > STUCK_SEC) {
        brain.reverseUntil = t + REVERSE_SEC;
        brain.reverseGas = !pilot.gas;
        brain.stuckSince = -1;
        brain.stuckCount += 1;
        if (brain.stuckCount >= 3) {
          // Still jammed: try another goal.
          brain.stuckCount = 0;
          brain.field = null;
          brain.nextGoalAt = t + 4;
          const crate = state.crates[Math.floor(this.rng() * state.crates.length)];
          if (crate) this.setGoal(brain, crate.x, crate.z);
        }
      }
    } else if (Math.abs(me.speed) >= STUCK_SPEED * 2) {
      brain.stuckSince = -1;
      if (Math.abs(me.speed) > 4) brain.stuckCount = 0;
    }
    if (t < brain.reverseUntil) {
      // Unjam: drive the other way, keep steering toward the goal.
      pilot.gas = brain.reverseGas;
      pilot.brake = !brain.reverseGas;
    }

    // ---- gunner: turn toward the enemy, fire when lined up and in range
    let aimYaw = me.aimYaw;
    let fire = false;
    if (enemy && (enemyVisible || me.weapon === 'mortar')) {
      const want = yawFromDir(enemy.pose.x - me.pose.x, enemy.pose.z - me.pose.z) + brain.aimError;
      aimYaw = turnToward(me.aimYaw, want, AIM_RATE * SIM.dt);
      const off = Math.abs(wrapAngle(want - me.aimYaw));
      fire = enemyDist <= FIRE_RANGE[me.weapon] && off < 6 * DEG;
      if (fire && this.rng() < 0.02) brain.aimError = (this.rng() - 0.5) * 6 * DEG;
    } else {
      aimYaw = turnToward(me.aimYaw, me.pose.yaw, AIM_RATE * SIM.dt);
    }

    // ---- engineer: powers when they make sense, shake whenever there is water
    let use: 0 | 1 | null = null;
    if (t >= brain.nextPowerAt) {
      for (const slot of SLOTS) {
        const power = me.powers[slot];
        if (!power) continue;
        const ahead = enemy ? Math.abs(wrapAngle(yawFromDir(enemy.pose.x - me.pose.x, enemy.pose.z - me.pose.z) - me.pose.yaw)) : Math.PI;
        const want =
          (power === 'shield' && enemyDist < 35) ||
          (power === 'boost' && enemyDist < 30 && ahead < 15 * DEG && me.speed > 4) ||
          (power === 'mine' && enemyDist < 30 && ahead > 120 * DEG) ||
          (power === 'smoke' && state.boats.some((b) => b.lockTarget === team)) ||
          (power === 'wave' && enemyDist < 10);
        if (want) {
          use = slot;
          brain.nextPowerAt = t + BOOST.durationSec;
          break;
        }
      }
    }

    const out = brain.frame;
    out.aimYaw = aimYaw;
    out.fire = fire;
    out.use = use;
    out.shake = me.water > 0 ? 1 : 0;
    return out;
  }

  private brain(team: number): Brain {
    let b = this.brains.get(team);
    if (!b) {
      b = {
        goalCol: -1,
        goalRow: -1,
        field: null,
        fieldBuf: null,
        nextGoalAt: 0,
        stuckSince: -1,
        reverseUntil: 0,
        reverseGas: false,
        stuckCount: 0,
        backing: false,
        nextPowerAt: 0,
        aimError: (this.rng() - 0.5) * 4 * DEG,
        frame: { pilot: { steer: 0, gas: false, brake: false }, aimYaw: 0, fire: false, use: null, shake: 0 },
      };
      this.brains.set(team, b);
    }
    return b;
  }

  private nearestEnemy(state: GameState, me: BoatState): BoatState | null {
    let best: BoatState | null = null;
    let bestD = Infinity;
    for (const b of state.boats) {
      if (b.team === me.team || !isTargetable(state, b.team)) continue;
      const d = Math.hypot(b.pose.x - me.pose.x, b.pose.z - me.pose.z);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    return best;
  }

  private nearestCrate(state: GameState, me: BoatState, category: 'weapon' | 'power' | null): { x: number; z: number } | null {
    let best: { x: number; z: number } | null = null;
    let bestD = Infinity;
    for (const c of state.crates) {
      if (!c.active || (category && c.category !== category)) continue;
      if (category === null && c.category === 'power' && me.powers[0] && me.powers[1]) continue;
      const d = Math.hypot(c.x - me.pose.x, c.z - me.pose.z);
      if (d < bestD) {
        bestD = d;
        best = { x: c.x, z: c.z };
      }
    }
    return best;
  }

  /** Breadth-first distance (in cells) from the goal over water cells. */
  private setGoal(brain: Brain, x: number, z: number): void {
    const m = this.map;
    const { col, row } = m.toCell(x, z);
    if (brain.field && col === brain.goalCol && row === brain.goalRow) return;
    if (!m.isWater(col, row)) return;
    brain.goalCol = col;
    brain.goalRow = row;
    brain.fieldBuf ??= new Int16Array(m.width * m.height);
    const field = brain.fieldBuf.fill(-1);
    const queue = (this.queue ??= new Int32Array(m.width * m.height));
    let head = 0;
    let tail = 0;
    field[row * m.width + col] = 0;
    queue[tail++] = row * m.width + col;
    while (head < tail) {
      const i = queue[head++] as number;
      const c = i % m.width;
      const r = (i - c) / m.width;
      const d = (field[i] as number) + 1;
      for (const [dc, dr] of NEIGHBOURS) {
        const nc = c + dc;
        const nr = r + dr;
        if (!m.isWater(nc, nr)) continue;
        const j = nr * m.width + nc;
        if (field[j] !== -1) continue;
        field[j] = d;
        queue[tail++] = j;
      }
    }
    brain.field = field;
  }

  /**
   * Walk down the field from the boat's cell (up to LOOKAHEAD cells) and keep
   * the farthest cell centre the whole hull can reach in a straight line
   * (three rays: centre and both sides of the beam). String pulling, so the
   * boat cuts open corners but not through buildings.
   */
  private lookahead(brain: Brain, x: number, z: number, los: (ax: number, az: number, bx: number, bz: number) => boolean): { x: number; z: number } | null {
    const field = brain.field;
    if (!field) return null;
    const m = this.map;
    let { col, row } = m.toCell(x, z);
    if (!m.isWater(col, row)) return null;
    let best = m.toWorld(col, row);
    for (let step = 0; step < LOOKAHEAD; step++) {
      const here = field[row * m.width + col] ?? -1;
      if (here <= 0) break;
      let next: [number, number] | null = null;
      let nextD = here;
      for (const [dc, dr] of NEIGHBOURS) {
        const d = m.isWater(col + dc, row + dr) ? (field[(row + dr) * m.width + col + dc] ?? -1) : -1;
        if (d >= 0 && d < nextD) {
          nextD = d;
          next = [col + dc, row + dr];
        }
      }
      if (!next) break;
      [col, row] = next;
      const p = m.toWorld(col, row);
      // The next two cells are always kept, so the target never sits beside the hull.
      if (step > 1 && !this.hullFits(x, z, p.x, p.z, los)) break;
      best = p;
    }
    return best;
  }

  private hullFits(ax: number, az: number, bx: number, bz: number, los: (ax: number, az: number, bx: number, bz: number) => boolean): boolean {
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz) || 1;
    const ox = (-dz / len) * HULL_CLEARANCE;
    const oz = (dx / len) * HULL_CLEARANCE;
    return los(ax, az, bx, bz) && los(ax + ox, az + oz, bx + ox, bz + oz) && los(ax - ox, az - oz, bx - ox, bz - oz);
  }
}

const NEIGHBOURS: readonly [number, number][] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];
