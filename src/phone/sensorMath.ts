// src/phone/sensorMath.ts
// Pure sensor maths for the phone controller. No DOM access, so vitest runs it in node.
//
// Frames (W3C Device Orientation spec, section 3): device x points right, y points
// to the top of the screen, z points out of the screen towards the viewer.
// `up` always means "the unit vector pointing to the sky, expressed in the device
// frame". Spec and Chrome Android report accelerationIncludingGravity = +9.81 * up
// (proper acceleration); iOS WebKit reports -9.81 * up. See sensors.ts for the sign fix.

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export const G = 9.80665;
export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

export const vec3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
export const vlen = (v: Vec3): number => Math.hypot(v.x, v.y, v.z);
export const vdot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const vsub = (a: Vec3, b: Vec3): Vec3 => vec3(a.x - b.x, a.y - b.y, a.z - b.z);
export const vscale = (v: Vec3, s: number): Vec3 => vec3(v.x * s, v.y * s, v.z * s);

export function vunit(v: Vec3, eps = 1e-6): Vec3 | null {
  const l = vlen(v);
  return l < eps ? null : vscale(v, 1 / l);
}

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Wraps degrees into (-180, 180]. */
export function wrapDeg(d: number): number {
  let r = d % 360;
  if (r <= -180) r += 360;
  else if (r > 180) r -= 360;
  return r;
}

/** Wraps radians into (-PI, PI]. */
export function wrapRad(r: number): number {
  let v = r % (2 * Math.PI);
  if (v <= -Math.PI) v += 2 * Math.PI;
  else if (v > Math.PI) v -= 2 * Math.PI;
  return v;
}

/** Removes `dead` from |v| and keeps the sign, so there is no jump at the edge. */
export function softDeadZone(v: number, dead: number): number {
  const a = Math.abs(v);
  return a <= dead ? 0 : Math.sign(v) * (a - dead);
}

/** All phone-side tunables. Mirror these in shared/config.ts (section 11 of SPEC.md). */
export interface SensorTuning {
  /** Wheel angles inside this band give steer 0 (spec: 4 deg). */
  readonly steerDeadDeg: number;
  /** Wheel angle that gives |steer| = 1 (spec: 35 deg). */
  readonly steerFullDeg: number;
  /** 0 = linear, 1 = cubic. 0.4 keeps small corrections gentle but full lock reachable. */
  readonly steerExpo: number;
  /** Time constant of the gravity low-pass used for steering, seconds. */
  readonly steerGravityTauS: number;
  /** Below this fraction of g in the screen plane the phone is too flat to steer. */
  readonly steerMinInPlane: number;
  /** Gyro turn rates below this are hand tremor and gyro bias (spec: about 2 deg/s). */
  readonly yawDeadDegPerS: number;
  /** View turns this many times faster than the phone (spec: 2). */
  readonly yawGain: number;
  /** Time constant of the gravity low-pass used as the vertical axis for yaw, seconds. */
  readonly yawGravityTauS: number;
  /** Rates above this are glitches; consumer gyros saturate around 2000 deg/s. */
  readonly yawMaxDegPerS: number;
  /** A peak of linear acceleration above this counts as one shake (spec: about 15 m/s^2). */
  readonly shakeThresholdMs2: number;
  /** The detector re-arms once the magnitude falls below this. */
  readonly shakeRearmMs2: number;
  /** Two peaks closer than this are one peak. */
  readonly shakeRefractoryMs: number;
  /** Peaks are counted over this sliding window. */
  readonly shakeWindowMs: number;
  /** Peaks per window that give shake = 1. */
  readonly shakePeaksForFull: number;
  /** Time constant of the gravity estimate used when `acceleration` is null, seconds. */
  readonly shakeGravityTauS: number;
  /** Input packets per second (spec: 30). */
  readonly sendHz: number;
}

/** The shape of `PHONE` in shared/config.ts (structural, so this file stays dependency-free). */
export interface PhoneConfigLike {
  readonly inputHz: number;
  readonly steerDeadZoneDeg: number;
  readonly steerFullLockDeg: number;
  readonly gravityFilterTau: number;
  readonly gyroGain: number;
  readonly gyroDeadZoneDegPerSec: number;
  readonly shakeThreshold: number;
  readonly shakeRefractorySec: number;
  readonly shakeFullRatePerSec: number;
}

/** Builds the tuning from the contract file: `tuningFromPhoneConfig(PHONE)`. */
export function tuningFromPhoneConfig(p: PhoneConfigLike): SensorTuning {
  return {
    ...DEFAULT_SENSOR_TUNING,
    sendHz: p.inputHz,
    steerDeadDeg: p.steerDeadZoneDeg,
    steerFullDeg: p.steerFullLockDeg,
    steerGravityTauS: p.gravityFilterTau,
    yawGain: p.gyroGain,
    yawDeadDegPerS: p.gyroDeadZoneDegPerSec,
    shakeThresholdMs2: p.shakeThreshold,
    shakeRefractoryMs: p.shakeRefractorySec * 1000,
    shakePeaksForFull: p.shakeFullRatePerSec,
  };
}

