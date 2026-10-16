/**
 * The crew's sway (src/render/avatars.ts): thrown outward in a turn, back when the boat speeds
 * up, settling once it goes straight; seated people lean less than the standing Pilot; picks
 * rebuild the people aboard. Geometry only, so it runs in Node without WebGL.
 */
import { describe, expect, it } from 'vitest';
import type { Group } from 'three';
import { CrewAvatars, type CrewFrame } from '../src/render/avatars.ts';

const crew3 = [
  { role: 'pilot', character: 'justin-simon' },
  { role: 'gunner', character: 'natalia-jurado-santiago' },
  { role: 'engineer', character: 'jinlong-yu' },
] as const;

function run(c: CrewAvatars, seconds: number, f: Partial<CrewFrame>, t0 = 0): number {
  let t = t0;
  for (let i = 0; i < Math.round(seconds * 60); i++) {
    t += 1 / 60;
    c.update({ dt: 1 / 60, time: t, speed: 8, angVel: 0, gas: true, aimRel: 0, water: 0, sinking: false, celebrate: false, ...f });
  }
  return t;
}

/** The lean group of the figure whose root sits at this z in the boat (pilot 2.35, engineer 0.55). */
function leanAt(c: CrewAvatars, z: number): Group {
  const root = c.root.children.find((o) => o.type === 'Group' && Math.abs(o.position.z - z) < 1e-6 && o.children.length === 1);
  const lean = root?.children[0];
  if (!lean) throw new Error(`no figure at z=${z}`);
  return lean as Group;
}

describe('crew sway', () => {
  it('leans outward in a turn, more standing than seated, and settles when the boat goes straight', () => {
    const c = new CrewAvatars('#3a8fe0');
    c.setCrew([...crew3]);
    let t = run(c, 1, {});
    // Hard left turn at 8 m/s: the crew is thrown to starboard (+X), i.e. negative roll.
    t = run(c, 2, { angVel: 1 }, t);
    const pilot = leanAt(c, 2.35).rotation.z;
    const engineer = leanAt(c, 0.55).rotation.z;
    expect(pilot).toBeLessThan(-0.12);
    expect(engineer).toBeLessThan(-0.05);
    expect(Math.abs(engineer)).toBeLessThan(Math.abs(pilot));
    // Straight again: the spring brings them back near upright (the wave bob stays small).
    run(c, 3, { angVel: 0 }, t);
    expect(Math.abs(leanAt(c, 2.35).rotation.z)).toBeLessThan(0.06);
  });

  it('tips back when the boat speeds up and forward when it brakes', () => {
    const c = new CrewAvatars('#e04a3a');
    c.setCrew([...crew3]);
    let t = run(c, 1, { speed: 0 });
    let speed = 0;
    for (let i = 0; i < 30; i++) {
      speed += 3.3 / 60;
      t = run(c, 1 / 60, { speed }, t);
    }
    expect(leanAt(c, 2.35).rotation.x).toBeGreaterThan(0.04);
    for (let i = 0; i < 30; i++) {
      speed -= 6 / 60;
      t = run(c, 1 / 60, { speed }, t);
    }
    expect(leanAt(c, 2.35).rotation.x).toBeLessThan(-0.04);
  });

  it('rebuilds only when the crew or a pick changes', () => {
    const c = new CrewAvatars('#3fbf5f');
    c.setCrew([...crew3]);
    const before = leanAt(c, 2.35);
    c.setCrew([...crew3]);
    expect(leanAt(c, 2.35)).toBe(before);
    c.setCrew([{ role: 'pilot', character: 'simon-moreau' }, crew3[1], crew3[2]]);
    expect(leanAt(c, 2.35)).not.toBe(before);
    // Unknown or missing picks become gondoliers rather than failing.
    c.setCrew([{ role: 'pilot', character: null }, { role: 'gunner', character: 'nobody' }]);
    expect(() => run(c, 0.5, {})).not.toThrow();
  });
});
