# Physics: 2D boat physics with Rapier 2D 0.21 and custom projectiles

Target files: `src/sim/physics.ts`, `src/sim/coords.ts`, `src/sim/geom.ts`, `src/sim/boat.ts`, `src/sim/walls.ts`, `src/sim/items.ts`, `src/sim/projectiles.ts`, `src/sim/loop.ts`, `src/sim/sim.ts`, the `PHYSICS` block of `shared/config.ts`, and `tests/sim/*.test.ts`.

Everything below was verified against the installed packages (`@dimforge/rapier2d-compat` 0.21.0, `three` 0.186.1, vite 8.3.4, vitest 5.0.5, TypeScript 5.9, node 24.15): every API name was read from `node_modules/@dimforge/rapier2d-compat/dist/**/*.d.ts`, and every code file in section 3 was typechecked with the repo's `tsconfig.json` options (strict, `noUncheckedIndexedAccess`, plus `noUnusedLocals`/`noUnusedParameters`) and exercised by the 34 vitest tests in section 5, all green, in a scratch mirror of the repo (`scratchpad/research/physics/repo`). Numbers quoted as "measured" come from the proof scripts `proof1.mjs` to `proof5.mjs` in the same folder.

---

## 1. The problem, in the words of the spec

From SPEC.md section 8 (Physics):

- "Gameplay physics runs in 2D on the water plane, and everything is drawn in 3D. Boats never leave the water, so a 2D solver gives correct collisions with far less code and far fewer bugs."
- "Engine: Rapier 2D (WASM build) for boats, walls, poles, crates and mines."
- "Projectiles: small custom code (position, velocity, gravity) with distance checks against boats. Cannonballs and mortar shells arc in 3D; only their impact point matters for hits."
- "Timestep: fixed 60 Hz simulation; the renderer interpolates between steps."
- Boat handling: "Rigid body shaped like a gondola, about 6 m × 1.4 m. GAS pushes forward; reverse is 40% of forward thrust. Strong sideways drag (the keel), so the boat goes where it points. Sideways drag drops during a drift turn, so the stern slides out. Linear and angular damping act as water resistance. Steering strength grows with speed, with a slow turn still possible at rest. Top speed about 10 m/s, 16 m/s with Boost."
- Collisions: "Boat against wall: bounce and scrape sparks, no damage. Boat against boat: both bounce with real momentum exchange. A boosted ram sinks the target; two boosted boats just bounce. A lethal hit applies an impulse at the impact point, so the boat flips and spins as it sinks. The Water Cannon applies a continuous push along its stream. Crates and mines are light bodies that drift and can be shoved around."
- "Visual-only motion (costs nothing in the simulation): boats bob on the waves, roll up to 8° into turns, pitch when accelerating and sit lower when the hull holds water."

Related rules the physics must serve: section 5 ("On a lethal hit the boat flips and sinks (about 2 s)... After 5 s the boat respawns at a random dock... 3 s of spawn protection... Speed is multiplied by 1 − 0.5 × water / 100"), section 6 (Cannon, Torpedo "locks the nearest enemy in a 40° cone ahead and homes along the water", Mortar "auto-ranged lob: lands on the nearest enemy within 10° of the aim line and 60 m, even behind buildings; with no target it lands 40 m ahead. 6 m splash", Mine "arms after 1 s, sinks the first enemy that touches it", crates "respawn 8 s later"), section 7 ("one ASCII grid in shared/map.ts, 8 m per cell... Physics builds its walls from the grid... Coordinates: metres, Y up, water surface at y = 0, map origin at the centre. The 2D physics uses (x, z) of the 3D world.") and section 4 ("In code, aim is just an angle in the 2D top-down simulation: hits are 2D rays and 2D projectile checks.").

The hard parts the spec flags or implies: binding the 2D solver to the 3D scene without sign bugs, making a Rapier body feel like an arcade boat (keel, drift, speed caps), telling a lethal ram from a scrape, keeping a sunk hull in the world without it colliding, building a few dozen wall colliders out of ~1900 map cells, and custom projectiles that respect walls but do not cost a Rapier body each.

---

## 2. Decisions, why, and what was rejected

