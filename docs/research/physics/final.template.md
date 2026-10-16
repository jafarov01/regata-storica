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
{{file:shared/config.ts}}
```

### 3.3 `src/sim/coords.ts` — the 2D/3D binding

```ts
{{file:src/sim/coords.ts}}
```

Renderer side (one place, in `src/render`): `mesh.position.set(simToWorldX(t.x), 0, simToWorldZ(t.y)); mesh.rotation.y = yawFromSimAngle(t.angle);` with `t = lerpTransform(boat.prev, boat.curr, stepper.alpha, scratch)`. Author the gondola model with the bow along −Z.

### 3.4 `src/sim/geom.ts` — segment/OBB, point/OBB, cone

```ts
{{file:src/sim/geom.ts}}
```

### 3.5 `src/sim/physics.ts` — world, groups, registry, events, ray queries

```ts
{{file:src/sim/physics.ts}}
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
{{file:src/sim/loop.ts}}
```

Scene usage: `let last = performance.now(); function frame(now) { sim.advance((now - last) / 1000); last = now; render(sim, sim.stepper.alpha); requestAnimationFrame(frame); }`. The round timer counts `stepper.simTime` (5:00 = 18 000 steps), so a stalled frame never shortens the match.

### 3.7 `src/sim/boat.ts` — the gondola body

```ts
{{file:src/sim/boat.ts}}
```

### 3.8 `src/sim/walls.ts` — static scenery from the ASCII map

```ts
{{file:src/sim/walls.ts}}
```

`StaticProps` (pole, moored and pile positions) must be produced by `shared/map.ts` from the grid with a deterministic rule (for example a pole at 1/4 and 3/4 of every water-cell edge that touches a building, thinned with a seeded hash) so the renderer places exactly the same props.

### 3.9 `src/sim/items.ts` — crates and mines

```ts
{{file:src/sim/items.ts}}
```

### 3.10 `src/sim/projectiles.ts` — cannonball, torpedo, mortar, water cannon

```ts
{{file:src/sim/projectiles.ts}}
```

### 3.11 `src/sim/sim.ts` — order of operations for one step

```ts
{{file:src/sim/sim.ts}}
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
{{file:tests/sim/coords.test.ts}}
```

### `tests/sim/boat.test.ts`

```ts
{{file:tests/sim/boat.test.ts}}
```

### `tests/sim/ram.test.ts`

```ts
{{file:tests/sim/ram.test.ts}}
```

### `tests/sim/walls.test.ts`

```ts
{{file:tests/sim/walls.test.ts}}
```

### `tests/sim/projectiles.test.ts`

```ts
{{file:tests/sim/projectiles.test.ts}}
```

### `tests/sim/items.test.ts`

```ts
{{file:tests/sim/items.test.ts}}
```

Vitest note for the base phase: the scaffolded `vite.config.ts` passes a `test` key to `defineConfig` from `'vite'`, which `tsc -p tsconfig.json` rejects (`'test' does not exist in type 'UserConfigExport'`, seen when typechecking the repo as-is); import `defineConfig` from `'vitest/config'` (or add a `vitest.config.ts` like the mirror's) so `npm run typecheck` passes. The tests above need only the `@shared` alias and `environment: 'node'`.
