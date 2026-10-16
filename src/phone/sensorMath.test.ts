// src/phone/sensorMath.test.ts
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SENSOR_TUNING as T,
  DEG2RAD,
  G,
  GravitySignDetector,
  LowPassVec3,
  ShakeDetector,
  aimHeadingDeg,
  inPlaneFraction,
  rollAngleDeg,
  softDeadZone,
  steerCurve,
  steerFromGravity,
  upFromOrientation,
  vec3,
  vscale,
  wrapDeg,
  yawRateDegPerS,
  yawStepRad,
  type Vec3,
} from './sensorMath';
import { applyEdges, buildInputSample, collectEdges, neutralSample, newTotals } from './sender';
import { defaultSimPose, simMotionSample, simOrientationSample, simUpVector } from './sensorSim';

/** Sky vector for a landscape phone: roll angle phi (deg, from +y towards +x) and pitch p. */
const upAt = (phiDeg: number, pitchDeg = 0): Vec3 => {
  const c = Math.cos(pitchDeg * DEG2RAD);
  return vec3(c * Math.sin(phiDeg * DEG2RAD), c * Math.cos(phiDeg * DEG2RAD), -Math.sin(pitchDeg * DEG2RAD));
};

describe('wrapDeg / softDeadZone', () => {
  it('wraps into (-180, 180]', () => {
    expect(wrapDeg(190)).toBe(-170);
    expect(wrapDeg(-190)).toBe(170);
    expect(wrapDeg(180)).toBe(180);
    expect(wrapDeg(-180)).toBe(180);
    expect(wrapDeg(540)).toBe(180);
    expect(wrapDeg(1)).toBe(1);
  });
  it('removes the dead band without a jump', () => {
    expect(softDeadZone(1.5, 2)).toBe(0);
    expect(softDeadZone(-1.5, 2)).toBe(0);
    expect(softDeadZone(3, 2)).toBe(1);
    expect(softDeadZone(-3, 2)).toBe(-1);
  });
});

describe('steering from gravity', () => {
  it('roll angle: portrait 0, landscape top-left +90, top-right -90, upside down 180', () => {
    expect(rollAngleDeg(vec3(0, 1, 0))).toBeCloseTo(0);
    expect(rollAngleDeg(vec3(1, 0, 0))).toBeCloseTo(90);
    expect(rollAngleDeg(vec3(-1, 0, 0))).toBeCloseTo(-90);
    expect(rollAngleDeg(vec3(0, -1, 0))).toBeCloseTo(180);
  });

  it('curve: dead zone 4, full lock 35, expo 0.4', () => {
    expect(steerCurve(0, T)).toBe(0);
    expect(steerCurve(4, T)).toBe(0);
    expect(steerCurve(-4, T)).toBe(0);
    expect(steerCurve(35, T)).toBeCloseTo(1);
    expect(steerCurve(-35, T)).toBeCloseTo(-1);
    expect(steerCurve(60, T)).toBeCloseTo(1);
    // midpoint of the active band: x = 0.5 -> 0.6*0.5 + 0.4*0.125 = 0.35
    expect(steerCurve(19.5, T)).toBeCloseTo(0.35);
    expect(steerCurve(19.5, { ...T, steerExpo: 0 })).toBeCloseTo(0.5);
  });

  it('clockwise wheel turn of 20 deg gives +20 deg and a positive steer, both landscapes', () => {
    for (const phiCal of [90, -90]) {
      const cal = rollAngleDeg(upAt(phiCal));
      const r = steerFromGravity(upAt(phiCal - 20), cal, T);
      expect(r.angleDeg).toBeCloseTo(20);
      expect(r.steer).toBeCloseTo(steerCurve(20, T));
      expect(r.weak).toBe(false);
      const l = steerFromGravity(upAt(phiCal + 35), cal, T);
      expect(l.angleDeg).toBeCloseTo(-35);
      expect(l.steer).toBeCloseTo(-1);
    }
  });

  it('is unchanged by the iOS sign flip once calibrated with the same sign', () => {
    const calUp = vscale(upAt(90), -G);
    const cal = rollAngleDeg(calUp);
    const r = steerFromGravity(vscale(upAt(70), -G), cal, T);
    expect(r.angleDeg).toBeCloseTo(20);
  });

  it('ignores a constant pitch (the in-plane angle is preserved)', () => {
    const cal = rollAngleDeg(upAt(90, 30));
    expect(steerFromGravity(upAt(70, 30), cal, T).angleDeg).toBeCloseTo(20);
    expect(steerFromGravity(upAt(70, 55), cal, T).angleDeg).toBeCloseTo(20);
  });

  it('flags a flat phone as weak', () => {
    expect(inPlaneFraction(vec3(0, 0, 1))).toBe(0);
    const r = steerFromGravity(upAt(80, 75), 90, T);
    expect(r.weak).toBe(true);
    expect(r.steer).toBe(0);
    expect(steerFromGravity(upAt(80, 60), 90, T).weak).toBe(false);
  });
});

