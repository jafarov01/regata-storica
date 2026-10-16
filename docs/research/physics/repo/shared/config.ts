// shared/config.ts — PHYSICS section. Every tunable number of the simulation.
// (The real file also holds ammo, timers, aim assist, etc. Only the physics
// block is shown here; merge it into the contract file as `PHYSICS`.)

export const DEG = Math.PI / 180;

export const PHYSICS = {
  /** Fixed simulation step, seconds. 60 Hz as the spec requires. */
  dt: 1 / 60,
  /** Longest frame the accumulator will swallow (spiral-of-death guard). */
  maxFrameTime: 0.25,
  /** ASCII map cell size, metres. */
  cellSize: 8,

  boat: {
    length: 6,
    width: 1.4,
    /** kg. Only ratios matter; 1000 keeps forces in readable Newtons. */
    mass: 1000,
    /** Rapier damping d: v *= 1/(1 + dt*d) each step. Top speed = thrust/(mass*d). */
    linearDamping: 1.0,
    angularDamping: 3.0,
    /** m/s with GAS held, calm hull. Thrust is derived: mass*linearDamping*topSpeed. */
    topSpeed: 10,
    /** Boost: +60 % -> 16 m/s. */
    boostMul: 1.6,
    /** Reverse thrust as a fraction of forward thrust. */
    reverseMul: 0.4,
    /** N applied against forward velocity while BRAKE is held and the boat still moves forward. */
    brakeForce: 15000,
    /** Keel: lateral velocity decays as exp(-keelGrip*dt) per step (1/s). */
    keelGrip: 8,
    /** Lateral decay rate during a drift turn (stern slides out). */
    driftGrip: 1.5,
    /** Drift needs this much forward speed (m/s) and this much steer (0..1). */
    driftMinSpeed: 4,
    driftMinSteer: 0.3,
    /** Steering torque multiplier while drifting (sharper turn). */
    driftTurnMul: 1.5,
    /** Extra forward drag while drifting (1/s): the drift "loses speed". */
    driftDrag: 0.8,
    /** Steady-state turn rate (rad/s) at rest and at top speed; torque is derived. */
    turnRateRest: 0.5,
    turnRateFull: 1.3,
    /** Hard cap on angular velocity (rad/s). */
    maxAngvel: 1.8,
    restitution: 0.3,
    friction: 0.2,
    /** Speed multiplier is 1 - hullWaterSlowdown * water/100. */
    hullWaterSlowdown: 0.5,
    /** Boosted ram: approach speed along the contact normal must exceed this (m/s)... */
    ramMinSpeed: 7,
    /** ...and the rammer's bow must face the target: dot(forward, normal) >= this (cos 60 deg). */
    ramBowCos: 0.5,
    /** Impulse (N*s) applied at the impact point on a lethal hit, for the 2D spin while sinking. */
    sinkImpulse: 4000,
    sinkTime: 2,
    respawnTime: 5,
    spawnProtection: 3,
  },

  crate: { radius: 0.8, mass: 20, linearDamping: 1.5, angularDamping: 1.5, respawn: 8 },

  mine: {
    solidRadius: 0.4,
    triggerRadius: 1.6,
    mass: 10,
    linearDamping: 2,
    angularDamping: 2,
    armDelay: 1,
    lifetime: 45,
    /** Dropped this far behind the boat centre, with this fraction of its velocity. */
    dropBehind: 4,
    dropSpeedMul: 0.5,
  },

  cannon: { speed: 60, range: 120, radius: 0.3, assistMaxDeg: 4, assistCaptureDeg: 10 },
  torpedo: { speed: 25, range: 100, radius: 0.5, lockConeDeg: 40, lockRange: 80, turnRateDeg: 120 },
  mortar: { flightTime: 1.5, targetConeDeg: 10, targetRange: 60, defaultRange: 40, splashRadius: 6, apexHeight: 20 },
  waterCannon: { range: 18, halfAngleDeg: 12, pushForce: 6000, waterPerSecond: 25 },
} as const;
