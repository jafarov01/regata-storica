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
