/**
 * The Socket.IO relay: one namespace ("/"), rooms keyed by the 4-letter code.
 *
 *   `${code}:scene`     the scene socket (at most one)
 *   `${code}:players`   every phone in the room
 *   `${code}:${pid}`    one phone
 *
 * Volatile rule (verified in engine.io's transports): a transport is "not writable" from the moment
 * a frame is handed to it until the send callback / next tick, and a volatile packet emitted in that
 * window is silently discarded. So `volatile` is only safe where a socket emits at most one packet
 * per tick: the phone's own 30 Hz stream, and the relay's per-phone HUD/evt delivery. Fan-in to
 * the scene (18 phones -> one socket) and anything emitted in a loop must be reliable.
 * lobby/room/err/welcome are reliable. The relay validates shape and size and never reads game
 * fields. Attach it to any http.Server; server/index.ts and tests/relay.test.ts both do.
 */
import type { Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server, type Socket } from 'socket.io';
import {
  NET,
  PROTOCOL_VERSION,
  hasTag,
  parseCalibrate,
  parseGate,
  parseHello,
  parseHost,
  parseInput,
  parseReady,
  parseRename,
  parseSwap,
  type ClientToServerEvents,
  type Err,
  type ErrCode,
  type Hud,
  type Evt,
  type InterServerEvents,
  type Lobby,
  type ServerToClientEvents,
  type SocketData,
} from '@shared/protocol.ts';
import { RoomRegistry, type RoomRec } from './rooms.ts';

export type RelayServer = Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;
export type RelaySocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

export interface RelayOptions {
  registry?: RoomRegistry;
  /** Browser origins allowed to open a socket. Empty/undefined = any (the tunnel URL is random anyway). */
  allowedOrigins?: string[];
  log?: (line: string) => void;
  sweepIntervalMs?: number;
}

export interface Relay {
  io: RelayServer;
  registry: RoomRegistry;
  close(): Promise<void>;
}

const sceneRoom = (code: string): string => `${code}:scene`;
const playersRoom = (code: string): string => `${code}:players`;
const playerRoom = (code: string, pid: string): string => `${code}:${pid}`;

