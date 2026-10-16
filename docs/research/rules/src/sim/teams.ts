/**
 * Lobby, teams and roles. Pure functions: every call returns a new Lobby and
 * the list of people it moved, so the host UI can toast "Marco -> Verde".
 *
 * Invariants:
 *  - a player is in exactly one place: one team's member list or the spectator queue.
 *  - role = index in the member list: 0 Pilot, 1 Gunner, 2 Engineer.
 *  - after every change the team sizes are the balanced multiset for the
 *    active player count (7 in threes is 3+2+2, never 3+3+1).
 */
import { CONFIG } from '@shared/config.ts';
import type { PlayerState, Role, TeamSize } from '@shared/state.ts';
import { ROLES } from '@shared/state.ts';

export type LobbyPlayer = Pick<
  PlayerState,
  'id' | 'name' | 'joinOrder' | 'pinned' | 'connected' | 'enabled' | 'ready' | 'calibrated' | 'kind'
>;

export interface Lobby {
  teamSize: TeamSize;
  /** teams[i] = player ids in role order. */
  teams: string[][];
  players: Record<string, LobbyPlayer>;
  /** Join-order queue beyond capacity. */
  spectators: string[];
}

export interface Move {
  id: string;
  /** Team index before, null = spectators or new. */
  from: number | null;
  /** Team index after (final numbering), null = spectators. */
  to: number | null;
}

export interface LobbyChange {
  lobby: Lobby;
  moves: Move[];
  /** Some surviving team changed its index (and therefore its colour). */
  renumbered: boolean;
}

export interface Slot {
  team: number;
  role: Role;
  index: number;
}

/** What one phone has to show. Merged roles for short-handed teams. */
export interface ControlSet {
  steer: boolean;
  gas: boolean;
  aim: boolean;
  fire: boolean;
  powers: boolean;
  bail: boolean;
  /** 1-person team: auto-throttle and auto-target FIRE (stretch). */
  solo: boolean;
}

const MAX_TEAMS = CONFIG.teams.maxTeams;

export function capacity(size: TeamSize, maxTeams: number = MAX_TEAMS): number {
  return size * maxTeams;
}

/** Number of teams for n active players: min(6, ceil(n / size)). */
export function teamCount(n: number, size: TeamSize, maxTeams: number = MAX_TEAMS): number {
  if (n <= 0) return 0;
  return Math.min(maxTeams, Math.ceil(n / size));
}

/**
 * Balanced sizes, largest first: base = floor(n / t), the first (n mod t) teams get one more.
 * Players beyond capacity are not counted (they are spectators).
 */
export function targetSizes(n: number, size: TeamSize, maxTeams: number = MAX_TEAMS): number[] {
  const active = Math.min(Math.max(0, n), capacity(size, maxTeams));
  const t = teamCount(active, size, maxTeams);
  if (t === 0) return [];
  const base = Math.floor(active / t);
  const extra = active % t;
  const out: number[] = [];
  for (let i = 0; i < t; i++) out.push(base + (i < extra ? 1 : 0));
  return out;
}

export function balanceTable(size: TeamSize, upTo: number = 18): { n: number; sizes: number[]; spectators: number }[] {
  const rows: { n: number; sizes: number[]; spectators: number }[] = [];
  for (let n = 1; n <= upTo; n++) {
    rows.push({ n, sizes: targetSizes(n, size), spectators: Math.max(0, n - capacity(size)) });
  }
  return rows;
}

export function createLobby(teamSize: TeamSize = CONFIG.teams.defaultTeamSize): Lobby {
  return { teamSize, teams: [], players: {}, spectators: [] };
}

export function slotOf(lobby: Lobby, id: string): Slot | null {
  for (let t = 0; t < lobby.teams.length; t++) {
    const members = lobby.teams[t];
    if (!members) continue;
    const i = members.indexOf(id);
    if (i >= 0) {
      const role = ROLES[i];
      if (role) return { team: t, role, index: i };
    }
  }
  return null;
}

