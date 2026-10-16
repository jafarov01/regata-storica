// src/sim/geom.ts — allocation-free 2D helpers used by projectiles and rules.
import type { Vec2 } from './coords';
import { wrapAngle } from './coords';

/** Oriented box in the sim plane. hw = half width (local x), hl = half length (local y, bow axis). */
export interface Obb {
  x: number;
  y: number;
  angle: number;
  hw: number;
  hl: number;
}

/**
 * Segment A->B against an OBB inflated by `pad` (projectile radius).
 * Returns the entry parameter t in [0, 1], or -1 when there is no hit.
 * Slab test in the box's local frame; A inside the box returns 0.
 */
export function segmentVsObb(ax: number, ay: number, bx: number, by: number, box: Obb, pad: number): number {
  const c = Math.cos(box.angle);
  const s = Math.sin(box.angle);
  // world -> local: rotate by -angle
  const dx0 = ax - box.x;
  const dy0 = ay - box.y;
  const lx0 = c * dx0 + s * dy0;
  const ly0 = -s * dx0 + c * dy0;
  const ddx = bx - ax;
  const ddy = by - ay;
  const ldx = c * ddx + s * ddy;
  const ldy = -s * ddx + c * ddy;
  const ex = box.hw + pad;
  const ey = box.hl + pad;

  let tmin = 0;
  let tmax = 1;
  // x slab
  if (Math.abs(ldx) < 1e-9) {
    if (lx0 < -ex || lx0 > ex) return -1;
  } else {
    let t1 = (-ex - lx0) / ldx;
    let t2 = (ex - lx0) / ldx;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  // y slab
  if (Math.abs(ldy) < 1e-9) {
    if (ly0 < -ey || ly0 > ey) return -1;
  } else {
    let t1 = (-ey - ly0) / ldy;
    let t2 = (ey - ly0) / ldy;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  return tmin;
}

/** Distance from a point to an OBB (0 when inside). Used by the mortar splash. */
export function pointObbDistance(px: number, py: number, box: Obb): number {
  const c = Math.cos(box.angle);
  const s = Math.sin(box.angle);
  const dx = px - box.x;
  const dy = py - box.y;
  const lx = c * dx + s * dy;
  const ly = -s * dx + c * dy;
  const ox = Math.max(Math.abs(lx) - box.hw, 0);
  const oy = Math.max(Math.abs(ly) - box.hl, 0);
  return Math.sqrt(ox * ox + oy * oy);
}

/**
 * Is point P inside the cone with apex O, axis `dirAngle` (sim angle: forward = (-sin, cos)),
 * half-angle `halfAngle` and length `range`? Writes the distance to `out.x` when it fits.
 */
export function pointInCone(
  ox: number,
  oy: number,
  dirAngle: number,
  halfAngle: number,
  range: number,
  px: number,
  py: number,
  out: Vec2,
): boolean {
  const dx = px - ox;
  const dy = py - oy;
  const dist = Math.hypot(dx, dy);
  if (dist > range || dist < 1e-6) return false;
  const toP = Math.atan2(-dx, dy);
  const off = Math.abs(wrapAngle(toP - dirAngle));
  if (off > halfAngle) return false;
  out.x = dist;
  out.y = off;
  return true;
}
