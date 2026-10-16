/**
 * shared/config.ts: every tunable number in one place.
 *
 * CONTRACT FILE: read-only for the three tracks. Values marked "playtest" are
 * the ones to touch at the Gate 2 playtest. Units: metres, seconds, radians
 * unless the name says Deg / Hz / Ms. Speeds in m/s.
 *
 * Tier flags at the bottom turn Should/Stretch features on and off so that a
 * cut feature is a flag flip, not a code change.
 */

export const TEAM_COLOURS = [
  { name: 'Rosso', hex: '#e04a3a' },
  { name: 'Azzurro', hex: '#3a8fe0' },
  { name: 'Verde', hex: '#3fbf5f' },
  { name: 'Oro', hex: '#f2b544' },
  { name: 'Viola', hex: '#9b5de5' },
  { name: 'Arancio', hex: '#ff8a2a' },
] as const;

export const MATCH = {
  /** Default crew size the host picks in the lobby (3 or 2). */
  teamSizeDefault: 2 as 2 | 3,
  /** Most viewports a projector can show readably. */
  maxTeams: 6,
  maxPlayers: 12,
  /** Countdown before the battle; Pilots and Gunners calibrate here. */
  countdownSec: 10,
  /** Fixed battle length. */
  battleSec: 300,
  /** Final scoreboard and podium. */
  resultsSec: 20,
  /** Overtime between tied teams; next kill wins. */
  suddenDeathSec: 30,
  /** Final-minute frenzy window (Stretch, see TIERS). */
  frenzyLastSec: 60,
} as const;

export const RESPAWN = {
  /** Flip-and-sink animation after a lethal hit. The kill-cam runs for the whole respawn delay. */
  sinkSec: 2,
  /** From the lethal hit to the boat reappearing at a dock. */
  delaySec: 5,
  /** Bubble after respawn; ends early when the Gunner fires a lethal weapon. playtest */
  protectionSec: 3,
  /** Only docks at least this far from every enemy boat are candidates. playtest */
  minDistanceFromEnemy: 50,
} as const;

export const SIM = {
  /** Fixed simulation step. */
  hz: 60,
  dt: 1 / 60,
  /** Max sim steps per rendered frame (spiral-of-death guard). */
  maxStepsPerFrame: 5,
} as const;

export const BOAT = {
  length: 6,
  beam: 1.4,
  /**
   * Body mass in kg; forces below are sized for it. Settled: 400 kg. Rapier damping
   * gives terminal speed = thrust / (mass * linearDamping), so keep
   * thrust = mass * linearDamping * topSpeed (400 * 0.65 * 10 = 2600) when tuning.
   * The physics research used 1000 kg; scale its forces by 0.4 when lifting code.
   */
  mass: 400,
  /** Arcade top speed (about 3x a real gondola). playtest */
  topSpeed: 10,
  /** Top speed while boosted. */
  boostSpeed: 16,
  /** Reverse thrust as a fraction of forward thrust. */
  reverseFactor: 0.4,
  /** Forward thrust in newtons at full GAS and no water aboard. */
  thrust: 2600,
  /** Rapier linear damping (water resistance); with thrust gives the top speed. */
  linearDamping: 0.65,
  angularDamping: 3,
  /** Steering torque at rest and its growth with speed: torque = steer * (base + perSpeed * min(v, topSpeed)). */
  steerTorqueBase: 900,
  steerTorquePerSpeed: 260,
  /** Hard cap on turn rate, rad/s. */
  maxTurnRate: 1.6,
  /** Fraction of lateral (keel) velocity removed per second: 1 = instant. */
  keelGrip: 7,
  /** Keel grip while drifting (BRAKE held while steering at speed). */
  driftGrip: 1.5,
  /** Speed above which BRAKE + steer counts as a drift turn. */
  driftMinSpeed: 5,
  /** Speed multiplier at a full hull: speed * (1 - waterSlowFactor * water / 100). */
  waterSlowFactor: 0.5,
  /** Minimum closing speed for a boosted ram to sink the target. playtest */
  ramMinClosingSpeed: 6,
  restitution: 0.4,
  friction: 0.2,
} as const;

/** Phone sensor processing and send rates (the phone side of the contract). */
export const PHONE = {
  /** Phones send inputs at this rate, not on every sensor event. */
  inputHz: 30,
  /** Scene sends HUD status back at this rate. */
  hudHz: 10,
  /** Tilt steering: no response below this roll angle. playtest */
  steerDeadZoneDeg: 4,
  /** Tilt steering: full lock at this roll angle. playtest */
  steerFullLockDeg: 35,
  /** Low-pass time constant for the gravity vector, seconds. */
  gravityFilterTau: 0.08,
  /** Gyro aim: how many times faster than the phone the view turns. playtest */
  gyroGain: 2.5,
  /** Gyro aim: ignore turn rates below this (hand tremor). playtest */
  gyroDeadZoneDegPerSec: 2,
  /** Gyro aim: low-pass on the turn rate, seconds. Takes the sensor noise out, lags a real turn by about this. */
  gyroRateTau: 0.05,
  /** Shake-to-bail: a peak is acceleration (without gravity) above this, m/s^2. */
  shakeThreshold: 15,
  /** Minimum time between two counted shake peaks. */
  shakeRefractorySec: 0.12,
  /** Peaks per second that count as shake = 1. */
  shakeFullRatePerSec: 4,
  /** Motion watchdog: if no sensor event arrives within this time after enabling, show help. */
  motionWatchdogSec: 1.5,
} as const;

