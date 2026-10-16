/**
 * In-memory room registry. Pure data, no socket.io: everything here is unit-testable
 * with fake clocks and fake randomness (see tests/rooms.test.ts).
 *
 * What the relay owns:  room code -> scene socket, token -> (room, pid), connection state, gate.
 * What the scene owns:  teams, roles, ready/calibrated flags, who plays and who spectates.
 */
import { NET, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, type ErrCode, type Gate, type RelayPlayer } from '@shared/protocol.ts';

export interface PlayerRec {
  pid: string;
  token: string;
  name: string;
  /** Live socket id, or null while the phone is disconnected. */
  socketId: string | null;
  queued: boolean;
  joinedAt: number;
  /** Last time the socket was attached; the slot expires NET.playerGraceMs after a disconnect. */
  disconnectedAt: number | null;
}

export interface RoomRec {
  code: string;
  sceneToken: string;
  sceneSocketId: string | null;
  sceneLeftAt: number | null;
  createdAt: number;
  gate: Gate;
  /** token -> player */
  players: Map<string, PlayerRec>;
  nextPid: number;
}

export type JoinResult =
  | { ok: true; room: RoomRec; player: PlayerRec; rejoined: boolean; replacedSocketId: string | null }
  | { ok: false; code: ErrCode };

/** What the join screen may know about a code before it opens the room (GET /api/rooms/:code). */
export interface RoomProbe {
  exists: boolean;
  /** No seat for a new token (a returning token still gets its old slot). */
  full: boolean;
  /** A match is running: new tokens wait for the next lobby (or are refused with late 'reject'). */
  locked: boolean;
}

export interface SweepResult {
  closedRooms: RoomRec[];
  expiredPlayers: Array<{ room: RoomRec; player: PlayerRec }>;
}

/** Consonant-vowel-consonant-vowel codes read aloud easily ("RIVA", "DAMU"). */
const CONSONANTS = 'BCDFGHJKMNPRSTVWXYZ';
const VOWELS = 'AEU';
/** Words we would rather not print on a projector in Italy. Regenerated if hit. */
const BLOCKED = new Set(['CACA', 'KAKA', 'PUTA', 'PENE', 'SEGA', 'CULA', 'CULE', 'CULU', 'NAZE', 'NAZA', 'FUKA']);

export interface RegistryOptions {
  rng?: () => number;
  now?: () => number;
  sceneGraceMs?: number;
  playerGraceMs?: number;
  maxPlayers?: number;
}

export class RoomRegistry {
  private readonly rooms = new Map<string, RoomRec>();
  /** player token -> room code */
  private readonly tokens = new Map<string, string>();
  private readonly rng: () => number;
  private readonly now: () => number;
  private readonly sceneGraceMs: number;
  private readonly playerGraceMs: number;
  private readonly maxPlayers: number;

  constructor(opts: RegistryOptions = {}) {
    this.rng = opts.rng ?? Math.random;
    this.now = opts.now ?? Date.now;
    this.sceneGraceMs = opts.sceneGraceMs ?? NET.sceneGraceMs;
    this.playerGraceMs = opts.playerGraceMs ?? NET.playerGraceMs;
    this.maxPlayers = opts.maxPlayers ?? NET.maxPlayers;
  }

  get size(): number {
    return this.rooms.size;
  }

  get playerCount(): number {
    let n = 0;
    for (const r of this.rooms.values()) n += r.players.size;
    return n;
  }

  get(code: string): RoomRec | undefined {
    return this.rooms.get(code);
  }

  roomOfToken(token: string): RoomRec | undefined {
    const code = this.tokens.get(token);
    return code ? this.rooms.get(code) : undefined;
  }

  /** A new room with a unique code. The sceneToken lets the same scene re-claim it after a reload. */
  create(sceneSocketId: string, sceneToken: string): RoomRec {
    const code = this.generateCode();
    const room: RoomRec = {
      code,
      sceneToken,
      sceneSocketId,
      sceneLeftAt: null,
      createdAt: this.now(),
      gate: { t: 'gate', max: this.maxPlayers, locked: false, late: 'queue' },
      players: new Map(),
      nextPid: 1,
    };
    this.rooms.set(code, room);
    return room;
  }

  /** Re-attaches a scene socket to its room. Null when the room is gone or the token is wrong. */
  reclaim(code: string, sceneToken: string, sceneSocketId: string): RoomRec | null {
    const room = this.rooms.get(code);
    if (!room || room.sceneToken !== sceneToken) return null;
    room.sceneSocketId = sceneSocketId;
    room.sceneLeftAt = null;
    return room;
  }

  /** The scene socket went away. The room stays for sceneGraceMs. Returns the room or null. */
  sceneLeft(code: string, sceneSocketId: string): RoomRec | null {
    const room = this.rooms.get(code);
    if (!room || room.sceneSocketId !== sceneSocketId) return null;
    room.sceneSocketId = null;
    room.sceneLeftAt = this.now();
    return room;
  }

