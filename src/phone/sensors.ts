// src/phone/sensors.ts
// Browser plumbing for the phone sensors: permission, event listeners, the 1 s watchdog
// and the filter pipeline that turns raw devicemotion events into steer / dYaw / shake.
// The maths lives in sensorMath.ts; this file only touches the DOM.

import {
  DEFAULT_SENSOR_TUNING,
  G,
  GravitySignDetector,
  LowPassVec3,
  ShakeDetector,
  aimHeadingDeg,
  rollAngleDeg,
  softDeadZone,
  steerFromGravity,
  vec3,
  vlen,
  vscale,
  vsub,
  wrapDeg,
  yawRateDegPerS,
  yawStepRad,
  type SensorTuning,
  type Vec3,
} from './sensorMath';

// ---------------------------------------------------------------- sample types

export interface MotionSample {
  /** performance.now() when the event was handled, ms. Never trust event.interval. */
  readonly t: number;
  /** accelerationIncludingGravity in m/s^2, raw platform sign, or null. */
  readonly ag: Vec3 | null;
  /** acceleration without gravity in m/s^2, or null (no linear-acceleration sensor). */
  readonly a: Vec3 | null;
  /** rotationRate alpha, beta, gamma = deg/s about device x, y, z, or null (no gyroscope). */
  readonly rot: Vec3 | null;
}

export interface OrientationSample {
  readonly t: number;
  readonly alpha: number | null;
  readonly beta: number | null;
  readonly gamma: number | null;
  /** iOS only: magnetic heading, clockwise from north, 0..360. */
  readonly compass: number | null;
}

/** Anything that produces samples: the real device or the desktop simulator. */
export interface SensorSource {
  start(): void;
  stop(): void;
  onMotion(cb: (s: MotionSample) => void): () => void;
  onOrientation(cb: (s: OrientationSample) => void): () => void;
}

// ---------------------------------------------------------------- platform

/** WebKit on a touch device: every iOS browser, and iPadOS Safari that claims to be a Mac. */
export function isIOSLike(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const apple = navigator.vendor.startsWith('Apple');
  return /iPhone|iPad|iPod/.test(ua) || (apple && navigator.maxTouchPoints > 1);
}

/** +1: accelerationIncludingGravity points to the sky (spec, Chrome Android). -1: iOS. */
export function guessGravitySign(): 1 | -1 {
  return isIOSLike() ? -1 : 1;
}

// ---------------------------------------------------------------- permission

/** The static exists on iOS 13+ WebKit and on Chrome 151+; lib.dom does not declare it. */
interface MotionPermissionApi {
  requestPermission?: () => Promise<PermissionState>;
}

function motionEventApi(): MotionPermissionApi | null {
  if (typeof DeviceMotionEvent === 'undefined') return null;
  return DeviceMotionEvent as unknown as MotionPermissionApi;
}

export type MotionAccessReason = 'insecure' | 'unsupported' | 'denied' | 'needs-gesture' | 'error';

export type MotionAccessResult =
  | { readonly ok: true; readonly prompted: boolean }
  | { readonly ok: false; readonly reason: MotionAccessReason; readonly message: string };

/**
 * Call this synchronously inside the "Enable controls" tap handler, before any await:
 * WebKit rejects the prompt with NotAllowedError unless it is processing a user gesture.
 * One grant covers devicemotion and deviceorientation (WebKit keeps one state per origin).
 */