export const AIM = {
  /**
   * The aim is held relative to the bow: when the Pilot turns, the Gunner's view turns with the
   * boat and the gyro offsets it from the bow. false = the spec's world-stabilised aim, where a
   * turning boat leaves the view behind and the Gunner has to follow by hand. playtest
   */
  followBow: true,
  /** Cannon shots bend up to this toward the nearest enemy near the aim line. playtest */
  assistMaxBendDeg: 4,
  /** "Near the aim line" for aim assist: half-angle of the cone. */
  assistConeDeg: 10,
  assistRange: 70,
  /** "Enemy under the crosshair": half-angle; gyro gain drops while true. */
  underCrosshairDeg: 3,
  underCrosshairRange: 90,
  /** Gyro gain multiplier while an enemy is under the crosshair (a 40% drop). playtest */
  gainUnderCrosshair: 0.6,
  /** Torpedo: lock the nearest enemy inside this cone around the aim direction. */
  torpedoLockConeDeg: 40,
  torpedoLockRange: 90,
  /** Mortar: auto-range onto the nearest enemy within this cone and range, else drop at defaultRange. */
  mortarConeDeg: 10,
  mortarRange: 60,
  mortarDefaultRange: 40,
} as const;

export const CAMERA = {
  /** Third-person rig: behind and above the boat along the aim direction. */
  back: 9,
  up: 4,
  fovDeg: 62,
  near: 0.5,
  far: 320,
  /** Exponential smoothing time constant for camera position (not for aim). */
  positionTau: 0.12,
  /** The camera's look direction eases toward the aim with this time constant (jitter, not lag). */
  lookTau: 0.04,
  /** Haze: fog starts and ends (metres). Hides the far map edge. */
  fogNear: 90,
  fogFar: 260,
} as const;

export type WeaponId = 'watercannon' | 'cannon' | 'torpedo' | 'mortar';
export type PowerId = 'shield' | 'mine' | 'boost' | 'smoke' | 'wave';
export type Tier = 'mvp' | 'should' | 'stretch';

export interface WeaponDef {
  id: WeaponId;
  label: string;
  tier: Tier;
  /** Shots per pickup; Infinity for the water cannon. */
  ammo: number;
  /** Seconds between shots; the water cannon is a continuous stream. */
  fireInterval: number;
  /** Holding FIRE keeps firing. */
  autoFire: boolean;
  lethal: boolean;
  /** Relative chance in a red (weapon) crate. */
  weight: number;
}

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  watercannon: { id: 'watercannon', label: 'Water Cannon', tier: 'mvp', ammo: Infinity, fireInterval: 0, autoFire: true, lethal: false, weight: 0 },
  // The Gunner's default: always there, unlimited, one shot a second (crates no longer hand it out).
  cannon: { id: 'cannon', label: 'Cannon', tier: 'mvp', ammo: Infinity, fireInterval: 1, autoFire: true, lethal: true, weight: 0 },
  torpedo: { id: 'torpedo', label: 'Torpedo', tier: 'mvp', ammo: 2, fireInterval: 0.8, autoFire: false, lethal: true, weight: 3 },
  mortar: { id: 'mortar', label: 'Fireworks Mortar', tier: 'should', ammo: 3, fireInterval: 0.9, autoFire: false, lethal: true, weight: 0 },
};

/**
 * What the Gunner holds with an empty slot, and gets back when a pickup runs out. Simplified
 * game (2026-10-16): the Cannon, unlimited; red crates hand out Torpedoes. The Water Cannon,
 * the Mortar, powers, hull water and the Engineer stay in the code behind TIERS, switched off.
 */
export const DEFAULT_WEAPON: WeaponId = 'cannon';

export const WATER_CANNON = {
  /** Stream reach and half-angle of the cone. */
  range: 14,
  halfAngleDeg: 12,
  /** Push force in newtons along the stream on every boat in the cone. playtest */
  pushForce: 2200,
  /** Hull water added per second under the stream (0..100 scale). playtest */
  fillPerSec: 30,
} as const;

export const CANNON = {
  speed: 60,
  /** Max flight distance before the ball splashes down. */
  range: 110,
  /** Visual arc apex height; the hit test is 2D. */
  arcHeight: 2.5,
} as const;

export const TORPEDO = {
  speed: 24,
  /** Max homing turn rate, rad/s. */
  turnRate: 1.8,
  lifetimeSec: 7,
  /** Smoke breaks the lock within this distance of a smoke puff. */
  smokeBreakRadius: 6,
} as const;

