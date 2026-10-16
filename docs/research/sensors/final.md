# Phone sensors and controller input

Target files: `src/phone/sensorMath.ts`, `src/phone/sensors.ts`, `src/phone/sensorSim.ts`, `src/phone/pads.ts`, `src/phone/pads.css`, `src/phone/wake.ts`, `src/phone/sender.ts`, `src/phone/controller.ts`, `src/phone/sensorMath.test.ts`. Every snippet below was typechecked with the repo's `tsconfig.json` settings (strict, `noUncheckedIndexedAccess`, bundler resolution, `@shared/*` alias) plus `noUnusedLocals` / `noUnusedParameters`, and the test file passes under the installed vitest 5.0.5 (20 tests). The modules were typechecked against the real `shared/protocol.ts`, `shared/state.ts` and `shared/config.ts` now in the repo (`InputPacket` with `seq`, `EngineerIn`, `GunnerIn.use` for teams of 2, `PHONE` tunables via `tuningFromPhoneConfig(PHONE)`). Nothing was written into the repo; the verified copies live in the scratchpad `research/sensors/proj/`.

## 1. The problem, in the words of SPEC.md

- "HTTPS everywhere. iOS only grants motion sensors and the camera on secure pages, and only after a user tap." (section 1). "Browsers: Safari on iOS 16+ and Chrome on Android for phones." "Phone orientation: landscape for Pilot and Gunner. Show a 'rotate your phone' overlay otherwise, since iOS ignores orientation lock." "Keyboard fallback: every role can be played from the scene PC keyboard."
- Lobby: "one big Enable controls button. That single tap is required: it triggers the iOS motion permission and the screen wake lock." (section 2)
- Pilot: "Hold the phone in landscape with both hands, like a steering wheel. Rotate it left or right to steer. Dead zone of 4°, full lock at 35°." "Right thumb holds GAS (the whole right half of the screen). Left thumb holds BRAKE / REVERSE (the left half)." "Calibration: during the countdown the Pilot holds the phone in a comfortable position and taps CALIBRATE. That angle becomes 'straight'." "Phone shows a big steering-wheel graphic that rotates live with the tilt." (section 3)
- Gunner: "turn it left or right to turn the view and the cannon. Gyroscope only: no dragging, no looking up or down." "FIRE: the whole right two-thirds of the screen is one big button. Tap to fire, hold for auto-fire where the weapon allows it." "RECENTER: a smaller button on the left." "Gain of 2 ... A small dead zone (about 2° per second) ignores hand tremor." "Reset: RECENTER snaps the view behind the bow and clears gyro drift." (sections 3 and 4)
- Engineer: "SHAKE TO BAIL ... Shaking empties it." "Portrait or landscape, either works."
- Every controller: "Phones send input 30 times per second, not on every sensor event." "Android vibrates on fire and on hit. iOS Safari has no vibration API, so iOS flashes the screen red instead." "The screen wake lock keeps phones awake for the whole round."
- Protocol (section 11): `PilotIn { steer: number /* -1..1 */, gas, brake }`, `GunnerIn { dYaw: number /* radians since last packet */, fire, recenter }`, `EngIn { use: 0 | 1 | null, shake: number /* 0..1 */ }`.
- Sensor notes (section 11): steering "from the gravity vector in DeviceMotionEvent.accelerationIncludingGravity (the angle of its x and y components, minus the calibration angle). Avoid the alpha, beta and gamma orientation angles: they jump when the phone is held upright, and alpha drifts." Gunner: "read DeviceMotionEvent.rotationRate (the gyroscope, degrees per second) and project it onto the low-pass-filtered gravity vector ... Check the sign on the first test and flip it if left turns right. If rotationRate is null ... fall back to changes in the alpha angle of deviceorientation." Shake: "count peaks where acceleration without gravity exceeds about 15 m/s²." "iOS: DeviceMotionEvent.requestPermission() must run inside a tap handler, on HTTPS. One permission covers both steering and gyro aim." "Wake lock: navigator.wakeLock.request('screen') in the same tap."
- Risk table (section 14): "iOS motion permission: Without HTTPS and a user tap, sensors silently return nothing. Test one iPhone through the tunnel during the base phase." Gate 1: "one phone steers a box boat on the TV."

## 2. Decisions and why