export const DEFAULT_SENSOR_TUNING: SensorTuning = {
  steerDeadDeg: 4,
  steerFullDeg: 35,
  steerExpo: 0.4,
  steerGravityTauS: 0.08,
  steerMinInPlane: 0.35,
  yawDeadDegPerS: 2,
  yawGain: 2,
  yawGravityTauS: 0.25,
  yawMaxDegPerS: 600,
  shakeThresholdMs2: 15,
  shakeRearmMs2: 8,
  shakeRefractoryMs: 120,
  shakeWindowMs: 1000,
  shakePeaksForFull: 4,
  shakeGravityTauS: 0.5,
  sendHz: 30,
};

/** One-pole low-pass on a vector with a time constant, so the sensor rate does not matter. */
export class LowPassVec3 {
  private v: Vec3 | null = null;

  constructor(private readonly tauS: number) {}

  get value(): Vec3 | null {
    return this.v;
  }

  reset(): void {
    this.v = null;
  }

  push(sample: Vec3, dtS: number): Vec3 {
    const prev = this.v;
    if (prev === null) {
      this.v = sample;
      return sample;
    }
    const a = dtS / (this.tauS + dtS);
    const next = vec3(prev.x + a * (sample.x - prev.x), prev.y + a * (sample.y - prev.y), prev.z + a * (sample.z - prev.z));
    this.v = next;
    return next;
  }
}

// ---------------------------------------------------------------- steering

/**
 * Angle of the in-plane gravity, degrees, measured from +y towards +x (clockwise on the
 * screen). Portrait upright = 0, landscape with the top of the phone on the left = +90,
 * top on the right = -90. Rotating the phone clockwise (as the pilot sees it) DEcreases it.
 * A global sign flip of `up` (iOS) shifts it by 180, which the calibration absorbs.
 */
export function rollAngleDeg(up: Vec3): number {
  return Math.atan2(up.x, up.y) * RAD2DEG;
}

/** Fraction of |up| that lies in the screen plane: 1 upright, 0 flat on a table. */
export function inPlaneFraction(up: Vec3): number {
  const l = vlen(up);
  return l === 0 ? 0 : Math.hypot(up.x, up.y) / l;
}

/** Dead zone, full lock and expo curve. Monotonic, odd, continuous, s(full) = 1. */
export function steerCurve(angleDeg: number, t: SensorTuning): number {
  const a = Math.abs(angleDeg);
  if (a <= t.steerDeadDeg) return 0;
  const x = clamp((a - t.steerDeadDeg) / (t.steerFullDeg - t.steerDeadDeg), 0, 1);
  const shaped = (1 - t.steerExpo) * x + t.steerExpo * x * x * x;
  return Math.sign(angleDeg) * shaped;
}

export interface SteerResult {
  /** -1..1, positive = phone turned clockwise = turn right. 0 while `weak`. */
  readonly steer: number;
  /** Wheel angle relative to the calibrated angle, degrees, positive = clockwise. */
  readonly angleDeg: number;
  /** True when the phone is too flat for the in-plane gravity to be trusted. */
  readonly weak: boolean;
}

/**
 * Wheel angle = calibrated roll angle - current roll angle (so clockwise is positive),
 * wrapped, then shaped. Works for either landscape and either platform sign because
 * both terms live on the same circle.
 */
export function steerFromGravity(up: Vec3, calibrationDeg: number, t: SensorTuning): SteerResult {
  const weak = inPlaneFraction(up) < t.steerMinInPlane;
  const angleDeg = wrapDeg(calibrationDeg - rollAngleDeg(up));
  return { steer: weak ? 0 : steerCurve(angleDeg, t), angleDeg, weak };
}

// ---------------------------------------------------------------- gunner yaw

/**
 * Turn rate about the world vertical, deg/s, from the gyroscope vector `rot`
 * (rotationRate.alpha, .beta, .gamma = rate about device x, y, z, right-hand rule, deg/s)
 * and the sky direction `up` in the device frame: yaw = rot . unit(up).
 * Positive = counter-clockwise seen from above = the gunner turns left.
 * Returns null when `up` is degenerate.
 */
export function yawRateDegPerS(rot: Vec3, up: Vec3): number | null {
  const u = vunit(up);
  return u === null ? null : vdot(rot, u);
}

/** Yaw increment in radians for one sensor sample: gain * deadzoned(rate) * dt. */
export function yawStepRad(rateDegPerS: number, dtS: number, t: SensorTuning): number {
  const r = clamp(rateDegPerS, -t.yawMaxDegPerS, t.yawMaxDegPerS);
  return t.yawGain * softDeadZone(r, t.yawDeadDegPerS) * DEG2RAD * dtS;
}

