/**
 * Gondola Royale wire protocol, version 1.
 *
 *   phone  --in/swap/ready/calibrate/rename/leave-->  relay  --(pid, msg)-->  scene
 *   scene  --hud/evt/lobby/gate/kick-->               relay  --msg-->         phone(s)
 *
 * Rules that every file in src/net and server/ follows:
 *   - The relay routes by room code and player id. It never reads game fields.
 *   - Every message object carries `t` (its type) so logs and tests can tell them apart.
 *   - Messages are small: short keys, no timestamps, no clock sync. Ordering of the
 *     30 Hz input stream comes from `seq`; everything else is a full snapshot that
 *     supersedes the previous one, so a lost packet never leaves a stale flag behind.
 *   - `v` is sent once per connection (socket.io `auth`) and inside `hello`/`host`.
 *
 * The parsers at the bottom are the only place that validates untrusted phone input.
 * They are pure (no imports) so the relay, the keyboard harness and tests share them.
 */

export const PROTOCOL_VERSION = 1 as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

export type Role = 'pilot' | 'gunner' | 'engineer';
export type Seat = Role | 'spectator';
export type Phase = 'lobby' | 'countdown' | 'battle' | 'results';

/** Tunables that both ends must agree on. Game tuning lives in shared/config.ts, not here. */
export const NET = {
  /** Phones send one input packet every 1000/30 ms, not one per sensor event. */
  inputHz: 30,
  /** The scene sends one HUD snapshot per player at this rate. */
  hudHz: 10,
  /** No input for this long means the phone dropped: the HUD shows it, the sim holds the last packet. */
  inputStaleMs: 1500,
  /** A `seq` that jumps backwards by more than this is a phone restart, not a late packet. */
  seqResetGap: 1000,
  /** Hard cap on players per room (6 teams x 3). The scene may lower it with a `gate`. */
  maxPlayers: 18,
  /** Longest name the relay accepts. Longer names are cut, not rejected. */
  nameMax: 16,
  /** A player slot (token -> pid) survives a disconnect for this long. */
  playerGraceMs: 10 * 60_000,
  /** A room survives its scene socket leaving for this long (reload, HMR, laptop sleep). */
  sceneGraceMs: 90_000,
  /** Relay-side rate limits per socket. Inputs: sustained/s and burst. Others: per second. */
  inputRatePerSec: 45,
  inputBurst: 60,
  controlRatePerSec: 10,
  /** Largest single socket.io message the relay accepts (bytes). Inputs are ~90 B, a full roster ~1.5 KB. */
  maxMessageBytes: 8192,
  /** Server ping settings. Phones detect a dead link within pingInterval + pingTimeout. */
  pingIntervalMs: 10_000,
  pingTimeoutMs: 10_000,
} as const;

// ---------------------------------------------------------------------------
// Room codes
// ---------------------------------------------------------------------------

/** 22 letters: no I, L, O, Q (they read as 1, I, 0, O on a projector). */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPRSTUVWXYZ';
export const ROOM_CODE_LENGTH = 4;
const ROOM_CODE_RE = /^[ABCDEFGHJKMNPRSTUVWXYZ]{4}$/;

/** Upper-cases and trims user input; returns null unless it is a valid code. */
export function normalizeRoomCode(raw: string): string | null {
  const code = raw.trim().toUpperCase();
  return ROOM_CODE_RE.test(code) ? code : null;
}

