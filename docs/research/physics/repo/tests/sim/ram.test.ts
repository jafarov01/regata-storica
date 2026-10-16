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
