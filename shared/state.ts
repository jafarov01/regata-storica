/**
 * shared/state.ts: the GameState.
 *
 * CONTRACT FILE. The simulation (src/sim) writes it; the renderer, the HUD and
 * the phone HUD feed (src/scene, src/render) only read it. It is a plain
 * serialisable object: no class instances, no Rapier handles, no DOM. Anything
 * physics-specific stays inside src/sim and is mirrored here each step.
 *
 * Coordinates: metres, Three.js world frame, Y up, water at y = 0. The 2D sim
 * uses (x, z). Heading and aim are world yaw angles in radians equal to
 * Object3D.rotation.y: forward = (-sin yaw, -cos yaw) in (x, z), yaw 0 looks
 * toward -z, positive yaw turns left (counter-clockwise seen from above).
 * See shared/map.ts for the full coordinate rules.
 */
import type { PowerId, WeaponId } from './config.ts';

export type Phase = 'lobby' | 'countdown' | 'battle' | 'suddendeath' | 'results';
export type Role = 'pilot' | 'gunner' | 'engineer';
export const ROLES: readonly Role[] = ['pilot', 'gunner', 'engineer'];
/** 'out': eliminated in sudden death (only tied teams keep fighting). */
export type BoatStatus = 'alive' | 'sinking' | 'respawning' | 'out';
export type CrosshairState = 'neutral' | 'enemy' | 'hit' | 'lock';
export type CrateCategory = 'weapon' | 'power';
export type KillCause = WeaponId | 'mine' | 'ram';

/** A 2D pose on the water plane. */
export interface Pose {
  x: number;
  z: number;
  yaw: number;
}

export interface PlayerState {
  /** Relay-assigned id (phones) or 'kb-<n>' for keyboard players and 'bot-<n>' for bots. */
  id: string;
  name: string;
  /** Team index, or -1 while waiting as a spectator. */
  team: number;
  role: Role;
  connected: boolean;
  ready: boolean;
  calibrated: boolean;
  /** Keyboard harness or bot; no phone behind it. */
  virtual: boolean;
  /** Sim time of the last input packet; the HUD flags phones that went quiet. */
  lastInputAt: number;
  kills: number;
  ramKills: number;
}

export interface TeamState {
  index: number;
  name: string;
  colour: string;
  /** Player ids in role order: [pilot, gunner, engineer]. */
  members: string[];
  kills: number;
  deaths: number;
}

export interface BoatState {
  team: number;
  status: BoatStatus;
  /** Pose at the end of the last sim step and the one before it; the renderer lerps by alpha. */
  pose: Pose;
  prevPose: Pose;
  /** World-space velocity (m/s) and signed forward speed. */
  vx: number;
  vz: number;
  speed: number;
  angVel: number;
  /** Gunner's aim, a world yaw held independent of the hull. */
  aimYaw: number;
  prevAimYaw: number;
  /** Hull water 0..100; speed scales by 1 - 0.5 * water / 100. */
  water: number;
  weapon: WeaponId;
  ammo: number;
  powers: [PowerId | null, PowerId | null];
  /** Sim-time deadlines; 0 means inactive. */
  shieldUntil: number;
  boostUntil: number;
  protectedUntil: number;
  smokeUntil: number;
  /** Set while sinking/respawning. */
  sunkAt: number;
  respawnAt: number;
  killerTeam: number | null;
  killCause: KillCause | null;
  /** Live inputs mirrored for animation (rowing speed, stream, bailing). */
  gas: boolean;
  brake: boolean;
  steer: number;
  firing: boolean;
  shake: number;
  drifting: boolean;
  /** Aiming helpers computed by the sim each step. */
  crosshair: CrosshairState;
  /** Enemy team under the crosshair or locked by a torpedo, else null. */
  aimTarget: number | null;
  lockTarget: number | null;
  /** Sim time of the last lethal shot (minimap reveal, spawn protection end). */
  lastFireAt: number;
  /** Sim time of the last hit landed by this team's Gunner (crosshair X flash). */
  lastHitAt: number;
  /** Bail/row animation phase, render-only hint. */
  rowPhase: number;
}