/** Extracts a room code from a scanned QR / pasted link (`/play?room=RIVA`) or a bare code. */
export function roomCodeFromText(text: string): string | null {
  const direct = normalizeRoomCode(text);
  if (direct) return direct;
  try {
    const url = new URL(text.trim(), 'https://x.invalid');
    const q = url.searchParams.get('room');
    return q ? normalizeRoomCode(q) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// phone -> relay -> scene  (inputs, 30 Hz, volatile)
// ---------------------------------------------------------------------------

/**
 * Shared header of every input packet.
 * `seq` is assigned by src/net/client.ts, monotonic per connection; the scene drops
 * packets whose seq is not greater than the last one it applied (see src/net/inputHold.ts).
 */
export interface InputBase {
  t: 'in';
  seq: number;
}

/** Pilot: `steer` is -1..1 after dead zone and full-lock mapping; gas/brake are held states. */
export interface PilotIn extends InputBase {
  role: 'pilot';
  steer: number;
  gas: boolean;
  brake: boolean;
}

/**
 * Gunner. Aim is sent twice so a dropped packet never loses rotation:
 *   dYaw  radians turned since the previous packet the phone built (the spec's field; kept for
 *         logging, drift tests and as a velocity hint for the aim-assist gain)
 *   yaw   radians accumulated since the last calibrate/recenter (absolute, what the sim uses)
 *   ep    "epoch": incremented by the phone on every calibrate or recenter. The scene re-bases
 *         its world aim when ep changes, so a lost `recenter: true` packet still recenters.
 *   fire  held state; fc counts fire taps so a tap shorter than one packet is never lost.
 */
export interface GunnerIn extends InputBase {
  role: 'gunner';
  dYaw: number;
  yaw: number;
  ep: number;
  fire: boolean;
  fc: number;
  recenter: boolean;
}

/**
 * Engineer. `use` is the slot tapped (latched for ~5 packets by the phone), `uc` counts taps so the
 * scene applies each tap exactly once (apply when uc changes and use !== null). `shake` is 0..1.
 */
export interface EngIn extends InputBase {
  role: 'engineer';
  use: 0 | 1 | null;
  uc: number;
  shake: number;
}

export type InputMsg = PilotIn | GunnerIn | EngIn;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** What the phone UI produces each tick; the net client adds `seq`. */
export type InputSample = DistributiveOmit<InputMsg, 'seq'>;

// ---------------------------------------------------------------------------
// phone -> relay  (control messages, reliable)
// ---------------------------------------------------------------------------

export interface Hello {
  t: 'hello';
  v: ProtocolVersion;
  room: string;
  token: string;
  name: string;
}
export interface Swap {
  t: 'swap';
  team?: number;
  role?: Role;
}
export interface Ready {
  t: 'ready';
  ready: boolean;
}
/** The phone finished calibration (Pilot: level angle; Gunner: pointed at the screen). */
export interface Calibrate {
  t: 'calibrate';
}
export interface Rename {
  t: 'rename';
  name: string;
}
export interface Leave {
  t: 'leave';
}

// ---------------------------------------------------------------------------
// scene -> relay -> phone(s)
// ---------------------------------------------------------------------------

export interface Hud {
  t: 'hud';
  phase: Phase;
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

export type EvtKind = 'kill' | 'sunk' | 'respawn' | 'shielded' | 'fired' | 'pickup' | 'win';
export interface Evt {
  t: 'evt';
  kind: EvtKind;
}

export interface LobbyMember {
  pid: string;
  name: string;
  team: number;
  seat: Seat;
  ready: boolean;
  calibrated: boolean;
  connected: boolean;
}
/** Full roster snapshot. Sent to every phone on every change; each phone finds itself by pid. */
export interface Lobby {
  t: 'lobby';
  phase: Phase;
  teamSize: 2 | 3;
  teams: number;
  members: LobbyMember[];
}

// ---------------------------------------------------------------------------
// relay <-> scene and relay <-> phone bookkeeping
// ---------------------------------------------------------------------------

/** Scene asks for a room. With `code` + `sceneToken` it re-claims the room after a reload. */
export interface HostMsg {
  t: 'host';
  v: ProtocolVersion;
  code?: string;
  sceneToken?: string;
}
export interface RelayPlayer {
  pid: string;
  name: string;
  connected: boolean;
  queued: boolean;
}
export interface RoomCreated {
  t: 'room';
  code: string;
  sceneToken: string;
  reclaimed: boolean;
  players: RelayPlayer[];
}
/** Scene tells the relay who may join. The relay enforces it without knowing why. */
export interface Gate {
  t: 'gate';
  /** Players the room accepts (<= NET.maxPlayers). */
  max: number;
  /** True while a match runs. New tokens are then queued (late: 'queue') or refused. */
  locked: boolean;
  late: 'queue' | 'reject';
}

export interface Welcome {
  t: 'welcome';
  v: ProtocolVersion;
  code: string;
  pid: string;
  token: string;
  /** The token was already in this room: same pid, same seat. */
  rejoined: boolean;
  /** Joined while locked: the scene seats this player at the next lobby. */
  queued: boolean;
  sceneOnline: boolean;
}

export type ErrCode =
  | 'bad_version'
  | 'bad_hello'
  | 'no_room'
  | 'room_full'
  | 'match_running'
  | 'room_closed'
  | 'kicked'
  | 'replaced'
  | 'rate_limited'
  | 'not_in_room';
export interface Err {
  t: 'err';
  code: ErrCode;
  msg?: string;
}

/** To phones: the big screen's socket went away (grace period) or came back. */
export interface RoomStatus {
  t: 'room';
  sceneOnline: boolean;
}

/** To the scene. */
export interface PlayerJoined {
  t: 'joined';
  pid: string;
  name: string;
  queued: boolean;
}
export interface PlayerLeft {
  t: 'left';
  pid: string;
  reason: 'disconnect' | 'leave' | 'kick' | 'expired';
}
export interface PlayerReconnected {
  t: 'reconnected';
  pid: string;
  name: string;
}

export type PhoneToRelay = Hello | Swap | Ready | Calibrate | Rename | Leave | InputMsg;
export type RelayToPhone = Welcome | Err | RoomStatus | Hud | Evt | Lobby;
export type SceneToRelay = HostMsg | Gate | Hud | Evt | Lobby;
export type RelayToScene = RoomCreated | Err | PlayerJoined | PlayerLeft | PlayerReconnected;

// ---------------------------------------------------------------------------
// Socket.IO typed event maps (socket.io 4.8: Server<C2S, S2C, InterServer, SocketData>)
// ---------------------------------------------------------------------------

export interface ClientToServerEvents {
  // scene
  host: (msg: HostMsg, ack: (res: RoomCreated | Err) => void) => void;
  gate: (msg: Gate) => void;
  kick: (pid: string) => void;
  hud: (pid: string, msg: Hud) => void;
  evt: (pid: string | null, msg: Evt) => void;
  lobby: (msg: Lobby) => void;
  // phone
  hello: (msg: Hello, ack: (res: Welcome | Err) => void) => void;
  in: (msg: InputMsg) => void;
  swap: (msg: Swap) => void;
  ready: (msg: Ready) => void;
  calibrate: (msg: Calibrate) => void;
  rename: (msg: Rename) => void;
  leave: (msg: Leave) => void;
}

export interface ServerToClientEvents {
  // to the scene, tagged with the player id
  joined: (msg: PlayerJoined) => void;
  left: (msg: PlayerLeft) => void;
  reconnected: (msg: PlayerReconnected) => void;
  in: (pid: string, msg: InputMsg) => void;
  swap: (pid: string, msg: Swap) => void;
  ready: (pid: string, msg: Ready) => void;
  calibrate: (pid: string, msg: Calibrate) => void;
  rename: (pid: string, msg: Rename) => void;
  // to phones
  hud: (msg: Hud) => void;
  evt: (msg: Evt) => void;
  lobby: (msg: Lobby) => void;
  room: (msg: RoomStatus) => void;
  // to either
  err: (msg: Err) => void;
}

/** Single-process relay: no inter-server events. */
export type InterServerEvents = Record<string, never>;

export interface SocketData {
  kind: 'scene' | 'player' | null;
  code: string | null;
  pid: string | null;
  token: string | null;
}

// ---------------------------------------------------------------------------
// Validation of untrusted phone messages (pure; used by server/relay.ts and tests)
// ---------------------------------------------------------------------------

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}
function num(x: unknown): number | null {
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}
function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
function uint(x: unknown): number | null {
  const n = num(x);
  return n !== null && n >= 0 && n <= Number.MAX_SAFE_INTEGER ? Math.floor(n) : null;
}
function bool(x: unknown): boolean {
  return x === true;
}

/** Trims, strips control characters, caps length. Returns null for an empty name. */
export function sanitizeName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const clean = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, NET.nameMax);
  return clean.length > 0 ? clean : null;
}