| # | Decision | Why | Rejected |
|---|----------|-----|----------|
| D1 | **Steering angle = `atan2(up.x, up.y)` of the low-passed gravity vector, minus the calibrated angle, wrapped to (-180, 180].** | Turning the wheel is a rotation about the screen normal (device z); that rotates the in-plane gravity components by exactly the wheel angle and leaves z alone, so the formula is exact at any constant pitch (checked numerically, section 3). Both landscape orientations just change the calibrated offset (+90 or -90), and the iOS sign inversion shifts both angles by 180, so the difference is unchanged. | `deviceorientation` beta/gamma: Euler angles hit gimbal lock exactly when the phone is upright (beta = 90), which is the pose we use; the spec itself warns about this. `asin(up.y)` (elevation of the long axis): sign flips between the two landscapes and cannot be absorbed by an offset. Raw per-event angles: 60 Hz accelerometer noise of about 0.5 deg peak to peak lands inside the 4 deg dead zone, so a short low-pass (80 ms) is enough. |
| D2 | **Gunner yaw rate = `rotationRate . unit(up)`, where `rotationRate = (alpha, beta, gamma)` is the rate about device **x, y, z** in that order.** | The projection of the body angular velocity onto the world vertical is the yaw rate whatever the tilt; checked numerically to 1e-12 at pitches 0 to 60 deg in both landscapes. The axis mapping is the surprise: the current W3C text says the `alpha` getter returns the **x**-axis rate, `beta` the y-axis, `gamma` the z-axis, and Chromium and WebKit both pass gyroscope x, y, z positionally into `(alpha, beta, gamma)`. The older reading "alpha about z, beta about x, gamma about y" is what the spec said before 2019 and it never matched any browser (w3c/deviceorientation#44). | Using `rotationRate.alpha` or `.gamma` alone: wrong unless the phone is held exactly upright or flat. `deviceorientation.alpha` deltas as the primary source: gimbal lock near upright, drift, and on iOS the value is relative to an arbitrary start. Generic Sensor API (`Gyroscope`): not implemented in Safari. |
| D3 | **Normalise gravity to a known direction before projecting: `up = sign * ag`, `sign = -1` on iOS, `+1` elsewhere, decided by a UA/vendor check, corrected by a physics detector, overridable by a persisted "Invert aim" toggle.** | iOS WebKit computes `accelerationIncludingGravity = (userAcceleration + gravity) * 9.80665` from CoreMotion without negation, so a phone lying flat reports z = -9.81; the spec example and Chrome Android give +9.81 (reaction to gravity). If `up` is not normalised the projected yaw flips sign on iOS. The detector compares `ag.y` with `sin(beta)` from `deviceorientation`, which is +90 for an upright phone on both Chrome Android and Safari, during the lobby (portrait, upright) and locks after 45 agreeing samples. | `typeof DeviceMotionEvent.requestPermission === 'function'` as the iOS test: Chrome shipped the same static in Chrome 151 (Intent to Ship 17 June 2026), so it stops being an iOS signal. Only "flip it on the first test": fine for one phone model, but 18 players bring both platforms at once. |
| D4 | **`dt` from `performance.now()` deltas, clamped to [0, 100 ms]; never from `event.interval`.** | WebKit passes `kMotionUpdateInterval = 1/60` (seconds) straight into the event, Chromium passes `kDefaultPumpDelayMicroseconds / 1000` (an integer 16, ms). Same field, different units. | `event.interval` with a unit heuristic. |
| D5 | **One `ControllerPipeline` keeps the filtered state; a separate 30 Hz `setTimeout` loop samples it, sends one message and resets the edge fields.** | 60 Hz sensor events through a tunnel are twice the packets for no gain, and the sim integrates `dYaw` anyway. `dYaw` is accumulated between sends so nothing is lost. The loop is scheduled on an absolute timeline (no drift) and resyncs after a hiccup instead of bursting. Edge fields: a FIRE tap shorter than 33 ms is latched so the next packet still carries `fire: true`; `recenter` and `use` are reported once. Hidden tab: sensors stop (the spec requires events only while visible), timers are throttled, so the loop pauses after sending one neutral packet and the filters reset on return. | Sending on every `devicemotion`. `requestAnimationFrame`: throttled to 0 in the background, tied to the display rate, and some phones run at 120 Hz. `setInterval`: drifts and bursts. |
| D6 | **Pads use pointer events on one root element; a pointer belongs to the zone it went down on; implicit touch capture delivers `pointerup` to that element; mouse gets explicit `setPointerCapture`.** | Multi-touch for free, one code path for mouse and touch. The browser gestures are stopped with CSS `touch-action: none` and, because WebKit still double-tap-zooms positioned elements with `touch-action: none` (WebKit bug 218015) and ignores `user-scalable=no`, with non-passive `touchstart/touchmove/touchend` + `gesturestart` `preventDefault()`. `overscroll-behavior: none` kills Chrome's pull-to-refresh and Safari's rubber band. `100dvh` + `position: fixed` avoid the iOS toolbar/`100vh` mismatch. | Touch events only: no mouse for the desktop simulator. Zone by current position: a thumb sliding over the middle would flip GAS to BRAKE. `click` events: 350 ms delay on iOS without `touch-action: manipulation`, and no multi-touch. |
| D7 | **Wake lock keeper re-requests on `visibilitychange`; fullscreen + `screen.orientation.lock('landscape')` attempted on Android inside the tap; iPhone gets the rotate overlay only.** | Browsers release the lock when the page is hidden. iPhone Safari has no element fullscreen (WebKit bug 212934, WONTFIX) and no `lock()`; the spec already says to use the overlay. | NoSleep-style hidden video for iOS 16.0 to 16.3: possible but adds an asset and autoplay rules; a banner telling the player to disable auto-lock is enough for a hackathon. |
| D8 | **Shake = peaks of linear acceleration magnitude above 15 m/s² with a 120 ms refractory and 8 m/s² re-arm, counted over 1 s, 4 peaks = 1.0; when `acceleration` is null, subtract a 0.5 s low-passed gravity from `accelerationIncludingGravity`.** | Peaks per second is what the spec asks for and is robust to the gravity sign (magnitude only). | Energy or RMS: counts slow waving as bailing. |
| D9 | **Orientation fallback when there is no gyroscope: heading of the device's aim axis from the full rotation matrix of alpha/beta/gamma, differenced with wrap-around.** | A heading computed from the rotation matrix is continuous where the raw `alpha` jumps (beta near 90). `webkitCompassHeading` (clockwise from north) is used only when `alpha` is null. | Raw `alpha` differences: jumps at the upright pose. |
| D10 | **Desktop simulator synthesises `devicemotion` and `deviceorientation` samples from a virtual pose (same frames, same iOS/Android signs, optional "no gyro").** | The whole pipeline, not just the UI, runs on a laptop; `I` flips the platform sign so both branches get exercised before the first iPhone arrives. | Mouse-dragging fake `steer` values straight into the sender: skips the maths we most need to test. |

## 3. Algorithms and code

### 3.1 Frames and formulas

Device frame (W3C): x to the right of the screen, y to the top, z out of the screen towards the player. `up` = unit vector towards the sky, in the device frame.

1. Sign normalisation: `up_raw = sign * accelerationIncludingGravity`, `sign = +1` (spec, Chrome Android: flat face-up gives z = +9.81, upright portrait gives y = +9.81), `sign = -1` (iOS: flat face-up z = -9.81, upright y = -9.81).
2. Low-pass (time-based, so 60 Hz vs 100 Hz does not matter): `v += dt / (tau + dt) * (s - v)`; tau = 0.08 s for steering, 0.25 s for the yaw axis, 0.5 s for the gravity estimate used by the shake fallback.
3. Steering: `phi = atan2(up.x, up.y)` (deg). Portrait upright: 0. Landscape, top of the phone on the left: +90. Top on the right: -90. Clockwise wheel turn decreases phi. `theta = wrap(phi_cal - phi)`; positive = clockwise = turn right. `x = clamp((|theta| - 4) / (35 - 4), 0, 1)`; `steer = sign(theta) * (0.6 x + 0.4 x^3)`. Weak pose guard: `sqrt(up.x^2 + up.y^2) / |up| < 0.35` (phone pitched more than about 70 deg from vertical): hold the last steer, grey the wheel.
   Pitch sensitivity (independent rotation-matrix check, `check_math.mjs`): rotating the phone about its own screen normal at any fixed pitch gives the exact wheel angle. If instead the pilot rotates about their line of sight while the phone is pitched 30 deg, 20 deg of wheel reads 22.8 deg and 35 reads 39.0; at pitch 60 deg, 20 reads 36. The calibration tap at the pilot's own pitch makes zero exact; the residual is a gain change, not an offset.
4. Gunner: `omega_up = alpha * up.x + beta * up.y + gamma * up.z` (deg/s, positive = counter-clockwise seen from above = turning left). `rate = sign(omega_up) * max(0, |omega_up| - 2)`, clamped to ±600 deg/s. `dYaw += 2 * rate * (pi / 180) * dt` radians, accumulated until the next send. Gyro bias (below 0.5 deg/s on phones) sits inside the dead zone, so drift at rest is zero; RECENTER and respawn reset the sim's aim, and the phone resets its local needle estimate.
5. Orientation fallback: with `R = Rz(alpha) Rx(beta) Ry(gamma)` (spec), the device -z axis in the earth frame is `-(ca sg + sa sb cg, sa sg - ca sb cg, cb cg)`; heading = `atan2(north, east)`; if the back of the phone points within 18 deg of vertical use the +y axis `(-cb sa, ca cb)` instead. `rate = wrap(h - h_prev) / dt` then the same dead zone and gain.
6. Shake: see D8. `lin = acceleration ?? (ag - lowpass_0.5s(ag))`; `|lin| >= 15` while armed and `t - t_lastPeak >= 120 ms` counts a peak and disarms; re-arm when `|lin| < 8`; `shake = min(1, peaks_in_last_1s / 4)`.
7. Sign detector: while `|sin(beta)| >= 0.5` and `|ag.y| >= g/2`, vote `sign(ag.y) == sign(sin beta)`; after 45 votes, >= 90 % agreement locks +1, <= 10 % locks -1, otherwise restart. Effective sign = locked ?? UA guess; the "Invert aim" toggle (localStorage `gr.invertAim`) multiplies the yaw step by -1 on top.

### 3.2 Code


#### `src/phone/sensorMath.ts`

```ts
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

```

#### `src/phone/sensors.ts`

```ts
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
 * The one-tap flow. Everything that needs the user gesture is started synchronously,
 * then awaited together. Call directly from the pointerup/click handler of the button.
 */
export function enableControls(deps: EnableControlsDeps): Promise<EnableControlsResult> {
  const fullscreen = deps.requestFullscreen().catch(() => false);
  const motion = requestMotionAccess();
  const wakeLock = deps.requestWakeLock().catch(() => false);
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

```

#### `src/phone/sensorSim.ts`

```ts
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

```

#### `src/phone/pads.ts`

```ts
// src/phone/pads.ts
// Multi-touch pads with pointer events. The root element owns every listener; zones are
// child elements with a data-zone attribute (gas, brake, fire, recenter, calibrate,
// power0, power1). A pointer belongs to the zone it went down on until it is released,
// so a thumb sliding across the middle does not flip GAS into BRAKE.
//
// Pair with pads.css (touch-action: none, user-select: none, -webkit-touch-callout: none,
// 100dvh, safe-area padding, overscroll-behavior: none).

export type PadZone = 'gas' | 'brake' | 'fire' | 'recenter' | 'calibrate' | 'power0' | 'power1';

const ZONES: ReadonlySet<string> = new Set<PadZone>(['gas', 'brake', 'fire', 'recenter', 'calibrate', 'power0', 'power1']);

function isPadZone(v: string | undefined): v is PadZone {
  return v !== undefined && ZONES.has(v);
}

export interface PadsView {
  isHeld(zone: PadZone): boolean;
  /** Pointerdown edges since the last call, in order. */
  drainTaps(): PadZone[];
}

const preventDefault = (e: Event): void => {
  e.preventDefault();
};

export class Pads implements PadsView {
  private readonly pointers = new Map<number, PadZone>();
  private readonly held = new Map<PadZone, number>();
  private taps: PadZone[] = [];
  private readonly onChange: ((zone: PadZone, down: boolean) => void) | undefined;

  constructor(
    private readonly root: HTMLElement,
    onChange?: (zone: PadZone, down: boolean) => void,
  ) {
    this.onChange = onChange;
    root.addEventListener('pointerdown', this.onPointerDown);
    root.addEventListener('pointerup', this.onPointerEnd);
    root.addEventListener('pointercancel', this.onPointerEnd);
    // Mouse on the desktop: capture so a release outside the pad still counts.
    root.addEventListener('lostpointercapture', this.onPointerEnd);
    // iOS Safari: stop double-tap zoom, the long-press callout and the synthetic click.
    // touch-action: none alone does not stop double-tap zoom on positioned elements (WebKit bug 218015).
    root.addEventListener('touchstart', preventDefault, { passive: false });
    root.addEventListener('touchmove', preventDefault, { passive: false });
    root.addEventListener('touchend', preventDefault, { passive: false });
    // iOS pinch: gesture events are WebKit-only and not in lib.dom, so the string overload is used.
    root.addEventListener('gesturestart', preventDefault);
    root.addEventListener('contextmenu', preventDefault);
    window.addEventListener('blur', this.releaseAll);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  isHeld(zone: PadZone): boolean {
    return (this.held.get(zone) ?? 0) > 0;
  }

  drainTaps(): PadZone[] {
    const out = this.taps;
    this.taps = [];
    return out;
  }

  dispose(): void {
    this.releaseAll();
    this.root.removeEventListener('pointerdown', this.onPointerDown);
    this.root.removeEventListener('pointerup', this.onPointerEnd);
    this.root.removeEventListener('pointercancel', this.onPointerEnd);
    this.root.removeEventListener('lostpointercapture', this.onPointerEnd);
    this.root.removeEventListener('touchstart', preventDefault);
    this.root.removeEventListener('touchmove', preventDefault);
    this.root.removeEventListener('touchend', preventDefault);
    this.root.removeEventListener('gesturestart', preventDefault);
    this.root.removeEventListener('contextmenu', preventDefault);
    window.removeEventListener('blur', this.releaseAll);
    document.removeEventListener('visibilitychange', this.onVisibility);
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const target = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-zone]') : null;
    const zone = target?.dataset['zone'];
    if (!isPadZone(zone)) return;
    e.preventDefault();
    if (e.pointerType === 'mouse') {
      try {
        this.root.setPointerCapture(e.pointerId);
      } catch {
        // Not capturable (already released); the up event still reaches the root.
      }
    }
    this.pointers.set(e.pointerId, zone);
    this.held.set(zone, (this.held.get(zone) ?? 0) + 1);
    this.taps.push(zone);
    if (this.held.get(zone) === 1) this.onChange?.(zone, true);
  };

  private readonly onPointerEnd = (e: PointerEvent): void => {
    this.release(e.pointerId);
  };

  private readonly onVisibility = (): void => {
    if (document.visibilityState !== 'visible') this.releaseAll();
  };

  private readonly releaseAll = (): void => {
    for (const id of [...this.pointers.keys()]) this.release(id);
  };

  private release(pointerId: number): void {
    const zone = this.pointers.get(pointerId);
    if (zone === undefined) return;
    this.pointers.delete(pointerId);
    const n = (this.held.get(zone) ?? 1) - 1;
    this.held.set(zone, Math.max(0, n));
    if (n <= 0) this.onChange?.(zone, false);
  }
}

/**
 * Builds the zone layout for a role. Returns the root; the caller adds it to the page.
 * `gunnerHasPowers`: teams of 2, the Gunner also gets the two power buttons (spec section 2).
 */
export function buildPadLayout(role: 'pilot' | 'gunner' | 'engineer', gunnerHasPowers = false): HTMLElement {
  const root = document.createElement('div');
  root.className = `pads pads-${role}`;
  const zone = (name: PadZone, label: string, extraClass = ''): HTMLElement => {
    const el = document.createElement('div');
    el.className = `zone zone-${name} ${extraClass}`.trim();
    el.dataset['zone'] = name;
    el.textContent = label;
    return el;
  };
  switch (role) {
    case 'pilot':
      root.append(zone('brake', 'BRAKE'), zone('gas', 'GAS'));
      root.append(zone('calibrate', 'CALIBRATE', 'small'));
      break;
    case 'gunner':
      root.append(zone('recenter', 'RECENTER'), zone('fire', 'FIRE'));
      root.append(zone('calibrate', 'CALIBRATE', 'small'));
      if (gunnerHasPowers) root.append(zone('power0', 'P1', 'small power-a'), zone('power1', 'P2', 'small power-b'));
      break;
    case 'engineer':
      root.append(zone('power0', 'POWER 1'), zone('power1', 'POWER 2'));
      break;
  }
  return root;
}

```

#### `src/phone/pads.css`

```css
/* src/phone/pads.css: the phone controller surface.
   Pair with: <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">
   (user-scalable=no is honoured by Chrome and ignored by iOS Safari; the JS in pads.ts covers iOS.) */

html,
body {
  margin: 0;
  height: 100%;
  overflow: hidden;
  background: #000;
  /* Chrome Android: no pull-to-refresh, no overscroll glow. Safari 16+: no rubber band. */
  overscroll-behavior: none;
}

.phone-root {
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100vh; /* fallback */
  height: 100dvh; /* Safari 15.4+, Chrome 108+: tracks the collapsing Safari toolbar */
  box-sizing: border-box;
  padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
  touch-action: none; /* no browser panning or zooming starts on the pads */
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none; /* no long-press menu on iOS */
  -webkit-tap-highlight-color: transparent;
  color: #fff;
  font: 700 clamp(18px, 5vmin, 40px) system-ui, sans-serif;
}

.pads {
  position: absolute;
  inset: 0;
  display: grid;
  grid-template-columns: 1fr 1fr;
}
.pads-gunner {
  grid-template-columns: 1fr 2fr; /* RECENTER | FIRE (two thirds) */
}

.zone {
  display: flex;
  align-items: center;
  justify-content: center;
  touch-action: none;
  border: 2px solid rgba(255, 255, 255, 0.25);
  transition: background 60ms;
}
.zone.held {
  background: rgba(255, 255, 255, 0.22);
}
.zone.small {
  position: absolute;
  left: 4vw;
  top: 4vh;
  width: 28vw;
  height: 14vh;
  font-size: 0.6em;
  border-radius: 1em;
  z-index: 2;
}

.rotate-overlay {
  position: fixed;
  inset: 0;
  display: none;
  place-items: center;
  background: rgba(0, 0, 0, 0.92);
  z-index: 10;
}
.rotate-overlay.visible {
  display: grid;
}

.flash-red {
  animation: flash-red 220ms ease-out;
}
@keyframes flash-red {
  from {
    box-shadow: inset 0 0 0 100vmax rgba(255, 0, 0, 0.75);
  }
  to {
    box-shadow: inset 0 0 0 100vmax rgba(255, 0, 0, 0);
  }
}

```

#### `src/phone/wake.ts`

```ts
// src/phone/wake.ts
// Screen wake lock, fullscreen / orientation lock attempts, the rotate-your-phone
// detector and haptics (vibration on Android, red flash on iOS).

// ---------------------------------------------------------------- wake lock

export class WakeLockKeeper {
  private sentinel: WakeLockSentinel | null = null;
  private wanted = false;

  constructor(private readonly onState?: (held: boolean) => void) {
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  /** navigator.wakeLock exists on Chrome 84+ and Safari 16.4+ (full on iOS 18.4+). */
  static supported(): boolean {
    return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
  }

  /** Resolves true when the lock is held. Safe to call outside a gesture. */
  async request(): Promise<boolean> {
    this.wanted = true;
    if (!WakeLockKeeper.supported()) return false;
    if (this.sentinel !== null && !this.sentinel.released) return true;
    try {
      const s = await navigator.wakeLock.request('screen');
      this.sentinel = s;
      s.addEventListener('release', () => {
        if (this.sentinel === s) this.sentinel = null;
        this.onState?.(false);
      });
      this.onState?.(true);
      return true;
    } catch {
      // Low battery, hidden document, or the request was refused.
      this.onState?.(false);
      return false;
    }
  }

  async release(): Promise<void> {
    this.wanted = false;
    const s = this.sentinel;
    this.sentinel = null;
    if (s !== null && !s.released) await s.release();
  }

  dispose(): void {
    document.removeEventListener('visibilitychange', this.onVisibility);
    void this.release();
  }

  /** The browser drops the lock whenever the page is hidden; re-request on return. */
  private readonly onVisibility = (): void => {
    if (this.wanted && document.visibilityState === 'visible') void this.request();
  };
}

// ---------------------------------------------------------------- fullscreen + orientation lock

/** lib.dom (TS 5.9) declares unlock() but not lock(); Safari does not implement lock(). */
interface OrientationLockApi {
  lock?: (orientation: 'landscape' | 'portrait' | 'natural' | 'any') => Promise<void>;
}

/**
 * Android Chrome: fullscreen hides the URL bar and allows screen.orientation.lock().
 * iPhone Safari: element fullscreen is not implemented and lock() does not exist, so
 * this resolves false and the rotate-your-phone overlay does the job. Call inside the tap.
 */
export async function requestFullscreenLandscape(): Promise<boolean> {
  const el = document.documentElement;
  if (typeof el.requestFullscreen !== 'function') return false;
  try {
    await el.requestFullscreen({ navigationUI: 'hide' });
  } catch {
    return false;
  }
  const so = screen.orientation as ScreenOrientation & OrientationLockApi;
  if (typeof so.lock === 'function') {
    try {
      await so.lock('landscape');
    } catch {
      // Not allowed (desktop, or not in fullscreen): fine, the overlay covers it.
    }
  }
  return true;
}

// ---------------------------------------------------------------- orientation detection

export interface OrientationInfo {
  readonly landscape: boolean;
  /** 'landscape-primary' etc. when the browser says, else null (iOS before 16.4). */
  readonly type: OrientationType | null;
}

export function readOrientation(): OrientationInfo {
  const type = typeof screen !== 'undefined' && screen.orientation ? screen.orientation.type : null;
  if (type !== null) return { landscape: type.startsWith('landscape'), type };
  // matchMedia works everywhere; it flips briefly when the keyboard shrinks the viewport.
  return { landscape: matchMedia('(orientation: landscape)').matches, type: null };
}

/** Calls back on every orientation change and once immediately. Returns the unsubscribe. */
export function watchOrientation(cb: (info: OrientationInfo) => void): () => void {
  const fire = (): void => cb(readOrientation());
  const mql = matchMedia('(orientation: landscape)');
  mql.addEventListener('change', fire);
  const so = typeof screen !== 'undefined' ? screen.orientation : undefined;
  so?.addEventListener('change', fire);
  window.addEventListener('resize', fire);
  fire();
  return () => {
    mql.removeEventListener('change', fire);
    so?.removeEventListener('change', fire);
    window.removeEventListener('resize', fire);
  };
}

// ---------------------------------------------------------------- haptics

export type HapticKind = 'fire' | 'hit';

const PATTERNS: Record<HapticKind, number | number[]> = { fire: 25, hit: [60, 40, 90] };

/**
 * Android: navigator.vibrate (needs a prior user gesture, which Enable controls gave us).
 * iOS: no Vibration API, so flash the given element red instead (the spec's fallback).
 */
export function haptic(kind: HapticKind, flashEl: HTMLElement | null): void {
  let vibrated = false;
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    try {
      vibrated = navigator.vibrate(PATTERNS[kind]);
    } catch {
      vibrated = false;
    }
  }
  if (!vibrated && flashEl !== null) flash(flashEl, kind === 'hit' ? 220 : 90);
}

function flash(el: HTMLElement, ms: number): void {
  el.classList.add('flash-red');
  window.setTimeout(() => el.classList.remove('flash-red'), ms);
}

```

#### `src/phone/sender.ts`

```ts
// src/phone/sender.ts
// The 30 Hz input loop. Samples the latest filtered state, builds one protocol packet,
// resets the edge-triggered fields, and pauses while the tab is hidden.

import type { EngineerIn, GunnerIn, InputPacket, PilotIn } from '@shared/protocol';
import type { Role } from '@shared/state';
import type { PadsView } from './pads';
import type { ControllerPipeline } from './sensors';

export interface InputSenderDeps {
  readonly role: Role;
  readonly pipeline: ControllerPipeline;
  readonly pads: PadsView;
  readonly send: (packet: InputPacket) => void;
  readonly hz?: number;
  /** Teams of 2: the Gunner also carries the two power buttons (GunnerIn.use). */
  readonly gunnerHasPowers?: boolean;
  /** Called on CALIBRATE taps so the screen can confirm and send { t: 'calibrated' }. */
  readonly onCalibrate?: (ok: boolean) => void;
}

/** What one tick consumed from the pads. Pure so it can be unit-tested. */
export interface TickEdges {
  readonly fireTapped: boolean;
  readonly recenter: boolean;
  readonly calibrate: boolean;
  readonly use: 0 | 1 | null;
}

export function collectEdges(taps: readonly string[]): TickEdges {
  let fireTapped = false;
  let recenter = false;
  let calibrate = false;
  let use: 0 | 1 | null = null;
  for (const t of taps) {
    if (t === 'fire') fireTapped = true;
    else if (t === 'recenter') recenter = true;
    else if (t === 'calibrate') calibrate = true;
    else if (t === 'power0' && use === null) use = 0;
    else if (t === 'power1' && use === null) use = 1;
  }
  return { fireTapped, recenter, calibrate, use };
}

export interface TickState {
  readonly seq: number;
  readonly steer: number;
  readonly dYawRad: number;
  readonly shake: number;
  readonly gasHeld: boolean;
  readonly brakeHeld: boolean;
  readonly fireHeld: boolean;
}

/**
 * Builds the packet for a role. A tap shorter than one tick still sends fire=true once
 * (the scene does the edge detection, so one `true` packet is one shot).
 */
export function buildInputPacket(role: Role, s: TickState, edges: TickEdges, gunnerHasPowers = false): InputPacket {
  switch (role) {
    case 'pilot': {
      const p: PilotIn = { t: 'in', seq: s.seq, role, steer: s.steer, gas: s.gasHeld, brake: s.brakeHeld };
      return p;
    }
    case 'gunner': {
      const p: GunnerIn = {
        t: 'in',
        seq: s.seq,
        role,
        dYaw: s.dYawRad,
        fire: s.fireHeld || edges.fireTapped,
        recenter: edges.recenter,
      };
      return gunnerHasPowers ? { ...p, use: edges.use } : p;
    }
    case 'engineer': {
      const p: EngineerIn = { t: 'in', seq: s.seq, role, use: edges.use, shake: s.shake };
      return p;
    }
  }
}

export function neutralPacket(role: Role, seq: number): InputPacket {
  return buildInputPacket(
    role,
    { seq, steer: 0, dYawRad: 0, shake: 0, gasHeld: false, brakeHeld: false, fireHeld: false },
    { fireTapped: false, recenter: false, calibrate: false, use: null },
  );
}

/**
 * Fixed-rate loop on setTimeout aligned to a schedule (no drift, no bursts after a hiccup).
 * Why not send on every sensor event: 60 Hz events through a tunnel double the packet
 * rate for no gameplay benefit, and the sim integrates dYaw anyway; the fixed loop also
 * keeps pads-only roles (engineer) at a steady rate.
 */
export function startInputSender(deps: InputSenderDeps): { stop(): void } {
  const hz = deps.hz ?? 30;
  const period = 1000 / hz;
  let stopped = false;
  let timer: number | null = null;
  let next = performance.now() + period;
  let seq = 0;

  const tick = (): void => {
    if (stopped || document.visibilityState !== 'visible') return;
    const edges = collectEdges(deps.pads.drainTaps());
    if (edges.calibrate) {
      const ok = deps.pipeline.calibrateSteer();
      deps.pipeline.recenterYaw();
      deps.onCalibrate?.(ok);
    }
    if (edges.recenter) deps.pipeline.recenterYaw();
    const snap = deps.pipeline.snapshot();
    seq += 1;
    const state: TickState = {
      seq,
      steer: snap.steer,
      dYawRad: deps.pipeline.drainYaw(),
      shake: snap.shake,
      gasHeld: deps.pads.isHeld('gas'),
      brakeHeld: deps.pads.isHeld('brake'),
      fireHeld: deps.pads.isHeld('fire'),
    };
    deps.send(buildInputPacket(deps.role, state, edges, deps.gunnerHasPowers ?? false));
    next += period;
    const now = performance.now();
    if (next < now - 5 * period) next = now + period; // fell far behind: resync instead of bursting
    timer = window.setTimeout(tick, Math.max(0, next - now));
  };

  const onVisibility = (): void => {
    if (document.visibilityState === 'visible') {
      if (stopped) return;
      deps.pipeline.resetFilters();
      next = performance.now() + period;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(tick, period);
    } else {
      // Sensors stop in the background and timers are throttled; make the boat coast now.
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      deps.pipeline.drainYaw();
      seq += 1;
      deps.send(neutralPacket(deps.role, seq));
    }
  };
  document.addEventListener('visibilitychange', onVisibility);
  timer = window.setTimeout(tick, period);

  return {
    stop(): void {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    },
  };
}

```

#### `src/phone/controller.ts`

```ts
// src/phone/controller.ts
// Wires sensors, pads, wake lock and the 30 Hz sender for one role screen.
// The lobby calls startController() from the "Enable controls" tap; the role screens
// read controller.snapshot() each animation frame for the wheel graphic and the needle.

import { PHONE } from '@shared/config';
import type { InputPacket } from '@shared/protocol';
import type { Role } from '@shared/state';
import { Pads, buildPadLayout } from './pads';
import { startInputSender } from './sender';
import { tuningFromPhoneConfig } from './sensorMath';
import { KeyboardSensorSource, wantsSimulator } from './sensorSim';
import {
  ControllerPipeline,
  DeviceSensorSource,
  createMotionWatchdog,
  enableControls,
  loadInvertAim,
  type ControllerSnapshot,
  type EnableControlsResult,
  type MotionHealth,
  type SensorSource,
} from './sensors';
import { WakeLockKeeper, requestFullscreenLandscape, watchOrientation } from './wake';

export interface PhoneController {
  readonly enable: EnableControlsResult;
  readonly pipeline: ControllerPipeline;
  readonly pads: Pads;
  readonly padsRoot: HTMLElement;
  snapshot(): ControllerSnapshot;
  setRole(role: Role, gunnerHasPowers: boolean): void;
  /** After a 'stalled' health report: re-arms the listeners without a new prompt. */
  restartSensors(): void;
  dispose(): void;
}

export interface PhoneControllerDeps {
  readonly role: Role;
  /** Teams of 2: the Gunner also gets the two power buttons. */
  readonly gunnerHasPowers: boolean;
  readonly mount: HTMLElement;
  readonly send: (packet: InputPacket) => void;
  readonly onHealth: (health: MotionHealth) => void;
  readonly onOrientation: (landscape: boolean) => void;
  /** Send { t: 'calibrated' } to the scene when ok. */
  readonly onCalibrate?: (ok: boolean) => void;
}

/** Must be called synchronously from the pointerup/click handler of "Enable controls". */
export async function startController(deps: PhoneControllerDeps): Promise<PhoneController> {
  const wake = new WakeLockKeeper();
  const enable = await enableControls({
    requestWakeLock: () => wake.request(),
    requestFullscreen: () => requestFullscreenLandscape(),
  });

  const sim = wantsSimulator();
  const source: SensorSource = sim ? new KeyboardSensorSource() : new DeviceSensorSource();
  const tuning = tuningFromPhoneConfig(PHONE);
  const pipeline = new ControllerPipeline({ tuning, invertAim: loadInvertAim() });
  const detach = pipeline.attach(source);

  const watchdog = createMotionWatchdog(deps.onHealth, PHONE.motionWatchdogSec * 1000);
  const offFeed = source.onMotion(() => watchdog.feed());
  if (enable.motion.ok || sim) {
    source.start();
    watchdog.arm();
  } else {
    deps.onHealth('no-events');
  }

  let role = deps.role;
  let gunnerHasPowers = deps.gunnerHasPowers;
  let padsRoot = buildPadLayout(role, gunnerHasPowers);
  deps.mount.append(padsRoot);
  const onZone = (zone: string, down: boolean): void => {
    padsRoot.querySelector(`[data-zone="${zone}"]`)?.classList.toggle('held', down);
  };
  let pads = new Pads(padsRoot, onZone);
  const makeSender = (): { stop(): void } =>
    startInputSender({
      role,
      pipeline,
      pads,
      send: deps.send,
      hz: tuning.sendHz,
      gunnerHasPowers,
      onCalibrate: deps.onCalibrate,
    });
  let sender = makeSender();
  const stopOrientation = watchOrientation((info) => deps.onOrientation(info.landscape));

  return {
    enable,
    pipeline,
    get pads() {
      return pads;
    },
    get padsRoot() {
      return padsRoot;
    },
    snapshot: () => pipeline.snapshot(),
    setRole(next: Role, nextGunnerHasPowers: boolean): void {
      if (next === role && nextGunnerHasPowers === gunnerHasPowers) return;
      role = next;
      gunnerHasPowers = nextGunnerHasPowers;
      sender.stop();
      pads.dispose();
      padsRoot.remove();
      padsRoot = buildPadLayout(role, gunnerHasPowers);
      deps.mount.append(padsRoot);
      pads = new Pads(padsRoot, onZone);
      sender = makeSender();
    },
    restartSensors(): void {
      source.stop();
      pipeline.resetFilters();
      source.start();
      watchdog.arm();
    },
    dispose(): void {
      sender.stop();
      stopOrientation();
      offFeed();
      watchdog.dispose();
      detach();
      source.stop();
      pads.dispose();
      padsRoot.remove();
      wake.dispose();
    },
  };
}

```

#### `src/phone/sensorMath.test.ts`

```ts
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
import { collectEdges, buildInputPacket, neutralPacket } from './sender';
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

describe('sender packets', () => {
  it('collects edges and builds role packets; a short fire tap is still reported', () => {
    const edges = collectEdges(['fire', 'power1', 'recenter', 'power0']);
    expect(edges).toEqual({ fireTapped: true, recenter: true, calibrate: false, use: 1 });
    const gunner = buildInputPacket(
      'gunner',
      { seq: 7, steer: 0, dYawRad: 0.02, shake: 0, gasHeld: false, brakeHeld: false, fireHeld: false },
      edges,
    );
    expect(gunner).toEqual({ t: 'in', seq: 7, role: 'gunner', dYaw: 0.02, fire: true, recenter: true });
    const gunner2 = buildInputPacket(
      'gunner',
      { seq: 8, steer: 0, dYawRad: 0, shake: 0, gasHeld: false, brakeHeld: false, fireHeld: true },
      edges,
      true,
    );
    expect(gunner2).toEqual({ t: 'in', seq: 8, role: 'gunner', dYaw: 0, fire: true, recenter: true, use: 1 });
    const pilot = buildInputPacket(
      'pilot',
      { seq: 1, steer: -0.4, dYawRad: 0, shake: 0, gasHeld: true, brakeHeld: false, fireHeld: false },
      collectEdges([]),
    );
    expect(pilot).toEqual({ t: 'in', seq: 1, role: 'pilot', steer: -0.4, gas: true, brake: false });
    const eng = buildInputPacket(
      'engineer',
      { seq: 2, steer: 0, dYawRad: 0, shake: 0.75, gasHeld: false, brakeHeld: false, fireHeld: false },
      collectEdges(['power0']),
    );
    expect(eng).toEqual({ t: 'in', seq: 2, role: 'engineer', use: 0, shake: 0.75 });
    expect(neutralPacket('pilot', 3)).toEqual({ t: 'in', seq: 3, role: 'pilot', steer: 0, gas: false, brake: false });
  });
});

```

### 3.3 What the phone screens draw from the snapshot

- **Pilot wheel**: rotate the wheel SVG by `-snapshot.steerAngleDeg` so its top mark stays pointing at the sky while the phone turns; fill an arc from 0 to `steer` with the dead zone (±4 deg) drawn as a thin grey band and the lock (±35 deg) as end stops. Grey the wheel and show "tilt the phone up" while `steerWeak`, and "tap CALIBRATE" while `!steerCalibrated`. The pilot looks at the wall, so the fill (not the angle) is the part they see in peripheral vision: make it the team colour, 30 vmin tall.
- **Gunner needle**: `yawSinceRecenterRad` is the phone's own estimate of aim versus bow since the last RECENTER; it ignores the sim's aim-assist gain cut (section 4 of the spec, applied in `src/sim`) and the boat's own turning, so treat it as a hint and prefer an `aimRel` field in `Hud` if the contract is extended. Show "no gyroscope, using compass" when `yawSource === 'orientation'`.
- **Engineer**: `shake` drives the bucket animation speed; the water meter comes from `Hud.water`.
- **Debug line** (`describeSensors(snapshot)`): sign in use, yaw source, shake level. Keep it on screen until Gate 1 passes.

## 4. Edge cases and how they are handled

| Case | Behaviour | Handling |
|------|-----------|----------|
| Plain http (LAN IP, no tunnel) | iOS: `requestPermission()` resolves `'denied'` and logs "Call to requestPermission() failed, reason: Browsing context is not secure." Chrome 76+: handlers never fire on insecure origins. | `requestMotionAccess()` checks `window.isSecureContext` first and returns `reason: 'insecure'` with the message "open the https link from the QR". The 1 s watchdog catches anything that slips through. |
| Desktop browser | `DeviceMotionEvent` exists but no events arrive. | Watchdog reports `'no-events'` after 1 s; with `?sim=1` the keyboard source replaces the device. |
| iOS prompt refused | WebKit caches the decision per origin in the UI process; later calls resolve `'denied'` without a prompt, across reloads. | Message tells the player to close the tab, scan again and tap Allow. |
| `requestPermission()` called outside a gesture | Rejects with `NotAllowedError` ("Requesting device motion access requires a user gesture to prompt"). | Mapped to `'needs-gesture'`: "tap Enable controls again". `enableControls()` starts fullscreen, permission and wake lock synchronously before any `await`. |
| Chrome 151+ exposes `requestPermission` | Resolves without a prompt while the default stays ALLOW. | The code calls it whenever it is a function; it is never used as a platform test. |
| `DeviceOrientationEvent.requestPermission` | WebKit keeps one state for motion and orientation and starts both listeners on grant. | Not called; one prompt. |
| No gyroscope | iOS: `rotationRate === null`. Chrome Android: an object whose `alpha/beta/gamma` are `null` (NaN internally). | `toRot()` returns null for both; `yawSource` becomes `'orientation'` and the heading fallback runs. |
| No linear-acceleration sensor | Chrome Android gives `acceleration` with null fields. | Shake uses `ag - lowpass(ag)`. |
| Tab hidden, screen locked, app switcher | The spec requires events only while the document is visible; timers are throttled; the wake lock is released. | Sender sends one neutral packet and stops; on return it resets the filters (no jump from stale state) and restarts; `WakeLockKeeper` re-requests; the watchdog gives a 1 s grace and then reports `'stalled'` with a "tap to re-enable" button that re-runs `source.start()` (no new prompt: the grant is cached). |
| iOS 16.0 to 16.3 | No `navigator.wakeLock`. | `WakeLockKeeper.supported()` false: show "turn off Auto-Lock in Settings > Display & Brightness for this round". iOS 16.4 to 18.3: works in a Safari tab, not in Home Screen web apps (we use Safari tabs from the camera QR). |
| Phone held flat | In-plane gravity vanishes; `atan2` becomes noise. | `weak` flag: steer holds, wheel greys, CALIBRATE refuses (`calibrateSteer()` returns false). |
| Landscape upside down (angle near ±180) | Wrap boundary. | `wrapDeg` keeps the difference continuous across ±180. |
| Both landscapes, both platforms | Offsets +90/-90 and a 180 shift on iOS. | Absorbed by the calibration difference; verified in `check_math.mjs` for all four combinations at pitch 0, 30, 60. |
| Pilot never taps CALIBRATE | `calibrationDeg` is null. | Steer stays 0 and the wheel shows "tap CALIBRATE"; the host can also broadcast a calibrate during the countdown through the sender's `calibrate` edge. |
| Gyro saturation / glitch samples | Consumer gyros saturate around 2000 deg/s; a glitch would throw the aim. | Rate clamped to ±600 deg/s; `dt` clamped to 100 ms, first sample uses 1/60. |
| Hand tremor and bias drift | Below 2 deg/s. | Soft dead zone removes 2 deg/s without a jump at the edge. |
| Fast swings pollute the gravity estimate | Centripetal acceleration adds to `ag`. | The yaw axis uses a slower filter (0.25 s) and the projection only needs the direction; errors are second order. |
| Aim sign reversed on a phone | Unknown sensor stack. | Persisted "Invert aim" toggle in the gunner screen, plus the sign detector; Gate 1 checklist includes the sign test. |
| `interval` field | iOS 0.01667 (seconds), Chrome 16 (ms). | Never read. |
| Two fingers on one zone | Counted per zone. | `held` is a counter; the zone releases when the last pointer leaves. |
| Finger slides from GAS into BRAKE | Would toggle both. | Zone fixed at pointerdown; pointerup is delivered to the captured element (implicit touch capture). |
| `pointercancel` (browser took the gesture, palm rejection, incoming call) | No `pointerup` arrives. | Treated as release; `touch-action: none` prevents the browser from taking the pointer in the first place. |
| Window blur / visibility hidden with a thumb down | Up event lost. | `releaseAll()` on `blur` and on hidden. |
| Double-tap zoom, pinch, long-press callout, text selection, context menu | iOS ignores `user-scalable=no`; WebKit zooms positioned elements despite `touch-action: none` (bug 218015). | `touch-action: none`, `-webkit-touch-callout: none`, `user-select: none`, non-passive `touchstart/touchmove/touchend` and `gesturestart` `preventDefault()`, `contextmenu` cancelled. |
| Pull-to-refresh, rubber band, swipe-back from the edge | Chrome and Safari gestures. | `overscroll-behavior: none` on `html, body`; `touchstart.preventDefault()` on the pads also blocks the iOS 13.4+ back-swipe when it starts on a pad. |
| Safari bottom toolbar / `100vh` | `100vh` is the largest viewport; content hides behind the bar. | `height: 100dvh` with a `100vh` fallback, `position: fixed; inset: 0`, no scrolling, `viewport-fit=cover` with `env(safe-area-inset-*)` padding for the notch in landscape. |
| Orientation detection on iOS before 16.4 | No `screen.orientation`. | `matchMedia('(orientation: landscape)')` is the fallback; `screen.orientation.type` is used when present (also tells left vs right landscape). The media query flips when the software keyboard shrinks the viewport, which only matters in the lobby where the nickname field lives. |
| Orientation lock | Safari has no `lock()`; Chrome allows it in fullscreen. | Attempted after `requestFullscreen` on Android, errors swallowed; the overlay is the real mechanism. |
| Vibration | Safari has none; Chrome returns `false` without a prior user gesture. | `haptic()` falls back to a 90/220 ms red flash on the pad root whenever `vibrate` is missing or returns false. |
| `localStorage` throws (private mode) | Toggle cannot persist. | try/catch, default off. |
| Role swap in the lobby | Different pad layout and message type. | `controller.setRole()` restarts the sender; the pipeline and sensors stay. |
| Engineer in portrait | Allowed by the spec. | The engineer screen does not show the rotate overlay; the pipeline still computes shake in any orientation. |

## 5. Day-one testing

Without phones (all three of these run from the scene PC):

1. `npm test` runs `src/phone/sensorMath.test.ts`: wrap, dead zone, curve values (19.5 deg -> 0.35, 35 -> 1.0), clockwise 20 deg -> +20 in both landscapes, iOS sign invariance, pitch invariance, weak pose, yaw projection (30 deg/s at a tilted pose, 0 when perpendicular, sign flips with `up`), yaw step (32 deg/s at 1/60 s -> 2 * 30 * pi/180 / 60 rad), 45 deg/s for 1 s -> 2 * 43 deg of view, orientation up vectors, heading continuity across beta = 90, shake peaks (refractory, re-arm, 4 peaks -> 1.0, decay), the sign detector, the low-pass step response, simulator sign conventions, and packet building (a sub-tick FIRE tap still sends `fire: true`).
2. Open `https://localhost:5173/play?room=TEST&sim=1` on the laptop (or the tunnel URL): the keyboard source runs. `A`/`D` roll the wheel (eased to ±35), `W`/`S` pitch, Left/Right arrows turn at 90 deg/s, Space shakes, `I` switches the simulated platform between Android and iOS signs (steer must not change, yaw must not change because the detector and the sign flip cancel), `N` removes the gyroscope (the yaw source switches to orientation and arrows still turn), `L` swaps landscape side (re-calibrate, steer must still be right-positive), `R` resets. The mouse drives the pads. Watch the sent packets in the console or the relay log at a steady 30 per second; switch tabs and confirm one neutral packet then silence.
3. `check_math.mjs` (scratchpad) is the independent rotation-matrix check of the formulas; keep it next to the tests if anyone changes the frames.

With phones (Gate 1, in this order; takes 10 minutes):

1. Start the relay and `npm run tunnel`; put the https URL in the QR. Open it on the iPhone with the camera app (Safari, not an in-app browser) and on the Android phone in Chrome.
2. Tap Enable controls. iPhone: the "would like to access motion and orientation" sheet must appear once; tap Allow. Android: no sheet. The debug line must show `ag=-up (iOS)` on the iPhone and `ag=+up` on Android within 2 s of holding the phone upright, and `yaw:gyro`.
3. Negative tests: open the same route over `http://<lan-ip>:5173` on both phones and confirm the "not on https" message, not a silent nothing. On the iPhone tap Don't Allow once, confirm the recovery message, close the tab, rejoin.
4. Pilot: hold landscape, tap CALIBRATE, turn the phone clockwise: the wheel fill grows to the right, the box boat on the TV turns right; 4 deg does nothing, 35 deg is full lock; lay the phone flat: the wheel greys and the boat keeps its last steer; rotate the phone to the other landscape, calibrate again, repeat.
5. Gunner: point at the screen, tap CALIBRATE, turn your body 45 deg left: the view turns 90 deg left on both phones. If one phone turns right, flip "Invert aim" and note the model; the detector log line tells whether the UA guess or the detector decided. Hold the phone pitched 30 deg down and repeat: same result (that is the projection working). Stand still for 30 s: no drift. Tap RECENTER: the view snaps to the bow.
6. FIRE: a quick tap registers once; holding auto-fires only with a weapon that allows it (sim side). Android vibrates on fire; iPhone flashes red.
7. Engineer: shake for 2 s: the water meter empties; waving slowly does nothing.
8. Lock the iPhone, unlock, return: the watchdog shows stalled for at most 1 s, then controls resume with no prompt; the wake lock re-arms (screen must not dim during a 5-minute round on both phones).
9. Rotate to portrait: overlay appears; back to landscape: it goes away. Pinch, double-tap and long-press on the pads must do nothing; swiping from the left edge on the pad must not go back.

## 6. Sources

Specs and standards

- W3C Device Orientation and Motion: frames, `accelerationIncludingGravity` example `{x: 0, y: 0, z: 9.8}` for a flat device, rotation rate in deg/s, `alpha` getter = x-axis rate, `interval` in ms, `requestPermission()` on both interfaces, `[SecureContext]`, events only while visible, nullable fields: https://w3c.github.io/deviceorientation/
- rotationRate axis mismatch resolved by changing the spec to the browsers' alpha=x, beta=y, gamma=z (issue #44, PR #43 merged 31 Jan 2019): https://github.com/w3c/deviceorientation/issues/44 and https://lists.w3.org/Archives/Public/public-geolocation/2017Aug/0001.html
- Pointer Events (implicit capture for direct-manipulation devices, `pointercancel` when the UA takes the gesture, `touch-action` is the only way to prevent that): https://www.w3.org/TR/pointerevents/

Browser engine sources (read via GitHub raw)

- WebKit `DeviceOrientationAndMotionAccessController.cpp`: one `m_accessStatePerOrigin` state for motion and orientation, no second prompt after a decision, starts both listeners on grant: https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/dom/DeviceOrientationAndMotionAccessController.cpp
- WebKit `DeviceMotionEvent.cpp`: `requestPermission` resolves `denied` with "Call to requestPermission() failed, reason: ..." or rejects `NotAllowedError` "Requesting device motion access requires a user gesture to prompt"; `interval()` returns the stored value unchanged: https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/dom/DeviceMotionEvent.cpp
- WebKit `LocalDOMWindow.cpp`: "Browsing context is not secure" and the Feature-Policy messages: https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/page/LocalDOMWindow.cpp
- WebKit `WebCoreMotionManager.mm`: `totalAccel = userAccel + gravity`, scaled by `kGravity = 9.80665`, no negation; `rad2deg(rotationRate.x, y, z)` positionally; `nullopt` rotation when no gyroscope: https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/platform/ios/WebCoreMotionManager.mm
- WebKit `WebCoreMotionManager.h`: `kMotionUpdateInterval = 1.0f / 60.0f`: https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/platform/ios/WebCoreMotionManager.h
- WebKit `DeviceMotionClientIOS.mm`: `RotationRate::create(xRotationRate, yRotationRate, zRotationRate)` and `kMotionUpdateInterval` passed as the event interval: https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/platform/ios/DeviceMotionClientIOS.mm
- Chromium `device_motion_event_pump.cc`: `RadToDeg(gyro.x, .y, .z)` into `Create(alpha, beta, gamma)`, accelerometer passed unnegated, NaN for missing sensors, `kDefaultPumpDelayMicroseconds / 1000` as interval: https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/modules/device_orientation/device_motion_event_pump.cc
- Chromium `device_motion_event_rotation_rate.h/.cc`: `Create(double alpha, double beta, double gamma)`, NaN -> `std::nullopt`: https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/modules/device_orientation/device_motion_event_rotation_rate.cc
- Chromium `device_sensor_event_pump.h`: `kDefaultPumpFrequencyHz = 60`: https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/modules/device_orientation/device_sensor_event_pump.h
- Chrome Intent to Ship: DeviceOrientation Events permission request API (17 June 2026, Chrome 151, no effect while the default is ALLOW): https://groups.google.com/a/chromium.org/g/blink-dev/c/ckd2rFmT3PA
- Chrome 76 deprecations: device motion and orientation restricted to secure contexts: https://developer.chrome.com/blog/chrome-76-deps-rems/

Platform behaviour

- iOS reports z = -9.81 for a flat face-up device while Android reports +9.81 (W3C list, Nov 2014): https://lists.w3.org/Archives/Public/public-geolocation/2014Nov/0001.html and https://lists.w3.org/Archives/Public/public-geolocation/2014Nov/0004.html
- Android motion sensors: stationary device reads +9.81, free fall 0, gyroscope in rad/s positive counter-clockwise: https://developer.android.com/develop/sensors-and-location/sensors/sensors_motion
- Apple CoreMotion: total acceleration = gravity + userAcceleration (device frame); rotation rate structure: https://developer.apple.com/documentation/coremotion/cmdevicemotion/gravity and https://developer.apple.com/documentation/coremotion/cmgyrodata/rotationrate
- iOS `alpha` is relative to the start, `absolute` undefined, `webkitCompassHeading` clockwise from magnetic north: https://lists.w3.org/Archives/Public/public-geolocation/2014Aug/0020.html and https://dev.to/toolswebs1/building-a-compass-in-the-browser-how-the-deviceorientation-api-actually-works-3f37
- beta = +90 for an upright phone on Chrome Android and Safari (2014 gap measurement): https://lists.w3.org/Archives/Public/public-geolocation/2014Jan/0000.html
- Safari 13 release post: Pointer Events, `DeviceMotionEvent.requestPermission()` required: https://webkit.org/blog/9674/new-webkit-features-in-safari-13/
- Permission must come from a tap and https (tutorial, 2020): https://yal.cc/js-device-motion/ ; denial cached across reloads (Apple forum): https://developer.apple.com/forums/thread/128376
- Firefox Android devicemotion interval 100 ms before Firefox 44 (bug 1217942): https://bugzilla.mozilla.org/show_bug.cgi?id=1217942
- Screen Wake Lock API: auto-release when hidden, re-request on `visibilitychange`: https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API ; support Chrome 84, Safari 16.4, iOS full 18.4 (16.4 partial, not in Home Screen web apps): https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/WakeLock.json
- Safari 16.4 features: Screen Wake Lock, Screen Orientation (`type`, `angle`, `change`; `lock()` experimental): https://webkit.org/blog/13966/webkit-features-in-safari-16-4/ ; `ScreenOrientation.lock` Safari: not supported, Chrome Android 38: https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/ScreenOrientation.json
- Element fullscreen on iPhone: WebKit bug 212934 (WONTFIX) and the forum thread: https://bugs.webkit.org/show_bug.cgi?id=212934 and https://developer.apple.com/forums/thread/133248?page=2
- `navigator.vibrate`: sticky activation required, no effect without hardware: https://developer.mozilla.org/en-US/docs/Web/API/Navigator/vibrate ; Chrome Android 32, returns false without a gesture since 60, Safari none: https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/Navigator.json
- `dvh`/`svh`: Safari 15.4, Chrome 108: https://raw.githubusercontent.com/mdn/browser-compat-data/main/css/types/length.json and https://webkit.org/blog/12445/new-webkit-features-in-safari-15-4/
- `overscroll-behavior` in Safari 16: https://webkit.org/blog/13152/webkit-features-in-safari-16-0/ ; disabling pull-to-refresh in Chrome: https://developer.chrome.com/blog/overscroll-behavior
- Pointer Events in Safari 13 (BCD): https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/PointerEvent.json ; `touch-action: none` Safari iOS 13, `manipulation` 9.3: https://raw.githubusercontent.com/mdn/browser-compat-data/main/css/properties/touch-action.json ; value semantics and `pointercancel` note: https://developer.mozilla.org/en-US/docs/Web/CSS/touch-action
- `touch-action: none` does not stop double-tap zoom on positioned elements (WebKit bug 218015): https://bugs.webkit.org/show_bug.cgi?id=218015 ; `user-scalable=no` ignored since iOS 10: https://frontendchecklist.io/rules/css/viewport-zoom ; `touch-action: manipulation` and the 350 ms delay: https://webkit.org/blog/5610/more-responsive-tapping-on-ios/ ; `touchstart.preventDefault()` blocks the iOS 13.4+ back-swipe: https://pqina.nl/blog/blocking-navigation-gestures-on-ios-13-4/
- Touch events: `preventDefault` on `touchstart`/first `touchmove` suppresses the compatibility mouse events; second-touch behaviour differs per browser: https://developer.mozilla.org/en-US/docs/Web/API/Touch_events
- Installed typings read: `node_modules/typescript/lib/lib.dom.d.ts` (TypeScript 5.9.3): `DeviceMotionEvent.{acceleration,accelerationIncludingGravity,rotationRate}: ... | null`, `interval: number`, `DeviceMotionEventAcceleration.x: number | null`, `DeviceMotionEventRotationRate.alpha: number | null`, no `requestPermission` static, `WakeLock.request(type?: WakeLockType): Promise<WakeLockSentinel>`, `WakeLockSentinel.released/release()`, `ScreenOrientation.type: OrientationType` with `unlock()` but no `lock()`, `Navigator.vibrate(pattern: VibratePattern): boolean`, `isSecureContext: boolean`, `PermissionState = "denied" | "granted" | "prompt"`, `FullscreenOptions.navigationUI`, `Element.setPointerCapture(pointerId)`, `pointercancel`/`lostpointercapture` in the event maps, `VisualViewport`, `DocumentVisibilityState`.
