/**
 * HUD data: pure projections of GameState for the phone (Hud message), each
 * viewport and the shared top bar. No DOM, no Three.js.
 */
import { CONFIG, itemDef } from '@shared/config.ts';
import type { GameConfig } from '@shared/config.ts';
import { angleDiff } from '@shared/math.ts';
import type { CrosshairState, GameState, Role } from '@shared/state.ts';
import { roleAt } from '@shared/state.ts';
import { rankTeams } from './rules.ts';

/** Mirrors the Hud message of SPEC section 11 (overtime is reported as 'battle'). */
export interface PhoneHud {
  t: 'hud';
  phase: 'lobby' | 'countdown' | 'battle' | 'results';
  team: number;
  role: Role;
  kills: number;
  deaths: number;
  respawnIn: number;
  weapon: string;
  ammo: number;
  powers: [string | null, string | null];
  water: number;
  alive: boolean;
}

export function phonePhase(phase: GameState['phase']): PhoneHud['phase'] {
  return phase === 'overtime' ? 'battle' : phase;
}

export function phoneHud(state: GameState, playerId: string, cfg: GameConfig = CONFIG): PhoneHud | null {
  for (const team of state.teams) {
    const index = team.members.indexOf(playerId);
    if (index < 0) continue;
    const role = roleAt(index);
    const boat = state.boats[team.index];
    if (!role) return null;
    return {
      t: 'hud',
      phase: phonePhase(state.phase),
      team: team.index,
      role,
      kills: team.kills,
      deaths: team.deaths,
      respawnIn: boat && boat.status !== 'alive' && boat.status !== 'out' ? Math.max(0, Math.ceil(boat.statusUntil - state.simTime)) : 0,
      weapon: boat?.weapon ? itemDef(boat.weapon.kind, cfg).label : 'Water Cannon',
      ammo: boat?.weapon ? boat.weapon.ammo : -1,
      powers: [boat?.powers[0] ? itemDef(boat.powers[0], cfg).label : null, boat?.powers[1] ? itemDef(boat.powers[1], cfg).label : null],
      water: boat ? Math.round(boat.water) : 0,
      alive: boat ? boat.status === 'alive' : false,
    };
  }
  return null;
}

export interface ViewportHud {
  team: number;
  name: string;
  colour: string;
  textColour: string;
  crew: { name: string; role: Role; connected: boolean }[];
  kills: number;
  deaths: number;
  weaponLabel: string;
  ammo: number | null;
  powers: [string | null, string | null];
  water: number;
  protectionLeft: number;
  shieldLeft: number;
  boostLeft: number;
  /** Bow direction relative to the aim (the camera), radians: 0 = bow straight ahead. */
  bowVsAim: number;
  crosshair: CrosshairState;
  killCam: { text: string; countdown: number; killerTeam: number | null } | null;
  out: boolean;
}

export function viewportHud(state: GameState, teamIndex: number, cfg: GameConfig = CONFIG): ViewportHud | null {
  const team = state.teams[teamIndex];
  const boat = state.boats[teamIndex];
  if (!team || !boat) return null;
  const now = state.simTime;
  const killer = boat.killedBy;
  const killerTeam = killer ? state.teams[killer.team] : undefined;
  const showKillCam = boat.status === 'sinking' || boat.status === 'respawning';
  return {
    team: teamIndex,
    name: team.name,
    colour: team.colour,
    textColour: team.textColour,
    crew: team.members.map((id, i) => ({
      name: state.players[id]?.name ?? '?',
      role: roleAt(i) ?? 'engineer',
      connected: state.players[id]?.connected ?? false,
    })),
    kills: team.kills,
    deaths: team.deaths,
    weaponLabel: boat.weapon ? itemDef(boat.weapon.kind, cfg).label : 'Water Cannon',
    ammo: boat.weapon ? boat.weapon.ammo : null,
    powers: [boat.powers[0] ? itemDef(boat.powers[0], cfg).label : null, boat.powers[1] ? itemDef(boat.powers[1], cfg).label : null],
    water: boat.water,
    protectionLeft: Math.max(0, boat.protectedUntil - now),
    shieldLeft: Math.max(0, boat.shieldUntil - now),
    boostLeft: Math.max(0, boat.boostUntil - now),
    bowVsAim: angleDiff(boat.aimYaw, boat.pose.angle),
    crosshair: boat.crosshair,
    killCam: showKillCam
      ? {
          text: killerTeam ? `SUNK by ${killerTeam.name}` : 'SUNK',
          countdown: Math.max(0, Math.ceil(boat.statusUntil - now)),
          killerTeam: killer ? killer.team : null,
        }
      : null,
    out: boat.status === 'out',
  };
}

export interface SharedHud {
  clock: string;
  clockRed: boolean;
  phaseLabel: string;
  scoreboard: { team: number; name: string; colour: string; kills: number; deaths: number }[];
  killFeed: string[];
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export function sharedHud(state: GameState, cfg: GameConfig = CONFIG): SharedHud {
  const left = state.phase === 'lobby' ? 0 : Math.max(0, state.phaseEndsAt - state.simTime);
  const labels: Record<GameState['phase'], string> = {
    lobby: 'LOBBY',
    countdown: 'GET READY',
    battle: '',
    overtime: 'SUDDEN DEATH',
    results: 'RESULTS',
  };
  return {
    clock: formatClock(left),
    clockRed: state.phase === 'overtime' || (state.phase === 'battle' && (state.frenzy || left <= cfg.match.clockRedLastSeconds)),
    phaseLabel: state.paused ? 'PAUSED' : labels[state.phase],
    scoreboard: rankTeams(state.teams).map((i) => {
      const t = state.teams[i];
      return { team: i, name: t?.name ?? '', colour: t?.colour ?? '#fff', kills: t?.kills ?? 0, deaths: t?.deaths ?? 0 };
    }),
    killFeed: state.killFeed.map((e) => e.text),
  };
}
