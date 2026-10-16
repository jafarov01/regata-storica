import { describe, expect, it } from 'vitest';
import { angleDiff, deadZoneCurve, lerpAngle, makeRng, turnToward, wrapAngle } from '../shared/math.ts';

describe('angles', () => {
  it('wraps into (-PI, PI]', () => {
    expect(wrapAngle(Math.PI * 3)).toBeCloseTo(Math.PI);
    expect(wrapAngle(-Math.PI * 3)).toBeCloseTo(Math.PI);
    expect(wrapAngle(0.5)).toBeCloseTo(0.5);
    expect(wrapAngle(-Math.PI - 0.1)).toBeCloseTo(Math.PI - 0.1);
  });
  it('takes the short way round', () => {
    expect(angleDiff(3, -3)).toBeCloseTo(2 * Math.PI - 6);
    expect(lerpAngle(3, -3, 0.5)).toBeCloseTo(wrapAngle(3 + (2 * Math.PI - 6) / 2));
    expect(turnToward(0, 1, 0.25)).toBeCloseTo(0.25);
    expect(turnToward(0, -1, 0.25)).toBeCloseTo(-0.25);
  });
});

describe('deadZoneCurve', () => {
  it('is zero inside the dead zone and saturates at full lock', () => {
    expect(deadZoneCurve(2, 4, 35)).toBe(0);
    expect(deadZoneCurve(-2, 4, 35)).toBe(0);
    expect(deadZoneCurve(35, 4, 35)).toBe(1);
    expect(deadZoneCurve(-60, 4, 35)).toBe(-1);
    expect(deadZoneCurve(19.5, 4, 35)).toBeCloseTo(0.5);
  });
});

describe('makeRng', () => {
  it('is deterministic and in [0, 1)', () => {
    const a = makeRng(42);
    const b = makeRng(42);
    for (let i = 0; i < 100; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});