export function controlsFor(lobby: Lobby, id: string): ControlSet | null {
  const slot = slotOf(lobby, id);
  if (!slot) return null;
  const size = lobby.teams[slot.team]?.length ?? 0;
  if (size === 1) return { steer: true, gas: false, aim: false, fire: true, powers: true, bail: false, solo: true };
  if (slot.role === 'pilot') return { steer: true, gas: true, aim: false, fire: false, powers: false, bail: false, solo: false };
  if (slot.role === 'gunner') {
    // 2-person team: the Gunner also gets the two power buttons; bailing is automatic.
    return { steer: false, gas: false, aim: true, fire: true, powers: size === 2, bail: false, solo: false };
  }
  return { steer: false, gas: false, aim: false, fire: false, powers: true, bail: true, solo: false };
}

function clone(lobby: Lobby): Lobby {
  const players: Record<string, LobbyPlayer> = {};
  for (const [id, p] of Object.entries(lobby.players)) players[id] = { ...p };
  return {
    teamSize: lobby.teamSize,
    teams: lobby.teams.map((m) => [...m]),
    players,
    spectators: [...lobby.spectators],
  };
}

function joinOrderOf(lobby: Lobby, id: string): number {
  return lobby.players[id]?.joinOrder ?? Number.MAX_SAFE_INTEGER;
}

/** Unpinned first, then most recent joiners first. */
function moverPriority(lobby: Lobby, a: string, b: string): number {
  const pa = lobby.players[a]?.pinned ? 1 : 0;
  const pb = lobby.players[b]?.pinned ? 1 : 0;
  if (pa !== pb) return pa - pb;
  return joinOrderOf(lobby, b) - joinOrderOf(lobby, a);
}

/**
 * Re-establish the invariants with the fewest moves:
 *  1. demote the most recent joiners beyond capacity to spectators, promote spectators into free capacity;
 *  2. the balanced size multiset is matched to teams by current size (largest keeps largest), so only surplus people move;
 *  3. surplus teams give up unpinned, most recent joiners first; dissolved teams are the smallest with the fewest pins;
 *  4. deficits are filled in team order, earliest joiners first; a moved player takes the next free role.
 * Each person who moves does so exactly once, which is the minimum for the chosen target multiset.
 */