// ---------------------------------------------------------------- orientation fallback

/**
 * Sky direction in the device frame from the deviceorientation beta/gamma angles
 * (spec Z-X'-Y'' Tait-Bryan; third row of the rotation matrix). alpha does not matter.
 */
export function upFromOrientation(betaDeg: number, gammaDeg: number): Vec3 {
  const b = betaDeg * DEG2RAD;
  const g = gammaDeg * DEG2RAD;
  return vec3(-Math.cos(b) * Math.sin(g), Math.sin(b), Math.cos(b) * Math.cos(g));
}

/**
 * Heading, degrees in [0, 360), increasing counter-clockwise seen from above, of the
 * axis the gunner aims with: the back of the phone (-z) while it points roughly
 * horizontally, else the top of the phone (+y). Built from the full rotation matrix,
 * so unlike raw `alpha` it does not jump near the upright (beta = 90) gimbal lock.
 */
export function aimHeadingDeg(alphaDeg: number, betaDeg: number, gammaDeg: number): number {
  const a = alphaDeg * DEG2RAD;
  const b = betaDeg * DEG2RAD;
  const g = gammaDeg * DEG2RAD;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const cb = Math.cos(b);
  const sb = Math.sin(b);
  const cg = Math.cos(g);
  const sg = Math.sin(g);
  // Columns of R = Rz(a) Rx(b) Ry(g) are the device axes in the earth frame (x east, y north, z up).
  const zEast = ca * sg + sa * sb * cg;
  const zNorth = sa * sg - ca * sb * cg;
  const zUp = cb * cg;
  let east: number;
  let north: number;
  if (Math.abs(zUp) < 0.95) {
    east = -zEast;
    north = -zNorth;
  } else {
    east = -cb * sa;
    north = ca * cb;
  }
  const deg = Math.atan2(north, east) * RAD2DEG;
  return deg < 0 ? deg + 360 : deg;
}

// ---------------------------------------------------------------- shake

/** Counts peaks of |linear acceleration| and turns peaks-per-second into 0..1. */
export class ShakeDetector {
  private armed = true;
  private lastPeakT = Number.NEGATIVE_INFINITY;
  private peaks: number[] = [];

  constructor(private readonly t: SensorTuning) {}

  reset(): void {
    this.armed = true;
    this.lastPeakT = Number.NEGATIVE_INFINITY;
    this.peaks = [];
  }

  /** Feed |acceleration without gravity| in m/s^2 with the sample time in ms. */
  push(linMag: number, tMs: number): void {
    this.prune(tMs);
    if (this.armed) {
      if (linMag >= this.t.shakeThresholdMs2 && tMs - this.lastPeakT >= this.t.shakeRefractoryMs) {
        this.peaks.push(tMs);
        this.lastPeakT = tMs;
        this.armed = false;
      }
    } else if (linMag < this.t.shakeRearmMs2) {
      this.armed = true;
    }
  }

  /** 0..1: peaks in the window divided by `shakePeaksForFull`. */
  level(tMs: number): number {
    this.prune(tMs);
    return clamp(this.peaks.length / this.t.shakePeaksForFull, 0, 1);
  }

  private prune(tMs: number): void {
    let first = this.peaks[0];
    while (first !== undefined && tMs - first > this.t.shakeWindowMs) {
      this.peaks.shift();
      first = this.peaks[0];
    }
  }
}

// ---------------------------------------------------------------- gravity sign

/**
 * Decides whether accelerationIncludingGravity points up (+1, spec and Android) or down
 * (-1, iOS) by comparing its y component with sin(beta) from deviceorientation, which both
 * platforms report as +90 for an upright phone. Only votes while the phone is clearly
 * tilted (|sin beta| >= 0.5 and |ag.y| >= g/2), typically the lobby in portrait.
 */
export class GravitySignDetector {
  private votes = 0;
  private agree = 0;
  private lockedSign: 1 | -1 | null = null;

  constructor(private readonly neededVotes = 45) {}

  get locked(): 1 | -1 | null {
    return this.lockedSign;
  }

  push(agY: number, betaDeg: number | null): void {
    if (this.lockedSign !== null || betaDeg === null) return;
    const s = Math.sin(betaDeg * DEG2RAD);
    if (Math.abs(s) < 0.5 || Math.abs(agY) < 0.5 * G) return;
    this.votes += 1;
    if (Math.sign(agY) === Math.sign(s)) this.agree += 1;
    if (this.votes < this.neededVotes) return;
    const ratio = this.agree / this.votes;
    if (ratio >= 0.9) this.lockedSign = 1;
    else if (ratio <= 0.1) this.lockedSign = -1;
    else {
      this.votes = 0;
      this.agree = 0;
    }
  }
}
