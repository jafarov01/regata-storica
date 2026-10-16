/**
 * What the scene sends back to phones: one `Hud` per player at 10 Hz, plus one-shot
 * `Evt` cues for haptics. Pure functions over GameState so they can be unit-tested.
 * Track B owns this file (docs/TASKS-B.md B11); Track A draws the result on the phone.
 */
import { TIERS } from '@shared/config.ts';
import { wrapAngle } from '@shared/math.ts';
import type { Evt, Hud } from '@shared/protocol.ts';
import type { GameState, SimEvent } from '@shared/state.ts';

export function buildHud(state: GameState, pid: string, stale: boolean): Hud | null {
  const p = state.players[pid];
  if (!p || p.virtual) return null;
  const team = state.teams[p.team];
  const boat = state.boats[p.team];
  const killer = boat?.killerTeam !== null && boat?.killerTeam !== undefined ? state.teams[boat.killerTeam] : undefined;
  const t = state.time;
  return {
    t: 'hud',
    phase: state.phase,
    team: p.team,
    role: p.role,
    teamName: team?.name ?? '',
    colour: team?.colour ?? '#333333',
    kills: team?.kills ?? 0,
    deaths: team?.deaths ?? 0,
    respawnIn: boat && boat.status !== 'alive' ? Math.max(0, boat.respawnAt - t) : 0,
    sunkBy: killer?.name ?? null,
    weapon: boat?.weapon ?? 'watercannon',
    ammo: boat?.ammo ?? 0,
    powers: boat ? [boat.powers[0], boat.powers[1]] : [null, null],
    water: boat?.water ?? 0,
    alive: (boat?.status ?? 'alive') === 'alive',
    protectedFor: boat ? Math.max(0, boat.protectedUntil - t) : 0,
    timeLeft: state.phaseEndsAt > 0 ? Math.max(0, state.phaseEndsAt - t) : 0,
    aimRel: boat ? wrapAngle(boat.aimYaw - boat.pose.yaw) : 0,
    onTarget: boat?.crosshair === 'enemy',
    locked: boat?.lockTarget !== null && boat?.lockTarget !== undefined,
    hasPowers: p.role === 'engineer' || (p.role === 'gunner' && state.teamSize === 2),
    bail: TIERS.bailing && p.role === 'engineer' && (boat?.water ?? 0) > 0,
    stale,
  };
}

export function* buildHuds(state: GameState, stalePids: ReadonlySet<string>): Iterable<[string, Hud]> {
  for (const pid of Object.keys(state.players)) {
    const hud = buildHud(state, pid, stalePids.has(pid));
    if (hud) yield [pid, hud];
  }
}

/** Turns sim events into phone cues. `send(pid | null, evt)`: null = every phone. */
export function forwardEvents(state: GameState, events: readonly SimEvent[], send: (pid: string | null, evt: Evt) => void): void {
  const crew = (team: number): string[] => state.teams[team]?.members ?? [];
  for (const e of events) {
    switch (e.kind) {
      case 'countdown':
        send(null, { t: 'evt', kind: 'countdown', detail: String(e.secondsLeft) });
        break;
      case 'phase':
        if (e.phase === 'battle') send(null, { t: 'evt', kind: 'start' });
        break;
      case 'fired': {
        const gunner = crew(e.team)[1] ?? crew(e.team)[0];
        if (gunner) send(gunner, { t: 'evt', kind: 'fired' });
        break;
      }
      case 'hit':
        for (const pid of crew(e.victim)) send(pid, { t: 'evt', kind: 'hit' });
        break;
      case 'sunk':
        for (const pid of crew(e.team)) send(pid, { t: 'evt', kind: 'sunk', detail: state.teams[e.killerTeam]?.name ?? '' });
        break;
      case 'kill':
        for (const pid of crew(e.team)) send(pid, { t: 'evt', kind: 'kill' });
        break;
      case 'win':
        send(null, { t: 'evt', kind: 'win', detail: state.teams[e.team]?.name ?? '' });
        break;
      default:
        break;
    }
  }
}