export function rebalance(input: Lobby): LobbyChange {
  const lobby = clone(input);
  const moves: Move[] = [];
  const cap = capacity(lobby.teamSize);

  interface Work {
    orig: number;
    members: string[];
    target: number;
  }
  const work: Work[] = lobby.teams.map((members, orig) => ({ orig, members, target: 0 }));
  let active = work.reduce((n, w) => n + w.members.length, 0);
  const homeless: { id: string; from: number | null }[] = [];

  // 1a. over capacity (team size was lowered): demote most recent joiners.
  while (active > cap) {
    let best: { w: Work; id: string } | null = null;
    for (const w of work) {
      for (const id of w.members) {
        if (!best || moverPriority(lobby, id, best.id) < 0) best = { w, id };
      }
    }
    if (!best) break;
    best.w.members.splice(best.w.members.indexOf(best.id), 1);
    lobby.spectators.push(best.id);
    moves.push({ id: best.id, from: best.w.orig, to: null });
    active--;
  }
  lobby.spectators.sort((a, b) => joinOrderOf(lobby, a) - joinOrderOf(lobby, b));
  // 1b. free capacity: promote spectators in join order.
  while (active < cap && lobby.spectators.length > 0) {
    const id = lobby.spectators.shift();
    if (id === undefined) break;
    homeless.push({ id, from: null });
    active++;
  }

  // 2. targets by current size: largest team keeps the largest target.
  const targets = targetSizes(active, lobby.teamSize);
  const pinnedCount = (w: Work): number => w.members.filter((id) => lobby.players[id]?.pinned).length;
  const order = [...work].sort((a, b) => b.members.length - a.members.length || pinnedCount(b) - pinnedCount(a) || a.orig - b.orig);
  while (work.length < targets.length) {
    const w: Work = { orig: -1, members: [], target: 0 };
    work.push(w);
    order.push(w);
  }
  for (let i = 0; i < order.length; i++) {
    const w = order[i];
    if (w) w.target = targets[i] ?? 0; // beyond the target count: dissolved
  }

  // 3. surplus leaves (dissolved teams have target 0 so everybody leaves).
  for (const w of work) {
    while (w.members.length > w.target) {
      const sorted = [...w.members].sort((a, b) => moverPriority(lobby, a, b));
      const id = sorted[0];
      if (id === undefined) break;
      w.members.splice(w.members.indexOf(id), 1);
      homeless.push({ id, from: w.orig });
    }
  }

  // 4. fill deficits in team order, earliest joiners first.
  homeless.sort((a, b) => joinOrderOf(lobby, a.id) - joinOrderOf(lobby, b.id));
  const kept = work.filter((w) => w.target > 0);
  for (const w of kept) {
    while (w.members.length < w.target && homeless.length > 0) {
      const h = homeless.shift();
      if (!h) break;
      w.members.push(h.id);
      moves.push({ id: h.id, from: h.from, to: w.orig }); // fixed up below
    }
  }
  // anything left over (should not happen) goes to spectators
  for (const h of homeless) {
    lobby.spectators.push(h.id);
    moves.push({ id: h.id, from: h.from, to: null });
  }

  // compact and renumber
  const finalIndex = new Map<number, number>();
  let renumbered = false;
  kept.forEach((w, i) => {
    if (w.orig >= 0) {
      finalIndex.set(w.orig, i);
      if (w.orig !== i) renumbered = true;
    }
  });
  lobby.teams = kept.map((w) => w.members);
  // `to` was recorded as orig index (or -1 for a new team): translate to the final index.
  for (const m of moves) {
    if (m.to === null) continue;
    if (m.to >= 0) m.to = finalIndex.get(m.to) ?? m.to;
    else m.to = kept.findIndex((w) => w.members.includes(m.id));
  }
  return { lobby, moves, renumbered };
}

export function joinPlayer(input: Lobby, player: LobbyPlayer): LobbyChange {
  const lobby = clone(input);
  if (lobby.players[player.id]) return reconnectPlayer(lobby, player.id, player.name);
  lobby.players[player.id] = { ...player, pinned: false };
  lobby.spectators.push(player.id); // rebalance promotes it if there is room
  return rebalance(lobby);
}

/** Same token comes back: same slot, same role. */
export function reconnectPlayer(input: Lobby, id: string, name?: string): LobbyChange {
  const lobby = clone(input);
  const p = lobby.players[id];
  if (!p) return { lobby, moves: [], renumbered: false };
  p.connected = true;
  if (name) p.name = name;
  return { lobby, moves: [], renumbered: false };
}

/** Lobby phase only: the player is gone for good and the teams close up. */
export function leavePlayer(input: Lobby, id: string): LobbyChange {
  const lobby = clone(input);
  if (!lobby.players[id]) return { lobby, moves: [], renumbered: false };
  for (const members of lobby.teams) {
    const i = members.indexOf(id);
    if (i >= 0) members.splice(i, 1);
  }
  lobby.spectators = lobby.spectators.filter((s) => s !== id);
  delete lobby.players[id];
  return rebalance(lobby);
}

/** Countdown or battle: the slot stays, the boat idles, the keyboard can take it. */
export function markDisconnected(input: Lobby, id: string): Lobby {
  const lobby = clone(input);
  const p = lobby.players[id];
  if (p) p.connected = false;
  return lobby;
}

export function setTeamSize(input: Lobby, size: TeamSize): LobbyChange {
  const lobby = clone(input);
  lobby.teamSize = size;
  return rebalance(lobby);
}

