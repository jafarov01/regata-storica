/**
 * src/sim/roster.ts: players, teams and roles in the lobby.
 *
 * Moved out of the baseline sim: join order, balanced team sizes (7 in
 * threes = 3+2+2), role = index in the member list, swaps, spectators beyond
 * 18, keyboard and bot teams pinned to their index. Bot teams are closed: a
 * phone never takes a seat on a bot boat (the bot would stop driving), they
 * count as one full team each when sizing the rest, and rebalancing never
 * moves keyboard or bot seats.
 */
import type { AddPlayerOptions } from '@shared/api.ts';
import { GONDOLIER_ID, isCharacterId } from '@shared/characters.ts';
import { MATCH, TIERS } from '@shared/config.ts';
import type { ParsedMap } from '@shared/map.ts';
import type { Lobby, LobbyMember, PhoneControl } from '@shared/protocol.ts';
import type { GameState, PlayerState, Role, SimEvent, TeamState } from '@shared/state.ts';
import { ROLES } from '@shared/state.ts';
import { newBoat, newTeam } from './ctx.ts';

const ROLE_INDEX: Record<Role, number> = { pilot: 0, gunner: 1, engineer: 2 };

/** Bot seats are named 'bot-<n>' (GameSim.debug.addBotTeam); src/sim/bot.ts uses the same rule. */
export function isBotId(id: string): boolean {
  return id.startsWith('bot-');
}

function isClosed(t: TeamState): boolean {
  return t.members.some(isBotId);
}

export class Roster {
  readonly joinOrder: string[] = [];

  constructor(
    private readonly state: GameState,
    private readonly map: ParsedMap,
    private readonly emit: (e: SimEvent) => void,
    /** Called when a player leaves for good (the sim forgets its inputs). */
    private readonly forget: (id: string) => void,
  ) {}

  addPlayer(id: string, name: string, opts: AddPlayerOptions = {}): void {
    const existing = this.state.players[id];
    if (existing) {
      existing.name = name;
      existing.connected = true;
      return;
    }
    const player: PlayerState = {
      id,
      name,
      team: -1,
      role: 'pilot',
      connected: true,
      ready: false,
      calibrated: false,
      virtual: opts.virtual ?? false,
      character: null,
      lastInputAt: this.state.time,
      kills: 0,
      ramKills: 0,
    };
    this.state.players[id] = player;
    this.joinOrder.push(id);
    if (this.state.phase !== 'lobby') {
      this.state.spectators.push(id);
    } else if (opts.team !== undefined) {
      this.ensureTeams(opts.team + 1);
      this.placeInTeam(id, opts.team, opts.role);
    } else {
      this.seatNewcomer(id);
    }
    this.syncRoles();
    this.emit({ kind: 'join', playerId: id });
  }

  removePlayer(id: string): void {
    const p = this.state.players[id];
    if (!p) return;
    this.unseat(id);
    this.state.spectators = this.state.spectators.filter((s) => s !== id);
    delete this.state.players[id];
    this.forget(id);
    const i = this.joinOrder.indexOf(id);
    if (i >= 0) this.joinOrder.splice(i, 1);
    if (this.state.phase === 'lobby') this.rebalance();
    this.syncRoles();
    this.emit({ kind: 'leave', playerId: id });
  }

  setConnected(id: string, connected: boolean): void {
    const p = this.state.players[id];
    if (p) p.connected = connected;
  }

  applyMessage(id: string, msg: PhoneControl): void {
    const p = this.state.players[id];
    if (!p) return;
    switch (msg.t) {
      case 'swap':
        if (this.state.phase !== 'lobby') return;
        if (msg.team !== undefined && msg.team !== p.team) this.moveToTeam(id, msg.team);
        if (msg.role !== undefined) this.takeRole(id, msg.role);
        this.syncRoles();
        return;
      case 'ready':
        p.ready = msg.ready;
        return;
      case 'calibrate':
        p.calibrated = true;
        return;
      case 'rename':
        p.name = msg.name;
        return;
      case 'character': {
        // One person per player; the gondolier is for anyone. An unknown or taken id changes nothing.
        if (msg.id === null) {
          p.character = null;
          return;
        }
        if (!isCharacterId(msg.id)) return;
        const taken = msg.id !== GONDOLIER_ID && Object.values(this.state.players).some((o) => o.id !== id && o.character === msg.id);
        if (!taken) p.character = msg.id;
        return;
      }
      case 'leave':
        this.removePlayer(id);
        return;
    }
  }

