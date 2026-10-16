/**
 * shared/protocol.ts: every message between phones, the relay and the scene.
 *
 * CONTRACT FILE. The relay (server/) only understands `host`, `hello`, `in`,
 * `msg`, `to` and `hud`; it routes by room code and never reads game fields.
 *
 *   phone --in/msg-->  relay --player:in/player:msg-->  scene
 *   scene --to/hud-->  relay --msg/hud-->               phone(s)
 *
 * Inputs flow at 30 Hz as volatile packets (a lost packet is replaced by the
 * next one; the sim holds the last input). Everything else is reliable.
 * Every message carries `v` only on the first hop (hello/host); the relay
 * rejects mismatched versions so an old phone tab cannot join a new build.
 */
import type { PowerId, WeaponId } from './config.ts';
import type { Phase, Role } from './state.ts';

export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Inputs: phone -> relay -> scene, 30 Hz, volatile.
// ---------------------------------------------------------------------------

interface InputBase {
  t: 'in';
  /** Monotonic per phone session; the scene drops packets older than the last seen. */
  seq: number;
}

export interface PilotIn extends InputBase {
  role: 'pilot';
  /** -1 (full left) .. 1 (full right), dead zone and curve already applied on the phone. */
  steer: number;
  gas: boolean;
  brake: boolean;
}

export interface GunnerIn extends InputBase {
  role: 'gunner';
  /**
   * Yaw change in radians accumulated since the last packet, gain already
   * applied on the phone. Positive = turn the view left (same sign as world yaw).
   * The scene applies the under-crosshair gain reduction, not the phone.
   */
  dYaw: number;
  /** FIRE held during this packet window (edge detection happens on the scene). */
  fire: boolean;
  /** RECENTER tapped since the last packet. */
  recenter: boolean;
  /** Teams of 2: the Gunner also holds the two power buttons. */
  use?: 0 | 1 | null;
}

export interface EngineerIn extends InputBase {
  role: 'engineer';
  /** Power slot tapped since the last packet, or null. */
  use: 0 | 1 | null;
  /** 0..1 shake intensity over the last window. */
  shake: number;
}

export type InputPacket = PilotIn | GunnerIn | EngineerIn;

// ---------------------------------------------------------------------------
// Phone -> scene control messages (reliable), forwarded by the relay as `player:msg`.
// ---------------------------------------------------------------------------

export type PhoneMsg =
  | { t: 'swap'; team?: number; role?: Role }
  | { t: 'ready'; ready: boolean }
  | { t: 'calibrated' }
  | { t: 'name'; name: string }
  | { t: 'leave' };

// ---------------------------------------------------------------------------
// Scene -> phone messages (reliable except `hud`), sent via `to` / `hud`.
// ---------------------------------------------------------------------------

/** Per-player status, 10 Hz, volatile. Everything a phone screen shows. */
export interface Hud {
  t: 'hud';
  phase: Phase;
  team: number;
  role: Role;
  teamName: string;
  colour: string;
  kills: number;
  deaths: number;
  /** Seconds until respawn while sunk, else 0. */
  respawnIn: number;
  /** Team that sank you, shown on the sunk screen. */
  sunkBy: string | null;
  weapon: WeaponId;
  ammo: number;
  powers: [PowerId | null, PowerId | null];
  /** Hull water 0..100. */
  water: number;
  alive: boolean;
  /** Spawn-protection seconds left, else 0. */
  protectedFor: number;
  /** Seconds left in the current phase (battle timer, countdown, results). */
  timeLeft: number;
  /** Gunner compass needle: aim minus bow, radians, wrapped. */
  aimRel: number;
  /** Enemy under the crosshair / torpedo lock ready. */
  onTarget: boolean;
  locked: boolean;
  /** This phone's role includes the power buttons (Engineer, or Gunner in teams of 2). */
  hasPowers: boolean;
  /** Show SHAKE TO BAIL (Engineer with water aboard). */
  bail: boolean;
  /** The scene has not heard from this phone recently (shown as a warning). */
  stale: boolean;
}

export type EvtKind = 'kill' | 'sunk' | 'respawn' | 'shielded' | 'fired' | 'hit' | 'pickup' | 'power' | 'rammed' | 'win' | 'countdown' | 'start';

export interface Evt {
  t: 'evt';
  kind: EvtKind;
  /** Optional detail: item picked up, countdown number, team that sank you. */
  detail?: string;
}

export interface LobbyMember {
  id: string;
  name: string;
  role: Role;
  ready: boolean;
  calibrated: boolean;
  connected: boolean;
  virtual: boolean;
}

export interface LobbyTeam {
  index: number;
  name: string;
  colour: string;
  members: LobbyMember[];
  /** Free slots in this team under the current size plan. */
  capacity: number;
}

/** Lobby roster broadcast to every phone on any change. Phones find themselves by id. */
export interface LobbySnapshot {
  t: 'lobby';
  phase: Phase;
  teamSize: 2 | 3;
  teams: LobbyTeam[];
  /** Spectators waiting for a slot. */
  spectators: LobbyMember[];
}

export type SceneMsg = Hud | Evt | LobbySnapshot | { t: 'kick'; reason: string };

