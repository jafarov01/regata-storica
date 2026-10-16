/**
 * src/sim/ctx.ts: what the sim modules share. One object per sim, passed to
 * the rules, items, weapons and bot modules so none of them owns the state.
 */
import { DEFAULT_WEAPON, TEAM_COLOURS, TIERS, WEAPONS } from '@shared/config.ts';
import type { ParsedMap } from '@shared/map.ts';
import type { BoatState, GameState, SimEvent, TeamState } from '@shared/state.ts';
import type { Hull } from './boat.ts';
import type { PhysicsWorld } from './physics.ts';

export interface SimCtx {
  readonly state: GameState;
  readonly map: ParsedMap;
  readonly phys: PhysicsWorld;
  /** One Rapier hull per boat, index = team. */
  readonly hulls: Hull[];
  readonly rng: () => number;
  emit(e: SimEvent): void;
  /** Player id holding a role in a team, or null. */
  memberFor(team: number, role: 'pilot' | 'gunner' | 'engineer'): string | null;
}

export function newBoat(team: number): BoatState {
  const pose = { x: 0, z: 0, yaw: 0 };
  return {
    team,
    status: 'alive',
    pose: { ...pose },
    prevPose: { ...pose },
    vx: 0,
    vz: 0,
    speed: 0,
    angVel: 0,
    aimYaw: 0,
    prevAimYaw: 0,
    water: 0,
    weapon: DEFAULT_WEAPON,
    ammo: WEAPONS[DEFAULT_WEAPON].ammo,
    powers: [null, null],
    shieldUntil: 0,
    boostUntil: 0,
    protectedUntil: 0,
    smokeUntil: 0,
    sunkAt: 0,
    respawnAt: 0,
    killerTeam: null,
    killCause: null,
    gas: false,
    brake: false,
    steer: 0,
    firing: false,
    shake: 0,
    drifting: false,
    crosshair: 'neutral',
    aimTarget: null,
    lockTarget: null,
    lastFireAt: 0,
    lastHitAt: 0,
    rowPhase: 0,
  };
}

export function newTeam(index: number): TeamState {
  const c = TEAM_COLOURS[index] ?? TEAM_COLOURS[0];
  return { index, name: c.name, colour: c.hex, members: [], kills: 0, deaths: 0 };
}

/** Back to a fresh life: no weapon, no powers, no timers, dry hull. Pose untouched. */
export function wipeBoat(boat: BoatState): void {
  boat.status = 'alive';
  boat.water = 0;
  boat.weapon = DEFAULT_WEAPON;
  boat.ammo = WEAPONS[DEFAULT_WEAPON].ammo;
  boat.powers = [null, null];
  boat.shieldUntil = 0;
  boat.boostUntil = 0;
  boat.protectedUntil = 0;
  boat.smokeUntil = 0;
  boat.sunkAt = 0;
  boat.respawnAt = 0;
  boat.killerTeam = null;
  boat.killCause = null;
  boat.vx = 0;
  boat.vz = 0;
  boat.speed = 0;
  boat.angVel = 0;
  boat.drifting = false;
  boat.firing = false;
  boat.crosshair = 'neutral';
  boat.aimTarget = null;
  boat.lockTarget = null;
  boat.lastFireAt = 0;
  boat.lastHitAt = 0;
}

/** Fighting phases: boats move, weapons fire, crates count. */
export function isLive(state: GameState): boolean {
  return state.phase === 'battle' || state.phase === 'suddendeath';
}

/**
 * The crew has an Engineer (SPEC section 2): three members with the Engineer
 * tier on. Decided by the members actually aboard, not by the lobby's team
 * size, because teams of 3 are balanced as 3 + 2 + 2.
 */
export function hasEngineer(state: GameState, team: number): boolean {
  return TIERS.engineer && (state.teams[team]?.members.length ?? 0) >= 3;
}

/** Without an Engineer the Gunner also holds the two power buttons (when powers are on at all). */
export function gunnerHasPowers(state: GameState, team: number): boolean {
  return TIERS.powers && !hasEngineer(state, team);
}
