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
