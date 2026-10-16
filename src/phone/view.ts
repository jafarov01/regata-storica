/**
 * Pure decisions behind the phone screens: which layer shows, what an error says and offers,
 * which warning the banner carries, where the Swap / Move buttons go. No DOM, no sockets, so
 * tests/phone.test.ts covers them; src/phone/main.ts only applies the result.
 */
import type { ErrCode, Lobby, Phase, Role } from '@shared/protocol.ts';

// ---------------------------------------------------------------- layers

export interface ViewInput {
  phase: Phase;
  /** The relay welcomed us (we have a pid). */
  hasPid: boolean;
  /** Team index from the newest Hud or Lobby, -1 while spectating or unknown. */
  team: number;
  /** Enable controls (or Tap to resume) has run on this page load. */
  controller: boolean;
  /** Lobby "Try controls" is on. */
  trying: boolean;
  landscape: boolean;
  role: Role;
  /** A blocking error panel is up (wrong code, full room, kicked, another tab). */
  blocked: boolean;
}

export interface ViewState {
  /** The pads and the role graphic are live. */
  playing: boolean;
  lobby: boolean;
  /** Seated in a running match without controls: one big "Tap to resume controls" (iOS needs the tap). */
  resume: boolean;
  /** In the room but not in a team while a match runs. */
  spectate: boolean;
  /** Rotate-your-phone overlay: Pilot and Gunner play in landscape (SPEC section 1). */
  rotate: boolean;
  /** Inputs coast: the rotate overlay is up. */
  suspended: boolean;
  /** Match strip (timer, team score) at the bottom. */
  strip: boolean;
  backToLobby: boolean;
}

export function phoneView(v: ViewInput): ViewState {
  const inLobby = v.phase === 'lobby';
  const playing = !v.blocked && v.controller && (!inLobby || v.trying) && v.team >= 0;
  const seatedInMatch = !inLobby && v.team >= 0;
  const rotate = playing && !v.landscape && v.role !== 'engineer';
  return {
    playing,
    lobby: !v.blocked && !playing && (inLobby || !v.hasPid),
    resume: !v.blocked && v.hasPid && seatedInMatch && !v.controller,
    spectate: !v.blocked && v.hasPid && !inLobby && v.team < 0,
    rotate,
    suspended: rotate,
    strip: playing && !v.trying,
    backToLobby: playing && v.trying,
  };
}

// ---------------------------------------------------------------- errors

export type ErrAction = 'retry' | 'takeover' | 'reload' | null;

export interface ErrView {
  text: string;
  /** Replace the lobby with an error panel (the player cannot do anything useful here). */
  blocking: boolean;
  /** Offer "Enter another code" (back to the join screen). */
  otherCode: boolean;
  /** The main button of the panel. */
  action: ErrAction;
  /** Non-blocking messages clear themselves after this long; 0 = until replaced. */
  ms: number;
}

/** What the phone says for each relay error. `room` is the code the phone tried. */
export function describeErr(code: ErrCode, room: string): ErrView {
  switch (code) {
    case 'no_room':
      return { text: `There is no room ${room}. Check the 4 letters on the big screen.`, blocking: true, otherCode: true, action: 'retry', ms: 0 };
    case 'room_full':
      return { text: `Room ${room} is full. Wait for someone to leave, or ask the host.`, blocking: true, otherCode: true, action: 'retry', ms: 0 };
    case 'match_running':
      return { text: `A match is running in ${room}. Try again when it ends.`, blocking: true, otherCode: true, action: 'retry', ms: 0 };
    case 'room_closed':
      return { text: `The big screen closed room ${room}.`, blocking: true, otherCode: true, action: null, ms: 0 };
    case 'kicked':
      return { text: 'The host removed you from the room.', blocking: true, otherCode: true, action: null, ms: 0 };
    case 'replaced':
      return { text: 'You opened this game in another tab or phone, so this one stopped.', blocking: true, otherCode: false, action: 'takeover', ms: 0 };
    case 'bad_version':
      return { text: 'The game was updated. Reload the page.', blocking: true, otherCode: false, action: 'reload', ms: 0 };
    case 'bad_hello':
      return { text: 'Could not join with this name. Change it or reload the page.', blocking: false, otherCode: false, action: null, ms: 5000 };
    case 'rate_limited':
      return { text: 'Too many taps. Slow down a little.', blocking: false, otherCode: false, action: null, ms: 2000 };
    case 'not_in_room':
      return { text: 'Not in the room yet. Reconnecting...', blocking: false, otherCode: false, action: null, ms: 3000 };
  }
}

// ---------------------------------------------------------------- warnings

/** No HUD for this long while a match runs: warn before the client's 4 s half-open check reconnects. */
export const HUD_WARN_MS = 1500;

export interface LinkInput {
  online: boolean;
  sceneOnline: boolean;
  /** ms since the last HUD on this connection, null before the first one. */
  hudAgeMs: number | null;
  /** The scene says it has not heard this phone recently (Hud.stale). */
  hudStale: boolean;
  playing: boolean;
}

/** The one warning line; '' when all is well. */
export function linkWarning(l: LinkInput): string {
  if (!l.online) return 'Reconnecting to the big screen...';
  if (!l.sceneOnline) return 'The big screen is reconnecting...';
  if (!l.playing) return '';
  if (l.hudStale || (l.hudAgeMs !== null && l.hudAgeMs > HUD_WARN_MS)) return "The big screen can't hear you. Check your connection.";
  return '';
}

// ---------------------------------------------------------------- lobby buttons

const ORDER: readonly Role[] = ['pilot', 'gunner', 'engineer'];

/** Swap role: the next seat in this team's role order, or null when alone in the team. */
export function nextRole(role: Role, teamSize: 2 | 3, members: number): Role | null {
  if (members < 2) return null;
  return ORDER[(ORDER.indexOf(role) + 1) % Math.min(teamSize, members)] ?? 'pilot';
}

/** Move team: the next team after ours with a free seat, or null. */
export function nextTeam(lobby: Lobby, team: number): number | null {
  const n = lobby.teams.length;
  for (let k = 1; k < n + (team < 0 ? 1 : 0); k++) {
    const t = lobby.teams[(((team + k) % n) + n) % n];
    if (t && t.index !== team && t.members.length < t.capacity) return t.index;
  }
  return null;
}

/** "m:ss" for the strip and the results countdown. */
export function clock(seconds: number): string {
  const t = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}