export type ProjectileKind = 'cannon' | 'torpedo' | 'mortar';

export interface ProjectileState {
  id: number;
  kind: ProjectileKind;
  team: number;
  x: number;
  z: number;
  prevX: number;
  prevZ: number;
  vx: number;
  vz: number;
  yaw: number;
  /** Height above water for the visual arc (render-only). */
  y: number;
  /** Mortar: impact point and 0..1 flight progress. */
  targetX: number;
  targetZ: number;
  progress: number;
  /** Torpedo: locked team or null. */
  lockTarget: number | null;
  spawnedAt: number;
}

export interface CrateState {
  id: number;
  x: number;
  z: number;
  category: CrateCategory;
  /** False while collected and waiting to respawn. */
  active: boolean;
  respawnAt: number;
  /** Floating drift offset applied by the physics (crates get shoved). */
  yaw: number;
}

export interface MineState {
  id: number;
  team: number;
  x: number;
  z: number;
  armedAt: number;
  expiresAt: number;
}

export interface SmokePuff {
  id: number;
  team: number;
  x: number;
  z: number;
  until: number;
}

export interface KillFeedEntry {
  at: number;
  killerTeam: number;
  victimTeam: number;
  cause: KillCause;
}

export interface Results {
  /** Team indices, best first. */
  ranking: number[];
  winner: number;
  /** Player id with the most kills, or null. */
  topGunner: string | null;
  bestRam: string | null;
  /** True when the match went to sudden death. */
  suddenDeath: boolean;
}

export interface GameState {
  phase: Phase;
  /** Sim time in seconds since the sim was created; all deadlines are in this clock. */
  time: number;
  tick: number;
  /** Sim time when the current phase ends (battle end, results end, countdown end). */
  phaseEndsAt: number;
  teamSize: 2 | 3;
  teams: TeamState[];
  players: Record<string, PlayerState>;
  /** Spectator queue: player ids waiting for a slot, in join order. */
  spectators: string[];
  /** One boat per team, indexed by team. */
  boats: BoatState[];
  crates: CrateState[];
  mines: MineState[];
  projectiles: ProjectileState[];
  smoke: SmokePuff[];
  /** Last 5 kills, newest last. */
  killFeed: KillFeedEntry[];
  /** Teams still fighting in sudden death; empty otherwise. */
  suddenDeathTeams: number[];
  results: Results | null;
  /** Final-minute frenzy is active (Stretch). */
  frenzy: boolean;
  /** Host paused the sim. */
  paused: boolean;
}

export type SimEvent =
  | { kind: 'phase'; phase: Phase }
  | { kind: 'countdown'; secondsLeft: number }
  | { kind: 'fired'; team: number; weapon: WeaponId; x: number; z: number; yaw: number }
  | { kind: 'hit'; team: number; victim: number; cause: KillCause; x: number; z: number }
  | { kind: 'shielded'; team: number; x: number; z: number }
  | { kind: 'kill'; team: number; victim: number; cause: KillCause; playerId: string | null }
  | { kind: 'sunk'; team: number; killerTeam: number; cause: KillCause; x: number; z: number }
  | { kind: 'respawn'; team: number; x: number; z: number }
  | { kind: 'pickup'; team: number; category: CrateCategory; item: WeaponId | PowerId; x: number; z: number }
  | { kind: 'power'; team: number; power: PowerId; x: number; z: number }
  | { kind: 'splash'; x: number; z: number; size: number }
  | { kind: 'wall'; team: number; x: number; z: number; speed: number }
  | { kind: 'ram'; team: number; victim: number; lethal: boolean; x: number; z: number }
  | { kind: 'win'; team: number }
  | { kind: 'join'; playerId: string }
  | { kind: 'leave'; playerId: string };

export type SimEventKind = SimEvent['kind'];
