/**
 * Every tunable number in one place. Read by the sim, the renderer, the HUD,
 * the phone and the bots. No logic here beyond tiny helpers; no imports from
 * src/. Values marked [spec] come from SPEC.md, the rest are our defaults
 * to be adjusted at the playtest (see PLAYTEST_TUNING at the bottom).
 */

export type Tier = 'mvp' | 'should' | 'stretch';

export type WeaponKind = 'cannon' | 'torpedo' | 'mortar';
export type PowerKind = 'shield' | 'mine' | 'boost' | 'smoke' | 'wave';
export type ItemKind = WeaponKind | PowerKind;
export type CrateCategory = 'weapon' | 'power';

/** Which scope tiers are switched on. Flip a tier off and every feature in it disappears from crates, HUD and rules. */
export const TIERS: Readonly<Record<Tier, boolean>> = {
  mvp: true,
  should: true,
  stretch: false,
};

export interface TeamColour {
  /** Italian name shown on the viewport border and the phone. */
  name: string;
  /** Fill colour: viewport border, crosshair, boat trim and lantern, phone background. */
  hex: string;
  /** Text colour that reads on `hex` (WCAG contrast >= 4.1 against it). */
  text: '#000000' | '#FFFFFF';
}

/** [spec] Team order is join order; the colour follows the team index. */
export const TEAM_COLOURS: readonly TeamColour[] = [
  { name: 'Rosso', hex: '#E53935', text: '#FFFFFF' },
  { name: 'Azzurro', hex: '#29B6F6', text: '#000000' },
  { name: 'Verde', hex: '#4CAF50', text: '#000000' },
  { name: 'Oro', hex: '#FFD600', text: '#000000' },
  { name: 'Viola', hex: '#BA68C8', text: '#000000' },
  { name: 'Arancio', hex: '#FB8C00', text: '#000000' },
];

export interface ItemDef {
  kind: ItemKind;
  /** Shown in the HUD, the phone and the kill feed ("sank X with a Torpedo"). */
  label: string;
  tier: Tier;
  /** Relative weight inside its crate category. */
  weight: number;
}