  setTeamSize(size: 2 | 3): void {
    if (this.state.phase !== 'lobby' || size === this.state.teamSize) return;
    // Crews of 3 need the Engineer.
    if (size === 3 && !TIERS.engineer) return;
    this.state.teamSize = size;
    // Keyboard crews and bots keep their team index; everyone else is seated again in join order.
    const pinned = new Map<string, number>();
    for (const id of this.joinOrder) {
      const p = this.state.players[id];
      if (p?.virtual && p.team >= 0) pinned.set(id, p.team);
    }
    for (const t of this.state.teams) t.members = [];
    this.state.teams = [];
    this.state.boats = [];
    for (const id of this.joinOrder) {
      const p = this.state.players[id];
      if (p) p.team = -1;
    }
    this.state.spectators = [];
    for (const [id, team] of pinned) {
      this.ensureTeams(team + 1);
      this.placeInTeam(id, team);
    }
    for (const id of this.joinOrder) if (!pinned.has(id)) this.seatNewcomer(id);
    this.syncRoles();
  }

  /** Spectators take free seats (between rounds). */
  seatSpectators(): void {
    for (const id of this.state.spectators.splice(0)) this.seatNewcomer(id);
    this.syncRoles();
  }

  lobbySnapshot(): Lobby {
    const member = (id: string): LobbyMember | null => {
      const p = this.state.players[id];
      if (!p) return null;
      return { pid: p.id, name: p.name, role: p.role, ready: p.ready, calibrated: p.calibrated, connected: p.connected, virtual: p.virtual, character: p.character };
    };
    return {
      t: 'lobby',
      phase: this.state.phase,
      teamSize: this.state.teamSize,
      teams: this.state.teams.map((t) => ({
        index: t.index,
        name: t.name,
        colour: t.colour,
        members: t.members.map(member).filter((m): m is LobbyMember => m !== null),
        capacity: this.state.teamSize,
      })),
      spectators: this.state.spectators.map(member).filter((m): m is LobbyMember => m !== null),
    };
  }

  ensureTeams(count: number): void {
    while (this.state.teams.length < Math.min(count, MATCH.maxTeams)) {
      const index = this.state.teams.length;
      this.state.teams.push(newTeam(index));
      const boat = newBoat(index);
      const dock = this.map.docks[index % Math.max(1, this.map.docks.length)];
      if (dock) {
        boat.pose = { x: dock.x, z: dock.z, yaw: dock.yaw };
        boat.prevPose = { ...boat.pose };
        boat.aimYaw = boat.prevAimYaw = dock.yaw;
      }
      this.state.boats.push(boat);
    }
  }

  /** Team count for n players on open teams: min(6, bot teams + ceil(n / size)). */
  private targetTeams(n: number): number {
    return Math.min(MATCH.maxTeams, this.botTeams() + Math.ceil(n / this.state.teamSize));
  }

  private botTeams(): number {
    return this.state.teams.reduce((n, t) => n + (isClosed(t) ? 1 : 0), 0);
  }

  /** Keyboard crews and bots ask for a team explicitly; rebalancing never dissolves those teams. */
  private pinnedTeams(): number {
    let n = 0;
    for (const p of Object.values(this.state.players)) if (p.virtual && p.team >= 0) n = Math.max(n, p.team + 1);
    return n;
  }

  /** Players on open (non-bot) teams. */
  private seated(): number {
    return this.state.teams.reduce((n, t) => n + (isClosed(t) ? 0 : t.members.length), 0);
  }