| # | Decision | Why | Rejected |
|---|---|---|---|
| D1 | `import RAPIER from '@dimforge/rapier2d-compat'` and `await RAPIER.init()` once, loaded with a dynamic `import()` on the SCENE route only. No Vite plugin or config. | The compat bundle inlines the wasm as base64 (`"AGFzbQ..."` decoded by base64-js inside `init()`), so there is no `.wasm` asset for the bundler to handle. Verified: `vite build` of a test app produced `rapier-*.js` 3.4 MB (1.3 MB gzip) with zero config, and the dev server pre-bundled it as `/node_modules/.vite/deps/@dimforge_rapier2d-compat.js`. The dynamic import keeps the 1.3 MB off the phones. | `@dimforge/rapier2d` (needs wasm asset handling and top-level await plugins, the exact thing the spec avoids). `vite-plugin-wasm`: not needed. |
| D2 | Coordinates: `sim.x = world.x`, `sim.y = -world.z`, `simAngle === Object3D.rotation.y`, bow = body local `+y`, forward = `(-sin a, cos a)`. | The mirror `y := -z` preserves handedness, so a positive Rapier angular velocity is a positive Three.js yaw (CCW seen from above). No sign flips anywhere; `rotation.y = body.rotation()`. Pinned by a test that compares with Three's own `applyQuaternion`. | `y := z`: then `yaw = -angle - PI/2` and every angular quantity flips sign; a classic source of "left turns right" bugs. |
| D3 | Boat = dynamic body, `roundCuboid(0.55, 2.85, 0.15)` (effective 0.7 × 3.0 half extents), `setMass(1000)`, `linearDamping 1.0`, `angularDamping 3.0`, `canSleep(false)`. Thrust derived: `F = m·d·v_top = 10 000 N`. | Rapier damping is `v *= 1/(1 + dt·d)` per step (source + measured), so with a constant force the terminal speed is exactly `F/(m·d)` and the approach is `v(t) ≈ v_top(1 − e^{−d t})`: 95 % at 3 s with `d = 1` (measured 9.49 m/s at 3 s). Boost ×1.6 and hull water `×(1 − 0.5·w/100)` scale the thrust and therefore the top speed with no extra clamp. Rounded corners slide over seams between merged wall rectangles. | Mass by density (needs density ≈ 119 for 1000 kg; opaque). `convexHull` of a gondola outline (verified it works: `ShapeType.ConvexPolygon`, inertia 2194 vs 3163 for the box) but the projectile OBB tests would no longer match the hull; adopt it later only if the pointed bow matters for wall scraping. CCD: unnecessary, 16 m/s × 1/60 = 0.27 m per step against 8 m thick walls. |
| D4 | Keel = scale the lateral velocity component each step with `setLinvel`: `v_lat *= exp(−grip·dt)`, `grip = 8 /s` (drift: 1.5 /s). | Exact, monotonic, frame-rate independent, cannot overshoot (measured: lateral 7 → 0.74 m/s after 0.25 s, → 0 by 1 s, no sign change). | Counter impulse `−m·v_lat·k·dt` (also measured stable at 60 Hz, but it is explicit Euler: overshoots if `k·dt > 1`, and the decay then depends on dt). |
| D5 | Steering = torque sized from the steady-state turn rate: `τ = ω_ss · I · angularDamping`, `ω_ss` lerped from 0.5 rad/s at rest to 1.3 rad/s at top speed; angular velocity hard-capped with `setAngvel`. | Angular damping has the same `1/(1+dt·d)` form, so `ω_ss = τ/(I·d)`; the shape-agnostic `body.principalInertia()` makes the torque right for any hull. Time constant `1/d = 0.33 s` feels responsive. Turn radius at top speed `v/ω = 7.7 m`, fits an 8–10 m canal. | Steering by setting angular velocity directly (kills the momentum feel and fights the solver during wall contact). |
| D6 | Ram detection = `COLLISION_EVENTS` "started" between two hulls + the velocities cached just before `world.step` + the contact normal and point from `world.contactPair(...)`. Rammer = boosted, closing speed along the normal ≥ 7 m/s, bow facing the normal (`dot ≥ cos 60°`). Both qualify → bounce. | After the step the solver has already resolved the impact (measured: pre-step 12 m/s, post-step −1.98 m/s), so pre-step velocities are needed. The manifold gives a world-space normal and solver contact point inside the handler (measured on the started event: normal (0,1), point (0.70, 19.00)). | `CONTACT_FORCE_EVENTS` with a threshold: fires in Newtons (solver and mass dependent, measured 50 kN spikes vs 2 kN resting), fires on sustained pushing too, and `TempContactForceEvent` has no contact point. |
| D7 | Sinking: `collider.setCollisionGroups(Masks.boatSinking)` (member SINKING, filter 0) and keep the body dynamic for 2 s, then `body.setEnabled(false)`; respawn = `setEnabled(true)`, `setTranslation`, `setRotation`, `setLinvel(0)`, `setAngvel(0)`, groups → PROTECTED for 3 s, then BOAT. | No body churn (stable handles, stable entity ids, no stale-handle aliasing, see edge case E2). A filter of 0 makes the hull invisible to every pair test and every scene query. | Removing and recreating the body (handle churn). Kinematic body (no drifting while sinking). Separate "ghost" entity. |
| D8 | Lethal-hit impulse: the sim applies `applyImpulseAtPoint(4000 N·s · dir, impactPoint)` so the sinking hull spins and slides in 2D (measured 45.5 rad/s from a 500 N·s impulse 2.5 m off-centre on the proof's density-1 box, I = 26.6 kg·m²; for the 1000 kg hull, I = 3163 kg·m², 4000 N·s at the 3 m bow gives 12 000/3163 = 3.8 rad/s against 3 /s angular damping). The flip (pitch/roll/submerge) is render-only from `phase === 'sinking'` and `phaseT`. | 2D spin is free and makes the kill-cam read; a 3D flip in the sim would need a 3D solver. | Flip in the sim: no. |
| D9 | Walls: greedy rectangle merge of solid cells into cuboids on one fixed body, plus 4 border slabs; friction 0, restitution 0.4; bridge cells are water; poles are `ball(0.25)`; moored gondolas `cuboid(0.7, 3)` rotated; pile clusters 3 × `ball(0.35)`. | The spec's sample map (8 × 24 cells, 101 solid cells) merges into 8 rectangles; a 50 × 38 map merges to a few dozen. Zero friction keeps "scrape" from becoming "stick". | One collider per cell (≈ 1000 colliders and a seam at every cell edge). Polyline contours with `PolylineFlags.ORIENTED` (exists in 0.21 and removes corner pushes, but needs contour tracing; keep as the upgrade if hulls still catch on seams). |
| D10 | Crates: dynamic `ball(0.8)`, 20 kg, damping 1.5, `COLLISION_EVENTS`; pickup = the "started" event with a hull; on pickup `setEnabled(false)` and after 8 s teleport home and `setEnabled(true)`. | Solid and light, so a boat with full slots shoves it (spec: "a blue crate is left in the water for someone else") and a boat with a free slot takes it on first touch. No body churn. | Sensor crates (cannot be shoved). Polling with `world.intersectionsWithShape` each step (works, verified; costs one query per boat per step and is only needed for the "slot freed while still touching" corner). |
| D11 | Mines: one dynamic body, two colliders: solid `ball(0.4)` (walls/crates only, so boats pass over it) and a sensor `ball(1.6)` with `density 0`, groups MINE_TRIG ↔ BOAT only; arming after 1 s with a one-off `intersectionPairsWith` poll; 45 s lifetime; deferred body removal. | A sensor never generates forces, so the solid core is what keeps the mine out of walls. Sensors add mass unless density is 0 (measured 17.07 kg vs 10 kg). PROTECTED hulls are not in the sensor's filter, so spawn-protected boats never trigger it. | Sensor only (drifts through walls). |
| D12 | Projectiles are plain objects: cannonball 60 m/s with per-step segment-vs-OBB (box inflated by the ball radius) and `world.castRay(..., Masks.queryWalls)` for walls; torpedo 25 m/s pure pursuit with a 120°/s turn cap, lock in the 40° cone with line of sight, straight when lost; mortar = fixed 1.5 s flight to the target's launch position (no wall check), 6 m splash by point-to-OBB distance; water cannon = 18 m, 12° half-angle cone with line of sight, `addForce` 6 kN along the stream and 25 water/s. | Matches the spec's "2D rays and 2D projectile checks"; a castRay costs 1.2 µs (measured). Own team is skipped everywhere. | Rapier bodies for projectiles (CCD, events, handles for every shot). |
| D13 | Loop: accumulator with `dt = 1/60`, frame clamp 0.25 s, `prev`/`curr` transforms per entity, `alpha = accumulator/dt`; all timers use `simTime`. | Standard "Fix your timestep"; the clamp bounds the catch-up to 15 steps. | Variable timestep (Rapier docs: the step should not vary). |
| D14 | Entity registry = `Map<colliderHandle, EntityRef>`; removals are deferred until the event drain finished. | Handles are opaque f64 numbers (index + generation packed into the bits; measured handles `5e-324`, `1e-323`...), fine as Map keys, never as array indices, and `RigidBody.userData` exists but `Collider` has none while events report collider handles. | `userData` on bodies (typed `unknown`, and events give collider handles anyway). |
| D15 | `phys.commit()` (= one `world.step()`) right after the static world is built. | Scene queries only see a collider after the next step inserts it into the broad phase (measured: `castRay` → null right after `createCollider`, still null after `propagateModifiedBodyPositionsToColliders()`, hit after one step). | Relying on the countdown steps (works in the game, fails in tests and in any "fire on frame 0" harness). |

---

## 3. Algorithms and code

### 3.1 Formulas

- Rapier damping (rapier `src/dynamics/rigid_body_components.rs`, `RigidBodyVelocity::apply_damping`): `linvel *= 1/(1 + dt·linear_damping)`, `angvel *= 1/(1 + dt·angular_damping)`. Measured one-step ratio 0.98360653 = 1/(1 + 1/60).
- Constant force `F` on mass `m` with damping `d`: `v_{n+1} = (v_n + (F/m)·dt) / (1 + dt·d)`; fixed point `v_∞ = F/(m·d)` (measured 10.000 m/s at 10 s with F = 10 000 N, m = 1000, d = 1). Continuous approximation `v(t) = v_∞ (1 − e^{−d t})`: 63 % at 1/d, 95 % at 3/d.
- Same for rotation: `ω_∞ = τ/(I·d_ang)`; the box inertia is `I = m (w² + l²)/12 = 3163 kg·m²` (Rapier reports 3163.333 for `setMass(1000)` on the 0.7 × 3 cuboid).
- Keel: in the body frame `v_f = v·f`, `v_r = v·r` with `f = (−sin a, cos a)`, `r = (cos a, sin a)`; new velocity `f·v_f + r·(v_r·e^{−grip·dt})`.
- Hull water: `thrust *= 1 − 0.5·water/100` → top speed scales identically (measured 5.0 m/s at water 100).
- Ram: with `n` from hull A to hull B, `closing = (v_A − v_B)·n` using the pre-step velocities; A rams if boosted, `closing ≥ 7` and `f_A·n ≥ 0.5`; B rams if boosted, `closing ≥ 7` and `−f_B·n ≥ 0.5`.
- Segment vs OBB: transform the segment into the box frame (`lx = c·dx + s·dy`, `ly = −s·dx + c·dy`), slab test against `±(hw + r)`, `±(hl + r)`, entry `t ∈ [0, 1]`.
- Mortar arc (render only): `s = t/T`, `pos = lerp(launch, landing, s)`, `height = 4·H·s·(1 − s)` with `H = 20 m`, `T = 1.5 s` (a real 9.81 m/s² lob with T = 1.5 s would only rise 2.8 m).
- Cone test: `dist ≤ range` and `|wrap(atan2(−dx, dy) − aim)| ≤ halfAngle`.

### 3.2 `shared/config.ts` — the PHYSICS block

```ts
// shared/config.ts — PHYSICS section. Every tunable number of the simulation.
// (The real file also holds ammo, timers, aim assist, etc. Only the physics
// block is shown here; merge it into the contract file as `PHYSICS`.)

export const DEG = Math.PI / 180;

export const PHYSICS = {
  /** Fixed simulation step, seconds. 60 Hz as the spec requires. */
  dt: 1 / 60,
  /** Longest frame the accumulator will swallow (spiral-of-death guard). */
  maxFrameTime: 0.25,
  /** ASCII map cell size, metres. */
  cellSize: 8,

  boat: {
    length: 6,
    width: 1.4,
    /** kg. Only ratios matter; 1000 keeps forces in readable Newtons. */
    mass: 1000,
    /** Rapier damping d: v *= 1/(1 + dt*d) each step. Top speed = thrust/(mass*d). */
    linearDamping: 1.0,
    angularDamping: 3.0,
    /** m/s with GAS held, calm hull. Thrust is derived: mass*linearDamping*topSpeed. */
    topSpeed: 10,
    /** Boost: +60 % -> 16 m/s. */
    boostMul: 1.6,
    /** Reverse thrust as a fraction of forward thrust. */
    reverseMul: 0.4,
    /** N applied against forward velocity while BRAKE is held and the boat still moves forward. */
    brakeForce: 15000,
    /** Keel: lateral velocity decays as exp(-keelGrip*dt) per step (1/s). */
    keelGrip: 8,
    /** Lateral decay rate during a drift turn (stern slides out). */
    driftGrip: 1.5,
    /** Drift needs this much forward speed (m/s) and this much steer (0..1). */
    driftMinSpeed: 4,
    driftMinSteer: 0.3,
    /** Steering torque multiplier while drifting (sharper turn). */
    driftTurnMul: 1.5,
    /** Extra forward drag while drifting (1/s): the drift "loses speed". */
    driftDrag: 0.8,
    /** Steady-state turn rate (rad/s) at rest and at top speed; torque is derived. */
    turnRateRest: 0.5,
    turnRateFull: 1.3,
    /** Hard cap on angular velocity (rad/s). */
    maxAngvel: 1.8,
    restitution: 0.3,
    friction: 0.2,
    /** Speed multiplier is 1 - hullWaterSlowdown * water/100. */
    hullWaterSlowdown: 0.5,
    /** Boosted ram: approach speed along the contact normal must exceed this (m/s)... */
    ramMinSpeed: 7,
    /** ...and the rammer's bow must face the target: dot(forward, normal) >= this (cos 60 deg). */
    ramBowCos: 0.5,
    /** Impulse (N*s) applied at the impact point on a lethal hit, for the 2D spin while sinking. */
    sinkImpulse: 4000,
    sinkTime: 2,
    respawnTime: 5,
    spawnProtection: 3,
  },

  crate: { radius: 0.8, mass: 20, linearDamping: 1.5, angularDamping: 1.5, respawn: 8 },

  mine: {
    solidRadius: 0.4,
    triggerRadius: 1.6,
    mass: 10,
    linearDamping: 2,
    angularDamping: 2,
    armDelay: 1,
    lifetime: 45,
    /** Dropped this far behind the boat centre, with this fraction of its velocity. */
    dropBehind: 4,
    dropSpeedMul: 0.5,
  },

  cannon: { speed: 60, range: 120, radius: 0.3, assistMaxDeg: 4, assistCaptureDeg: 10 },
  torpedo: { speed: 25, range: 100, radius: 0.5, lockConeDeg: 40, lockRange: 80, turnRateDeg: 120 },
  mortar: { flightTime: 1.5, targetConeDeg: 10, targetRange: 60, defaultRange: 40, splashRadius: 6, apexHeight: 20 },
  waterCannon: { range: 18, halfAngleDeg: 12, pushForce: 6000, waterPerSecond: 25 },
} as const;
```

### 3.3 `src/sim/coords.ts` — the 2D/3D binding

```ts
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
```

Renderer side (one place, in `src/render`): `mesh.position.set(simToWorldX(t.x), 0, simToWorldZ(t.y)); mesh.rotation.y = yawFromSimAngle(t.angle);` with `t = lerpTransform(boat.prev, boat.curr, stepper.alpha, scratch)`. Author the gondola model with the bow along −Z.

### 3.4 `src/sim/geom.ts` — segment/OBB, point/OBB, cone

```ts
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
```

### 3.5 `src/sim/physics.ts` — world, groups, registry, events, ray queries

```ts
// src/sim/physics.ts — Rapier 2D world, collision groups, handle -> entity map, events, ray queries.
import RAPIER, {
  type Collider,
  type ColliderDesc,
  type EventQueue,
  type RigidBody,
  type RigidBodyDesc,
  type World,
} from '@dimforge/rapier2d-compat';
import { PHYSICS } from '@shared/config';

/** Call once (SCENE only) before any sim object is created. Decodes the inlined wasm. */
export async function initPhysics(): Promise<void> {
  await RAPIER.init();
}

export function physicsVersion(): string {
  return RAPIER.version();
}

// ---------------------------------------------------------------------------
// Collision groups. Rapier packs two 16-bit masks in one number:
//   (memberships << 16) | filter
// A pair interacts iff (A.memberships & B.filter) != 0 && (B.memberships & A.filter) != 0.
// The same two-way test is applied to the `filterGroups` argument of scene queries,
// so query masks use memberships 0xffff to pass the collider-side check.
// ---------------------------------------------------------------------------
export const Group = {
  BOAT: 1 << 0, // alive, unprotected hull
  WALL: 1 << 1, // buildings, border, moored gondolas, pile clusters
  POLE: 1 << 2, // mooring poles (thin: projectiles ignore them)
  CRATE: 1 << 3,
  MINE_BODY: 1 << 4, // small solid part of a mine (walls and crates only)
  MINE_TRIG: 1 << 5, // mine sensor (boats only)
  SINKING: 1 << 6, // sinking boat: collides with nothing
  PROTECTED: 1 << 7, // spawn-protected hull: like BOAT, but mines ignore it
} as const;

export function groupMask(memberships: number, filter: number): number {
  return ((memberships & 0xffff) << 16) | (filter & 0xffff);
}

const SOLIDS = Group.BOAT | Group.PROTECTED | Group.CRATE | Group.MINE_BODY;

export const Masks = {
  boat: groupMask(Group.BOAT, Group.WALL | Group.POLE | Group.BOAT | Group.PROTECTED | Group.CRATE | Group.MINE_TRIG),
  boatProtected: groupMask(Group.PROTECTED, Group.WALL | Group.POLE | Group.BOAT | Group.PROTECTED | Group.CRATE),
  boatSinking: groupMask(Group.SINKING, 0),
  wall: groupMask(Group.WALL, SOLIDS),
  pole: groupMask(Group.POLE, SOLIDS),
  crate: groupMask(Group.CRATE, Group.WALL | Group.POLE | SOLIDS),
  mineBody: groupMask(Group.MINE_BODY, Group.WALL | Group.POLE | Group.CRATE | Group.MINE_BODY),
  mineTrigger: groupMask(Group.MINE_TRIG, Group.BOAT),
  /** Scene-query masks (membership 0xffff so every collider's filter accepts the query). */
  queryWalls: groupMask(0xffff, Group.WALL),
  queryBoats: groupMask(0xffff, Group.BOAT | Group.PROTECTED),
  queryCrates: groupMask(0xffff, Group.CRATE),
} as const;

// ---------------------------------------------------------------------------
// Entities. Collider handles are opaque f64 numbers (index + generation bits), fine as
// Map keys but NOT array indices. The JS-side lookup (world.getCollider / colliders.get)
// ignores the generation, so a stale handle can alias a newer collider in the same slot:
// unregister on removal, never keep handles of removed objects.
// ---------------------------------------------------------------------------
export type EntityKind = 'boat' | 'wall' | 'pole' | 'crate' | 'mineBody' | 'mineTrigger';

export interface EntityRef {
  kind: EntityKind;
  /** Index into the owning array (boats[], crates[], mines[]); -1 for static scenery. */
  id: number;
}

export type CollisionHandler = (a: EntityRef, b: EntityRef, ca: Collider, cb: Collider, started: boolean) => void;

export interface ContactInfo {
  /** World normal from collider 1 to collider 2. */
  nx: number;
  ny: number;
  /** World impact point. */
  px: number;
  py: number;
}

export class PhysicsWorld {
  readonly world: World;
  readonly events: EventQueue;
  private readonly byCollider = new Map<number, EntityRef>();
  private readonly pendingRemoval: RigidBody[] = [];
  private draining = false;
  // reusable scratch objects (no per-step allocation)
  private readonly ray = new RAPIER.Ray({ x: 0, y: 0 }, { x: 0, y: 0 });
  private readonly tmpN = { x: 0, y: 0 };
  private readonly tmpP = { x: 0, y: 0 };

  constructor(dt: number = PHYSICS.dt) {
    this.world = new RAPIER.World({ x: 0, y: 0 });
    this.world.timestep = dt;
    this.events = new RAPIER.EventQueue(true);
  }

  createBody(desc: RigidBodyDesc): RigidBody {
    return this.world.createRigidBody(desc);
  }

  createCollider(desc: ColliderDesc, body: RigidBody, ref: EntityRef): Collider {
    const collider = this.world.createCollider(desc, body);
    this.byCollider.set(collider.handle, ref);
    return collider;
  }

  lookup(handle: number): EntityRef | undefined {
    return this.byCollider.get(handle);
  }

  /** Forget the colliders now, remove the body after the current drain (safe inside event handlers). */
  removeBody(body: RigidBody): void {
    const n = body.numColliders();
    for (let i = 0; i < n; i++) this.byCollider.delete(body.collider(i).handle);
    if (this.draining) this.pendingRemoval.push(body);
    else this.world.removeRigidBody(body);
  }

  /** One fixed step: integrate, then drain collision events (sensors included) into the handler. */
  step(onCollision?: CollisionHandler): void {
    this.world.step(this.events);
    if (onCollision) {
      this.draining = true;
      this.events.drainCollisionEvents((h1, h2, started) => {
        const a = this.byCollider.get(h1);
        const b = this.byCollider.get(h2);
        if (a === undefined || b === undefined) return; // one side already removed this step
        const ca = this.world.colliders.get(h1);
        const cb = this.world.colliders.get(h2);
        if (ca === null || cb === null) return;
        onCollision(a, b, ca, cb, started);
      });
      this.draining = false;
    }
    for (const body of this.pendingRemoval) this.world.removeRigidBody(body);
    this.pendingRemoval.length = 0;
  }

  /**
   * Scene queries (castRay, intersectionsWithShape, ...) only see a collider after the next
   * world.step() inserts it into the broad phase; propagateModifiedBodyPositionsToColliders()
   * does not. Call this once after building the static world, before any boat exists, so the
   * first projectile of the round cannot fly through a wall.
   */
  commit(): void {
    this.world.step();
  }

  /** Contact normal (c1 -> c2) and first solver contact point of a touching pair. */
  contactInfo(c1: Collider, c2: Collider, out: ContactInfo): boolean {
    let found = false;
    this.world.contactPair(c1, c2, (manifold, flipped) => {
      if (found) return;
      const n = manifold.normal(this.tmpN);
      const sign = flipped ? -1 : 1;
      const p = manifold.solverContactPoint(0, this.tmpP);
      if (p === null) return;
      out.nx = n.x * sign;
      out.ny = n.y * sign;
      out.px = p.x;
      out.py = p.y;
      found = true;
    });
    return found;
  }

  /**
   * Fraction t in [0,1] along segment A->B where a wall blocks it, or -1 if clear.
   * solid=true: a segment starting inside a wall is blocked at t=0.
   */
  wallHitFraction(ax: number, ay: number, bx: number, by: number): number {
    this.ray.origin.x = ax;
    this.ray.origin.y = ay;
    this.ray.dir.x = bx - ax;
    this.ray.dir.y = by - ay;
    const hit = this.world.castRay(this.ray, 1, true, undefined, Masks.queryWalls);
    return hit === null ? -1 : hit.timeOfImpact;
  }

  /** Line of sight between two points, walls only. */
  hasLineOfSight(ax: number, ay: number, bx: number, by: number): boolean {
    return this.wallHitFraction(ax, ay, bx, by) < 0;
  }

  free(): void {
    this.events.free();
    this.world.free();
    this.byCollider.clear();
  }
}
```

Collision-group table (memberships ↔ filters):

| Collider | Members | Collides with |
|---|---|---|
| alive hull | BOAT | WALL, POLE, BOAT, PROTECTED, CRATE, MINE_TRIG |
| protected hull | PROTECTED | WALL, POLE, BOAT, PROTECTED, CRATE (not MINE_TRIG) |
| sinking hull | SINKING | nothing (filter 0: no pairs, no queries) |
| wall / border / moored / piles | WALL | BOAT, PROTECTED, CRATE, MINE_BODY |
| pole | POLE | BOAT, PROTECTED, CRATE, MINE_BODY (rays ignore poles) |
| crate | CRATE | WALL, POLE, BOAT, PROTECTED, CRATE, MINE_BODY |
| mine core | MINE_BODY | WALL, POLE, CRATE, MINE_BODY (boats pass over) |
| mine sensor | MINE_TRIG | BOAT only |
| wall ray query | 0xffff | WALL |

### 3.6 `src/sim/loop.ts` — fixed step, snapshots, interpolation

```ts
// src/sim/loop.ts — fixed 60 Hz stepping with an accumulator, frame clamp and interpolation snapshots.
import { PHYSICS } from '@shared/config';
import { lerpAngle } from './coords';

export interface Transform2 {
  x: number;
  y: number;
  angle: number;
}

export function makeTransform(x = 0, y = 0, angle = 0): Transform2 {
  return { x, y, angle };
}

export function copyTransform(from: Transform2, to: Transform2): void {
  to.x = from.x;
  to.y = from.y;
  to.angle = from.angle;
}

/** out = prev*(1-alpha) + curr*alpha, angle along the shortest arc. The renderer calls this. */
export function lerpTransform(prev: Transform2, curr: Transform2, alpha: number, out: Transform2): Transform2 {
  out.x = prev.x + (curr.x - prev.x) * alpha;
  out.y = prev.y + (curr.y - prev.y) * alpha;
  out.angle = lerpAngle(prev.angle, curr.angle, alpha);
  return out;
}

/**
 * Accumulator loop ("Fix your timestep"). Wall time feeds `advance`; the sim only ever
 * sees `dt`. A frame longer than `maxFrameTime` is clamped, so after a stall the sim
 * runs at most maxFrameTime/dt (= 15) steps and the sim clock falls behind wall time
 * instead of spiralling. All game timers must use `simTime`, never Date.now().
 */
export class FixedStepper {
  private accumulator = 0;
  /** Seconds of simulated time (dt * steps). */
  simTime = 0;
  /** Number of fixed steps run so far. */
  stepCount = 0;
  /** Blend factor for the renderer after the last `advance`: 0 = previous step, 1 = current step. */
  alpha = 0;
  /** Set when the last frame had to be clamped (debug HUD). */
  clamped = false;

  constructor(
    readonly dt: number = PHYSICS.dt,
    readonly maxFrameTime: number = PHYSICS.maxFrameTime,
  ) {}

  /**
   * @param frameSeconds wall-clock seconds since the previous frame
   * @param step runs exactly one fixed step; it must snapshot prev <- curr first
   * @returns the number of steps run this frame
   */
  advance(frameSeconds: number, step: (dt: number) => void): number {
    let ft = frameSeconds;
    if (!(ft >= 0)) ft = 0; // NaN or negative (clock went backwards)
    this.clamped = ft > this.maxFrameTime;
    if (this.clamped) ft = this.maxFrameTime;
    this.accumulator += ft;
    let n = 0;
    while (this.accumulator >= this.dt) {
      step(this.dt);
      this.accumulator -= this.dt;
      this.simTime += this.dt;
      this.stepCount += 1;
      n += 1;
    }
    this.alpha = this.accumulator / this.dt;
    return n;
  }

  reset(): void {
    this.accumulator = 0;
    this.simTime = 0;
    this.stepCount = 0;
    this.alpha = 0;
    this.clamped = false;
  }
}
```

Scene usage: `let last = performance.now(); function frame(now) { sim.advance((now - last) / 1000); last = now; render(sim, sim.stepper.alpha); requestAnimationFrame(frame); }`. The round timer counts `stepper.simTime` (5:00 = 18 000 steps), so a stalled frame never shortens the match.

### 3.7 `src/sim/boat.ts` — the gondola body

```ts
// src/sim/boat.ts — the gondola rigid body: thrust, brake, keel, drift, steering, ram, sink, respawn.
import RAPIER, { type Collider, type RigidBody } from '@dimforge/rapier2d-compat';
import { PHYSICS } from '@shared/config';
import { forwardSim, rightSim, type Vec2 } from './coords';
import type { Obb } from './geom';
import { Masks, type ContactInfo, type PhysicsWorld } from './physics';
import { copyTransform, makeTransform, type Transform2 } from './loop';

/** Mirrors PilotIn from shared/protocol.ts. */
export interface BoatInput {
  /** -1 (full left) .. 1 (full right) */
  steer: number;
  gas: boolean;
  brake: boolean;
}

export type BoatPhase = 'alive' | 'sinking' | 'dead';

export interface Boat {
  readonly id: number;
  readonly team: number;
  readonly body: RigidBody;
  readonly collider: Collider;
  phase: BoatPhase;
  /** Seconds spent in the current phase. */
  phaseT: number;
  boosted: boolean;
  /** Remaining spawn protection, seconds (0 = none). */
  protectedT: number;
  /** Hull water 0..100. */
  water: number;
  drifting: boolean;
  /** Forward speed (m/s, negative when reversing) read at the last control update. */
  speed: number;
  /** Linear velocity captured right before the last world.step (ram detection). */
  readonly prevVel: Vec2;
  /** Interpolation snapshots for the renderer. */
  readonly prev: Transform2;
  readonly curr: Transform2;
}

export interface RamResult {
  rammer: Boat;
  target: Boat;
  px: number;
  py: number;
  /** Unit normal from rammer to target. */
  nx: number;
  ny: number;
}

const B = PHYSICS.boat;
export const BOAT_HALF_WIDTH = B.width / 2;
export const BOAT_HALF_LENGTH = B.length / 2;
const CORNER = 0.15;

/** Thrust whose terminal velocity under Rapier damping is `topSpeed`: v_inf = F / (m * d). */
export function thrustFor(topSpeed: number): number {
  return B.mass * B.linearDamping * topSpeed;
}

// scratch (module-level, never allocated per step)
const tmpF: Vec2 = { x: 0, y: 0 };
const tmpR: Vec2 = { x: 0, y: 0 };
const tmpV: Vec2 = { x: 0, y: 0 };
const tmpW: Vec2 = { x: 0, y: 0 };
const tmpContact: ContactInfo = { nx: 0, ny: 0, px: 0, py: 0 };

export function createBoat(phys: PhysicsWorld, id: number, team: number, x: number, y: number, angle: number): Boat {
  const body = phys.createBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, y)
      .setRotation(angle)
      .setLinearDamping(B.linearDamping)
      .setAngularDamping(B.angularDamping)
      .setCanSleep(false),
  );
  // roundCuboid(hx, hy, r) has effective half extents (hx + r, hy + r): 0.7 x 3.0.
  // Rounded corners slide over seams between merged wall rectangles instead of catching.
  const collider = phys.createCollider(
    RAPIER.ColliderDesc.roundCuboid(BOAT_HALF_WIDTH - CORNER, BOAT_HALF_LENGTH - CORNER, CORNER)
      .setMass(B.mass)
      .setFriction(B.friction)
      .setRestitution(B.restitution)
      .setCollisionGroups(Masks.boat)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
    body,
    { kind: 'boat', id },
  );
  return {
    id,
    team,
    body,
    collider,
    phase: 'alive',
    phaseT: 0,
    boosted: false,
    protectedT: 0,
    water: 0,
    drifting: false,
    speed: 0,
    prevVel: { x: 0, y: 0 },
    prev: makeTransform(x, y, angle),
    curr: makeTransform(x, y, angle),
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Per-step control. Call before world.step. Forces are rebuilt every step
 * (Rapier keeps added forces until resetForces).
 */
export function applyBoatControls(boat: Boat, input: BoatInput, dt: number): void {
  if (boat.phase !== 'alive') return;
  const body = boat.body;
  body.resetForces(false);
  body.resetTorques(false);

  const a = body.rotation();
  const f = forwardSim(a, tmpF);
  const r = rightSim(a, tmpR);
  const v = body.linvel(tmpV);
  const vf = v.x * f.x + v.y * f.y; // forward speed
  const vr = v.x * r.x + v.y * r.y; // lateral (starboard) speed
  boat.speed = vf;

  const hullMul = 1 - B.hullWaterSlowdown * clamp(boat.water, 0, 100) / 100;
  const thrustMax = thrustFor(B.topSpeed) * hullMul * (boat.boosted ? B.boostMul : 1);
  // Network input: a NaN steer would poison the body state for good, so sanitise here.
  const steer = Number.isFinite(input.steer) ? clamp(input.steer, -1, 1) : 0;

  // Drift: BRAKE while steering at speed. No thrust, little grip, extra drag, sharper torque.
  const drifting = input.brake && Math.abs(steer) >= B.driftMinSteer && vf >= B.driftMinSpeed;
  boat.drifting = drifting;

  let fwdForce = 0;
  if (drifting) {
    fwdForce = -B.driftDrag * B.mass * vf;
  } else if (input.gas && !input.brake) {
    fwdForce = thrustMax;
  } else if (input.brake) {
    // brake while moving forward, else reverse at 40 %
    fwdForce = vf > 0.5 ? -B.brakeForce : input.gas ? 0 : -B.reverseMul * thrustMax;
  }
  if (fwdForce !== 0) {
    tmpW.x = f.x * fwdForce;
    tmpW.y = f.y * fwdForce;
    body.addForce(tmpW, true);
  }

  // Keel: exponential decay of the lateral component, exact and frame-rate independent.
  const grip = drifting ? B.driftGrip : B.keelGrip;
  const vr2 = vr * Math.exp(-grip * dt);
  if (vr2 !== vr) {
    tmpW.x = f.x * vf + r.x * vr2;
    tmpW.y = f.y * vf + r.y * vr2;
    body.setLinvel(tmpW, true);
  }

  // Steering: torque sized for a steady-state turn rate, omega_ss = torque / (I * angularDamping).
  if (steer !== 0) {
    const speedFactor = clamp(Math.abs(vf) / B.topSpeed, 0, 1);
    const rate = B.turnRateRest + (B.turnRateFull - B.turnRateRest) * speedFactor;
    const torque = -steer * rate * body.principalInertia() * B.angularDamping * (drifting ? B.driftTurnMul : 1);
    body.addTorque(torque, true);
  }
  const w = body.angvel();
  if (Math.abs(w) > B.maxAngvel) body.setAngvel(Math.sign(w) * B.maxAngvel, true);
}

/** Call right before world.step: the velocity the boat carries into the step. */
export function cacheVelocity(boat: Boat): void {
  boat.body.linvel(boat.prevVel);
}

/** Call before each step: curr becomes prev. */
export function snapshotBoat(boat: Boat): void {
  copyTransform(boat.curr, boat.prev);
}

/** Call after each step: read the body into curr. */
export function readBoatTransform(boat: Boat): void {
  const p = boat.body.translation(tmpV);
  boat.curr.x = p.x;
  boat.curr.y = p.y;
  boat.curr.angle = boat.body.rotation();
}

/** The boat as an oriented box for projectile tests. */
export function boatObb(boat: Boat, out: Obb): Obb {
  out.x = boat.curr.x;
  out.y = boat.curr.y;
  out.angle = boat.curr.angle;
  out.hw = BOAT_HALF_WIDTH;
  out.hl = BOAT_HALF_LENGTH;
  return out;
}

/**
 * Lethal hit: the hull stops colliding, keeps drifting for `sinkTime`, and gets an impulse at the
 * impact point so it spins in 2D. The 3D flip (pitch/roll/submerge) is render-only from phase + phaseT.
 */
export function sinkBoat(boat: Boat, px: number, py: number, dx: number, dy: number): void {
  if (boat.phase !== 'alive') return;
  boat.phase = 'sinking';
  boat.phaseT = 0;
  boat.boosted = false;
  boat.drifting = false;
  boat.protectedT = 0;
  boat.collider.setCollisionGroups(Masks.boatSinking);
  boat.body.resetForces(false);
  boat.body.resetTorques(false);
  tmpW.x = dx * B.sinkImpulse;
  tmpW.y = dy * B.sinkImpulse;
  tmpV.x = px;
  tmpV.y = py;
  boat.body.applyImpulseAtPoint(tmpW, tmpV, true);
}

/** Phase timers. Sinking -> dead (body disabled) after sinkTime; protection counts down. */
export function updateBoatPhase(boat: Boat, dt: number): void {
  boat.phaseT += dt;
  if (boat.phase === 'sinking' && boat.phaseT >= B.sinkTime) {
    boat.phase = 'dead';
    boat.phaseT = 0;
    boat.body.setLinvel(zero(), false);
    boat.body.setAngvel(0, false);
    boat.body.setEnabled(false);
  } else if (boat.phase === 'alive' && boat.protectedT > 0) {
    boat.protectedT -= dt;
    if (boat.protectedT <= 0) setProtected(boat, false);
  }
}

const ZERO: Vec2 = { x: 0, y: 0 };
function zero(): Vec2 {
  ZERO.x = 0;
  ZERO.y = 0;
  return ZERO;
}

/** Teleport to a dock, wipe state, start spawn protection. Snapshots are reset so nothing interpolates across the jump. */
export function respawnBoat(boat: Boat, x: number, y: number, angle: number): void {
  const body = boat.body;
  body.setEnabled(true);
  tmpV.x = x;
  tmpV.y = y;
  body.setTranslation(tmpV, true);
  body.setRotation(angle, true);
  body.setLinvel(zero(), true);
  body.setAngvel(0, true);
  body.resetForces(true);
  body.resetTorques(true);
  boat.phase = 'alive';
  boat.phaseT = 0;
  boat.water = 0;
  boat.boosted = false;
  boat.drifting = false;
  boat.speed = 0;
  boat.prevVel.x = 0;
  boat.prevVel.y = 0;
  boat.curr.x = x;
  boat.curr.y = y;
  boat.curr.angle = angle;
  copyTransform(boat.curr, boat.prev);
  setProtected(boat, true);
}

/** Spawn protection on/off (also called early when the Gunner fires). Mines ignore protected hulls. */
export function setProtected(boat: Boat, on: boolean): void {
  boat.protectedT = on ? B.spawnProtection : 0;
  boat.collider.setCollisionGroups(on ? Masks.boatProtected : Masks.boat);
}

/**
 * Called on a boat-boat collision *started* event. Uses the velocities cached before the step
 * (post-step velocities are already resolved by the solver) and the manifold normal.
 */
export function detectRam(phys: PhysicsWorld, a: Boat, b: Boat, ca: Collider, cb: Collider, out: RamResult): boolean {
  if (a.team === b.team) return false;
  if (a.phase !== 'alive' || b.phase !== 'alive') return false;
  if (!phys.contactInfo(ca, cb, tmpContact)) {
    // no manifold yet: fall back to centre-to-centre
    const dx = b.curr.x - a.curr.x;
    const dy = b.curr.y - a.curr.y;
    const len = Math.hypot(dx, dy) || 1;
    tmpContact.nx = dx / len;
    tmpContact.ny = dy / len;
    tmpContact.px = (a.curr.x + b.curr.x) / 2;
    tmpContact.py = (a.curr.y + b.curr.y) / 2;
  }
  const nx = tmpContact.nx;
  const ny = tmpContact.ny;
  // closing speed of a toward b along the normal (same number seen from b)
  const closing = (a.prevVel.x - b.prevVel.x) * nx + (a.prevVel.y - b.prevVel.y) * ny;
  if (closing < B.ramMinSpeed) return false;
  const fa = forwardSim(a.curr.angle, tmpF);
  const aBow = fa.x * nx + fa.y * ny;
  const fb = forwardSim(b.curr.angle, tmpR);
  const bBow = -(fb.x * nx + fb.y * ny);
  const aRams = a.boosted && aBow >= B.ramBowCos;
  const bRams = b.boosted && bBow >= B.ramBowCos;
  if (aRams === bRams) return false; // neither, or both boosted: they just bounce
  out.rammer = aRams ? a : b;
  out.target = aRams ? b : a;
  out.px = tmpContact.px;
  out.py = tmpContact.py;
  out.nx = aRams ? nx : -nx;
  out.ny = aRams ? ny : -ny;
  return true;
}
```

### 3.8 `src/sim/walls.ts` — static scenery from the ASCII map

```ts
// src/sim/walls.ts — static scenery from the ASCII map: merged building rectangles, border, poles, moored boats, piles.
import RAPIER, { type RigidBody } from '@dimforge/rapier2d-compat';
import { PHYSICS } from '@shared/config';
import { cellToSim, type Vec2 } from './coords';
import { Masks, type PhysicsWorld } from './physics';

/** Anything that can answer "is this cell solid for boats". shared/map.ts provides it. */
export interface GridLike {
  cols: number;
  rows: number;
  isSolid(col: number, row: number): boolean;
}

/** Legend: B building and T tower are solid; ~ water, L lagoon, S dock, C crate point, = bridge (water for physics). */
export function isSolidChar(ch: string): boolean {
  return ch === 'B' || ch === 'T';
}

export function gridFromRows(rows: readonly string[]): GridLike {
  const cols = rows.reduce((m, r) => Math.max(m, r.length), 0);
  return {
    cols,
    rows: rows.length,
    isSolid(col, row) {
      const line = rows[row];
      if (line === undefined) return false;
      const ch = line[col];
      return ch === undefined ? false : isSolidChar(ch);
    },
  };
}

export interface CellRect {
  col: number;
  row: number;
  w: number;
  h: number;
}

/**
 * Greedy rectangle merging: scan row-major; grow a run to the right, then grow it downward
 * while every cell of the next row under the run is solid and unvisited. O(cells), typically
 * turns ~1000 building cells into a few dozen cuboids.
 */
export function mergeSolidCells(grid: GridLike): CellRect[] {
  const { cols, rows } = grid;
  const visited = new Uint8Array(cols * rows);
  const out: CellRect[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (visited[r * cols + c] === 1 || !grid.isSolid(c, r)) continue;
      let w = 1;
      while (c + w < cols && grid.isSolid(c + w, r) && visited[r * cols + c + w] === 0) w++;
      let h = 1;
      grow: while (r + h < rows) {
        for (let k = 0; k < w; k++) {
          if (!grid.isSolid(c + k, r + h) || visited[(r + h) * cols + c + k] === 1) break grow;
        }
        h++;
      }
      for (let rr = r; rr < r + h; rr++) for (let cc = c; cc < c + w; cc++) visited[rr * cols + cc] = 1;
      out.push({ col: c, row: r, w, h });
    }
  }
  return out;
}

export interface MooredBoat {
  x: number;
  y: number;
  angle: number;
}

/** Positions in sim coordinates; shared/map.ts derives them from the grid so art and physics agree. */
export interface StaticProps {
  poles: readonly Vec2[];
  moored: readonly MooredBoat[];
  piles: readonly Vec2[];
}

export const POLE_RADIUS = 0.25;
export const PILE_RADIUS = 0.35;
const WALL_RESTITUTION = 0.4;
const WALL_FRICTION = 0;

export interface StaticWorld {
  body: RigidBody;
  rects: CellRect[];
  colliderCount: number;
}

/** One fixed body carries every static collider; collider translations are world positions. */
export function buildStaticWorld(
  phys: PhysicsWorld,
  grid: GridLike,
  props: StaticProps,
  cell: number = PHYSICS.cellSize,
): StaticWorld {
  const body = phys.createBody(RAPIER.RigidBodyDesc.fixed());
  const wallRef = { kind: 'wall', id: -1 } as const;
  const poleRef = { kind: 'pole', id: -1 } as const;
  const centre: Vec2 = { x: 0, y: 0 };
  let count = 0;

  const rects = mergeSolidCells(grid);
  for (const rc of rects) {
    cellToSim(rc.col + rc.w / 2 - 0.5, rc.row + rc.h / 2 - 0.5, grid.cols, grid.rows, cell, centre);
    phys.createCollider(
      RAPIER.ColliderDesc.cuboid((rc.w * cell) / 2, (rc.h * cell) / 2)
        .setTranslation(centre.x, centre.y)
        .setFriction(WALL_FRICTION)
        .setRestitution(WALL_RESTITUTION)
        .setCollisionGroups(Masks.wall),
      body,
      wallRef,
    );
    count++;
  }

  // Border: four slabs one cell thick hugging the outside of the grid.
  const hx = (grid.cols * cell) / 2;
  const hy = (grid.rows * cell) / 2;
  const t = cell / 2;
  const border: readonly [number, number, number, number][] = [
    [-hx - t, 0, t, hy + cell], // west
    [hx + t, 0, t, hy + cell], // east
    [0, hy + t, hx + cell, t], // north (sim +y = world -z)
    [0, -hy - t, hx + cell, t], // south
  ];
  for (const [x, y, ex, ey] of border) {
    phys.createCollider(
      RAPIER.ColliderDesc.cuboid(ex, ey)
        .setTranslation(x, y)
        .setFriction(WALL_FRICTION)
        .setRestitution(WALL_RESTITUTION)
        .setCollisionGroups(Masks.wall),
      body,
      wallRef,
    );
    count++;
  }

  for (const p of props.poles) {
    phys.createCollider(
      RAPIER.ColliderDesc.ball(POLE_RADIUS).setTranslation(p.x, p.y).setRestitution(0.5).setCollisionGroups(Masks.pole),
      body,
      poleRef,
    );
    count++;
  }
  for (const m of props.moored) {
    phys.createCollider(
      RAPIER.ColliderDesc.cuboid(PHYSICS.boat.width / 2, PHYSICS.boat.length / 2)
        .setTranslation(m.x, m.y)
        .setRotation(m.angle)
        .setRestitution(WALL_RESTITUTION)
        .setCollisionGroups(Masks.wall),
      body,
      wallRef,
    );
    count++;
  }
  // A pile cluster: three posts in a tight triangle (one collider each; they block shots like a wall).
  for (const p of props.piles) {
    for (let k = 0; k < 3; k++) {
      const ang = (k * 2 * Math.PI) / 3;
      phys.createCollider(
        RAPIER.ColliderDesc.ball(PILE_RADIUS)
          .setTranslation(p.x + Math.cos(ang) * 0.6, p.y + Math.sin(ang) * 0.6)
          .setRestitution(0.5)
          .setCollisionGroups(Masks.wall),
        body,
        wallRef,
      );
      count++;
    }
  }
  phys.commit(); // make the walls visible to ray queries before the first projectile
  return { body, rects, colliderCount: count };
}
```

`StaticProps` (pole, moored and pile positions) must be produced by `shared/map.ts` from the grid with a deterministic rule (for example a pole at 1/4 and 3/4 of every water-cell edge that touches a building, thinned with a seeded hash) so the renderer places exactly the same props.

### 3.9 `src/sim/items.ts` — crates and mines

```ts
// src/sim/items.ts — crates (light solid bodies, collected on first touch) and mines (drifting sensor + solid core).
import RAPIER, { type Collider, type RigidBody } from '@dimforge/rapier2d-compat';
import { PHYSICS } from '@shared/config';
import { forwardSim, type Vec2 } from './coords';
import { Masks, type PhysicsWorld } from './physics';
import { copyTransform, makeTransform, type Transform2 } from './loop';

export type CrateCategory = 'weapon' | 'power';

export interface Crate {
  readonly id: number;
  readonly category: CrateCategory;
  readonly body: RigidBody;
  readonly collider: Collider;
  /** Fixed spawn point (sim coords). */
  readonly homeX: number;
  readonly homeY: number;
  active: boolean;
  respawnT: number;
  readonly prev: Transform2;
  readonly curr: Transform2;
}

const C = PHYSICS.crate;
const M = PHYSICS.mine;
const tmpV: Vec2 = { x: 0, y: 0 };
const tmpF: Vec2 = { x: 0, y: 0 };

export function createCrate(phys: PhysicsWorld, id: number, category: CrateCategory, x: number, y: number): Crate {
  const body = phys.createBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, y)
      .setLinearDamping(C.linearDamping)
      .setAngularDamping(C.angularDamping)
      .setCanSleep(true),
  );
  const collider = phys.createCollider(
    RAPIER.ColliderDesc.ball(C.radius)
      .setMass(C.mass)
      .setRestitution(0.5)
      .setCollisionGroups(Masks.crate)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
    body,
    { kind: 'crate', id },
  );
  return {
    id,
    category,
    body,
    collider,
    homeX: x,
    homeY: y,
    active: true,
    respawnT: 0,
    prev: makeTransform(x, y, 0),
    curr: makeTransform(x, y, 0),
  };
}

/** Rules decided the boat takes it: hide the body, respawn in 8 s at the home point. */
export function collectCrate(crate: Crate): void {
  if (!crate.active) return;
  crate.active = false;
  crate.respawnT = C.respawn;
  crate.body.setEnabled(false);
}

export function updateCrates(crates: Iterable<Crate>, dt: number): void {
  for (const crate of crates) {
    if (crate.active) {
      copyTransform(crate.curr, crate.prev);
      const p = crate.body.translation(tmpV);
      crate.curr.x = p.x;
      crate.curr.y = p.y;
      crate.curr.angle = crate.body.rotation();
      continue;
    }
    crate.respawnT -= dt;
    if (crate.respawnT <= 0) {
      tmpV.x = crate.homeX;
      tmpV.y = crate.homeY;
      crate.body.setTranslation(tmpV, true);
      tmpV.x = 0;
      tmpV.y = 0;
      crate.body.setLinvel(tmpV, true);
      crate.body.setAngvel(0, true);
      crate.body.setEnabled(true);
      crate.active = true;
      crate.curr.x = crate.homeX;
      crate.curr.y = crate.homeY;
      crate.curr.angle = 0;
      copyTransform(crate.curr, crate.prev);
    }
  }
}

export interface Mine {
  readonly id: number;
  readonly ownerTeam: number;
  readonly body: RigidBody;
  readonly solid: Collider;
  readonly trigger: Collider;
  /** Seconds until armed (<= 0 when armed). */
  armT: number;
  /** Seconds until it disappears. */
  lifeT: number;
  /** Set once exploded or expired; the body is already scheduled for removal. */
  gone: boolean;
  readonly prev: Transform2;
  readonly curr: Transform2;
}

/** Drop behind the boat with half its velocity. Two colliders: a solid core (walls/crates) and a boat-only sensor. */
export function dropMine(
  phys: PhysicsWorld,
  id: number,
  ownerTeam: number,
  boatX: number,
  boatY: number,
  boatAngle: number,
  boatVx: number,
  boatVy: number,
): Mine {
  const f = forwardSim(boatAngle, tmpF);
  const x = boatX - f.x * M.dropBehind;
  const y = boatY - f.y * M.dropBehind;
  const body = phys.createBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, y)
      .setLinvel(boatVx * M.dropSpeedMul, boatVy * M.dropSpeedMul)
      .setLinearDamping(M.linearDamping)
      .setAngularDamping(M.angularDamping)
      .setCanSleep(true),
  );
  const solid = phys.createCollider(
    RAPIER.ColliderDesc.ball(M.solidRadius).setMass(M.mass).setCollisionGroups(Masks.mineBody),
    body,
    { kind: 'mineBody', id },
  );
  // density 0: a sensor would otherwise add mass to the body
  const trigger = phys.createCollider(
    RAPIER.ColliderDesc.ball(M.triggerRadius)
      .setSensor(true)
      .setDensity(0)
      .setCollisionGroups(Masks.mineTrigger)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
    body,
    { kind: 'mineTrigger', id },
  );
  return {
    id,
    ownerTeam,
    body,
    solid,
    trigger,
    armT: M.armDelay,
    lifeT: M.lifetime,
    gone: false,
    prev: makeTransform(x, y, 0),
    curr: makeTransform(x, y, 0),
  };
}

export function isMineArmed(mine: Mine): boolean {
  return !mine.gone && mine.armT <= 0;
}

/** From the collision handler: an alive, unprotected hull entered the trigger. */
export function mineShouldExplode(mine: Mine, boatTeam: number): boolean {
  return isMineArmed(mine) && boatTeam !== mine.ownerTeam;
}

export function removeMine(phys: PhysicsWorld, mine: Mine): void {
  if (mine.gone) return;
  mine.gone = true;
  phys.removeBody(mine.body);
}

/**
 * Timers, snapshots, and the arming poll: a hull already sitting inside the sensor when the
 * mine arms produces no new "started" event, so we ask the intersection graph once at that moment.
 * `teamOf` maps a boat id to its team; returns -1 for boats that cannot be hit.
 */
export function updateMines(
  phys: PhysicsWorld,
  mines: Iterable<Mine>,
  dt: number,
  teamOf: (boatId: number) => number,
  onExplode: (mine: Mine, boatId: number) => void,
): void {
  for (const mine of mines) {
    if (mine.gone) continue;
    copyTransform(mine.curr, mine.prev);
    const p = mine.body.translation(tmpV);
    mine.curr.x = p.x;
    mine.curr.y = p.y;
    mine.curr.angle = mine.body.rotation();

    mine.lifeT -= dt;
    if (mine.lifeT <= 0) {
      removeMine(phys, mine);
      continue;
    }
    if (mine.armT > 0) {
      mine.armT -= dt;
      if (mine.armT <= 0) {
        let victim = -1;
        phys.world.intersectionPairsWith(mine.trigger, (other) => {
          if (victim >= 0) return;
          const ref = phys.lookup(other.handle);
          if (ref === undefined || ref.kind !== 'boat') return;
          const team = teamOf(ref.id);
          if (team >= 0 && team !== mine.ownerTeam) victim = ref.id;
        });
        if (victim >= 0) onExplode(mine, victim);
      }
    }
  }
}
```

### 3.10 `src/sim/projectiles.ts` — cannonball, torpedo, mortar, water cannon

```ts
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
```

### 3.11 `src/sim/sim.ts` — order of operations for one step

```ts
// src/sim/sim.ts — order of operations for one fixed step. Rules (kills, score, inventory,
// respawn docks) plug in through `SimRules`; this file only wires the physics pieces together.
import { PHYSICS } from '@shared/config';
import { forwardSim, type Vec2 } from './coords';
import { FixedStepper } from './loop';
import type { Collider } from '@dimforge/rapier2d-compat';
import { PhysicsWorld, type EntityRef } from './physics';
import {
  applyBoatControls,
  boatObb,
  cacheVelocity,
  createBoat,
  detectRam,
  readBoatTransform,
  sinkBoat,
  snapshotBoat,
  updateBoatPhase,
  type Boat,
  type BoatInput,
  type RamResult,
} from './boat';
import { collectCrate, dropMine, mineShouldExplode, removeMine, updateCrates, updateMines, type Crate, type Mine } from './items';
import { applyWaterCannon, Projectiles, type Hit, type Target } from './projectiles';
import { buildStaticWorld, type GridLike, type StaticProps } from './walls';

/** What the rules layer decides; the sim only reports. */
export interface SimRules {
  /** A projectile hit an alive enemy hull. Return true to sink it (no shield / protection). */
  onProjectileHit(hit: Hit): boolean;
  /** A boosted ram. Return true to sink the target. */
  onRam(ram: RamResult): boolean;
  /** A hull touched a crate. Return true to take it (slot free). */
  onCrateTouched(boat: Boat, crate: Crate): boolean;
  /** An armed enemy mine was triggered by this hull. Return true to sink it. */
  onMineTriggered(boat: Boat, mine: Mine): boolean;
  onSplash(kind: 'cannon' | 'torpedo' | 'mortar', x: number, y: number, surface: 'wall' | 'water'): void;
}

const IDLE: BoatInput = { steer: 0, gas: false, brake: false };
const tmpF: Vec2 = { x: 0, y: 0 };
const ramScratch: RamResult = { rammer: undefined as unknown as Boat, target: undefined as unknown as Boat, px: 0, py: 0, nx: 0, ny: 0 };

export class Sim {
  readonly phys = new PhysicsWorld(PHYSICS.dt);
  readonly stepper = new FixedStepper(PHYSICS.dt, PHYSICS.maxFrameTime);
  readonly boats: Boat[] = [];
  readonly crates: Crate[] = [];
  readonly mines = new Map<number, Mine>();
  readonly projectiles = new Projectiles();
  private readonly inputs: BoatInput[] = [];
  private readonly targets: Target[] = [];
  /** Water cannon streams held this step: boat id -> aim angle (sim). */
  private readonly streams = new Map<number, number>();
  private nextMineId = 0;

  constructor(private readonly rules: SimRules) {}

  buildWorld(grid: GridLike, props: StaticProps): void {
    buildStaticWorld(this.phys, grid, props);
  }

  addBoat(team: number, x: number, y: number, angle: number): Boat {
    const id = this.boats.length;
    const boat = createBoat(this.phys, id, team, x, y, angle);
    this.boats.push(boat);
    this.inputs.push({ steer: 0, gas: false, brake: false });
    this.targets.push({ id, team, hittable: true, box: { x, y, angle, hw: 0, hl: 0 } });
    return boat;
  }

  setPilotInput(boatId: number, input: BoatInput): void {
    const slot = this.inputs[boatId];
    if (slot === undefined) return;
    slot.steer = input.steer;
    slot.gas = input.gas;
    slot.brake = input.brake;
  }

  /** Gunner holds FIRE with the water cannon: aim is a world angle (sim convention). */
  holdWaterCannon(boatId: number, aim: number): void {
    this.streams.set(boatId, aim);
  }

  fire(kind: 'cannon' | 'torpedo' | 'mortar', boat: Boat, aim: number): void {
    const { x, y } = boat.curr; // the centre is never inside a wall; the muzzle flash is render-only
    if (kind === 'cannon') this.projectiles.fireCannon(x, y, aim, boat.team, boat.id, this.targets, this.phys);
    else if (kind === 'torpedo') this.projectiles.fireTorpedo(x, y, aim, boat.team, boat.id, this.targets, this.phys);
    else this.projectiles.fireMortar(x, y, aim, boat.team, boat.id, this.targets, this.phys);
  }

  dropMine(boat: Boat): Mine {
    const v = boat.body.linvel();
    const mine = dropMine(this.phys, this.nextMineId++, boat.team, boat.curr.x, boat.curr.y, boat.curr.angle, v.x, v.y);
    this.mines.set(mine.id, mine);
    return mine;
  }

  /** Wall-clock frame -> zero or more fixed steps. The renderer then reads prev/curr with stepper.alpha. */
  advance(frameSeconds: number): void {
    this.stepper.advance(frameSeconds, (dt) => this.step(dt));
  }

  step(dt: number): void {
    // 1. snapshots + controls + cached velocities
    for (const boat of this.boats) {
      snapshotBoat(boat);
      applyBoatControls(boat, this.inputs[boat.id] ?? IDLE, dt);
    }
    // 2. water cannon pushes (forces must be added before the step)
    for (const [boatId, aim] of this.streams) {
      const shooter = this.boats[boatId];
      if (shooter === undefined || shooter.phase !== 'alive') continue;
      applyWaterCannon(this.phys, shooter.curr.x, shooter.curr.y, aim, shooter.team, this.targets, dt, (id, fx, fy, water) => {
        const victim = this.boats[id];
        if (victim === undefined) return;
        tmpF.x = fx;
        tmpF.y = fy;
        victim.body.addForce(tmpF, true);
        victim.water = Math.min(100, victim.water + water);
      });
    }
    this.streams.clear();
    for (const boat of this.boats) cacheVelocity(boat);

    // 3. physics step + contact events
    this.phys.step((a, b, ca, cb, started) => this.onCollision(a, b, ca, cb, started));

    // 4. read back, timers
    for (const boat of this.boats) {
      readBoatTransform(boat);
      updateBoatPhase(boat, dt);
      const t = this.targets[boat.id];
      if (t !== undefined) {
        boatObb(boat, t.box);
        t.hittable = boat.phase === 'alive';
      }
    }
    updateCrates(this.crates, dt);
    updateMines(
      this.phys,
      this.mines.values(),
      dt,
      (id) => {
        const b = this.boats[id];
        return b !== undefined && b.phase === 'alive' && b.protectedT <= 0 ? b.team : -1;
      },
      (mine, boatId) => this.explodeMine(mine, boatId),
    );

    // 5. custom projectiles (after the step, against the fresh hull poses)
    this.projectiles.step(
      dt,
      this.phys,
      this.targets,
      (hit) => {
        const victim = this.boats[hit.targetId];
        if (victim !== undefined && this.rules.onProjectileHit(hit)) this.sink(victim, hit.px, hit.py, hit.dx, hit.dy);
      },
      (kind, x, y, surface) => this.rules.onSplash(kind, x, y, surface),
    );
  }

  private onCollision(a: EntityRef, b: EntityRef, ca: Collider, cb: Collider, started: boolean): void {
    if (!started) return;
    if (a.kind === 'boat' && b.kind === 'boat') {
      const ba = this.boats[a.id];
      const bb = this.boats[b.id];
      if (ba === undefined || bb === undefined) return;
      if (detectRam(this.phys, ba, bb, ca, cb, ramScratch) && this.rules.onRam(ramScratch)) {
        this.sink(ramScratch.target, ramScratch.px, ramScratch.py, ramScratch.nx, ramScratch.ny);
      }
      return;
    }
    const boatRef = a.kind === 'boat' ? a : b.kind === 'boat' ? b : null;
    const other = a.kind === 'boat' ? b : a;
    if (boatRef === null) return;
    const boat = this.boats[boatRef.id];
    if (boat === undefined || boat.phase !== 'alive') return;
    if (other.kind === 'crate') {
      const crate = this.crates[other.id];
      if (crate !== undefined && crate.active && this.rules.onCrateTouched(boat, crate)) collectCrate(crate);
    } else if (other.kind === 'mineTrigger') {
      const mine = this.mines.get(other.id);
      if (mine !== undefined && mineShouldExplode(mine, boat.team)) this.explodeMine(mine, boat.id);
    }
  }

  private explodeMine(mine: Mine, boatId: number): void {
    const boat = this.boats[boatId];
    removeMine(this.phys, mine);
    this.mines.delete(mine.id);
    if (boat === undefined || !this.rules.onMineTriggered(boat, mine)) return;
    const f = forwardSim(boat.curr.angle, tmpF);
    this.sink(boat, mine.curr.x, mine.curr.y, -f.x, -f.y);
  }

  private sink(boat: Boat, px: number, py: number, dx: number, dy: number): void {
    sinkBoat(boat, px, py, dx, dy); // no-op unless the hull is still alive (two hits in one step)
  }
}
```

Per step, in this order: snapshot `prev ← curr`, boat controls (forces rebuilt from scratch, keel via `setLinvel`), water-cannon pushes (`addForce`), cache pre-step velocities, `world.step(eventQueue)` and drain collision events (ram, crate, mine), flush deferred removals, read transforms and phase timers, crate/mine timers, then custom projectiles against the fresh hull boxes.

---

## 4. Edge cases and how they are handled

- **E1 Queries do not see new colliders until a step.** `castRay`/`intersectionsWithShape` return nothing for a collider created since the last `world.step()`; `propagateModifiedBodyPositionsToColliders()` only refreshes moved colliders. `buildStaticWorld` ends with `phys.commit()`. Mid-game bodies (crates, mines) are never ray targets, and hull hits use our own OBB test, so nothing else depends on it.
- **E2 Stale handles alias.** The JS-side `Coarena` ignores the generation bits: after `removeRigidBody`, `world.colliders.get(staleHandle)` returns `null` until a new collider reuses the slot, then it returns the *new* collider and `contains()` is true again (measured). `PhysicsWorld.removeBody` deletes the registry entries immediately and defers the actual removal until the event drain is over; code never stores raw handles, only `Boat`/`Crate`/`Mine` objects, and `collider.isValid()` is the safe check for a kept wrapper.
- **E3 Handles are not integers.** Collider/body handles beyond index 0 are denormal-looking f64s (`5e-324` = index 1, generation 0). `Map` keys only; no `handles[]` arrays, no `Number.isInteger` checks.
- **E4 Forces persist.** `addForce` accumulates until `resetForces`; `applyBoatControls` resets forces and torques every step, so a disconnected phone (no input) leaves no ghost thrust.
- **E5 NaN from the network.** A `NaN` steer would poison the body for the rest of the match; `applyBoatControls` sanitises with `Number.isFinite`. Do the same for `dYaw` on the gunner side before it reaches the sim.
- **E6 Teleport vs interpolation.** `respawnBoat` and the crate respawn set `prev = curr` to the new pose; otherwise the renderer would slide the hull across the map for one frame.
- **E7 Two lethal events in one step** (torpedo hit and ram, or two torpedoes): `sinkBoat` is a no-op unless `phase === 'alive'`; rules must credit only the first.
- **E8 Hull already inside a sensor when it arms.** No new "started" event would fire; `updateMines` polls `intersectionPairsWith` once at the arming instant (test: mine dropped under an enemy explodes at t = 1 s).
- **E9 Owner over own mine, protected hull over a mine.** Owner is filtered by team in `mineShouldExplode`; protected hulls are not in the sensor's filter at all, so no event is generated.
- **E10 Mine dropped into a wall.** The solid core is 1 m inside an 8 m slab at worst (4 m behind a hull whose stern touches the wall); the solver pushes it back toward the nearest face, which is the water side.
- **E11 Sensor mass.** Sensors contribute mass unless `setDensity(0)`; the mine sensor has density 0 (measured 10.0 kg total).
- **E12 Projectile origin inside a wall.** Shots start at the hull centre, which is always ≥ 0.7 m from any wall; with `solid = true` a ray starting inside a wall would otherwise return t = 0 and splash on the muzzle.
- **E13 Teammate in the line of fire.** Projectile tests skip `team === shooterTeam`; the water cannon skips teammates too (spec: never hurts your own team).
- **E14 Sinking or dead hulls** are `hittable = false` for projectiles and have no collision pairs (filter 0 / body disabled), so torpedoes lose the lock (`!target.hittable`) and run straight.
- **E15 Torpedo lock behind a wall or behind the torpedo.** Lock needs line of sight at launch; it is dropped when the target is > 90° off the torpedo's heading, out of 1.22 × lock range, or the ray to it is blocked; Smoke calls `breakLocks(targetId)`.
- **E16 Mortar with no enemy in the cone** lands 40 m ahead; splash uses point-to-OBB distance, so a hull edge 5.5 m away is hit and 6.5 m away is not (tested).
- **E17 Ram on a glancing or sideways contact.** The bow test (`dot(forward, normal) ≥ 0.5`) and the 7 m/s closing-speed threshold reject scrapes; the resting target gets the closing speed from the rammer's cached velocity, not from post-solver values.
- **E18 Contact without a manifold.** `contactInfo` can return false on the very first event in exotic cases; `detectRam` falls back to the centre-to-centre normal and midpoint.
- **E19 Spiral of death / tab hidden.** Frame time is clamped to 0.25 s (15 steps); the sim clock then lags wall time by design. `requestAnimationFrame` stops in a hidden tab, so the scene PC must keep the tab visible (it does, it is the projector).
- **E20 Wall seams.** Merged rectangles still meet at edges; the rounded hull corners (0.15 m) and zero wall friction stop hulls from catching. If they still do, switch walls to `polyline` contours with `PolylineFlags.ORIENTED`.
- **E21 Sleeping.** Hulls never sleep (`canSleep(false)`); crates and mines may, and a sleeping crate still produces the "started" event when an awake hull touches it (tested).
- **E22 Hull water and reverse.** The water multiplier scales thrust (forward and reverse); the brake force is unscaled so a flooded boat still stops.
- **E23 Steering while reversing** is not inverted (tunable at the playtest).
- **E24 Map border.** Four slabs outside the grid stop boats leaving even where the lagoon reaches the edge.
- **E25 Performance.** Measured 0.13 ms wall time per step for 6 hulls, 24 crates, 6 mines and 100 wall cuboids (Rapier's own `timingStep` 0.013 ms), 1.2 µs per `castRay`: the whole sim is far below 1 ms per frame.
- **E26 Memory.** `EventQueue(true)` auto-drains; `PhysicsWorld.free()` frees the queue and the world on teardown; for a rematch keep the world and respawn.

---

## 5. How to test on day one

**Without phones (vitest, `npm run test`)**: the six files below run in ~0.6 s in node; `initPhysics()` in `beforeAll` is all a test needs.

- `tests/sim/coords.test.ts`: heading 0 moves along −z; `rotation.y = simAngle` agrees with Three's own quaternion for five yaws; positive angle = CCW; cell (0,0) is the north-west corner.
- `tests/sim/boat.test.ts`: 95 % of 10 m/s within 3 s and 10.0 at 8 s; boost 16; full hull 5; reverse −4; brake to < 0.6 m/s in 1 s; keel decays lateral velocity monotonically to < 0.05 m/s in 1 s; steer +1 gives negative angular velocity, 0.5 rad/s at rest, more at speed, never above the cap; drift slides and bleeds speed; sink → groups SINKING → disabled after 2 s → respawn protected at the dock → BOAT after 3 s.
- `tests/sim/ram.test.ts`: boosted rammer vs resting enemy from behind → one ram with normal (0,1) and an impact point between the hulls; two boosted head-on → no ram, separated after; unboosted → bounce with momentum exchange (the resting boat is pushed > 0.5 m); slow boosted touch → no ram.
- `tests/sim/walls.test.ts`: 3 × 3 block → 1 rect; L shape → 2 rects; the spec's sample map (101 solid cells) is covered exactly once by 8 rectangles; a ray from water into a building hits half-way, the open canal row has line of sight, a ray with the wrong group mask hits nothing, the border stops a ray shot off the map.
- `tests/sim/projectiles.test.ts`: slab test values; cannonball hits an enemy 30 m ahead in 0.45 s and never the teammate sitting in the line of fire; blocked by a wall; 4° assist; splash at max range; torpedo locks at 14° off and hits, no lock at 32°, turn capped, lock dropped behind a wall; mortar targets through a wall and lands at 1.5 s, 5.5 m splash hits and 6.5 m does not, apex 20 m at half flight; water cannon pushes 6 kN and adds 25/s only to enemies in the cone with line of sight.
- `tests/sim/items.test.ts`: crate touch event, disabled, back home after 8 s; mine mass 10 kg, owner-safe, enemy sinks on touch, body removed after the drain; mine under an enemy explodes on arming; mine expires at 45 s.

**Without phones, on screen (keyboard harness in `src/scene`)**: map arrow keys / WASD to `sim.setPilotInput` (steer ±1, gas, brake), B toggles `boat.boosted`, 1/2/3 fire cannon/torpedo/mortar along the camera aim, M drops a mine, K sinks the focused boat (`sinkBoat`) to see the sink/respawn cycle, F1 draws `world.debugRender()` (`DebugRenderBuffers.vertices` = 2 floats per vertex, `colors` = 4 per vertex; 5496 floats for the proof scene) as a `THREE.LineSegments` on the water plane through `simToWorldX/Z`, and F2 prints `world.timingStep()` with `profilerEnabled = true`. Drive into a wall at full speed (should bounce, not stick), hold BRAKE while turning at speed (stern slides out), drive a second keyboard boat into the first with boost on (sinks it) and without (bounces).

**With one phone (Gate 1)**: the only physics-specific check is the sign of steer: tilt left must turn the bow left on the TV. If it does not, the bug is in the phone's gravity-angle sign, not in the sim: the sim's convention is pinned by `coords.test.ts` (steer +1 → negative angular velocity → clockwise from above).

---

## 6. Sources

- Installed typings (primary source for every API name): `node_modules/@dimforge/rapier2d-compat/dist/{pipeline/world,pipeline/event_queue,pipeline/query_pipeline,dynamics/rigid_body,dynamics/integration_parameters,geometry/collider,geometry/interaction_groups,geometry/narrow_phase,geometry/ray,geometry/shape,geometry/broad_phase,coarena,init,math}.d.ts`, package.json (`version 0.21.0`, `module: dist/rapier.mjs`), and the minified `dist/rapier.mjs` (`init` = `gC`, decodes `jg.toByteArray("AGFzbQ...")`).
- Proof scripts (this folder): `proof1.mjs` (init, step, events, castRay, contactPair, teleport, removal), `proof2.mjs` (damping ratio, terminal velocity, keel stability, handles, convex hull, sensor + multi-collider events), `proof3.mjs` (sensor mass, stale handle aliasing), `proof4.mjs` (query visibility before/after a step), `proof5.mjs` (step and ray timings, debugRender), `proof_three.mjs` (Three r186 yaw/forward), `vitecheck/` (vite build + dev server).
- Rapier source, damping formula: https://raw.githubusercontent.com/dimforge/rapier/master/src/dynamics/rigid_body_components.rs (`apply_damping`: `linvel * (1/(1 + dt*linear_damping))`).
- Rapier JS user guide, rigid-body damping: https://rapier.rs/docs/user_guides/javascript/rigid_body_damping
- Rapier JS user guide, rigid bodies (forces persist, resetForces, mass, setTranslation = teleport, sleeping): https://rapier.rs/docs/user_guides/javascript/rigid_bodies
- Rapier JS user guide, colliders (collision groups bit layout and two-way test, sensors, combine rules, density vs mass, several colliders per body): https://rapier.rs/docs/user_guides/javascript/colliders
- Rapier JS user guide, scene queries (castRay, `ray.pointAt(toi)`, filters): https://rapier.rs/docs/user_guides/javascript/scene_queries
- Rapier JS user guide, advanced collision detection (collision events, contact force events and threshold, contact graph, intersection graph): https://rapier.rs/docs/user_guides/javascript/advanced_collision_detection_js
- Rapier JS getting started (compat packages, `await RAPIER.init()`): https://rapier.rs/docs/user_guides/javascript/getting_started_js
- Rapier npm README (compat builds embed the wasm as base64): `node_modules/@dimforge/rapier2d-compat/README.md`
- rapier.js changelog (0.18.0-beta.0 "fully reworked broad-phase that supports scene queries"; 0.9.0 contact force events; 0.8.0 merged collision/intersection events): https://raw.githubusercontent.com/dimforge/rapier.js/master/CHANGELOG.md
- Fixed timestep with accumulator and interpolation: https://gafferongames.com/post/fix_your_timestep/
- Three.js r186 (`Object3D.rotation.y`, `Vector3.applyQuaternion`): `node_modules/three/package.json`, `node_modules/@types/three`.

---

## Appendix: measured numbers (proof scripts)

```
rapier version 0.21.0; default World timestep 0.016666668
one-step damping ratio 0.98360653 = 1/(1+dt*1); angular 0.95238101 = 1/(1+dt*3)
terminal: [t, v] = [1, 6.291], [2, 8.624], [3, 9.49], [5, 9.93], [10, 10.0]  (F=10000, m=1000, d=1)
keel setLinvel: lateral every 0.25 s [0.739, 0.078, 0.008, 0.001, 0, 0]  (from 7 m/s)
keel impulse:   lateral every 0.25 s [0.639, 0.058, 0.005, 0, 0, 0]
setMass(1000) on cuboid(0.7,3): mass 1000, inertia 3163.33; convexHull gondola: inertia 2194.0, 7 verts, ShapeType 9
handles [body, collider]: [0,0],[5e-324,5e-324],[1e-323,1e-323],[1.5e-323,1.5e-323]; after remove+create: 2.1219957915e-314 (bits index 2, generation 1)
colliders.get(stale) after slot reuse -> the NEW collider; contains(stale) true; staleWrapper.isValid() false
mine body: 2 colliders, mass 17.07 with a density-1 sensor, 10.0 with density 0
boat-wall started event: normal (0,1), solverContacts 2, point (0.70, 19.00), pre-step vel (0,12), post-step vel (0,-1.98)
castRay right after createCollider: null; after propagateModifiedBodyPositionsToColliders: null; after one step: toi 9
avg wall ms per step (6 boats, 24 crates, 6 mines, 100 walls): 0.129; rapier timingStep 0.013 ms; castRay 1.23 us
vite build: dist/assets/rapier-*.js 3,403.57 kB | gzip 1,301.05 kB (chunk-size warning only); vite dev pre-bundles @dimforge_rapier2d-compat.js
three REVISION 186: yaw +90deg maps (0,0,-1) to (-1,0,0); yaw 0.3 -> (-sin, -cos)
vitest: 6 files, 34 tests passed; tsc --noEmit: 0 errors (strict + noUncheckedIndexedAccess + noUnusedLocals/Parameters)
```


---

## Appendix B: the test files (`tests/sim/*.test.ts`, all passing)

### `tests/sim/coords.test.ts`

```ts
// tests/sim/coords.test.ts — the sim/render binding, pinned against Three.js itself.
import { describe, expect, it } from 'vitest';
import { Object3D, Vector3 } from 'three';
import { cellToSim, forwardSim, headingToPoint, rightSim, simToWorldX, simToWorldZ, worldToSim, wrapAngle, yawFromSimAngle } from '../../src/sim/coords';

describe('coordinate convention', () => {
  it('heading 0 moves along -z in the 3D world', () => {
    const f = forwardSim(0, { x: 0, y: 0 });
    expect(simToWorldX(f.x)).toBeCloseTo(0);
    expect(simToWorldZ(f.y)).toBeCloseTo(-1);
  });

  it('matches Object3D.rotation.y = simAngle for every yaw', () => {
    const obj = new Object3D();
    for (const a of [0, 0.3, Math.PI / 2, -1.2, Math.PI]) {
      obj.rotation.y = yawFromSimAngle(a);
      const three = new Vector3(0, 0, -1).applyQuaternion(obj.quaternion);
      const f = forwardSim(a, { x: 0, y: 0 });
      expect(three.x).toBeCloseTo(simToWorldX(f.x), 6);
      expect(three.z).toBeCloseTo(simToWorldZ(f.y), 6);
    }
  });

  it('positive sim angle is a CCW (left) turn seen from above', () => {
    const f0 = forwardSim(0, { x: 0, y: 0 });
    const f1 = forwardSim(0.1, { x: 0, y: 0 });
    // 2D cross product f0 x f1 > 0 means CCW in the sim plane, which is CCW from above (y := -z mirror)
    expect(f0.x * f1.y - f0.y * f1.x).toBeGreaterThan(0);
    const r = rightSim(0, { x: 0, y: 0 });
    expect(r.x).toBeCloseTo(1);
    expect(r.y).toBeCloseTo(0);
  });

  it('round-trips world <-> sim and heading <-> point', () => {
    const s = worldToSim(3, -7, { x: 0, y: 0 });
    expect(s).toEqual({ x: 3, y: 7 });
    expect(simToWorldZ(s.y)).toBe(-7);
    const a = headingToPoint(0, 0, -5, 5);
    const f = forwardSim(a, { x: 0, y: 0 });
    expect(f.x).toBeCloseTo(-Math.SQRT1_2);
    expect(f.y).toBeCloseTo(Math.SQRT1_2);
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(Math.PI);
    expect(wrapAngle(-3 * Math.PI)).toBeCloseTo(Math.PI);
  });

  it('places cell (0,0) at the north-west corner', () => {
    const p = cellToSim(0, 0, 4, 2, 8, { x: 0, y: 0 });
    expect(p.x).toBe(-12); // world x
    expect(simToWorldZ(p.y)).toBe(-4); // world z (north = negative z)
  });
});
```

### `tests/sim/boat.test.ts`

```ts
// tests/sim/boat.test.ts — handling: top speed, boost, hull water, keel, steering, sink/respawn.
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PHYSICS } from '@shared/config';
import { initPhysics, Masks, PhysicsWorld } from '../../src/sim/physics';
import { applyBoatControls, cacheVelocity, createBoat, readBoatTransform, respawnBoat, setProtected, sinkBoat, snapshotBoat, updateBoatPhase, type Boat, type BoatInput } from '../../src/sim/boat';
import { forwardSim, rightSim } from '../../src/sim/coords';

const DT = PHYSICS.dt;
let phys: PhysicsWorld;

beforeAll(async () => {
  await initPhysics();
});

afterEach(() => {
  phys.free();
});

function run(boat: Boat, input: BoatInput, seconds: number, each?: (b: Boat) => void): void {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    snapshotBoat(boat);
    applyBoatControls(boat, input, DT);
    cacheVelocity(boat);
    phys.step();
    readBoatTransform(boat);
    updateBoatPhase(boat, DT);
    each?.(boat);
  }
}

function forwardSpeed(boat: Boat): number {
  const f = forwardSim(boat.body.rotation(), { x: 0, y: 0 });
  const v = boat.body.linvel();
  return v.x * f.x + v.y * f.y;
}

function lateralSpeed(boat: Boat): number {
  const r = rightSim(boat.body.rotation(), { x: 0, y: 0 });
  const v = boat.body.linvel();
  return v.x * r.x + v.y * r.y;
}

describe('boat handling', () => {
  it('reaches about 10 m/s with GAS and 95 % of it within 3 s', () => {
    phys = new PhysicsWorld();
    const boat = createBoat(phys, 0, 0, 0, 0, 0);
    run(boat, { steer: 0, gas: true, brake: false }, 3);
    expect(forwardSpeed(boat)).toBeGreaterThan(0.94 * PHYSICS.boat.topSpeed);
    run(boat, { steer: 0, gas: true, brake: false }, 5);
    expect(forwardSpeed(boat)).toBeCloseTo(PHYSICS.boat.topSpeed, 1);
    expect(Math.abs(lateralSpeed(boat))).toBeLessThan(0.01);
    // heading 0 moves along sim +y (world -z)
    expect(boat.curr.y).toBeGreaterThan(50);
    expect(Math.abs(boat.curr.x)).toBeLessThan(0.1);
  });

  it('boost gives about 16 m/s and a full hull halves the speed', () => {
    phys = new PhysicsWorld();
    const boat = createBoat(phys, 0, 0, 0, 0, 0);
    boat.boosted = true;
    run(boat, { steer: 0, gas: true, brake: false }, 8);
    expect(forwardSpeed(boat)).toBeCloseTo(PHYSICS.boat.topSpeed * PHYSICS.boat.boostMul, 1);
    boat.boosted = false;
    boat.water = 100;
    run(boat, { steer: 0, gas: true, brake: false }, 8);
    expect(forwardSpeed(boat)).toBeCloseTo(PHYSICS.boat.topSpeed * 0.5, 1);
  });

  it('reverse is 40 % of forward and brake stops the boat', () => {
    phys = new PhysicsWorld();
    const boat = createBoat(phys, 0, 0, 0, 0, 0);
    run(boat, { steer: 0, gas: false, brake: true }, 8);
    expect(forwardSpeed(boat)).toBeCloseTo(-PHYSICS.boat.topSpeed * PHYSICS.boat.reverseMul, 1);
    run(boat, { steer: 0, gas: true, brake: false }, 6);
    expect(forwardSpeed(boat)).toBeGreaterThan(9);
    run(boat, { steer: 0, gas: false, brake: true }, 1);
    expect(forwardSpeed(boat)).toBeLessThan(0.6);
  });

  it('keel kills lateral velocity while keeping forward motion', () => {
    phys = new PhysicsWorld();
    const boat = createBoat(phys, 0, 0, 0, 0, 0);
    boat.body.setLinvel({ x: 7, y: 7 }, true); // 7 m/s sideways + 7 m/s forward
    let monotone = true;
    let last = Infinity;
    run(boat, { steer: 0, gas: false, brake: false }, 1, (b) => {
      const lat = Math.abs(lateralSpeed(b));
      if (lat > last + 1e-6) monotone = false;
      last = lat;
    });
    expect(monotone).toBe(true);
    expect(Math.abs(lateralSpeed(boat))).toBeLessThan(0.05);
    expect(forwardSpeed(boat)).toBeGreaterThan(2);
  });

  it('steers right with positive steer (clockwise = negative angular velocity), capped, and turns slowly at rest', () => {
    phys = new PhysicsWorld();
    const boat = createBoat(phys, 0, 0, 0, 0, 0);
    let maxAbs = 0;
    run(boat, { steer: 1, gas: false, brake: false }, 2, (b) => {
      maxAbs = Math.max(maxAbs, Math.abs(b.body.angvel()));
    });
    expect(boat.body.angvel()).toBeLessThan(-0.3); // slow turn at rest
    expect(boat.body.angvel()).toBeCloseTo(-PHYSICS.boat.turnRateRest, 1);
    expect(boat.curr.angle).toBeLessThan(0);
    run(boat, { steer: 1, gas: true, brake: false }, 6, (b) => {
      maxAbs = Math.max(maxAbs, Math.abs(b.body.angvel()));
    });
    expect(Math.abs(boat.body.angvel())).toBeGreaterThan(PHYSICS.boat.turnRateRest + 0.2); // stronger at speed
    expect(maxAbs).toBeLessThanOrEqual(PHYSICS.boat.maxAngvel + 0.05);
  });

  it('drift turn: brake + steer at speed lowers grip and bleeds speed', () => {
    phys = new PhysicsWorld();
    const boat = createBoat(phys, 0, 0, 0, 0, 0);
    run(boat, { steer: 0, gas: true, brake: false }, 5);
    const before = forwardSpeed(boat);
    let sawDrift = false;
    let maxLat = 0;
    run(boat, { steer: 1, gas: true, brake: true }, 1, (b) => {
      sawDrift = sawDrift || b.drifting;
      maxLat = Math.max(maxLat, Math.abs(lateralSpeed(b)));
    });
    expect(sawDrift).toBe(true);
    expect(maxLat).toBeGreaterThan(1.0); // the stern slides out (grip-limited keel keeps it under 0.3)
    expect(forwardSpeed(boat)).toBeLessThan(before - 2); // and it loses speed
  });

  it('sinks for 2 s without colliding, then is disabled, then respawns protected at a dock', () => {
    phys = new PhysicsWorld();
    const boat = createBoat(phys, 0, 0, 0, 0, 0);
    sinkBoat(boat, 0, 3, 0, 1);
    expect(boat.phase).toBe('sinking');
    expect(boat.collider.collisionGroups()).toBe(Masks.boatSinking);
    run(boat, { steer: 0, gas: true, brake: false }, 2.1);
    expect(boat.phase).toBe('dead');
    expect(boat.body.isEnabled()).toBe(false);
    respawnBoat(boat, 100, -50, Math.PI / 2);
    expect(boat.phase).toBe('alive');
    expect(boat.body.isEnabled()).toBe(true);
    expect(boat.body.translation()).toMatchObject({ x: 100, y: -50 });
    expect(boat.prev).toEqual(boat.curr);
    expect(boat.collider.collisionGroups()).toBe(Masks.boatProtected);
    expect(boat.protectedT).toBe(PHYSICS.boat.spawnProtection);
    run(boat, { steer: 0, gas: false, brake: false }, PHYSICS.boat.spawnProtection + 0.1);
    expect(boat.collider.collisionGroups()).toBe(Masks.boat);
    setProtected(boat, true);
    setProtected(boat, false); // Gunner fired: ends early
    expect(boat.protectedT).toBe(0);
  });
});
```

### `tests/sim/ram.test.ts`

```ts
// tests/sim/ram.test.ts — boat-boat contact: momentum exchange, boosted ram sinks, two boosted bounce.
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PHYSICS } from '@shared/config';
import { initPhysics, PhysicsWorld } from '../../src/sim/physics';
import { applyBoatControls, cacheVelocity, createBoat, detectRam, readBoatTransform, snapshotBoat, updateBoatPhase, type Boat, type RamResult } from '../../src/sim/boat';

const DT = PHYSICS.dt;
let phys: PhysicsWorld;

beforeAll(async () => {
  await initPhysics();
});
afterEach(() => phys.free());

interface Setup {
  a: Boat;
  b: Boat;
  boats: Boat[];
  rams: RamResult[];
  contacts: number;
}

function setup(aBoost: boolean, bBoost: boolean, headOn: boolean, gap = 6): Setup {
  phys = new PhysicsWorld();
  const a = createBoat(phys, 0, 0, 0, 0, 0);
  const b = createBoat(phys, 1, 1, 0, PHYSICS.boat.length + gap, headOn ? Math.PI : 0);
  a.boosted = aBoost;
  b.boosted = bBoost;
  return { a, b, boats: [a, b], rams: [], contacts: 0 };
}

function simulate(s: Setup, seconds: number, aGas: boolean, bGas: boolean): void {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    for (const boat of s.boats) snapshotBoat(boat);
    applyBoatControls(s.a, { steer: 0, gas: aGas, brake: false }, DT);
    applyBoatControls(s.b, { steer: 0, gas: bGas, brake: false }, DT);
    for (const boat of s.boats) cacheVelocity(boat);
    phys.step((ra, rb, ca, cb, started) => {
      if (!started || ra.kind !== 'boat' || rb.kind !== 'boat') return;
      s.contacts++;
      const ba = s.boats[ra.id];
      const bb = s.boats[rb.id];
      if (ba === undefined || bb === undefined) return;
      const out: RamResult = { rammer: ba, target: bb, px: 0, py: 0, nx: 0, ny: 0 };
      if (detectRam(phys, ba, bb, ca, cb, out)) s.rams.push(out);
    });
    for (const boat of s.boats) {
      readBoatTransform(boat);
      updateBoatPhase(boat, DT);
    }
  }
}

describe('ramming', () => {
  it('a boosted boat hitting a resting enemy from behind rams it', () => {
    const s = setup(true, false, false);
    s.a.body.setLinvel({ x: 0, y: 12 }, true);
    simulate(s, 2, true, false);
    expect(s.contacts).toBeGreaterThan(0);
    expect(s.rams.length).toBe(1);
    const ram = s.rams[0];
    expect(ram?.rammer.id).toBe(0);
    expect(ram?.target.id).toBe(1);
    // impact point lies between the two hulls, normal points from a to b (+y)
    expect(ram?.ny).toBeGreaterThan(0.9);
    expect(ram?.py).toBeGreaterThan(2);
    expect(ram?.py).toBeLessThan(10);
  });

  it('two boosted boats head-on just bounce, with momentum exchanged', () => {
    const s = setup(true, true, true);
    s.a.body.setLinvel({ x: 0, y: 12 }, true);
    s.b.body.setLinvel({ x: 0, y: -12 }, true);
    simulate(s, 1.5, true, true);
    expect(s.contacts).toBeGreaterThan(0);
    expect(s.rams.length).toBe(0);
    // they separated and are not interpenetrating
    expect(s.b.curr.y - s.a.curr.y).toBeGreaterThan(PHYSICS.boat.length - 0.3);
  });

  it('an unboosted hit is a bounce, not a kill', () => {
    const s = setup(false, false, false);
    s.a.body.setLinvel({ x: 0, y: 12 }, true);
    simulate(s, 2, true, false);
    expect(s.contacts).toBeGreaterThan(0);
    expect(s.rams.length).toBe(0);
    // the resting boat was pushed forward: momentum exchange
    expect(s.b.curr.y).toBeGreaterThan(12.5);
  });

  it('a slow boosted touch is not a ram', () => {
    const s = setup(true, false, false, 1); // 1 m gap: a 3 m/s nudge reaches it before damping stops it
    s.a.body.setLinvel({ x: 0, y: 3 }, true);
    simulate(s, 2, false, false);
    expect(s.contacts).toBeGreaterThan(0);
    expect(s.rams.length).toBe(0);
  });
});
```

### `tests/sim/walls.test.ts`

```ts
// tests/sim/walls.test.ts — greedy rectangle merge and the static world built from the spec's sample map.
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import RAPIER from '@dimforge/rapier2d-compat';
import { initPhysics, Masks, PhysicsWorld } from '../../src/sim/physics';
import { buildStaticWorld, gridFromRows, mergeSolidCells, type CellRect, type GridLike } from '../../src/sim/walls';
import { cellToSim } from '../../src/sim/coords';

// The sample from SPEC.md section 7 (backslashes removed).
const SAMPLE = [
  'BBBBBBBBBBBBBBBBBBBBBBBB',
  'BBB~~BBBBB~~BBBBBBBBC~LL',
  'BBB~~BBBBB~~BBBBB~~~~~LL',
  '~~~~~~~~=~~~~~~~~~~~~~LL',
  '~~~S~~~~=~~~~C~~~~~~~SLL',
  'BBB~~BBBBBBBBB~~BBBB~~LL',
  'BBB==BBBTBBBBB~~BBBB~~LL',
  'BBB~~BBBBBBBBB~~BBBB~~LL',
];

function coverage(grid: GridLike, rects: CellRect[]): { cells: number; overlaps: number } {
  const seen = new Uint8Array(grid.cols * grid.rows);
  let overlaps = 0;
  let cells = 0;
  for (const r of rects) {
    for (let y = r.row; y < r.row + r.h; y++) {
      for (let x = r.col; x < r.col + r.w; x++) {
        expect(grid.isSolid(x, y)).toBe(true);
        const i = y * grid.cols + x;
        if (seen[i] === 1) overlaps++;
        seen[i] = 1;
        cells++;
      }
    }
  }
  return { cells, overlaps };
}

function solidCount(grid: GridLike): number {
  let n = 0;
  for (let y = 0; y < grid.rows; y++) for (let x = 0; x < grid.cols; x++) if (grid.isSolid(x, y)) n++;
  return n;
}

describe('mergeSolidCells', () => {
  it('merges a full block into one rectangle', () => {
    const rects = mergeSolidCells(gridFromRows(['BBB', 'BBB', 'BBB']));
    expect(rects).toEqual([{ col: 0, row: 0, w: 3, h: 3 }]);
  });

  it('splits an L shape into two rectangles, bridges and water are not solid', () => {
    const rects = mergeSolidCells(gridFromRows(['BB=~', 'B~~~', 'B~~~']));
    expect(rects).toEqual([
      { col: 0, row: 0, w: 2, h: 1 },
      { col: 0, row: 1, w: 1, h: 2 },
    ]);
  });

  it('covers every solid cell of the sample map exactly once, with far fewer colliders than cells', () => {
    const grid = gridFromRows(SAMPLE);
    const rects = mergeSolidCells(grid);
    const { cells, overlaps } = coverage(grid, rects);
    expect(overlaps).toBe(0);
    expect(cells).toBe(solidCount(grid));
    expect(rects.length).toBeLessThan(cells / 3);
  });
});

describe('buildStaticWorld', () => {
  let phys: PhysicsWorld;
  beforeAll(async () => {
    await initPhysics();
  });
  afterEach(() => phys.free());

  it('creates walls that block rays from water into buildings, and a border around the map', () => {
    phys = new PhysicsWorld();
    const grid = gridFromRows(SAMPLE);
    const built = buildStaticWorld(phys, grid, { poles: [{ x: 0, y: 0 }], moored: [], piles: [{ x: 5, y: 5 }] });
    expect(built.colliderCount).toBe(built.rects.length + 4 + 1 + 3);
    expect(phys.world.colliders.len()).toBe(built.colliderCount);

    // from the water cell (0,3) north into the building cell (0,2)
    const from = cellToSim(0, 3, grid.cols, grid.rows, 8, { x: 0, y: 0 });
    const to = cellToSim(0, 2, grid.cols, grid.rows, 8, { x: 0, y: 0 });
    const t = phys.wallHitFraction(from.x, from.y, to.x, to.y);
    expect(t).toBeGreaterThan(0.4);
    expect(t).toBeLessThan(0.6); // hits the cell boundary half-way
    expect(phys.hasLineOfSight(from.x, from.y, to.x, to.y)).toBe(false);

    // along the open canal row 3, east-west, nothing blocks
    const a = cellToSim(0, 3, grid.cols, grid.rows, 8, { x: 0, y: 0 });
    const b = cellToSim(20, 3, grid.cols, grid.rows, 8, { x: 0, y: 0 });
    expect(phys.hasLineOfSight(a.x, a.y, b.x, b.y)).toBe(true);

    // the ray's own membership must be accepted by the wall filter: a query with the wrong mask sees nothing
    const ray = new RAPIER.Ray({ x: from.x, y: from.y }, { x: to.x - from.x, y: to.y - from.y });
    expect(phys.world.castRay(ray, 1, true, undefined, Masks.queryCrates)).toBeNull();

    // the border: a ray shot far west ends on the border slab
    expect(phys.wallHitFraction(a.x, a.y, a.x - 1000, a.y)).toBeGreaterThan(0);
  });
});
```

### `tests/sim/projectiles.test.ts`

```ts
// tests/sim/projectiles.test.ts — segment/OBB maths, cannon, torpedo, mortar, water cannon.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import RAPIER from '@dimforge/rapier2d-compat';
import { DEG, PHYSICS } from '@shared/config';
import { initPhysics, Masks, PhysicsWorld } from '../../src/sim/physics';
import { pointObbDistance, segmentVsObb } from '../../src/sim/geom';
import { applyWaterCannon, Projectiles, type Hit, type Target } from '../../src/sim/projectiles';

const DT = PHYSICS.dt;
let phys: PhysicsWorld;

beforeAll(async () => {
  await initPhysics();
});
beforeEach(() => {
  phys = new PhysicsWorld();
});
afterEach(() => phys.free());

function target(id: number, team: number, x: number, y: number, angle = 0): Target {
  return { id, team, hittable: true, box: { x, y, angle, hw: 0.7, hl: 3 } };
}

function addWall(x: number, y: number, hx: number, hy: number): void {
  const body = phys.createBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, y));
  phys.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy).setCollisionGroups(Masks.wall), body, { kind: 'wall', id: -1 });
  phys.commit(); // new colliders enter the broad phase (and so ray queries) on the next step
}

function stepAll(p: Projectiles, targets: Target[], seconds: number, hits: Hit[], splashes: string[]): void {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    p.step(
      DT,
      phys,
      targets,
      (h) => hits.push({ ...h }),
      (kind, _x, _y, surface) => splashes.push(`${kind}:${surface}`),
    );
  }
}

describe('geometry', () => {
  it('segment vs oriented box', () => {
    const box = { x: 0, y: 10, angle: 0, hw: 0.7, hl: 3 };
    expect(segmentVsObb(0, 0, 0, 20, box, 0)).toBeCloseTo(7 / 20);
    expect(segmentVsObb(5, 0, 5, 20, box, 0)).toBe(-1);
    expect(segmentVsObb(0, 9, 0, 11, box, 0)).toBe(0); // starts inside
    const rotated = { x: 0, y: 10, angle: Math.PI / 2, hw: 0.7, hl: 3 }; // bow now along -x
    expect(segmentVsObb(5, 10, -5, 10, rotated, 0)).toBeCloseTo(2 / 10);
    expect(segmentVsObb(0, 0, 0, 20, rotated, 0)).toBeCloseTo(9.3 / 20);
    expect(segmentVsObb(1.0, 0, 1.0, 20, box, 0.5)).toBeGreaterThanOrEqual(0); // radius inflation
  });

  it('point to oriented box distance', () => {
    const box = { x: 0, y: 0, angle: 0, hw: 0.7, hl: 3 };
    expect(pointObbDistance(0, 0, box)).toBe(0);
    expect(pointObbDistance(0, 9, box)).toBeCloseTo(6);
    expect(pointObbDistance(4.7, 0, box)).toBeCloseTo(4);
  });
});

describe('cannonball', () => {
  it('hits an enemy 30 m ahead in half a second and never a teammate', () => {
    const p = new Projectiles();
    const targets = [target(1, 1, 0, 30), target(2, 0, 0, 15)]; // the teammate sits in the line of fire
    const hits: Hit[] = [];
    const splashes: string[] = [];
    p.fireCannon(0, 0, 0, 0, 7, targets, phys);
    stepAll(p, targets, 0.6, hits, splashes);
    expect(hits.length).toBe(1);
    expect(hits[0]?.targetId).toBe(1);
    expect(hits[0]?.shooterId).toBe(7);
    expect(hits[0]?.py).toBeCloseTo(27 - PHYSICS.cannon.radius, 0);
    expect(hits[0]?.dy).toBeCloseTo(1);
    expect(p.cannonballs[0]?.active).toBe(false);
  });

  it('is blocked by a wall in between', () => {
    addWall(0, 15, 5, 1);
    const p = new Projectiles();
    const targets = [target(1, 1, 0, 30)];
    const hits: Hit[] = [];
    const splashes: string[] = [];
    p.fireCannon(0, 0, 0, 0, 7, targets, phys);
    stepAll(p, targets, 1, hits, splashes);
    expect(hits.length).toBe(0);
    expect(splashes).toEqual(['cannon:wall']);
  });

  it('bends up to 4 degrees toward an enemy near the aim line and splashes in water at max range', () => {
    const p = new Projectiles();
    const targets = [target(1, 1, Math.tan(3 * DEG) * -40, 40)]; // 3 deg to the left of the aim line at 40 m
    const hits: Hit[] = [];
    const splashes: string[] = [];
    p.fireCannon(0, 0, 0, 0, 7, targets, phys);
    stepAll(p, targets, 1, hits, splashes);
    expect(hits.length).toBe(1);
    const q = new Projectiles();
    q.fireCannon(0, 0, 0, 0, 7, [], phys);
    stepAll(q, [], 3, hits, splashes);
    expect(splashes).toEqual(['cannon:water']);
  });
});

describe('torpedo', () => {
  it('locks an enemy inside the 40 deg cone and homes into it', () => {
    const p = new Projectiles();
    const targets = [target(1, 1, 10, 40)]; // 14 deg off the aim line
    const lock = p.fireTorpedo(0, 0, 0, 0, 7, targets, phys);
    expect(lock).toBe(1);
    const hits: Hit[] = [];
    const splashes: string[] = [];
    stepAll(p, targets, 3, hits, splashes);
    expect(hits.length).toBe(1);
    expect(hits[0]?.kind).toBe('torpedo');
  });

  it('does not lock outside the cone and then runs straight', () => {
    const p = new Projectiles();
    const targets = [target(1, 1, 25, 40)]; // 32 deg off
    expect(p.fireTorpedo(0, 0, 0, 0, 7, targets, phys)).toBe(-1);
    const hits: Hit[] = [];
    const splashes: string[] = [];
    stepAll(p, targets, 4.5, hits, splashes);
    expect(hits.length).toBe(0);
    expect(splashes).toEqual(['torpedo:water']);
  });

  it('turns at most the max turn rate and drops the lock when a wall hides the target', () => {
    const p = new Projectiles();
    const targets = [target(1, 1, 8, 40)];
    p.fireTorpedo(0, 0, 0, 0, 7, targets, phys);
    const t = p.torpedoes[0];
    if (t === undefined) throw new Error('no torpedo');
    const before = t.angle;
    p.step(DT, phys, targets, () => undefined, () => undefined);
    expect(Math.abs(t.angle - before)).toBeLessThanOrEqual(PHYSICS.torpedo.turnRateDeg * DEG * DT + 1e-9);
    addWall(4, 20, 10, 1);
    p.step(DT, phys, targets, () => undefined, () => undefined);
    expect(t.targetId).toBe(-1);
  });
});

describe('mortar', () => {
  it('lands on the nearest enemy within 10 deg and 60 m even behind a wall, after the fixed flight time', () => {
    addWall(0, 20, 10, 1);
    const p = new Projectiles();
    const targets = [target(1, 1, 0, 40), target(2, 1, 4, 50)];
    p.fireMortar(0, 0, 0, 0, 7, targets, phys);
    const s = p.shells[0];
    expect(s?.x1).toBe(0);
    expect(s?.y1).toBe(40);
    const hits: Hit[] = [];
    const splashes: string[] = [];
    stepAll(p, targets, PHYSICS.mortar.flightTime - 0.05, hits, splashes);
    expect(hits.length).toBe(0);
    stepAll(p, targets, 0.1, hits, splashes);
    expect(hits.length).toBe(1);
    expect(hits[0]?.targetId).toBe(1);
    const pose = { x: 0, y: 0, height: 0 };
    s!.t = PHYSICS.mortar.flightTime / 2;
    Projectiles.mortarPose(s!, pose);
    expect(pose.y).toBeCloseTo(20);
    expect(pose.height).toBeCloseTo(PHYSICS.mortar.apexHeight);
  });

  it('with no target lands 40 m ahead and splashes 6 m wide', () => {
    const p = new Projectiles();
    const hitsA: Hit[] = [];
    const splashes: string[] = [];
    // no enemies in the cone at launch...
    p.fireMortar(0, 0, 0, 0, 7, [], phys);
    // ...but one parks 5.5 m past the landing spot (edge of hull at 40+5.5-3? no: centre 48.5, hull edge 45.5 -> 5.5 m away)
    const near = [target(1, 1, 0, 48.5)];
    stepAll(p, near, 2, hitsA, splashes);
    expect(hitsA.length).toBe(1);
    const q = new Projectiles();
    q.fireMortar(0, 0, 0, 0, 7, [], phys);
    const far = [target(1, 1, 0, 49.5)]; // 6.5 m from the hull edge
    const hitsB: Hit[] = [];
    stepAll(q, far, 2, hitsB, splashes);
    expect(hitsB.length).toBe(0);
    expect(splashes).toEqual(['mortar:water']);
  });
});

describe('water cannon', () => {
  it('pushes and fills enemies in the cone with line of sight, never teammates', () => {
    const targets = [target(1, 1, 0, 10), target(2, 0, 2, 12), target(3, 1, 10, 10), target(4, 1, 0, 30)];
    const pushed: number[] = [];
    let water = 0;
    applyWaterCannon(phys, 0, 0, 0, 0, targets, DT, (id, fx, fy, w) => {
      pushed.push(id);
      expect(fx).toBeCloseTo(0);
      expect(fy).toBeCloseTo(PHYSICS.waterCannon.pushForce);
      water += w;
    });
    expect(pushed).toEqual([1]);
    expect(water).toBeCloseTo(PHYSICS.waterCannon.waterPerSecond * DT);
    addWall(0, 5, 3, 0.5);
    pushed.length = 0;
    applyWaterCannon(phys, 0, 0, 0, 0, targets, DT, (id) => pushed.push(id));
    expect(pushed).toEqual([]);
  });
});
```

### `tests/sim/items.test.ts`

```ts
// tests/sim/items.test.ts — crate pickup events and respawn, mine arming / owner safety / expiry.
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PHYSICS } from '@shared/config';
import { initPhysics, PhysicsWorld, type CollisionHandler, type EntityRef } from '../../src/sim/physics';
import { applyBoatControls, cacheVelocity, createBoat, readBoatTransform, snapshotBoat, type Boat } from '../../src/sim/boat';
import { collectCrate, createCrate, dropMine, mineShouldExplode, removeMine, updateCrates, updateMines, type Mine } from '../../src/sim/items';

const DT = PHYSICS.dt;
let phys: PhysicsWorld;

beforeAll(async () => {
  await initPhysics();
});
afterEach(() => phys.free());

function drive(boat: Boat, seconds: number, onPair: CollisionHandler, after?: () => void): void {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    snapshotBoat(boat);
    applyBoatControls(boat, { steer: 0, gas: true, brake: false }, DT);
    cacheVelocity(boat);
    phys.step(onPair);
    readBoatTransform(boat);
    after?.();
  }
}

describe('crates', () => {
  it('report a collision with the boat on first touch, vanish, and come back 8 s later at home', () => {
    phys = new PhysicsWorld();
    const boat = createBoat(phys, 0, 0, 0, 0, 0);
    const crate = createCrate(phys, 0, 'weapon', 0, 20);
    const crates = [crate];
    let touched = 0;
    drive(
      boat,
      4,
      (a, b, _ca, _cb, started) => {
        if (!started) return;
        const kinds = [a.kind, b.kind];
        if (kinds.includes('boat') && kinds.includes('crate')) {
          touched++;
          collectCrate(crate);
        }
      },
      () => updateCrates(crates, DT),
    );
    expect(touched).toBe(1);
    expect(crate.active).toBe(false);
    expect(crate.body.isEnabled()).toBe(false);
    // boat drove straight through the empty spot
    expect(boat.curr.y).toBeGreaterThan(25);
    drive(boat, PHYSICS.crate.respawn, () => undefined, () => updateCrates(crates, DT));
    expect(crate.active).toBe(true);
    expect(crate.body.isEnabled()).toBe(true);
    expect(crate.body.translation()).toMatchObject({ x: 0, y: 20 });
  });
});

describe('mines', () => {
  function explodeOnTouch(mines: Map<number, Mine>, boat: Boat, exploded: number[]): CollisionHandler {
    return (a: EntityRef, b: EntityRef, _ca, _cb, started: boolean): void => {
      if (!started) return;
      const trig = a.kind === 'mineTrigger' ? a : b.kind === 'mineTrigger' ? b : null;
      const hull = a.kind === 'boat' ? a : b.kind === 'boat' ? b : null;
      if (trig === null || hull === null) return;
      const mine = mines.get(trig.id);
      if (mine === undefined) return;
      if (mineShouldExplode(mine, boat.team)) {
        exploded.push(mine.id);
        removeMine(phys, mine);
        mines.delete(mine.id);
      }
    };
  }

  it('is dropped behind the boat, ignores its owner, and sinks the first armed enemy touch', () => {
    phys = new PhysicsWorld();
    const owner = createBoat(phys, 0, 0, 0, 0, 0);
    const enemy = createBoat(phys, 1, 1, 0, -30, 0);
    const mines = new Map<number, Mine>();
    const mine = dropMine(phys, 0, owner.team, 0, 0, 0, 0, 10);
    mines.set(mine.id, mine);
    expect(mine.curr.y).toBeCloseTo(-PHYSICS.mine.dropBehind);
    expect(mine.body.mass()).toBeCloseTo(PHYSICS.mine.mass, 3); // the sensor adds no mass

    // the owner reverses over it: nothing happens (also before arming)
    const exploded: number[] = [];
    owner.body.setLinvel({ x: 0, y: -8 }, true);
    for (let i = 0; i < 60; i++) {
      phys.step(explodeOnTouch(mines, owner, exploded));
      updateMines(phys, mines.values(), DT, () => -1, () => undefined);
    }
    expect(exploded).toEqual([]);
    expect(mine.armT).toBeLessThanOrEqual(0);

    // the enemy drives over it
    drive(enemy, 4, explodeOnTouch(mines, enemy, exploded), () => updateMines(phys, mines.values(), DT, () => -1, () => undefined));
    expect(exploded).toEqual([0]);
    expect(mine.gone).toBe(true);
    expect(phys.world.bodies.len()).toBe(2); // mine body removed after the drain
  });

  it('explodes on arming when an enemy already sits inside the trigger, and expires after 45 s', () => {
    phys = new PhysicsWorld();
    const enemy = createBoat(phys, 1, 1, 0, 0, 0);
    const mines = new Map<number, Mine>();
    const mine = dropMine(phys, 5, 0, 0, 4, 0, 0, 0); // dropped 4 m "behind" (0,4) -> lands at (0,0), inside the enemy hull
    mines.set(mine.id, mine);
    const exploded: number[] = [];
    for (let i = 0; i < 90; i++) {
      phys.step();
      updateMines(
        phys,
        mines.values(),
        DT,
        (id) => (id === enemy.id ? enemy.team : -1),
        (m, boatId) => {
          exploded.push(boatId);
          removeMine(phys, m);
        },
      );
    }
    expect(exploded).toEqual([enemy.id]);

    const late = dropMine(phys, 6, 0, 50, 50, 0, 0, 0);
    const m2 = new Map<number, Mine>([[late.id, late]]);
    for (let i = 0; i < Math.round((PHYSICS.mine.lifetime + 0.5) / DT); i++) {
      phys.step();
      updateMines(phys, m2.values(), DT, () => -1, () => undefined);
    }
    expect(late.gone).toBe(true);
  });
});
```

Vitest note for the base phase: the scaffolded `vite.config.ts` passes a `test` key to `defineConfig` from `'vite'`, which `tsc -p tsconfig.json` rejects (`'test' does not exist in type 'UserConfigExport'`, seen when typechecking the repo as-is); import `defineConfig` from `'vitest/config'` (or add a `vitest.config.ts` like the mirror's) so `npm run typecheck` passes. The tests above need only the `@shared` alias and `environment: 'node'`.