  setGate(code: string, gate: Gate): void {
    const room = this.rooms.get(code);
    if (!room) return;
    room.gate = { ...gate, max: Math.min(gate.max, this.maxPlayers) };
    // Back in the lobby the scene seats everyone it holds, so nobody is waiting any more.
    // Without this a phone that joined mid-match is told "you join at the next lobby" on every rejoin.
    if (!room.gate.locked) for (const p of room.players.values()) p.queued = false;
  }

  /** Read-only look at a code for the join screen. Never creates or changes anything. */
  probe(code: string): RoomProbe {
    const room = this.rooms.get(code);
    if (!room) return { exists: false, full: false, locked: false };
    return { exists: true, full: room.players.size >= room.gate.max, locked: room.gate.locked };
  }

  /**
   * A phone says hello. The same token always lands in the same slot (same pid), whatever
   * happened to its socket in between; a token moving to another room leaves the old one.
   */
  join(code: string, token: string, name: string, socketId: string): JoinResult {
    const room = this.rooms.get(code);
    if (!room) return { ok: false, code: 'no_room' };

    const previousRoom = this.roomOfToken(token);
    if (previousRoom && previousRoom !== room) this.removePlayer(previousRoom, token);

    const existing = room.players.get(token);
    if (existing) {
      const replacedSocketId = existing.socketId !== null && existing.socketId !== socketId ? existing.socketId : null;
      existing.socketId = socketId;
      existing.disconnectedAt = null;
      existing.name = name;
      return { ok: true, room, player: existing, rejoined: true, replacedSocketId };
    }

    if (room.players.size >= room.gate.max) return { ok: false, code: 'room_full' };
    if (room.gate.locked && room.gate.late === 'reject') return { ok: false, code: 'match_running' };

    const player: PlayerRec = {
      pid: `p${room.nextPid++}`,
      token,
      name,
      socketId,
      queued: room.gate.locked,
      joinedAt: this.now(),
      disconnectedAt: null,
    };
    room.players.set(token, player);
    this.tokens.set(token, code);
    return { ok: true, room, player, rejoined: false, replacedSocketId: null };
  }

  /** A player socket closed. Only the live socket detaches the slot (an old replaced socket does not). */
  playerSocketLeft(token: string, socketId: string): { room: RoomRec; player: PlayerRec } | null {
    const room = this.roomOfToken(token);
    const player = room?.players.get(token);
    if (!room || !player || player.socketId !== socketId) return null;
    player.socketId = null;
    player.disconnectedAt = this.now();
    return { room, player };
  }

  /** Explicit leave or kick: the slot is freed at once. */
  removeByToken(token: string): { room: RoomRec; player: PlayerRec } | null {
    const room = this.roomOfToken(token);
    const player = room?.players.get(token);
    if (!room || !player) return null;
    this.removePlayer(room, token);
    return { room, player };
  }

  removeByPid(code: string, pid: string): PlayerRec | null {
    const room = this.rooms.get(code);
    if (!room) return null;
    for (const p of room.players.values()) {
      if (p.pid === pid) {
        this.removePlayer(room, p.token);
        return p;
      }
    }
    return null;
  }

  /** Called every few seconds by the relay: closes rooms whose scene stayed away, expires dead slots. */
  sweep(): SweepResult {
    const now = this.now();
    const out: SweepResult = { closedRooms: [], expiredPlayers: [] };
    for (const room of this.rooms.values()) {
      if (room.sceneLeftAt !== null && now - room.sceneLeftAt >= this.sceneGraceMs) {
        out.closedRooms.push(room);
        continue;
      }
      for (const player of room.players.values()) {
        if (player.disconnectedAt !== null && now - player.disconnectedAt >= this.playerGraceMs) {
          out.expiredPlayers.push({ room, player });
        }
      }
    }
    for (const { room, player } of out.expiredPlayers) this.removePlayer(room, player.token);
    for (const room of out.closedRooms) this.close(room.code);
    return out;
  }

  close(code: string): RoomRec | null {
    const room = this.rooms.get(code);
    if (!room) return null;
    for (const token of room.players.keys()) this.tokens.delete(token);
    this.rooms.delete(code);
    return room;
  }

  snapshot(room: RoomRec): RelayPlayer[] {
    return [...room.players.values()].map((p) => ({ pid: p.pid, name: p.name, connected: p.socketId !== null, queued: p.queued }));
  }

  /** Unique per server. Tries pronounceable CVCV codes first, then anything from the alphabet. */
  generateCode(): string {
    for (let attempt = 0; attempt < 64; attempt++) {
      const code = this.pick(CONSONANTS) + this.pick(VOWELS) + this.pick(CONSONANTS) + this.pick(VOWELS);
      if (!BLOCKED.has(code) && !this.rooms.has(code)) return code;
    }
    for (;;) {
      let code = '';
      for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += this.pick(ROOM_CODE_ALPHABET);
      if (!BLOCKED.has(code) && !this.rooms.has(code)) return code;
    }
  }

  private pick(alphabet: string): string {
    const i = Math.min(alphabet.length - 1, Math.floor(this.rng() * alphabet.length));
    return alphabet.charAt(i);
  }

  private removePlayer(room: RoomRec, token: string): void {
    room.players.delete(token);
    if (this.tokens.get(token) === room.code) this.tokens.delete(token);
  }
}