/** Validates and clamps one input packet. Returns null for anything the sim must not see. */
export function parseInput(x: unknown): InputMsg | null {
  if (!isRecord(x) || x['t'] !== 'in') return null;
  const seq = uint(x['seq']);
  if (seq === null) return null;
  switch (x['role']) {
    case 'pilot': {
      const steer = num(x['steer']);
      if (steer === null) return null;
      return { t: 'in', seq, role: 'pilot', steer: clamp(steer, -1, 1), gas: bool(x['gas']), brake: bool(x['brake']) };
    }
    case 'gunner': {
      const dYaw = num(x['dYaw']);
      const yaw = num(x['yaw']);
      const ep = uint(x['ep']);
      const fc = uint(x['fc']);
      if (dYaw === null || yaw === null || ep === null || fc === null) return null;
      return {
        t: 'in',
        seq,
        role: 'gunner',
        dYaw: clamp(dYaw, -Math.PI, Math.PI),
        yaw: clamp(yaw, -64 * Math.PI, 64 * Math.PI),
        ep,
        fire: bool(x['fire']),
        fc,
        recenter: bool(x['recenter']),
      };
    }
    case 'engineer': {
      const shake = num(x['shake']);
      const uc = uint(x['uc']);
      if (shake === null || uc === null) return null;
      const u = x['use'];
      const use: 0 | 1 | null = u === 0 ? 0 : u === 1 ? 1 : null;
      return { t: 'in', seq, role: 'engineer', use, uc, shake: clamp(shake, 0, 1) };
    }
    default:
      return null;
  }
}

