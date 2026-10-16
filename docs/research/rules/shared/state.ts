/**
 * GameState: the simulation writes it, everything else reads it.
 *
 * Rules for this file:
 *  - plain data only: numbers, strings, booleans, arrays, records, null.
 *    JSON.parse(JSON.stringify(state)) must give an equal object.
 *  - NO Rapier World / RigidBody / Collider objects and NO Rapier handles
 *    (they are packed f64 values such as 5e-324 that only mean something to
 *    the live World). NO Three.js objects, NO functions, NO Map/Set/Date,
 *    NO class instances. The sim keeps its handles in a private side table
 *    keyed by team index / crate id / mine id.
 *  - every timer is an absolute sim time in seconds (compare with simTime),
 *    never a wall-clock value and never a countdown that must be decremented.
 */
import type { CrateCategory, ItemKind, PowerKind, WeaponKind } from './config.ts';

export type Phase = 'lobby' | 'countdown' | 'battle' | 'overtime' | 'results';
export type Role = 'pilot' | 'gunner' | 'engineer';
export const ROLES: readonly Role[] = ['pilot', 'gunner', 'engineer'];
export type TeamSize = 2 | 3;
export type BoatStatus = 'alive' | 'sinking' | 'respawning' | 'out';
/** What can sink a boat. Powers other than the Mine never kill. */
export type LethalKind = WeaponKind | 'mine' | 'ram';
export type CrosshairState = 'neutral' | 'target' | 'hit' | 'lock';
export type PlayerKind = 'phone' | 'keyboard' | 'bot';
export type ProjectileKind = WeaponKind;

/** Sim-plane pose. x, y are metres on the water (sim y = world z); angle is radians, bow direction = (cos angle, sin angle). */
export interface Pose {
  x: number;
  y: number;
  angle: number;
}

export interface Killer {
  team: number;
  playerId: string | null;
  weapon: LethalKind;
  /** The killer's pose at the moment of the hit: the kill-cam looks here if the killer sinks or respawns meanwhile. */
  pose: Pose;
}

export interface BoatState {
  team: number;
  /** After the last sim step. */
  pose: Pose;
  /** Before the last sim step; the renderer lerps prevPose -> pose by the frame's alpha. */
  prevPose: Pose;
  vx: number;
  vy: number;
  speed: number;
  /** World angle of the Gunner's aim (stabilised: does not follow the bow). */
  aimYaw: number;
  status: BoatStatus;
  /** Sim time at which `status` ends: sinking -> respawning -> alive. 0 while alive. */
  statusUntil: number;
  water: number;
  weapon: { kind: WeaponKind; ammo: number } | null;
  powers: [PowerKind | null, PowerKind | null];
  shieldUntil: number;
  boostUntil: number;
  protectedUntil: number;
  smokeUntil: number;
  revealedUntil: number;
  fireReadyAt: number;
  hitFlashUntil: number;
  /** Echo of the last applied inputs, for animation (rowing, bailing) and the bots. */
  input: { steer: number; gas: boolean; brake: boolean; fire: boolean; shake: number };
  /** Set on a lethal hit, cleared at respawn. Drives the kill-cam and "SUNK by X". */
  killedBy: Killer | null;
  crosshair: CrosshairState;
  /** Enemy team the Torpedo would lock, or the Cannon would bend toward. */
  lockTeam: number | null;
  assistTeam: number | null;
}

export interface TeamState {
  index: number;
  name: string;
  colour: string;
  textColour: string;
  /** Player ids in role order: [pilot, gunner, engineer]. */
  members: string[];
  kills: number;
  deaths: number;
  /** Sim time of the last kill, for the "first to reach the score" tiebreak. 0 = never. */
  lastKillAt: number;
}

export interface PlayerState {
  id: string;
  name: string;
  joinOrder: number;
  /** Placed by hand (moved or swapped): the balancer moves these last. */
  pinned: boolean;
  connected: boolean;
  /** Tapped Enable controls (sensor permission granted). */
  enabled: boolean;
  ready: boolean;
  calibrated: boolean;
  kind: PlayerKind;
  kills: number;
  deaths: number;
  bestRamSpeed: number;
}