export function requestMotionAccess(): Promise<MotionAccessResult> {
  if (typeof window !== 'undefined' && !window.isSecureContext) {
    return Promise.resolve({
      ok: false,
      reason: 'insecure',
      message: 'This page is not on https, so the phone will not share its motion sensors. Open the https link from the QR code.',
    });
  }
  const api = motionEventApi();
  if (api === null) {
    return Promise.resolve({
      ok: false,
      reason: 'unsupported',
      message: 'This browser has no motion sensors. Use Safari on iPhone or Chrome on Android.',
    });
  }
  if (typeof api.requestPermission !== 'function') {
    // Android Chrome before 151, Firefox: no prompt, events just flow on https.
    return Promise.resolve({ ok: true, prompted: false });
  }
  let pending: Promise<PermissionState>;
  try {
    pending = api.requestPermission();
  } catch (err: unknown) {
    return Promise.resolve({ ok: false, reason: 'error', message: describeError(err) });
  }
  return pending.then(
    (state): MotionAccessResult =>
      state === 'granted'
        ? { ok: true, prompted: true }
        : {
            ok: false,
            reason: 'denied',
            message:
              'Motion access was refused. Safari remembers that until you close this tab: close it, scan the QR again and tap Allow.',
          },
    (err: unknown): MotionAccessResult => {
      const name = err instanceof Error ? err.name : '';
      if (name === 'NotAllowedError') {
        return { ok: false, reason: 'needs-gesture', message: 'Please tap Enable controls again.' };
      }
      return { ok: false, reason: 'error', message: describeError(err) };
    },
  );
}

function describeError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

// ---------------------------------------------------------------- device source

interface WebKitOrientationEvent extends DeviceOrientationEvent {
  readonly webkitCompassHeading?: number;
}

function toVec(a: DeviceMotionEventAcceleration | null): Vec3 | null {
  if (a === null || a.x === null || a.y === null || a.z === null) return null;
  return vec3(a.x, a.y, a.z);
}

function toRot(r: DeviceMotionEventRotationRate | null): Vec3 | null {
  // Chrome Android gives an object with null fields when there is no gyroscope; iOS gives null.
  if (r === null || r.alpha === null || r.beta === null || r.gamma === null) return null;
  return vec3(r.alpha, r.beta, r.gamma);
}

export class DeviceSensorSource implements SensorSource {
  private readonly motionCbs = new Set<(s: MotionSample) => void>();
  private readonly orientationCbs = new Set<(s: OrientationSample) => void>();
  private running = false;

  private readonly handleMotion = (e: DeviceMotionEvent): void => {
    const sample: MotionSample = {
      t: performance.now(),
      ag: toVec(e.accelerationIncludingGravity),
      a: toVec(e.acceleration),
      rot: toRot(e.rotationRate),
    };
    for (const cb of this.motionCbs) cb(sample);
  };

  private readonly handleOrientation = (e: DeviceOrientationEvent): void => {
    const compass = (e as WebKitOrientationEvent).webkitCompassHeading;
    const sample: OrientationSample = {
      t: performance.now(),
      alpha: e.alpha,
      beta: e.beta,
      gamma: e.gamma,
      compass: typeof compass === 'number' && Number.isFinite(compass) ? compass : null,
    };
    for (const cb of this.orientationCbs) cb(sample);
  };

  start(): void {
    if (this.running) return;
    this.running = true;
    window.addEventListener('devicemotion', this.handleMotion);
    window.addEventListener('deviceorientation', this.handleOrientation);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    window.removeEventListener('devicemotion', this.handleMotion);
    window.removeEventListener('deviceorientation', this.handleOrientation);
  }

  onMotion(cb: (s: MotionSample) => void): () => void {
    this.motionCbs.add(cb);
    return () => this.motionCbs.delete(cb);
  }

  onOrientation(cb: (s: OrientationSample) => void): () => void {
    this.orientationCbs.add(cb);
    return () => this.orientationCbs.delete(cb);
  }
}

// ---------------------------------------------------------------- watchdog

export type MotionHealth = 'waiting' | 'ok' | 'no-events' | 'stalled';

/**
 * Tells the player when motion data is not flowing: nothing within `firstMs` of start
 * (http, denied, desktop) or a gap of `stallMs` while the page is visible (Safari stops
 * events in the background and after the screen locks).
 */