export const CONFIG = {
  teams: {
    maxTeams: 6, // [spec] most viewports a projector shows readably
    defaultTeamSize: 3 as 2 | 3, // [spec] host picks 3 (default) or 2
    maxPlayers: 18, // [spec] 6 teams x 3
    minTeamsToStart: 2, // a match needs an enemy
  },

  boat: {
    length: 6, // [spec] m
    width: 1.4, // [spec] m
    mass: 400, // kg, arcade value (a real gondola is ~600 kg; lighter = snappier)
    topSpeed: 10, // [spec] m/s
    boostMultiplier: 1.6, // [spec] 16 m/s with Boost
    reverseThrustRatio: 0.4, // [spec] reverse is 40% of forward thrust
    forwardThrust: 2600, // N; with mass 400 and damping 0.6 this reaches ~10 m/s
    linearDamping: 0.6, // 1/s, water resistance (Rapier RigidBodyDesc.setLinearDamping)
    angularDamping: 3.0, // 1/s
    lateralGrip: 8, // 1/s, how fast sideways velocity is killed (the keel)
    driftGrip: 2, // 1/s, same while BRAKE is held at speed (stern slides out)
    driftMinSpeed: 4, // m/s, BRAKE below this is plain reverse, above it is a drift turn
    steerTorqueAtRest: 400, // N m, slow turn still possible at rest
    steerTorqueAtSpeed: 1800, // N m, reached at topSpeed
    hullRadius: 3.2, // m, bounding circle used by aim tests and crate pickup
    ramMinImpactSpeed: 7, // m/s relative speed for a boosted ram to be lethal
  },

  steer: {
    deadZoneDeg: 4, // [spec]
    fullLockDeg: 35, // [spec]
    sign: 1 as 1 | -1, // flip if left turns right on the first phone test
  },

  water: {
    max: 100, // [spec] hull water 0..100
    speedPenalty: 0.5, // [spec] speed x (1 - 0.5 * water / 100)
    fillPerSecond: 25, // 4 s of continuous Water Cannon stream fills a hull
    bailPerSecondAtFullShake: 40, // Engineer shaking hard empties a full hull in 2.5 s
    autoDrainPerSecond: 20, // [spec] 2-person teams drain at half the manual rate
    naturalDrainPerSecond: 0, // 3-person teams: the Engineer has to work
  },

  weapons: {
    waterCannon: {
      range: 14, // m, short stream
      halfAngleDeg: 6, // the stream is a thin cone
      pushForce: 1800, // N, continuous push along the stream
      endsSpawnProtection: true, // decision: any firing ends the bubble, water cannon included
    },
    cannon: {
      ammo: 5, // [spec]
      speed: 45, // m/s, fast straight shot
      range: 90, // m, the ball is removed beyond this
      cooldown: 0.45, // s between shots while FIRE is held (auto-fire allowed)
      autoFire: true,
      hitRadius: 1.2, // m, ball vs hull-circle check
    },
    torpedo: {
      ammo: 2, // [spec]
      speed: 20, // m/s, slower than the cannon, homes
      lifetime: 7, // s
      lockHalfAngleDeg: 20, // [spec] 40 degree cone ahead of the aim
      lockRange: 70, // m
      homingTurnRateDegPerSec: 90, // how fast it bends toward the lock
      cooldown: 1.0,
      autoFire: false,
      hitRadius: 1.5,
    },
    mortar: {
      ammo: 3, // [spec]
      targetHalfAngleDeg: 10, // [spec] within 10 degrees of the aim line
      targetRange: 60, // [spec] m
      fallbackRange: 40, // [spec] lands 40 m ahead without a target
      splashRadius: 6, // [spec] m
      flightTime: 1.8, // s, fixed so the lob is readable
      cooldown: 1.2,
      autoFire: false,
    },
  },

  powers: {
    shield: { duration: 8, hits: 1 }, // [spec] 8 s or 1 hit
    mine: { armDelay: 1, lifetime: 45, triggerRadius: 2.5, dropBehind: 5 }, // [spec] arms after 1 s, lasts 45 s
    boost: { duration: 3 }, // [spec] 3 s, speed from boat.boostMultiplier
    smoke: { duration: 6, radius: 7, trailSpacing: 4 }, // [spec] 6 s trail, hides and breaks locks
    wave: { radius: 12, impulse: 2500 }, // [spec] shoves every boat within 12 m
    ping: { reveal: 2, cooldown: 20 }, // [spec] stretch, Engineer
  },

  items: [
    { kind: 'cannon', label: 'Cannon', tier: 'mvp', weight: 50 },
    { kind: 'torpedo', label: 'Torpedo', tier: 'mvp', weight: 30 },
    { kind: 'mortar', label: 'Mortar', tier: 'should', weight: 20 },
    { kind: 'shield', label: 'Shield', tier: 'mvp', weight: 35 },
    { kind: 'mine', label: 'Mine', tier: 'mvp', weight: 35 },
    { kind: 'boost', label: 'Boost', tier: 'should', weight: 20 },
    { kind: 'smoke', label: 'Smoke', tier: 'stretch', weight: 5 },
    { kind: 'wave', label: 'Wave', tier: 'stretch', weight: 5 },
  ] as readonly ItemDef[],

  crates: {
    respawnSeconds: 8, // [spec]
    frenzyRespawnSeconds: 4, // [spec] stretch: twice as fast in the final minute
    pickupRadius: 2.5, // m, crate centre to hull circle
    weaponShare: 0.6, // 3 of every 5 crate points are red (weapon)
    powerSlots: 2, // [spec] Engineer holds 2 powers
  },

  match: {
    countdownSeconds: 10, // [spec]
    battleSeconds: 300, // [spec]
    resultsSeconds: 20, // [spec]
    suddenDeathSeconds: 30, // [spec]
    frenzyLastSeconds: 60, // [spec] stretch: timer turns red, crates respawn faster
    hornAtSecondsLeft: 3, // 3-2-1 beeps then the horn at 0
    clockRedLastSeconds: 30, // the big clock turns red for the last 30 s (and all of overtime / frenzy)
    autoReturnToLobby: true, // results time out into a rematch-ready lobby
  },

  respawn: {
    sinkSeconds: 2, // [spec] flip and sink
    respawnSeconds: 5, // [spec] measured from the hit
    killCamSeconds: 5, // [spec]
    spawnProtectionSeconds: 3, // [spec]
    minDistanceToEnemy: 80, // [spec] m
    dockClearance: 12, // m, a dock already holding a boat is skipped
  },

  aim: {
    gyroGain: 2, // [spec] phone turn x2 = view turn
    gyroDeadZoneDegPerSec: 2, // [spec] hand tremor
    gyroSign: 1 as 1 | -1, // flip on the first test if left turns right
    onTargetGain: 0.6, // [spec] gain drops by 40% while an enemy is under the crosshair
    onTargetRadius: 3.5, // m, hull circle used for "under the crosshair" (hullRadius + margin)
    onTargetStickyRadius: 4.6, // m, larger circle while already on target (hysteresis)
    onTargetRange: 90, // m
    assistHalfAngleDeg: 8, // candidates for the 4 degree bend
    assistRange: 70, // m
    assistMaxBendDeg: 4, // [spec]
    requireLineOfSight: true, // diamond + assist + torpedo lock need a clear wall ray
    keyboardTurnRateDegPerSec: 120, // Left/Right keys
    hitFlashSeconds: 0.3, // X flash after a landed shot
  },

  camera: {
    back: 9, // [spec] m behind the boat along the aim
    up: 4, // [spec] m above the water
    fovDeg: 60,
    yawSmoothingTau: 0.08, // s, exponential smoothing of the camera yaw toward aimYaw
    killCamDistance: 14, // m from the killer
    killCamHeight: 7,
    far: 220, // m, haze hides the rest
  },

  phone: {
    inputHz: 30, // [spec]
    hudHz: 10, // [spec]
    shakePeakThreshold: 15, // [spec] m/s^2 without gravity
    shakePeaksPerSecondForFull: 4, // peaks/s that map to shake = 1
    vibrateFireMs: 25,
    vibrateHitMs: 120,
    flashMs: 150, // iOS has no vibration: red flash
    gravityLowPassTau: 0.15, // s, gravity vector filter for the gyro projection
  },

  net: {
    inputTimeoutSeconds: 1.5, // no packet for this long: the controller is idle (boat coasts)
    reconnectGraceSeconds: 180, // the slot is kept for a token this long after a drop
    tokenStorageKey: 'gondola.token',
    roomCodeLength: 4,
  },

  minimap: {
    revealAfterFireSeconds: 2, // [spec]
    revealOnWaterCannon: false, // the stream is short range; it would reveal constantly
    revealInLagoon: true, // [spec]
    revealTiedTeamsInOvertime: true, // decision: sudden death must not be hide and seek
  },

  bots: {
    turnRateDegPerSec: 150,
    fireRange: 55,
    fireHalfAngleDeg: 12,
    stuckSeconds: 2,
    stuckSpeed: 0.8,
    reverseSeconds: 1.5,
    waypointReached: 6,
    powerUseInterval: 8,
  },

  sim: {
    hz: 60, // [spec] fixed step
    maxStepsPerFrame: 5, // spiral-of-death guard when a tab was hidden
  },
} as const;