/** Token bucket: `rate` tokens per second, up to `burst` stored. */
class Bucket {
  private tokens: number;
  private last: number;
  constructor(
    private readonly rate: number,
    private readonly burst: number,
    now: number,
  ) {
    this.tokens = burst;
    this.last = now;
  }
  take(now: number): boolean {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

function err(code: ErrCode, msg?: string): Err {
  return msg === undefined ? { t: 'err', code } : { t: 'err', code, msg };
}

export function createRelay(httpServer: HttpServer, opts: RelayOptions = {}): Relay {
  const registry = opts.registry ?? new RoomRegistry();
  const log = opts.log ?? ((line: string): void => console.log(`[relay] ${line}`));
  const allowed = new Set(opts.allowedOrigins ?? []);

  const io: RelayServer = new Server(httpServer, {
    path: '/socket.io',
    serveClient: false,
    // WebSocket first; phones on a self-signed LAN cert fall back to HTTPS polling (see docs).
    transports: ['websocket', 'polling'],
    pingInterval: NET.pingIntervalMs,
    pingTimeout: NET.pingTimeoutMs,
    maxHttpBufferSize: NET.maxMessageBytes,
    // connectionStateRecovery stays OFF: it would keep every reliable packet (540 inputs/s) for two
    // minutes and replay stale inputs/HUDs on recovery. The token re-join in `hello` covers reconnects.
    allowRequest: (req, fn) => {
      const origin = req.headers.origin;
      if (allowed.size > 0 && origin !== undefined && !allowed.has(origin)) {
        fn('origin not allowed', false);
        return;
      }
      fn(null, true);
    },
  });

  // Protocol version gate. A mismatch surfaces on the client as connect_error with data.code.
  io.use((socket, next) => {
    const v: unknown = socket.handshake.auth['v'];
    if (v !== PROTOCOL_VERSION) {
      const e = new Error('bad_version') as Error & { data?: unknown };
      e.data = { code: 'bad_version', want: PROTOCOL_VERSION };
      next(e);
      return;
    }
    next();
  });

  const emptyData = (): SocketData => ({ kind: null, code: null, pid: null, token: null });

  function bySocketId(id: string): RelaySocket | undefined {
    return io.sockets.sockets.get(id);
  }

  function announceSceneStatus(room: RoomRec, sceneOnline: boolean): void {
    io.to(playersRoom(room.code)).emit('room', { t: 'room', sceneOnline });
  }

  function closeRoom(room: RoomRec, reason: ErrCode): void {
    for (const s of io.sockets.sockets.values()) {
      if (s.data.code !== room.code) continue;
      s.emit('err', err(reason));
      for (const r of s.rooms) if (r !== s.id) void s.leave(r);
      s.data = emptyData();
    }
    registry.close(room.code);
    log(`room ${room.code} closed (${reason})`);
  }

  function detachPlayerSocket(s: RelaySocket): void {
    const { code, pid } = s.data;
    if (code) {
      void s.leave(playersRoom(code));
      if (pid) void s.leave(playerRoom(code, pid));
    }
    s.data = emptyData();
  }

  io.on('connection', (socket) => {
    socket.data = emptyData();
    const inputBucket = new Bucket(NET.inputRatePerSec, NET.inputBurst, Date.now());
    const controlBucket = new Bucket(NET.controlRatePerSec, NET.controlRatePerSec * 2, Date.now());
    let droppedInputs = 0;

    const control = (): boolean => {
      if (controlBucket.take(Date.now())) return true;
      socket.emit('err', err('rate_limited'));
      return false;
    };

    // ---------------- scene ----------------

    socket.on('host', (raw, ack) => {
      if (typeof ack !== 'function' || !control()) return;
      const msg = parseHost(raw);
      // A phone socket that turned into a scene would leave its player slot attached to a scene socket.
      if (!msg || socket.data.kind === 'player') {
        ack(err('bad_hello'));
        return;
      }
      let room: RoomRec | null = null;
      let reclaimed = false;
      if (msg.code && msg.sceneToken) {
        const previousSceneId = registry.get(msg.code)?.sceneSocketId ?? null;
        room = registry.reclaim(msg.code, msg.sceneToken, socket.id);
        reclaimed = room !== null;
        if (!room) {
          // Lost the race with the grace period, or a different server: tell the scene so it starts fresh.
          ack(err('no_room'));
          return;
        }
        if (previousSceneId !== null && previousSceneId !== socket.id) {
          // A duplicated scene tab shares sessionStorage: the newest scene wins, the old one is told.
          const old = bySocketId(previousSceneId);
          if (old) {
            old.emit('err', err('replaced'));
            void old.leave(sceneRoom(room.code));
            old.data = emptyData();
          }
        }
      }
      if (!room) room = registry.create(socket.id, randomUUID());
      socket.data = { kind: 'scene', code: room.code, pid: null, token: room.sceneToken };
      void socket.join(sceneRoom(room.code));
      ack({ t: 'room', code: room.code, sceneToken: room.sceneToken, reclaimed, players: registry.snapshot(room) });
      if (reclaimed) announceSceneStatus(room, true);
      log(`scene ${socket.id} ${reclaimed ? 'reclaimed' : 'created'} room ${room.code}`);
    });

    socket.on('gate', (raw) => {
      const { kind, code } = socket.data;
      if (kind !== 'scene' || !code) return;
      const gate = parseGate(raw);
      if (gate) registry.setGate(code, gate);
    });

    socket.on('kick', (pid) => {
      const { kind, code } = socket.data;
      if (kind !== 'scene' || !code || typeof pid !== 'string') return;
      const player = registry.removeByPid(code, pid);
      if (!player) return;
      const target = player.socketId ? bySocketId(player.socketId) : undefined;
      if (target) {
        target.emit('err', err('kicked'));
        detachPlayerSocket(target);
      }
      socket.emit('left', { t: 'left', pid, reason: 'kick' });
    });

    socket.on('hud', (pid, msg) => {
      const { kind, code } = socket.data;
      if (kind !== 'scene' || !code || typeof pid !== 'string' || !hasTag(msg, 'hud')) return;
      // One HUD per phone per tick: volatile is safe here and drops rather than queues on a dead link.
      io.to(playerRoom(code, pid)).volatile.emit('hud', msg as Hud);
    });

    socket.on('evt', (pid, msg) => {
      const { kind, code } = socket.data;
      if (kind !== 'scene' || !code || !hasTag(msg, 'evt')) return;
      const target = pid === null ? playersRoom(code) : typeof pid === 'string' ? playerRoom(code, pid) : null;
      if (target) io.to(target).volatile.emit('evt', msg as Evt);
    });

    socket.on('lobby', (msg) => {
      const { kind, code } = socket.data;
      if (kind !== 'scene' || !code || !hasTag(msg, 'lobby')) return;
      io.to(playersRoom(code)).emit('lobby', msg as Lobby);
    });

    // ---------------- phone ----------------

    socket.on('hello', (raw, ack) => {
      if (typeof ack !== 'function' || !control()) return;
      const msg = parseHello(raw);
      // A scene socket that said hello would orphan its room (its disconnect would no longer free it).
      if (!msg || socket.data.kind === 'scene') {
        ack(err('bad_hello'));
        return;
      }
      // A socket that was in another room (or this one under another token) leaves it first.
      if (socket.data.kind === 'player' && socket.data.token && socket.data.token !== msg.token) {
        const gone = registry.removeByToken(socket.data.token);
        if (gone) io.to(sceneRoom(gone.room.code)).emit('left', { t: 'left', pid: gone.player.pid, reason: 'leave' });
        detachPlayerSocket(socket);
      }
      const res = registry.join(msg.room, msg.token, msg.name, socket.id);
      if (!res.ok) {
        ack(err(res.code));
        return;
      }
      const { room, player, rejoined, replacedSocketId } = res;
      if (replacedSocketId) {
        // Same token from a second tab/phone: the newest socket wins, the old one is told why.
        const old = bySocketId(replacedSocketId);
        if (old) {
          old.emit('err', err('replaced'));
          detachPlayerSocket(old);
        }
      }
      socket.data = { kind: 'player', code: room.code, pid: player.pid, token: player.token };
      void socket.join([playersRoom(room.code), playerRoom(room.code, player.pid)]);
      ack({
        t: 'welcome',
        v: PROTOCOL_VERSION,
        code: room.code,
        pid: player.pid,
        token: player.token,
        rejoined,
        queued: player.queued,
        sceneOnline: room.sceneSocketId !== null,
      });
      if (rejoined) io.to(sceneRoom(room.code)).emit('reconnected', { t: 'reconnected', pid: player.pid, name: player.name });
      else io.to(sceneRoom(room.code)).emit('joined', { t: 'joined', pid: player.pid, name: player.name, queued: player.queued });
      log(`player ${player.pid} (${player.name}) ${rejoined ? 'rejoined' : 'joined'} ${room.code}`);
    });

    socket.on('in', (raw) => {
      const { kind, code, pid } = socket.data;
      if (kind !== 'player' || !code || !pid) return;
      if (!inputBucket.take(Date.now())) {
        if (++droppedInputs % 300 === 1) log(`rate limit: dropping inputs from ${pid} in ${code}`);
        return;
      }
      const msg = parseInput(raw);
      if (!msg) return;
      // Reliable on purpose: many phones feed one scene socket in the same tick (see header).
      io.to(sceneRoom(code)).emit('in', pid, msg);
    });

    socket.on('swap', (raw) => {
      const { kind, code, pid } = socket.data;
      if (kind !== 'player' || !code || !pid || !control()) return;
      const msg = parseSwap(raw);
      if (msg) io.to(sceneRoom(code)).emit('swap', pid, msg);
    });

    socket.on('ready', (raw) => {
      const { kind, code, pid } = socket.data;
      if (kind !== 'player' || !code || !pid || !control()) return;
      const msg = parseReady(raw);
      if (msg) io.to(sceneRoom(code)).emit('ready', pid, msg);
    });

    socket.on('calibrate', (raw) => {
      const { kind, code, pid } = socket.data;
      if (kind !== 'player' || !code || !pid || !control()) return;
      const msg = parseCalibrate(raw);
      if (msg) io.to(sceneRoom(code)).emit('calibrate', pid, msg);
    });

    socket.on('rename', (raw) => {
      const { kind, code, pid, token } = socket.data;
      if (kind !== 'player' || !code || !pid || !token || !control()) return;
      const msg = parseRename(raw);
      if (!msg) return;
      const room = registry.get(code);
      const player = room?.players.get(token);
      if (player) player.name = msg.name;
      io.to(sceneRoom(code)).emit('rename', pid, msg);
    });

    socket.on('leave', () => {
      const { kind, token } = socket.data;
      if (kind !== 'player' || !token || !control()) return;
      const gone = registry.removeByToken(token);
      if (gone) io.to(sceneRoom(gone.room.code)).emit('left', { t: 'left', pid: gone.player.pid, reason: 'leave' });
      detachPlayerSocket(socket);
    });

    // ---------------- either ----------------

    socket.on('disconnect', (reason) => {
      const { kind, code, token } = socket.data;
      if (kind === 'scene' && code) {
        const room = registry.sceneLeft(code, socket.id);
        if (room) {
          announceSceneStatus(room, false);
          log(`scene left ${code} (${reason}); grace ${NET.sceneGraceMs} ms`);
        }
      } else if (kind === 'player' && token) {
        const gone = registry.playerSocketLeft(token, socket.id);
        if (gone) {
          io.to(sceneRoom(gone.room.code)).emit('left', { t: 'left', pid: gone.player.pid, reason: 'disconnect' });
          log(`player ${gone.player.pid} dropped from ${gone.room.code} (${reason})`);
        }
      }
    });
  });

  const sweep = setInterval(() => {
    const { closedRooms, expiredPlayers } = registry.sweep();
    for (const { room, player } of expiredPlayers) {
      io.to(sceneRoom(room.code)).emit('left', { t: 'left', pid: player.pid, reason: 'expired' });
    }
    for (const room of closedRooms) closeRoom(room, 'room_closed');
  }, opts.sweepIntervalMs ?? 5000);
  sweep.unref();

  return {
    io,
    registry,
    async close(): Promise<void> {
      clearInterval(sweep);
      await io.close();
    },
  };
}