export function setFlags(
  input: Lobby,
  id: string,
  flags: Partial<Pick<LobbyPlayer, 'enabled' | 'ready' | 'calibrated' | 'name'>>,
): Lobby {
  const lobby = clone(input);
  const p = lobby.players[id];
  if (p) Object.assign(p, flags);
  return lobby;
}

/** Swap role with a teammate (both become pinned). */
export function swapRoles(input: Lobby, id: string, otherId: string): LobbyChange {
  const lobby = clone(input);
  const a = slotOf(lobby, id);
  const b = slotOf(lobby, otherId);
  if (!a || !b || a.team !== b.team || id === otherId) return { lobby, moves: [], renumbered: false };
  const members = lobby.teams[a.team];
  if (!members) return { lobby, moves: [], renumbered: false };
  members[a.index] = otherId;
  members[b.index] = id;
  const pa = lobby.players[id];
  const pb = lobby.players[otherId];
  if (pa) pa.pinned = true;
  if (pb) pb.pinned = true;
  return { lobby, moves: [], renumbered: false };
}

/** Move to any team with a free slot (members < teamSize). The mover is pinned; the balancer then fixes sizes around them. */
export function moveToTeam(input: Lobby, id: string, team: number): LobbyChange {
  const lobby = clone(input);
  const from = slotOf(lobby, id);
  const dest = lobby.teams[team];
  if (!dest || dest.length >= lobby.teamSize || (from && from.team === team)) {
    return { lobby, moves: [], renumbered: false };
  }
  if (from) lobby.teams[from.team]?.splice(from.index, 1);
  else lobby.spectators = lobby.spectators.filter((s) => s !== id);
  dest.push(id);
  const p = lobby.players[id];
  if (p) p.pinned = true;
  const result = rebalance(lobby);
  result.moves.unshift({ id, from: from ? from.team : null, to: team });
  return result;
}

export interface StartCheck {
  ok: boolean;
  problems: string[];
  warnings: string[];
}

/** The host needs at least 2 teams, each with a connected Pilot. Missing Enable controls only warns: the keyboard can cover. */
export function canStart(lobby: Lobby, minTeams: number = CONFIG.teams.minTeamsToStart): StartCheck {
  const problems: string[] = [];
  const warnings: string[] = [];
  if (lobby.teams.length < minTeams) problems.push(`need ${minTeams} teams, have ${lobby.teams.length}`);
  lobby.teams.forEach((members, t) => {
    const pilot = members[0];
    const p = pilot ? lobby.players[pilot] : undefined;
    if (!p) problems.push(`team ${t} has no Pilot`);
    else if (!p.connected) problems.push(`team ${t}: Pilot ${p.name} is disconnected`);
    for (const id of members) {
      const m = lobby.players[id];
      if (m && m.kind === 'phone' && !m.enabled) warnings.push(`${m.name} has not tapped Enable controls`);
    }
  });
  return { ok: problems.length === 0, problems, warnings };
}

/** Rematch: same teams, same roles; per-round flags reset. Disconnected players keep their slot. */
export function rematchLobby(input: Lobby): Lobby {
  const lobby = clone(input);
  for (const p of Object.values(lobby.players)) {
    p.ready = false;
    p.calibrated = false;
  }
  return lobby;
}

/** New lobby: pins cleared, disconnected players dropped, everyone re-seated by join order. */
export function resetLobby(input: Lobby): LobbyChange {
  const fresh = createLobby(input.teamSize);
  const ids = Object.values(input.players)
    .filter((p) => p.connected)
    .sort((a, b) => a.joinOrder - b.joinOrder);
  for (const p of ids) {
    fresh.players[p.id] = { ...p, pinned: false, ready: false, calibrated: false };
    fresh.spectators.push(p.id);
  }
  return rebalance(fresh);
}

export function activePlayerCount(lobby: Lobby): number {
  return lobby.teams.reduce((n, m) => n + m.length, 0);
}
