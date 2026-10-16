// src/phone/sensorSim.ts
// Desktop simulator: a fake SensorSource driven by the keyboard so the phone screens can
// be developed on a laptop. It synthesises devicemotion/deviceorientation samples from a
// virtual phone pose using the same frame conventions as the real device, including the
// iOS gravity sign, so the whole pipeline (not just the UI) runs on the desktop.
//
// Keys: A / D roll the wheel (hold), W / S pitch, Left / Right turn (yaw rate),
// Space shake, I toggle iOS/Android sign, N toggle "no gyroscope" (orientation fallback),
// R reset the pose. Enable with ?sim=1 on the /play route.

import { DEG2RAD, G, RAD2DEG, vec3, type Vec3 } from './sensorMath';
import type { MotionSample, OrientationSample, SensorSource } from './sensors';

export type SimPlatform = 'android' | 'ios';

export interface SimPose {
  /** Wheel angle, degrees, positive = clockwise as the player sees it. */
  wheelDeg: number;
  /** Pitch of the screen away from vertical, degrees (0 upright, 90 flat face up). */
  pitchDeg: number;
  /** Turn rate about the vertical, deg/s, positive = turning left. */
  yawRateDegPerS: number;
  /** Accumulated heading, degrees. */
  headingDeg: number;
  shaking: boolean;
  platform: SimPlatform;
  gyro: boolean;
  /** Which landscape: true = top of the phone on the left (home button right). */
  topLeft: boolean;
}

export function defaultSimPose(): SimPose {
  return {
    wheelDeg: 0,
    pitchDeg: 20,
    yawRateDegPerS: 0,
    headingDeg: 0,
    shaking: false,
    platform: 'android',
    gyro: true,
    topLeft: true,
  };
}

/** Sky direction in the device frame for a landscape phone at the given wheel and pitch. */
export function simUpVector(p: SimPose): Vec3 {
  const phi = (p.topLeft ? 90 : -90) - p.wheelDeg; // roll angle as rollAngleDeg() measures it
  const inPlane = Math.cos(p.pitchDeg * DEG2RAD);
  return vec3(inPlane * Math.sin(phi * DEG2RAD), inPlane * Math.cos(phi * DEG2RAD), -Math.sin(p.pitchDeg * DEG2RAD));
}

/** Synthesises one devicemotion sample from the pose. */
export function simMotionSample(p: SimPose, t: number, rng: () => number = Math.random): MotionSample {
  const up = simUpVector(p);
  const sign = p.platform === 'ios' ? -1 : 1;
  const noise = (): number => (rng() - 0.5) * 0.1;
  const ag = vec3(up.x * G * sign + noise(), up.y * G * sign + noise(), up.z * G * sign + noise());
  const shakeMag = p.shaking ? 18 + rng() * 20 : 0;
  const shakeDir = rng() < 0.5 ? -1 : 1;
  const a = vec3(shakeDir * shakeMag + noise(), noise(), noise());
  const rot = p.gyro
    ? vec3(up.x * p.yawRateDegPerS + noise() * 5, up.y * p.yawRateDegPerS + noise() * 5, up.z * p.yawRateDegPerS + noise() * 5)
    : null;
  return { t, ag: p.shaking ? vec3(ag.x + a.x, ag.y + a.y, ag.z + a.z) : ag, a, rot };
}

/** Synthesises one deviceorientation sample (spec angles) from the pose. */
export function simOrientationSample(p: SimPose, t: number): OrientationSample {
  const up = simUpVector(p);
  const beta = Math.asin(Math.max(-1, Math.min(1, up.y))) * RAD2DEG;
  const gamma = Math.atan2(-up.x, up.z) * RAD2DEG;
  return { t, alpha: ((p.headingDeg % 360) + 360) % 360, beta, gamma, compass: null };
}

export class KeyboardSensorSource implements SensorSource {
  readonly pose: SimPose = defaultSimPose();
  private readonly motionCbs = new Set<(s: MotionSample) => void>();
  private readonly orientationCbs = new Set<(s: OrientationSample) => void>();
  private readonly keys = new Set<string>();
  private timer: number | null = null;
  private lastT = 0;

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    this.keys.add(e.code);
    if (e.code === 'KeyI') this.pose.platform = this.pose.platform === 'ios' ? 'android' : 'ios';
    if (e.code === 'KeyN') this.pose.gyro = !this.pose.gyro;
    if (e.code === 'KeyL') this.pose.topLeft = !this.pose.topLeft;
    if (e.code === 'KeyR') Object.assign(this.pose, defaultSimPose(), { platform: this.pose.platform });
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  constructor(private readonly hz = 60) {}

  start(): void {
    if (this.timer !== null) return;
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    this.lastT = performance.now();
    this.timer = window.setInterval(() => this.tick(), 1000 / this.hz);
  }

  stop(): void {
    if (this.timer === null) return;
    window.clearInterval(this.timer);
    this.timer = null;
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    this.keys.clear();
  }

  onMotion(cb: (s: MotionSample) => void): () => void {
    this.motionCbs.add(cb);
    return () => this.motionCbs.delete(cb);
  }

  onOrientation(cb: (s: OrientationSample) => void): () => void {
    this.orientationCbs.add(cb);
    return () => this.orientationCbs.delete(cb);
  }

  private tick(): void {
    const t = performance.now();
    const dt = Math.min((t - this.lastT) / 1000, 0.1);
    this.lastT = t;
    const p = this.pose;
    const wheelTarget = (this.keys.has('KeyD') ? 35 : 0) - (this.keys.has('KeyA') ? 35 : 0);
    p.wheelDeg += (wheelTarget - p.wheelDeg) * Math.min(1, dt * 6); // ease like a wrist
    if (this.keys.has('KeyW')) p.pitchDeg = Math.max(-30, p.pitchDeg - 60 * dt);
    if (this.keys.has('KeyS')) p.pitchDeg = Math.min(85, p.pitchDeg + 60 * dt);
    p.yawRateDegPerS = (this.keys.has('ArrowLeft') ? 90 : 0) - (this.keys.has('ArrowRight') ? 90 : 0);
    p.headingDeg += p.yawRateDegPerS * dt;
    p.shaking = this.keys.has('Space');
    const m = simMotionSample(p, t);
    for (const cb of this.motionCbs) cb(m);
    const o = simOrientationSample(p, t);
    for (const cb of this.orientationCbs) cb(o);
  }
}

/** True when the desktop simulator should replace the real sensors. */
export function wantsSimulator(search: string = typeof location === 'undefined' ? '' : location.search): boolean {
  return new URLSearchParams(search).get('sim') === '1';
}
