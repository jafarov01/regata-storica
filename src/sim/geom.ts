/**
 * src/sim/geom.ts: allocation-free 2D helpers in world (x, z) and world yaw.
 *
 * Adapted from docs/research/physics (geom.ts), which worked in the Rapier
 * plane. Here everything is in the repo convention (shared/map.ts): forward =
 * (-sin yaw, -cos yaw), right = (cos yaw, -sin yaw).
 */
import { BOAT } from '@shared/config.ts';
import { wrapAngle } from '@shared/math.ts';
import { yawFromDir } from '@shared/map.ts';
import type { Pose } from '@shared/state.ts';

/** Oriented box: centre, yaw, half width (across the beam) and half length (along the bow). */
export interface Obb {
  x: number;
  z: number;
  yaw: number;
  hw: number;
  hl: number;
}

export const HULL_HALF_WIDTH = BOAT.beam / 2;
export const HULL_HALF_LENGTH = BOAT.length / 2;

export function hullObb(pose: Pose, out: Obb): Obb {
  out.x = pose.x;
  out.z = pose.z;
  out.yaw = pose.yaw;
  out.hw = HULL_HALF_WIDTH;
  out.hl = HULL_HALF_LENGTH;
  return out;
}

/**
 * Segment A->B against an OBB inflated by `pad`. Returns the entry parameter t
 * in [0, 1], or -1 when there is no hit. A inside the box returns 0.
 */
export function segmentVsObb(ax: number, az: number, bx: number, bz: number, box: Obb, pad: number): number {
  const fx = -Math.sin(box.yaw);
  const fz = -Math.cos(box.yaw);
  const rx = -fz; // (cos yaw, -sin yaw)
  const rz = fx;
  const dx0 = ax - box.x;
  const dz0 = az - box.z;
  const ddx = bx - ax;
  const ddz = bz - az;
  // local frame: u along the beam (right), v along the bow (forward)
  const u0 = dx0 * rx + dz0 * rz;
  const v0 = dx0 * fx + dz0 * fz;
  const du = ddx * rx + ddz * rz;
  const dv = ddx * fx + ddz * fz;
  const eu = box.hw + pad;
  const ev = box.hl + pad;
  let tmin = 0;
  let tmax = 1;
  const slab = (p0: number, d: number, e: number): boolean => {
    if (Math.abs(d) < 1e-9) return p0 >= -e && p0 <= e;
    let t1 = (-e - p0) / d;
    let t2 = (e - p0) / d;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    return tmin <= tmax;
  };
  if (!slab(u0, du, eu)) return -1;
  if (!slab(v0, dv, ev)) return -1;
  return tmin;
}

/** Distance from a point to an OBB (0 when inside). */
export function pointObbDistance(px: number, pz: number, box: Obb): number {
  const fx = -Math.sin(box.yaw);
  const fz = -Math.cos(box.yaw);
  const dx = px - box.x;
  const dz = pz - box.z;
  const u = dx * -fz + dz * fx;
  const v = dx * fx + dz * fz;
  const ou = Math.max(Math.abs(u) - box.hw, 0);
  const ov = Math.max(Math.abs(v) - box.hl, 0);
  return Math.hypot(ou, ov);
}

/** Signed angle from `yaw` to the direction from (ox, oz) to (px, pz), in (-PI, PI]. */
export function bearingOffset(ox: number, oz: number, yaw: number, px: number, pz: number): number {
  return wrapAngle(yawFromDir(px - ox, pz - oz) - yaw);
}