  private seatNewcomer(id: string): void {
    const p = this.state.players[id];
    if (!p) return;
    const capacity = (MATCH.maxTeams - this.botTeams()) * this.state.teamSize;
    if (this.seated() >= capacity) {
      this.state.spectators.push(id);
      return;
    }
    this.ensureTeams(Math.max(this.targetTeams(this.seated() + 1), this.pinnedTeams()));
    let best: TeamState | null = null;
    for (const t of this.state.teams) {
      if (isClosed(t)) continue;
      if (t.members.length < this.state.teamSize && (!best || t.members.length < best.members.length)) best = t;
    }
    if (!best) {
      this.state.spectators.push(id);
      return;
    }
    best.members.push(id);
    p.team = best.index;
    this.rebalance();
  }

  /** Balanced sizes: move the most recent joiners from big teams to small ones. */
  private rebalance(): void {
    const teams = this.state.teams;
    const n = this.seated();
    const want = Math.max(1, this.targetTeams(n), this.pinnedTeams());
    while (teams.length > want) {
      const gone = teams.pop();
      this.state.boats.pop();
      for (const id of gone?.members ?? []) {
        const p = this.state.players[id];
        if (p) p.team = -1;
        this.seatNewcomer(id);
      }
    }
    // Balance the open teams only; keyboard and bot seats never move.
    const open = teams.filter((t) => !isClosed(t));
    if (open.length === 0) return;
    const base = Math.floor(n / open.length);
    const extra = n % open.length;
    const target = (i: number): number => base + (i < extra ? 1 : 0);
    const movable = (t: TeamState): string | undefined => {
      let latest: string | undefined;
      for (const id of t.members) {
        if (this.state.players[id]?.virtual) continue;
        if (latest === undefined || this.joinOrder.indexOf(id) > this.joinOrder.indexOf(latest)) latest = id;
      }
      return latest;
    };
    for (let guard = 0; guard < 36; guard++) {
      const big = open.findIndex((t, i) => t.members.length > target(i) && movable(t) !== undefined);
      const small = open.findIndex((t, i) => t.members.length < target(i));
      if (big < 0 || small < 0) break;
      const from = open[big];
      const to = open[small];
      if (!from || !to) break;
      const latest = movable(from);
      if (latest === undefined) break;
      from.members = from.members.filter((m) => m !== latest);
      to.members.push(latest);
      const p = this.state.players[latest];
      if (p) p.team = to.index;
    }
  }

  private unseat(id: string): void {
    for (const t of this.state.teams) t.members = t.members.filter((m) => m !== id);
    const p = this.state.players[id];
    if (p) p.team = -1;
  }

  private placeInTeam(id: string, team: number, role?: Role): void {
    const t = this.state.teams[team];
    const p = this.state.players[id];
    if (!t || !p) return;
    this.unseat(id);
    t.members.push(id);
    p.team = team;
    if (role) this.takeRole(id, role);
  }

  private moveToTeam(id: string, team: number): void {
    const t = this.state.teams[team];
    if (!t || t.members.length >= this.state.teamSize) return;
    this.placeInTeam(id, team);
  }

  /** Role = index in the member list; taking a role swaps with whoever holds it. */
  private takeRole(id: string, role: Role): void {
    const p = this.state.players[id];
    const t = p ? this.state.teams[p.team] : undefined;
    if (!p || !t) return;
    const from = t.members.indexOf(id);
    const to = Math.min(ROLE_INDEX[role], t.members.length - 1);
    if (from < 0 || to < 0 || from === to) return;
    const other = t.members[to];
    if (other === undefined) return;
    t.members[to] = id;
    t.members[from] = other;
  }

  syncRoles(): void {
    for (const t of this.state.teams) {
      t.members.forEach((id, i) => {
        const p = this.state.players[id];
        if (p) {
          p.team = t.index;
          p.role = ROLES[i] ?? 'engineer';
        }
      });
    }
  }
}