// ---------------------------------------------------------------------------
// Relay control: room creation and joining.
// ---------------------------------------------------------------------------

export interface HostRequest {
  v: number;
  /** Reclaim an existing room after a scene reload (code from sessionStorage). */
  reclaim?: string;
}

export type HostResponse = { ok: true; code: string; reclaimed: boolean } | { ok: false; code: ErrorCode };

export interface Hello {
  v: number;
  room: string;
  /** Random per phone, kept in localStorage; the same token rejoins the same slot. */
  token: string;
  name: string;
}

export type ErrorCode = 'no_room' | 'room_full' | 'bad_version' | 'no_scene' | 'bad_request' | 'rate_limited';

export type HelloResponse =
  | { ok: true; playerId: string; reconnected: boolean; sceneConnected: boolean }
  | { ok: false; code: ErrorCode };

/** Relay -> scene when a phone joins or rejoins. */
export interface PlayerJoined {
  playerId: string;
  name: string;
  reconnected: boolean;
}

/** Scene -> relay: deliver a message to one player or to every phone in the room. */
export interface Envelope {
  to: string | 'all';
  msg: SceneMsg;
}

/** Scene -> relay: one HUD per player per tick; the relay fans out. */
export interface HudBatch {
  byPlayer: Record<string, Hud>;
}

// ---------------------------------------------------------------------------
// Socket.IO typed event maps (shared by server/ and src/net/).
// ---------------------------------------------------------------------------

export interface ClientToServerEvents {
  host: (req: HostRequest, ack: (res: HostResponse) => void) => void;
  hello: (req: Hello, ack: (res: HelloResponse) => void) => void;
  /** Phone input packet, volatile. */
  in: (pkt: InputPacket) => void;
  /** Phone control message. */
  msg: (msg: PhoneMsg) => void;
  /** Scene -> one player or all. */
  to: (env: Envelope) => void;
  /** Scene -> many players, volatile. */
  hud: (batch: HudBatch) => void;
}

export interface ServerToClientEvents {
  /** To the scene. */
  'player:join': (p: PlayerJoined) => void;
  'player:leave': (p: { playerId: string }) => void;
  'player:in': (p: { playerId: string; in: InputPacket }) => void;
  'player:msg': (p: { playerId: string; msg: PhoneMsg }) => void;
  /** To phones. */
  msg: (msg: SceneMsg) => void;
  'scene:status': (s: { connected: boolean }) => void;
  'room:closed': (r: { reason: string }) => void;
}

export interface InterServerEvents {}

export interface SocketData {
  kind: 'scene' | 'player';
  room: string;
  playerId?: string;
  token?: string;
}

// ---------------------------------------------------------------------------
// Validation helpers used by the relay and the scene. Small, allocation-free.
// ---------------------------------------------------------------------------

export function isRoomCode(s: unknown): s is string {
  return typeof s === 'string' && /^[A-Z]{4}$/.test(s);
}

export function isFiniteNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

/** Shape-check an input packet and clamp its numbers; returns null when malformed. */
export function sanitizeInput(raw: unknown): InputPacket | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  if (p['t'] !== 'in' || !isFiniteNumber(p['seq'])) return null;
  const seq = Math.max(0, Math.floor(p['seq']));
  switch (p['role']) {
    case 'pilot': {
      if (!isFiniteNumber(p['steer'])) return null;
      return { t: 'in', seq, role: 'pilot', steer: Math.max(-1, Math.min(1, p['steer'])), gas: p['gas'] === true, brake: p['brake'] === true };
    }
    case 'gunner': {
      if (!isFiniteNumber(p['dYaw'])) return null;
      const use = p['use'] === 0 || p['use'] === 1 ? p['use'] : null;
      return {
        t: 'in',
        seq,
        role: 'gunner',
        dYaw: Math.max(-Math.PI, Math.min(Math.PI, p['dYaw'])),
        fire: p['fire'] === true,
        recenter: p['recenter'] === true,
        use,
      };
    }
    case 'engineer': {
      if (!isFiniteNumber(p['shake'])) return null;
      const use = p['use'] === 0 || p['use'] === 1 ? p['use'] : null;
      return { t: 'in', seq, role: 'engineer', use, shake: Math.max(0, Math.min(1, p['shake'])) };
    }
    default:
      return null;
  }
}

export function sanitizePhoneMsg(raw: unknown): PhoneMsg | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  switch (m['t']) {
    case 'swap': {
      const out: PhoneMsg = { t: 'swap' };
      if (isFiniteNumber(m['team'])) out.team = Math.floor(m['team']);
      if (m['role'] === 'pilot' || m['role'] === 'gunner' || m['role'] === 'engineer') out.role = m['role'];
      return out;
    }
    case 'ready':
      return { t: 'ready', ready: m['ready'] === true };
    case 'calibrated':
      return { t: 'calibrated' };
    case 'name':
      return typeof m['name'] === 'string' ? { t: 'name', name: m['name'].slice(0, 16) } : null;
    case 'leave':
      return { t: 'leave' };
    default:
      return null;
  }
}

/** Build the join URL the QR encodes. */
export function joinUrl(origin: string, code: string): string {
  return `${origin}/play?room=${encodeURIComponent(code)}`;
}