export interface CrateState {
  id: number;
  x: number;
  y: number;
  category: CrateCategory;
  /** null while the crate is respawning. */
  contents: ItemKind | null;
  respawnAt: number;
}

export interface MineState {
  id: number;
  x: number;
  y: number;
  ownerTeam: number;
  ownerPlayer: string | null;
  armedAt: number;
  expiresAt: number;
}

export interface ProjectileState {
  id: number;
  kind: ProjectileKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Visual height above the water for the arc; hits are decided in 2D. */
  height: number;
  ownerTeam: number;
  ownerPlayer: string | null;
  /** Torpedo lock or Mortar target team, null when unguided. */
  targetTeam: number | null;
  /** Mortar landing point (fixed at launch). */
  landX: number;
  landY: number;
  spawnedAt: number;
  expiresAt: number;
}

export interface SmokeState {
  id: number;
  x: number;
  y: number;
  ownerTeam: number;
  until: number;
}

export interface KillFeedEntry {
  at: number;
  killerTeam: number | null;
  victimTeam: number;
  weapon: LethalKind | 'none';
  text: string;
}

export interface ResultsState {
  /** Team indices, best first. */
  ranking: number[];
  winner: number | null;
  draw: boolean;
  decidedBy: 'kills' | 'deaths' | 'overtime' | 'firstToScore' | 'draw';
  topGunner: { playerId: string; name: string; kills: number } | null;
  bestRam: { playerId: string; name: string; speed: number } | null;
}

export interface GameState {
  roomCode: string;
  tick: number;
  /** Seconds of simulated time. Advances only while the sim steps, so pause freezes every timer. */
  simTime: number;
  phase: Phase;
  /** Sim time at which the current phase ends (0 in the lobby). */
  phaseEndsAt: number;
  paused: boolean;
  teamSize: TeamSize;
  teams: TeamState[];
  /** One boat per team, same index. */
  boats: BoatState[];
  players: Record<string, PlayerState>;
  /** Join-order queue of players beyond capacity. */
  spectators: string[];
  crates: CrateState[];
  mines: MineState[];
  projectiles: ProjectileState[];
  smoke: SmokeState[];
  /** Newest last, at most 5. */
  killFeed: KillFeedEntry[];
  results: ResultsState | null;
  /** Teams still playing in sudden death; empty otherwise. */
  overtimeTeams: number[];
  /** Final-minute frenzy is on (stretch). */
  frenzy: boolean;
}

export type SimEvent =
  | { kind: 'phase'; phase: Phase }
  | { kind: 'horn' }
  | { kind: 'beep'; secondsLeft: number }
  | { kind: 'fired'; team: number; weapon: WeaponKind | 'waterCannon' }
  | { kind: 'hit'; team: number; victimTeam: number }
  | { kind: 'shielded'; team: number; byTeam: number }
  | { kind: 'kill'; team: number; victimTeam: number; playerId: string | null; weapon: LethalKind }
  | { kind: 'sunk'; team: number; byTeam: number | null }
  | { kind: 'respawn'; team: number }
  | { kind: 'pickup'; team: number; item: ItemKind }
  | { kind: 'power'; team: number; power: PowerKind }
  | { kind: 'crateRespawn'; crateId: number }
  | { kind: 'win'; team: number | null };

export function createEmptyState(roomCode: string, teamSize: TeamSize = 3): GameState {
  return {
    roomCode,
    tick: 0,
    simTime: 0,
    phase: 'lobby',
    phaseEndsAt: 0,
    paused: false,
    teamSize,
    teams: [],
    boats: [],
    players: {},
    spectators: [],
    crates: [],
    mines: [],
    projectiles: [],
    smoke: [],
    killFeed: [],
    results: null,
    overtimeTeams: [],
    frenzy: false,
  };
}

export function roleAt(index: number): Role | null {
  return ROLES[index] ?? null;
}
