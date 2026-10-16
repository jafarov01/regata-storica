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