describe('gunner yaw', () => {
  it('projects the gyro onto the vertical: full rate when turning about up, zero when perpendicular', () => {
    expect(yawRateDegPerS(vec3(0, 0, 30), vec3(0, 0, 1))).toBeCloseTo(30);
    expect(yawRateDegPerS(vec3(0, 0, 30), vec3(0, 0, -9.81))).toBeCloseTo(-30); // sign flips with the sign of up
    expect(yawRateDegPerS(vec3(30, 0, 0), vec3(0, 0, 1))).toBeCloseTo(0);
    const up = vec3(0.8, 0.2, -0.5);
    const perp = vec3(0.2, -0.8, 0); // orthogonal to up
    const rot = vec3(30 * up.x + 50 * perp.x, 30 * up.y + 50 * perp.y, 30 * up.z + 50 * perp.z);
    const len = Math.hypot(up.x, up.y, up.z);
    expect(yawRateDegPerS(rot, vscale(up, 9.81 / len))).toBeCloseTo(30 * len);
    expect(yawRateDegPerS(vec3(1, 1, 1), vec3(0, 0, 0))).toBeNull();
  });

  it('step: dead zone 2 deg/s, gain 2, radians per sample', () => {
    const dt = 1 / 60;
    expect(yawStepRad(1.5, dt, T)).toBe(0);
    expect(yawStepRad(32, dt, T)).toBeCloseTo(2 * 30 * DEG2RAD * dt, 9);
    expect(yawStepRad(-32, dt, T)).toBeCloseTo(-2 * 30 * DEG2RAD * dt, 9);
    expect(yawStepRad(5000, dt, T)).toBeCloseTo(2 * (600 - 2) * DEG2RAD * dt, 9);
  });

  it('a 45 deg turn of the phone over 1 s becomes 90 deg of view', () => {
    let total = 0;
    for (let i = 0; i < 60; i += 1) total += yawStepRad(45, 1 / 60, T);
    expect(total).toBeCloseTo((2 * (45 - 2) * Math.PI) / 180, 6);
  });
});

describe('orientation fallback', () => {
  it('up from beta/gamma: flat, upright, right side down', () => {
    const flat = upFromOrientation(0, 0);
    expect(flat.x).toBeCloseTo(0);
    expect(flat.y).toBeCloseTo(0);
    expect(flat.z).toBeCloseTo(1);
    const upright = upFromOrientation(90, 0);
    expect(upright.y).toBeCloseTo(1);
    const tilted = upFromOrientation(0, 45);
    expect(tilted.x).toBeCloseTo(-Math.SQRT1_2);
    expect(tilted.z).toBeCloseTo(Math.SQRT1_2);
  });

  it('aim heading increases with alpha (counter-clockwise) and stays continuous near beta = 90', () => {
    const h0 = aimHeadingDeg(0, 90, 0);
    const h1 = aimHeadingDeg(10, 90, 0);
    expect(wrapDeg(h1 - h0)).toBeCloseTo(10);
    const hA = aimHeadingDeg(30, 89, 0);
    const hB = aimHeadingDeg(30, 91, 0);
    expect(Math.abs(wrapDeg(hB - hA))).toBeLessThan(3);
    const flatA = aimHeadingDeg(30, 0, 0);
    const flatB = aimHeadingDeg(40, 0, 0);
    expect(wrapDeg(flatB - flatA)).toBeCloseTo(10);
  });
});

describe('shake detector', () => {
  const feed = (d: ShakeDetector, series: Array<[number, number]>): void => {
    for (const [t, mag] of series) d.push(mag, t);
  };

  it('counts peaks above 15 m/s^2 with a refractory period and re-arm', () => {
    const d = new ShakeDetector(T);
    feed(d, [
      [0, 2],
      [16, 20],
      [32, 25], // still above threshold: same peak
      [48, 3], // re-arm
      [64, 30], // only 48 ms after the last peak: refractory, no count
      [200, 2],
      [216, 22], // second peak
    ]);
    expect(d.level(216)).toBeCloseTo(0.5);
  });

  it('four peaks in a second give full shake, which decays after the window', () => {
    const d = new ShakeDetector(T);
    for (const t0 of [0, 200, 400, 600]) feed(d, [[t0, 30], [t0 + 50, 1]]);
    expect(d.level(650)).toBe(1);
    expect(d.level(1250)).toBeCloseTo(0.5); // peaks at 0 and 200 fell out
    expect(d.level(1700)).toBe(0);
  });

  it('gentle motion never counts', () => {
    const d = new ShakeDetector(T);
    for (let t = 0; t < 2000; t += 16) d.push(5 + 4 * Math.sin(t / 50), t);
    expect(d.level(2000)).toBe(0);
  });
});

