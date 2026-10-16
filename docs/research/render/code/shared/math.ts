/**
 * Small 2D math helpers shared by the sim, the renderer, the phone and the tests.
 * Angles are radians. Yaw conventions live in shared/map.ts (coordinate rules).
 * No classes, no allocations in hot paths beyond what the caller passes in.
 */

export interface Vec2 {
  x: number;
  y: number;
}

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Wrap an angle to (-PI, PI]. */
export function wrapAngle(a: number): number {
  let r = a % TAU;
  if (r <= -Math.PI) r += TAU;
  else if (r > Math.PI) r -= TAU;
  return r;
}

/** Signed shortest difference b - a in (-PI, PI]. */
export function angleDiff(a: number, b: number): number {
  return wrapAngle(b - a);
}

/** Interpolate between two angles along the shortest arc. */
export function lerpAngle(a: number, b: number, t: number): number {
  return wrapAngle(a + angleDiff(a, b) * t);
}

/** Move angle `from` toward `to` by at most `maxStep` radians. */
export function turnToward(from: number, to: number, maxStep: number): number {
  const d = angleDiff(from, to);
  return wrapAngle(from + clamp(d, -maxStep, maxStep));
}

export function len2(x: number, y: number): number {
  return Math.hypot(x, y);
}

export function dist2(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(bx - ax, by - ay);
}

/** Smooth dead zone: 0 inside `dead`, then rises linearly to 1 at `full`, clamped. */
export function deadZoneCurve(value: number, dead: number, full: number): number {
  const a = Math.abs(value);
  if (a <= dead) return 0;
  const t = clamp((a - dead) / (full - dead), 0, 1);
  return Math.sign(value) * t;
}

/** Exponential smoothing factor for a time constant `tau` (s) over `dt` (s). */
export function smoothingAlpha(dt: number, tau: number): number {
  if (tau <= 0) return 1;
  return 1 - Math.exp(-dt / tau);
}

/** Deterministic PRNG (mulberry32) so tests and replays can seed the sim. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pickRandom<T>(items: readonly T[], rng: () => number = Math.random): T | undefined {
  if (items.length === 0) return undefined;
  return items[Math.min(items.length - 1, Math.floor(rng() * items.length))];
}