export function createMotionWatchdog(
  onChange: (health: MotionHealth) => void,
  firstMs = 1000,
  stallMs = 2000,
): { feed(): void; arm(): void; dispose(): void } {
  let lastT = Number.NaN;
  let armedAt = performance.now();
  let health: MotionHealth = 'waiting';
  const set = (h: MotionHealth): void => {
    if (h !== health) {
      health = h;
      onChange(h);
    }
  };
  const check = (): void => {
    if (document.visibilityState !== 'visible') return;
    const now = performance.now();
    if (Number.isNaN(lastT)) {
      if (now - armedAt > firstMs) set('no-events');
    } else if (now - lastT > stallMs) {
      set('stalled');
    }
  };
  const timer = window.setInterval(check, 250);
  const onVisibility = (): void => {
    if (document.visibilityState === 'visible') {
      // Give the sensors a moment to restart before shouting.
      armedAt = performance.now();
      if (!Number.isNaN(lastT)) lastT = armedAt;
    }
  };
  document.addEventListener('visibilitychange', onVisibility);
  return {
    feed(): void {
      lastT = performance.now();
      set('ok');
    },
    arm(): void {
      lastT = Number.NaN;
      armedAt = performance.now();
      set('waiting');
    },
    dispose(): void {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    },
  };
}

// ---------------------------------------------------------------- pipeline

export type YawSource = 'gyro' | 'orientation' | 'none';

export interface ControllerSnapshot {
  readonly steer: number;
  readonly steerAngleDeg: number;
  readonly steerWeak: boolean;
  readonly steerCalibrated: boolean;
  /** Radians accumulated since the last drain(). */
  readonly dYawRad: number;
  /** Radians accumulated since the last recenter, for the phone's own compass needle. */
  readonly yawSinceRecenterRad: number;
  readonly yawSource: YawSource;
  readonly shake: number;
  /** Sign in use for accelerationIncludingGravity, after detection and the invert toggle. */
  readonly gravitySign: 1 | -1;
  readonly lastMotionT: number;
}

export interface PipelineOptions {
  readonly tuning?: SensorTuning;
  /** Initial guess; the detector may override it. Default: guessGravitySign(). */
  readonly gravitySign?: 1 | -1;
  /** Player-visible "invert aim" toggle. */
  readonly invertAim?: boolean;
}

const INVERT_AIM_KEY = 'gr.invertAim';