export function parseHello(x: unknown): Hello | null {
  if (!isRecord(x) || x['t'] !== 'hello' || x['v'] !== PROTOCOL_VERSION) return null;
  const room = typeof x['room'] === 'string' ? normalizeRoomCode(x['room']) : null;
  const token = x['token'];
  const name = sanitizeName(x['name']);
  if (!room || typeof token !== 'string' || token.length < 8 || token.length > 64 || !name) return null;
  return { t: 'hello', v: PROTOCOL_VERSION, room, token, name };
}

export function parseHost(x: unknown): HostMsg | null {
  if (!isRecord(x) || x['t'] !== 'host' || x['v'] !== PROTOCOL_VERSION) return null;
  const msg: HostMsg = { t: 'host', v: PROTOCOL_VERSION };
  if (typeof x['code'] === 'string' && typeof x['sceneToken'] === 'string') {
    const code = normalizeRoomCode(x['code']);
    if (code && x['sceneToken'].length >= 8 && x['sceneToken'].length <= 64) {
      msg.code = code;
      msg.sceneToken = x['sceneToken'];
    }
  }
  return msg;
}

export function parseSwap(x: unknown): Swap | null {
  if (!isRecord(x) || x['t'] !== 'swap') return null;
  const out: Swap = { t: 'swap' };
  const team = x['team'];
  if (team !== undefined) {
    const n = uint(team);
    if (n === null || n > 5) return null;
    out.team = n;
  }
  const role = x['role'];
  if (role !== undefined) {
    if (role !== 'pilot' && role !== 'gunner' && role !== 'engineer') return null;
    out.role = role;
  }
  return out;
}

export function parseReady(x: unknown): Ready | null {
  if (!isRecord(x) || x['t'] !== 'ready') return null;
  return { t: 'ready', ready: bool(x['ready']) };
}

export function parseCalibrate(x: unknown): Calibrate | null {
  return isRecord(x) && x['t'] === 'calibrate' ? { t: 'calibrate' } : null;
}

export function parseRename(x: unknown): Rename | null {
  if (!isRecord(x) || x['t'] !== 'rename') return null;
  const name = sanitizeName(x['name']);
  return name ? { t: 'rename', name } : null;
}

export function parseGate(x: unknown): Gate | null {
  if (!isRecord(x) || x['t'] !== 'gate') return null;
  const max = uint(x['max']);
  const late = x['late'];
  if (max === null || (late !== 'queue' && late !== 'reject')) return null;
  return { t: 'gate', max: clamp(max, 1, NET.maxPlayers), locked: bool(x['locked']), late };
}

/** The scene is our own PC, so scene payloads get a shape check only (the relay never reads game fields). */
export function hasTag<T extends string>(x: unknown, t: T): x is { t: T } & Record<string, unknown> {
  return isRecord(x) && x['t'] === t;
}