describe('gravity sign detector', () => {
  it('locks +1 when ag.y agrees with sin(beta), -1 when opposite, ignores flat poses', () => {
    const plus = new GravitySignDetector(10);
    for (let i = 0; i < 10; i += 1) plus.push(9.5, 80);
    expect(plus.locked).toBe(1);
    const minus = new GravitySignDetector(10);
    for (let i = 0; i < 10; i += 1) minus.push(-9.5, 80);
    expect(minus.locked).toBe(-1);
    const flat = new GravitySignDetector(10);
    for (let i = 0; i < 20; i += 1) flat.push(9.5, 10);
    expect(flat.locked).toBeNull();
  });
});

describe('low-pass', () => {
  it('step response: alpha = dt / (tau + dt)', () => {
    const lp = new LowPassVec3(0.1);
    lp.push(vec3(0, 0, 0), 0.1);
    const v = lp.push(vec3(1, 0, 0), 0.1);
    expect(v.x).toBeCloseTo(0.5);
  });
});

describe('simulator matches the real conventions', () => {
  it('android ag points up, ios ag points down, gyro follows the up axis', () => {
    const p = defaultSimPose();
    p.pitchDeg = 0;
    p.yawRateDegPerS = 30;
    const rng = (): number => 0.5; // no noise
    const android = simMotionSample(p, 0, rng);
    expect(android.ag?.x).toBeCloseTo(G); // landscape top-left: sky is +x
    p.platform = 'ios';
    const ios = simMotionSample(p, 0, rng);
    expect(ios.ag?.x).toBeCloseTo(-G);
    const up = simUpVector(p);
    expect(yawRateDegPerS(android.rot ?? vec3(0, 0, 0), up)).toBeCloseTo(30);
    const o = simOrientationSample(p, 0);
    const back = upFromOrientation(o.beta ?? 0, o.gamma ?? 0);
    expect(back.x).toBeCloseTo(up.x);
    expect(back.y).toBeCloseTo(up.y);
    expect(back.z).toBeCloseTo(up.z);
  });
});

describe('sender samples', () => {
  it('collects edges into running totals so a lost packet loses nothing', () => {
    const edges = collectEdges(['fire', 'power1', 'fire', 'power0']);
    expect(edges).toEqual({ fireTaps: 2, recenter: false, calibrate: false, uses: [1, 0] });
    const totals = newTotals();
    applyEdges(totals, edges, 0.02);
    expect(totals).toEqual({ yaw: 0.02, ep: 0, fc: 2, uc: 2, lastUse: 0 });
    const still = { steer: 0, dYawRad: 0.02, shake: 0, gasHeld: false, brakeHeld: false, fireHeld: false };
    expect(buildInputSample('gunner', still, totals, edges)).toEqual({
      t: 'in', role: 'gunner', dYaw: 0.02, yaw: 0.02, ep: 0, fire: false, fc: 2, recenter: false, use: null, uc: 0,
    });
    expect(buildInputSample('gunner', still, totals, edges, true)).toMatchObject({ use: 0, uc: 2 });

    const recenter = collectEdges(['recenter']);
    applyEdges(totals, recenter, 0.5);
    expect(totals.yaw).toBe(0);
    expect(totals.ep).toBe(1);
    expect(buildInputSample('gunner', still, totals, recenter)).toMatchObject({ dYaw: 0, yaw: 0, ep: 1, recenter: true });
  });

  it('builds pilot, engineer and neutral samples', () => {
    const totals = newTotals();
    const pilot = buildInputSample('pilot', { steer: -0.4, dYawRad: 0, shake: 0, gasHeld: true, brakeHeld: false, fireHeld: false }, totals, collectEdges([]));
    expect(pilot).toEqual({ t: 'in', role: 'pilot', steer: -0.4, gas: true, brake: false });
    const edges = collectEdges(['power0']);
    applyEdges(totals, edges, 0);
    const eng = buildInputSample('engineer', { steer: 0, dYawRad: 0, shake: 0.75, gasHeld: false, brakeHeld: false, fireHeld: false }, totals, edges);
    expect(eng).toEqual({ t: 'in', role: 'engineer', use: 0, uc: 1, shake: 0.75 });
    expect(neutralSample('pilot', totals)).toEqual({ t: 'in', role: 'pilot', steer: 0, gas: false, brake: false });
    expect(neutralSample('engineer', totals)).toEqual({ t: 'in', role: 'engineer', use: 0, uc: 1, shake: 0 });
  });
});
