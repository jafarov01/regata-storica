// src/sim/coords.ts
// One convention, used by the sim, the renderer and the HUD:
//
//   Three.js world: Y up, right-handed. Boat yaw = Object3D.rotation.y (about +Y).
//   At yaw 0 the bow points along -Z; yaw +90 deg points along -X (CCW seen from above).
//   Rapier sim plane: sim.x = world.x, sim.y = -world.z.
//   The mirror (y := -z) keeps handedness: a positive Rapier angle / angular velocity
//   is a CCW turn seen from above, exactly a positive Three.js yaw. So simAngle === yaw.
//   The bow is the body's local +y axis in Rapier: forward = (-sin a, cos a).
//
// Nothing else in the code base converts coordinates; it imports these.

export interface Vec2 {
  x: number;
  y: number;
}

export function worldToSim(x: number, z: number, out: Vec2): Vec2 {
  out.x = x;
  out.y = -z;
  return out;
}

export function simToWorldX(simX: number): number {
  return simX;
}

export function simToWorldZ(simY: number): number {
  return -simY;
}

/** Object3D.rotation.y = yawFromSimAngle(body.rotation()). Identity by construction. */
export function yawFromSimAngle(simAngle: number): number {
  return simAngle;
}

export function simAngleFromYaw(yaw: number): number {
  return yaw;
}

/** Bow direction in the sim plane for a sim angle. */
export function forwardSim(a: number, out: Vec2): Vec2 {
  out.x = -Math.sin(a);
  out.y = Math.cos(a);
  return out;
}

/** Starboard (right-hand) direction in the sim plane. */
export function rightSim(a: number, out: Vec2): Vec2 {
  out.x = Math.cos(a);
  out.y = Math.sin(a);
  return out;
}

/** Sim angle whose forward vector points from (fx,fy) to (tx,ty). */
export function headingToPoint(fx: number, fy: number, tx: number, ty: number): number {
  return Math.atan2(-(tx - fx), ty - fy);
}

/** Wrap to (-PI, PI]. */
export function wrapAngle(a: number): number {
  let r = a % (2 * Math.PI);
  if (r <= -Math.PI) r += 2 * Math.PI;
  else if (r > Math.PI) r -= 2 * Math.PI;
  return r;
}

/** Shortest-arc interpolation between two angles. */
export function lerpAngle(a: number, b: number, t: number): number {
  return a + wrapAngle(b - a) * t;
}

/** Map cell (col, row) centre in sim coordinates. Row 0 is the north edge (most negative world z). */
export function cellToSim(col: number, row: number, cols: number, rows: number, cell: number, out: Vec2): Vec2 {
  const wx = (col - cols / 2 + 0.5) * cell;
  const wz = (row - rows / 2 + 0.5) * cell;
  return worldToSim(wx, wz, out);
}
