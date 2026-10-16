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
