/**
 * Aiming in 2D (SPEC section 4). Aim is one world angle per team; every shot
 * leaves flat along it. These functions are pure: they take the shooter's
 * position, the aim yaw, the enemy candidates and an injected line-of-sight
 * test (a Rapier wall ray in the sim, `() => true` in tests).
 */
import { CONFIG } from '@shared/config.ts';
import type { GameConfig, WeaponKind } from '@shared/config.ts';
import { angleDiff, clamp, DEG, wrapAngle } from '@shared/math.ts';
import type { CrosshairState } from '@shared/state.ts';

export interface AimCandidate {
  team: number;
  x: number;
  y: number;
  /** Inside smoke: invisible to assist, diamond and locks. */
  hidden: boolean;
}

/** True when nothing solid (walls, bridges piers, poles) lies between a and b. */
export type LineOfSight = (ax: number, ay: number, bx: number, by: number) => boolean;
export const ALWAYS_VISIBLE: LineOfSight = () => true;

export interface Bearing {
  team: number;
  x: number;
  y: number;
  dist: number;
  /** Signed angle from the aim line to the enemy, radians, positive = anticlockwise. */
  offset: number;
}

/** Distance along the unit ray (ox, oy) + t (dx, dy) to the first point on the circle, or null. */
export function rayCircleDistance(ox: number, oy: number, dx: number, dy: number, cx: number, cy: number, r: number): number | null {
  const fx = ox - cx;
  const fy = oy - cy;
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - r * r;
  const disc = b * b - 4 * c;
  if (disc < 0) return null;
  const s = Math.sqrt(disc);
  const t0 = (-b - s) / 2;
  if (t0 >= 0) return t0;
  const t1 = (-b + s) / 2;
  return t1 >= 0 ? 0 : null; // origin inside the circle counts as distance 0
}

export function bearings(ox: number, oy: number, aimYaw: number, candidates: readonly AimCandidate[]): Bearing[] {
  const out: Bearing[] = [];
  for (const c of candidates) {
    if (c.hidden) continue;
    const dx = c.x - ox;
    const dy = c.y - oy;
    const dist = Math.hypot(dx, dy);
    if (dist < 1e-6) continue;
    out.push({ team: c.team, x: c.x, y: c.y, dist, offset: angleDiff(aimYaw, Math.atan2(dy, dx)) });
  }
  return out;
}

/**
 * Red diamond + gyro slow-down: the aim ray hits an enemy's hull circle within
 * range and with line of sight. `wasOnTarget` enlarges the circle (hysteresis)
 * so the state does not flicker at the hull edge.
 */
export function enemyUnderCrosshair(
  ox: number,
  oy: number,
  aimYaw: number,
  candidates: readonly AimCandidate[],
  wasOnTarget: boolean,
  cfg: GameConfig = CONFIG,
  los: LineOfSight = ALWAYS_VISIBLE,
): number | null {
  const dx = Math.cos(aimYaw);
  const dy = Math.sin(aimYaw);
  const r = wasOnTarget ? cfg.aim.onTargetStickyRadius : cfg.aim.onTargetRadius;
  let best: { team: number; t: number } | null = null;
  for (const c of candidates) {
    if (c.hidden) continue;
    const t = rayCircleDistance(ox, oy, dx, dy, c.x, c.y, r);
    if (t === null || t > cfg.aim.onTargetRange) continue;
    if (best && t >= best.t) continue;
    if (cfg.aim.requireLineOfSight && !los(ox, oy, c.x, c.y)) continue;
    best = { team: c.team, t };
  }
  return best ? best.team : null;
}

/**
 * Cannon aim assist: among enemies inside the assist cone (smallest angular
 * offset wins, distance breaks ties), bend the shot by at most assistMaxBendDeg.
 */