export function loadInvertAim(): boolean {
  try {
    return localStorage.getItem(INVERT_AIM_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveInvertAim(on: boolean): void {
  try {
    localStorage.setItem(INVERT_AIM_KEY, on ? '1' : '0');
  } catch {
    // Private mode or storage disabled: the toggle just does not persist.
  }
}

/** Turns samples into the filtered controller state. One instance per phone session. */
export class ControllerPipeline {
  private readonly t: SensorTuning;
  private readonly upSteer: LowPassVec3;
  private readonly upYaw: LowPassVec3;
  private readonly gShake: LowPassVec3;
  private readonly shaker: ShakeDetector;
  private readonly signDetector = new GravitySignDetector();
  private readonly guessedSign: 1 | -1;
  private invertAim: boolean;

  private lastMotionT = Number.NaN;
  private lastBeta: number | null = null;
  private calibrationDeg: number | null = null;
  private steer = 0;
  private steerAngleDeg = 0;
  private steerWeak = true;
  private dYawRad = 0;
  private yawSinceRecenterRad = 0;
  private yawSource: YawSource = 'none';
  private shake = 0;
  private lastHeadingDeg: number | null = null;
  private lastOrientationT = Number.NaN;
  private gyroSeen = false;

  constructor(opts: PipelineOptions = {}) {
    this.t = opts.tuning ?? DEFAULT_SENSOR_TUNING;
    this.guessedSign = opts.gravitySign ?? guessGravitySign();
    this.invertAim = opts.invertAim ?? false;
    this.upSteer = new LowPassVec3(this.t.steerGravityTauS);
    this.upYaw = new LowPassVec3(this.t.yawGravityTauS);
    this.gShake = new LowPassVec3(this.t.shakeGravityTauS);
    this.shaker = new ShakeDetector(this.t);
  }

  get gravitySign(): 1 | -1 {
    return this.signDetector.locked ?? this.guessedSign;
  }

  setInvertAim(on: boolean): void {
    this.invertAim = on;
  }

  attach(source: SensorSource): () => void {
    const offMotion = source.onMotion((s) => this.pushMotion(s));
    const offOrientation = source.onOrientation((s) => this.pushOrientation(s));
    return () => {
      offMotion();
      offOrientation();
    };
  }

  /** CALIBRATE for the pilot: the current wheel angle becomes straight. False if too flat. */
  calibrateSteer(): boolean {
    const up = this.upSteer.value;
    if (up === null) return false;
    const r = steerFromGravity(up, 0, this.t);
    if (r.weak) return false;
    this.calibrationDeg = rollAngleDeg(up);
    return true;
  }

  /** RECENTER / calibrate for the gunner and respawn: clears local drift bookkeeping. */
  recenterYaw(): void {
    this.yawSinceRecenterRad = 0;
    this.dYawRad = 0;
  }

  /** Called after a visibility gap so stale filter state does not produce a jump. */
  resetFilters(): void {
    this.upSteer.reset();
    this.upYaw.reset();
    this.gShake.reset();
    this.shaker.reset();
    this.lastMotionT = Number.NaN;
    this.lastHeadingDeg = null;
    this.lastOrientationT = Number.NaN;
    this.dYawRad = 0;
  }

  snapshot(): ControllerSnapshot {
    return {
      steer: this.steer,
      steerAngleDeg: this.steerAngleDeg,
      steerWeak: this.steerWeak,
      steerCalibrated: this.calibrationDeg !== null,
      dYawRad: this.dYawRad,
      yawSinceRecenterRad: this.yawSinceRecenterRad,
      yawSource: this.yawSource,
      shake: this.shake,
      gravitySign: this.gravitySign,
      lastMotionT: this.lastMotionT,
    };
  }

  /** Returns the accumulated yaw for one packet and resets it. */
  drainYaw(): number {
    const d = this.dYawRad;
    this.dYawRad = 0;
    return d;
  }

  pushMotion(s: MotionSample): void {
    const dtS = Number.isNaN(this.lastMotionT) ? 1 / 60 : Math.min(Math.max((s.t - this.lastMotionT) / 1000, 0), 0.1);
    this.lastMotionT = s.t;

    if (s.ag !== null) {
      this.signDetector.push(s.ag.y, this.lastBeta);
      const up = vscale(s.ag, this.gravitySign);
      const upS = this.upSteer.push(up, dtS);
      const upY = this.upYaw.push(up, dtS);

      if (this.calibrationDeg !== null) {
        const r = steerFromGravity(upS, this.calibrationDeg, this.t);
        this.steerAngleDeg = r.angleDeg;
        this.steerWeak = r.weak;
        if (!r.weak) this.steer = r.steer; // hold the last value while the phone is flat
      } else {
        this.steerWeak = steerFromGravity(upS, 0, this.t).weak;
      }

      if (s.rot !== null) {
        this.gyroSeen = true;
        this.yawSource = 'gyro';
        const rate = yawRateDegPerS(s.rot, upY);
        if (rate !== null) {
          const step = yawStepRad(rate, dtS, this.t) * (this.invertAim ? -1 : 1);
          this.dYawRad += step;
          this.yawSinceRecenterRad += step;
        }
      } else if (!this.gyroSeen) {
        this.yawSource = 'orientation';
      }

      // Shake: prefer the linear-acceleration field, else subtract a slow gravity estimate.
      const lin = s.a ?? vsub(s.ag, this.gShake.push(s.ag, dtS));
      this.shaker.push(vlen(lin), s.t);
    } else if (s.a !== null) {
      this.shaker.push(vlen(s.a), s.t);
    }
    this.shake = this.shaker.level(s.t);
  }

  pushOrientation(s: OrientationSample): void {
    this.lastBeta = s.beta;
    if (this.yawSource === 'gyro') return;
    if (s.beta === null || s.gamma === null) return;
    // iOS reports a relative alpha; if it is missing, use the compass (opposite sign).
    const alpha = s.alpha ?? (s.compass === null ? null : 360 - s.compass);
    if (alpha === null) return;
    const heading = aimHeadingDeg(alpha, s.beta, s.gamma);
    const dtS = Number.isNaN(this.lastOrientationT) ? 0 : Math.min((s.t - this.lastOrientationT) / 1000, 0.1);
    if (this.lastHeadingDeg !== null && dtS > 0) {
      const dDeg = wrapDeg(heading - this.lastHeadingDeg);
      const rate = dDeg / dtS; // deg/s, same sign convention as the gyro path
      const step = yawStepRad(rate, dtS, this.t) * (this.invertAim ? -1 : 1);
      this.dYawRad += step;
      this.yawSinceRecenterRad += step;
      this.yawSource = 'orientation';
    }
    this.lastHeadingDeg = heading;
    this.lastOrientationT = s.t;
  }
}

// ---------------------------------------------------------------- enable controls

/** How long the one-tap flow waits for the motion permission prompt before giving up. */
const MOTION_PROMPT_TIMEOUT_MS = 8000;

export interface EnableControlsDeps {
  /** Kick off the wake lock request; must not await before being called. */
  readonly requestWakeLock: () => Promise<boolean>;
  /** Android: fullscreen + landscape lock attempt; returns false on iPhone. */
  readonly requestFullscreen: () => Promise<boolean>;
}

export interface EnableControlsResult {
  readonly motion: MotionAccessResult;
  readonly wakeLock: boolean;
  readonly fullscreen: boolean;
}

/**
 * The one-tap flow. Everything that needs the user gesture is started synchronously
 * (motion permission, then wake lock, then fullscreen), then awaited together.
 * Call directly from the pointerup/click handler of the button.
 */
export function enableControls(deps: EnableControlsDeps): Promise<EnableControlsResult> {
  // Order matters: requestFullscreen() consumes the tap's user activation (Fullscreen spec), and
  // the motion prompt needs that activation. Motion is the one that must work, so it asks first.
  // A permission prompt that never answers (desktop Chromium, embedded webviews) must not freeze the tap.
  const motion = Promise.race([
    requestMotionAccess(),
    new Promise<MotionAccessResult>((resolve) =>
      setTimeout(() => resolve({ ok: false, reason: 'error', message: 'No answer from the motion permission prompt. Tap Enable controls again.' }), MOTION_PROMPT_TIMEOUT_MS),
    ),
  ]);
  const wakeLock = deps.requestWakeLock().catch(() => false);
  const fullscreen = deps.requestFullscreen().catch(() => false);
  return Promise.all([motion, wakeLock, fullscreen]).then(([m, w, f]) => ({ motion: m, wakeLock: w, fullscreen: f }));
}

/** Helper for the HUD: the gravity sign and the gyro availability in one line. */
export function describeSensors(snapshot: ControllerSnapshot): string {
  const sign = snapshot.gravitySign === 1 ? 'ag=+up' : 'ag=-up (iOS)';
  return `${sign} yaw:${snapshot.yawSource} shake:${snapshot.shake.toFixed(2)} g=${G.toFixed(2)}`;
}

/** Exposed so the UI can draw the dead zone of the aim without re-deriving it. */
export function deadZonedYawRate(rateDegPerS: number, tuning: SensorTuning = DEFAULT_SENSOR_TUNING): number {
  return softDeadZone(rateDegPerS, tuning.yawDeadDegPerS);
}