export const MORTAR = {
  /** Fixed flight time from launch to impact. */
  flightSec: 1.6,
  splashRadius: 6,
  /** Visual arc apex height. */
  arcHeight: 25,
} as const;

export interface PowerDef {
  id: PowerId;
  label: string;
  tier: Tier;
  weight: number;
}

export const POWERS: Record<PowerId, PowerDef> = {
  shield: { id: 'shield', label: 'Shield', tier: 'mvp', weight: 5 },
  mine: { id: 'mine', label: 'Mine', tier: 'mvp', weight: 5 },
  boost: { id: 'boost', label: 'Boost', tier: 'should', weight: 4 },
  smoke: { id: 'smoke', label: 'Smoke', tier: 'stretch', weight: 2 },
  wave: { id: 'wave', label: 'Wave', tier: 'stretch', weight: 2 },
};

/** A Shield from a blue crate lasts this long, or until it absorbs one hit. */
export const SHIELD = { durationSec: 5 } as const;
export const MINE = {
  armDelaySec: 1,
  lifetimeSec: 45,
  /** Trigger radius around the mine. */
  radius: 2.2,
  /** Dropped this far behind the stern. */
  dropBehind: 4,
} as const;
export const BOOST = { durationSec: 3, speedMultiplier: 1.6 } as const;
export const SMOKE = { durationSec: 6, puffEverySec: 0.25, puffLifetimeSec: 5 } as const;
export const WAVE = { radius: 12, impulse: 2800 } as const;

export const CRATES = {
  /** Seconds before a collected crate reappears with new random contents. */
  respawnSec: 8,
  /** Drive within this distance of a crate to collect it. */
  pickupRadius: 3.2,
  /** Share of crate points that are red (weapon) versus blue (power). */
  weaponShare: 0.65, // red (Torpedo) crates; the rest are blue instant-Shield crates (TIERS.shieldCrates)
  /** Final-minute frenzy respawn speed-up (Stretch). */
  frenzyRespawnMultiplier: 2,
} as const;

export const HULL = {
  /** Water drained per second at shake = 1 (Engineer shaking hard). playtest */
  bailPerSecAtFullShake: 60,
  /** 2-person teams drain automatically at half speed. */
  autoDrainPerSec: 30,
} as const;

export const MINIMAP = {
  /** An enemy stays on the minimap this long after it fires. */
  revealAfterFireSec: 2,
  /** Stretch: Engineer Ping reveals everyone for this long, then cools down. */
  pingRevealSec: 2,
  pingCooldownSec: 20,
} as const;

// Wire constants (room codes, rates, grace periods) live in shared/protocol.ts (NET).

export const KEYBOARD = {
  /** Keyboard steering ramps to full lock in this many seconds. */
  steerRampSec: 0.25,
  /** Keyboard aim turn rate, rad/s. */
  aimRate: 2.2,
} as const;

/** Feature tiers. Flip to false to cut a feature without touching code. */
export const TIERS = {
  engineer: false, // Should: Engineer role and teams of 3 (off: crews of 2)
  mortar: false, // Should
  boost: false, // Should: Boost and ram kills
  killCam: true, // Should
  animatedCrew: true, // Should
  bailing: false, // Should: shake to bail
  powers: false, // power slots and buttons: Shield, Mine, Boost held by an Engineer (off with the Engineer)
  shieldCrates: true, // blue crates give an instant 5 s Shield on pickup, no button (the simplified game)
  killFeed: true, // Should
  audio: true, // Should
  smoke: false, // Stretch
  wave: false, // Stretch
  frenzy: false, // Stretch: final-minute crate frenzy
  solo: false, // Stretch: 1-person teams
  ping: false, // Stretch: Engineer ping
} as const;

export type TierFlag = keyof typeof TIERS;

/** Items currently enabled by tier flags, for crate rolls. */
export function enabledWeapons(): WeaponDef[] {
  return Object.values(WEAPONS).filter((w) => w.weight > 0 && (w.id !== 'mortar' || TIERS.mortar));
}

export function enabledPowers(): PowerDef[] {
  return Object.values(POWERS).filter((p) => {
    if (p.id === 'boost') return TIERS.boost;
    if (p.id === 'smoke') return TIERS.smoke;
    if (p.id === 'wave') return TIERS.wave;
    return true;
  });
}

/** Tune these at the Gate 2 playtest, in this order. */
export const PLAYTEST_TUNING = [
  'PHONE.gyroGain / gyroDeadZoneDegPerSec: twitchy or sluggish aim',
  'PHONE.steerDeadZoneDeg / steerFullLockDeg: wobbly or stiff steering',
  'AIM.assistMaxBendDeg / gainUnderCrosshair: too easy or too hard to hit',
  'BOAT.topSpeed / thrust / keelGrip: pace of the match',
  'WEAPONS ammo counts: how often teams loot',
  'RESPAWN.minDistanceFromEnemy / protectionSec: spawn kills',
  'WATER_CANNON.fillPerSec / HULL.bailPerSecAtFullShake: how punishing water is',
] as const;