export type GameConfig = typeof CONFIG;

export function itemDef(kind: ItemKind, cfg: GameConfig = CONFIG): ItemDef {
  const def = cfg.items.find((d) => d.kind === kind);
  if (!def) throw new Error(`unknown item ${kind}`);
  return def;
}

export function isWeapon(kind: ItemKind): kind is WeaponKind {
  return kind === 'cannon' || kind === 'torpedo' || kind === 'mortar';
}

export function itemEnabled(kind: ItemKind, tiers: Readonly<Record<Tier, boolean>> = TIERS, cfg: GameConfig = CONFIG): boolean {
  return tiers[itemDef(kind, cfg).tier];
}

/** What to tune with real players at checkpoint 2, in priority order. */
export const PLAYTEST_TUNING: readonly string[] = [
  'aim.gyroGain and aim.gyroDeadZoneDegPerSec (twitchy vs sluggish)',
  'aim.assistMaxBendDeg and aim.onTargetGain (hits per shot should be about 1 in 3)',
  'steer.deadZoneDeg and steer.fullLockDeg (nobody should need to wrench the phone)',
  'boat.forwardThrust, linearDamping, steerTorqueAtSpeed (feel of the turn)',
  'respawn.minDistanceToEnemy and spawnProtectionSeconds (spawn kills)',
  'water.fillPerSecond and bailPerSecondAtFullShake (is bailing a real job)',
  'weapons.cannon.ammo, torpedo.ammo, mortar.ammo and crates.respawnSeconds (looting pace)',
  'items[].weight (are Torpedoes deciding every fight)',
  'boat.ramMinImpactSpeed (rams should be rare and loud)',
];
