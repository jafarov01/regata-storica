/**
 * What the scene sends back to phones: one `Hud` per player at 10 Hz, plus one-shot
 * `Evt` cues for haptics. Pure functions over GameState so they can be unit-tested.
 * Track B owns this file (docs/TASKS-B.md B11); Track A draws the result on the phone.
 */
import { POWERS, TIERS, WEAPONS } from '@shared/config.ts';
import { wrapAngle } from '@shared/math.ts';
import type { Evt, Hud, Lobby } from '@shared/protocol.ts';
import type { GameState, SimEvent } from '@shared/state.ts';
import { gunnerHasPowers, hasEngineer } from '../sim/ctx.ts';

export function buildHud(state: GameState, pid: string, stale: boolean): Hud | null {
  const p = state.players[pid];
  if (!p || p.virtual) return null;
  const team = state.teams[p.team];
  const boat = state.boats[p.team];
  const killer = boat?.killerTeam !== null && boat?.killerTeam !== undefined ? state.teams[boat.killerTeam] : undefined;
  const t = state.time;
  const alive = (boat?.status ?? 'alive') === 'alive';
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
    alive,
    protectedFor: boat ? Math.max(0, boat.protectedUntil - t) : 0,
    timeLeft: state.phaseEndsAt > 0 ? Math.max(0, state.phaseEndsAt - t) : 0,
    aimRel: boat ? wrapAngle(boat.aimYaw - boat.pose.yaw) : 0,
    // An enemy under the crosshair also while the crosshair shows a lock or a hit X.
    onTarget: alive && boat?.aimTarget !== null && boat?.aimTarget !== undefined,
    locked: alive && boat?.lockTarget !== null && boat?.lockTarget !== undefined,
    // By the crew aboard, not the lobby size: a 2-member team in teams of 3 has no Engineer either.
    hasPowers: p.team >= 0 && (p.role === 'engineer' || (p.role === 'gunner' && gunnerHasPowers(state, p.team))),
    bail: TIERS.bailing && p.role === 'engineer' && p.team >= 0 && hasEngineer(state, p.team) && (boat?.water ?? 0) > 0,
    stale,
  };
}

export function* buildHuds(state: GameState, stalePids: ReadonlySet<string>): Iterable<[string, Hud]> {
  for (const pid of Object.keys(state.players)) {
    const hud = buildHud(state, pid, stalePids.has(pid));
    if (hud) yield [pid, hud];
  }
}

/**
 * Turns sim events into phone cues. `send(pid | null, evt)`: null = every phone.
 * Crew cues: fired (Gunner), hit / sunk / rammed / shielded / respawn (whole crew of
 * the boat it happened to), kill / pickup / power (whole crew of the team that did it).
 */
export function forwardEvents(state: GameState, events: readonly SimEvent[], send: (pid: string | null, evt: Evt) => void): void {
  // Keyboard and bot seats have no phone behind them: no cue goes to the relay for them.
  const crew = (team: number): string[] => (state.teams[team]?.members ?? []).filter((id) => !state.players[id]?.virtual);
  for (const e of events) {
    switch (e.kind) {
      case 'countdown':
        send(null, { t: 'evt', kind: 'countdown', detail: String(e.secondsLeft) });
        break;
      case 'phase':
        if (e.phase === 'battle') send(null, { t: 'evt', kind: 'start' });
        break;
      case 'fired': {
        // The Water Cannon is a stream (8 blobs/s): no haptic per blob.
        if (e.weapon === 'watercannon') break;
        const members = state.teams[e.team]?.members ?? [];
        const gunner = members[1] ?? members[0];
        if (gunner && !state.players[gunner]?.virtual) send(gunner, { t: 'evt', kind: 'fired' });
        break;
      }
      case 'hit':
        if (e.cause === 'watercannon') break;
        for (const pid of crew(e.victim)) send(pid, { t: 'evt', kind: 'hit' });
        {
          // The shooter's Gunner gets a "shot landed" cue (compass pulse, no hit haptic).
          const members = state.teams[e.team]?.members ?? [];
          const gunner = members[1] ?? members[0];
          if (gunner && e.team !== e.victim && !state.players[gunner]?.virtual) send(gunner, { t: 'evt', kind: 'hit', detail: 'landed' });
        }
        break;
      case 'sunk':
        for (const pid of crew(e.team)) send(pid, { t: 'evt', kind: 'sunk', detail: state.teams[e.killerTeam]?.name ?? '' });
        break;
      case 'kill':
        for (const pid of crew(e.team)) send(pid, { t: 'evt', kind: 'kill', detail: state.teams[e.victim]?.name ?? '' });
        break;
      case 'shielded':
        for (const pid of crew(e.team)) send(pid, { t: 'evt', kind: 'shielded' });
        break;
      case 'respawn':
        for (const pid of crew(e.team)) send(pid, { t: 'evt', kind: 'respawn' });
        break;
      case 'pickup': {
        const label = e.category === 'weapon' ? WEAPONS[e.item as keyof typeof WEAPONS]?.label : POWERS[e.item as keyof typeof POWERS]?.label;
        for (const pid of crew(e.team)) send(pid, { t: 'evt', kind: 'pickup', detail: label ?? e.item });
        break;
      }
      case 'power':
        for (const pid of crew(e.team)) send(pid, { t: 'evt', kind: 'power', detail: POWERS[e.power].label });
        break;
      case 'ram':
        for (const pid of crew(e.victim)) send(pid, { t: 'evt', kind: 'rammed', detail: state.teams[e.team]?.name ?? '' });
        break;
      case 'win':
        send(null, { t: 'evt', kind: 'win', detail: state.teams[e.team]?.name ?? '' });
        break;
      default:
        break;
    }
  }
}

/**
 * The roster goes to phones only when it changed, but a phone that reloads and
 * rejoins the same seat changes nothing and would wait on "Waiting" forever:
 * every join, rejoin and leave invalidates, so the next tick resends it.
 */
export class LobbySync {
  private last = '';

  invalidate(): void {
    this.last = '';
  }

  /** The snapshot when it differs from the last one taken (or after invalidate), else null. */
  take(lobby: Lobby): Lobby | null {
    const json = JSON.stringify(lobby);
    if (json === this.last) return null;
    this.last = json;
    return lobby;
  }
}