export function aimAssist(
  ox: number,
  oy: number,
  aimYaw: number,
  candidates: readonly AimCandidate[],
  cfg: GameConfig = CONFIG,
  los: LineOfSight = ALWAYS_VISIBLE,
): { yaw: number; team: number | null } {
  const half = cfg.aim.assistHalfAngleDeg * DEG;
  const maxBend = cfg.aim.assistMaxBendDeg * DEG;
  let best: Bearing | null = null;
  for (const b of bearings(ox, oy, aimYaw, candidates)) {
    if (b.dist > cfg.aim.assistRange || Math.abs(b.offset) > half) continue;
    if (best && (Math.abs(b.offset) > Math.abs(best.offset) || (Math.abs(b.offset) === Math.abs(best.offset) && b.dist >= best.dist))) continue;
    if (cfg.aim.requireLineOfSight && !los(ox, oy, b.x, b.y)) continue;
    best = b;
  }
  if (!best) return { yaw: aimYaw, team: null };
  return { yaw: wrapAngle(aimYaw + clamp(best.offset, -maxBend, maxBend)), team: best.team };
}

/** Torpedo lock: the NEAREST enemy (by distance) inside the 40 degree cone ahead of the AIM, within lockRange. */
export function torpedoLock(
  ox: number,
  oy: number,
  aimYaw: number,
  candidates: readonly AimCandidate[],
  cfg: GameConfig = CONFIG,
  los: LineOfSight = ALWAYS_VISIBLE,
): number | null {
  const half = cfg.weapons.torpedo.lockHalfAngleDeg * DEG;
  let best: Bearing | null = null;
  for (const b of bearings(ox, oy, aimYaw, candidates)) {
    if (b.dist > cfg.weapons.torpedo.lockRange || Math.abs(b.offset) > half) continue;
    if (best && b.dist >= best.dist) continue;
    if (cfg.aim.requireLineOfSight && !los(ox, oy, b.x, b.y)) continue;
    best = b;
  }
  return best ? best.team : null;
}

/** Mortar: lands on the nearest enemy within 10 degrees of the aim line and 60 m (walls do not matter), else 40 m ahead. */
export function mortarTarget(
  ox: number,
  oy: number,
  aimYaw: number,
  candidates: readonly AimCandidate[],
  cfg: GameConfig = CONFIG,
): { x: number; y: number; team: number | null } {
  const half = cfg.weapons.mortar.targetHalfAngleDeg * DEG;
  let best: Bearing | null = null;
  for (const b of bearings(ox, oy, aimYaw, candidates)) {
    if (b.dist > cfg.weapons.mortar.targetRange || Math.abs(b.offset) > half) continue;
    if (best && b.dist >= best.dist) continue;
    best = b;
  }
  if (best) return { x: best.x, y: best.y, team: best.team };
  const r = cfg.weapons.mortar.fallbackRange;
  return { x: ox + Math.cos(aimYaw) * r, y: oy + Math.sin(aimYaw) * r, team: null };
}

/**
 * The sim integrates the phone's dYaw (already dead-zoned and x2 on the phone).
 * The on-target gain lives here because only the sim knows where enemies are.
 */
export function integrateAim(aimYaw: number, dYaw: number, onTarget: boolean, cfg: GameConfig = CONFIG): number {
  const gain = (onTarget ? cfg.aim.onTargetGain : 1) * cfg.aim.gyroSign;
  return wrapAngle(aimYaw + dYaw * gain);
}

/** Crosshair state from the same facts, priority: hit flash > lock ring > red diamond > neutral. */
export function crosshairFor(args: {
  now: number;
  hitFlashUntil: number;
  weapon: WeaponKind | null;
  lockTeam: number | null;
  onTarget: boolean;
}): CrosshairState {
  if (args.now < args.hitFlashUntil) return 'hit';
  if (args.weapon === 'torpedo' && args.lockTeam !== null) return 'lock';
  if (args.onTarget) return 'target';
  return 'neutral';
}

/** Keyboard Gunner: Left/Right produce a dYaw per frame like a phone would. */
export function keyboardDYaw(left: boolean, right: boolean, dt: number, cfg: GameConfig = CONFIG): number {
  const dir = (right ? -1 : 0) + (left ? 1 : 0);
  return dir * cfg.aim.keyboardTurnRateDegPerSec * DEG * dt;
}
