/**
 * src/sim/tuning.ts: sim-internal numbers that shared/config.ts does not carry.
 *
 * Everything a playtest is likely to touch lives in shared/config.ts. These are
 * the physics research's values (docs/research/physics/final.md, PHYSICS block),
 * scaled by 0.4 where they are forces or impulses because the repo boat weighs
 * 400 kg instead of 1000 kg.
 */
export const TUNING = {
  boat: {
    /** N against forward motion while BRAKE is held and the boat still moves forward (15 000 x 0.4). */
    brakeForce: 6000,
    /** BRAKE + steer counts as a drift only above this much steer. */
    driftMinSteer: 0.3,
    /** Steering torque multiplier while drifting. */
    driftTurnMul: 1.5,
    /** Extra forward drag while drifting (1/s): a drift loses speed. */
    driftDrag: 0.8,
    /** Ram: the rammer's bow must face the target, dot(forward, normal) >= cos 60 deg. */
    ramBowCos: 0.5,
    /** Impulse at the impact point on a lethal hit, so the hull spins while it sinks (4000 x 0.4). */
    sinkImpulse: 1600,
    /** Hull corner radius: rounded corners slide over seams between wall rectangles. */
    cornerRadius: 0.15,
    /** Wall contact faster than this emits a `wall` event (sparks, thud). */
    wallEventSpeed: 2.5,
  },
  crate: {
    /** Floating crate: a light ball the hulls can shove (20 kg x 0.4). */
    radius: 0.8,
    mass: 8,
    linearDamping: 1.5,
    angularDamping: 1.5,
  },
  mine: {
    /** A dropped mine keeps this share of the boat's velocity, then drifts to a stop. */
    dropSpeedMul: 0.5,
    drag: 2,
  },
  cannon: {
    /** Projectile radius for the hull test. */
    radius: 0.3,
    /** Height the shot leaves the hull at (render hint). */
    muzzleHeight: 1.2,
  },
  torpedo: {
    radius: 0.5,
  },
  waterCannon: {
    /** A tap keeps the stream on this long; holding FIRE keeps it on. */
    tapStreamSec: 0.35,
    /** `fired` / `hit` cues for the stream are throttled to this interval. */
    cueIntervalSec: 0.25,
  },
  aim: {
    /** Hull radius used to widen the under-crosshair cone for close boats. */
    hullRadius: 2,
    /** Crosshair X flash after a landed hit. */
    hitFlashSec: 0.3,
  },
  respawn: {
    /** A dock with any boat closer than this is skipped. */
    dockClearance: 12,
  },
  killFeedMax: 5,
} as const;
