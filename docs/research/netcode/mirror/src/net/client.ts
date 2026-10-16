/**
 * Phone-side socket client: connect, say hello, stream inputs at 30 Hz, receive HUD/lobby.
 *
 * Reconnect story (in order of what actually happens on an iPhone that slept 30 s):
 *   1. iOS freezes the page; the WebSocket dies. On wake, socket.io's throttled ping timer fires,
 *      the Manager reconnects with backoff (500 ms .. 3 s).
 *   2. On every `connect` we send `hello` again with the same token. The relay re-attaches the
 *      socket to the same pid and tells the scene `reconnected`. This does not depend on
 *      Socket.IO's connection-state-recovery; if that also succeeded, hello is a harmless no-op.
 *   3. On `visibilitychange` -> visible we check for a half-open link (no ping seen for 2 intervals)
 *      and force a fresh transport instead of waiting for the ping timeout.
 */
import { io, type Socket } from 'socket.io-client';
import {
  NET,
  PROTOCOL_VERSION,
  type ClientToServerEvents,
  type Err,
  type Evt,
  type Hud,
  type InputMsg,
  type InputSample,
  type Lobby,
  type Role,
  type RoomStatus,
  type ServerToClientEvents,
  type Welcome,
} from '@shared/protocol.ts';

export type RelayClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export type LinkState = 'connecting' | 'online' | 'offline';

/** One socket factory for both modes. Same-origin: Vite proxies /socket.io in dev, Express serves it in prod. */
export function connectSocket(): RelayClientSocket {
  return io({
    path: '/socket.io',
    // WebSocket first (tunnels and prod), HTTPS long-polling as the fallback for iOS on a
    // self-signed LAN certificate, where Safari accepts the page but refuses wss://.
    transports: ['websocket', 'polling'],
    tryAllTransports: true,
    auth: { v: PROTOCOL_VERSION },
    reconnectionDelay: 500,
    reconnectionDelayMax: 3000,
    randomizationFactor: 0.3,
    timeout: 8000,
  });
}

export interface PhoneHandlers {
  onLink(state: LinkState, detail?: string): void;
  onWelcome(w: Welcome): void;
  onLobby(l: Lobby): void;
  onHud(h: Hud): void;
  onEvt(e: Evt): void;
  onRoom(r: RoomStatus): void;
  onError(e: Err): void;
}

export class PhoneClient {
  readonly socket: RelayClientSocket;
  private seq = 0;
  private sampler: (() => InputSample | null) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastServerAt = Date.now();
  private joined = false;
  private readonly onVisibility = (): void => {
    if (document.visibilityState !== 'visible') return;
    if (!this.socket.connected) {
      this.socket.connect();
    } else if (Date.now() - this.lastServerAt > 2 * NET.pingIntervalMs) {
      // Half-open after sleep: drop the transport, the Manager reconnects at once.
      this.socket.io.engine.close();
    }
  };

  constructor(
    private readonly room: string,
    private readonly token: string,
    private name: string,
    private readonly h: PhoneHandlers,
  ) {
    this.socket = connectSocket();
    const touch = (): void => {
      this.lastServerAt = Date.now();
    };
    this.socket.io.on('ping', touch);
    this.socket.on('connect', () => {
      touch();
      this.h.onLink('online');
      void this.hello();
    });
    this.socket.on('disconnect', (reason) => {
      this.joined = false;
      this.h.onLink('offline', reason);
      // 'io server disconnect' means we were told to go (room closed/kicked): do not fight it.
    });
    this.socket.on('connect_error', (e) => {
      const data = (e as { data?: { code?: unknown } }).data;
      if (data?.code === 'bad_version') {
        this.h.onError({ t: 'err', code: 'bad_version', msg: 'Reload the page: the game was updated.' });
        this.socket.disconnect();
        return;
      }
      this.h.onLink('connecting', e.message);
    });
    this.socket.on('lobby', (m) => {
      touch();
      this.h.onLobby(m);
    });
    this.socket.on('hud', (m) => {
      touch();
      this.h.onHud(m);
    });
    this.socket.on('evt', (m) => {
      touch();
      this.h.onEvt(m);
    });
    this.socket.on('room', (m) => {
      touch();
      this.h.onRoom(m);
    });
    this.socket.on('err', (m) => {
      touch();
      if (m.code === 'room_closed' || m.code === 'kicked' || m.code === 'replaced') this.joined = false;
      this.h.onError(m);
    });
    document.addEventListener('visibilitychange', this.onVisibility);
    this.h.onLink('connecting');
  }

  get isJoined(): boolean {
    return this.joined;
  }

  private async hello(): Promise<void> {
    try {
      const res = await this.socket
        .timeout(5000)
        .emitWithAck('hello', { t: 'hello', v: PROTOCOL_VERSION, room: this.room, token: this.token, name: this.name });
      if (res.t === 'welcome') {
        this.joined = true;
        this.h.onWelcome(res);
      } else {
        this.h.onError(res);
      }
    } catch {
      // ack timeout: the socket will reconnect and hello runs again on 'connect'
      this.h.onLink('connecting', 'no answer from relay');
    }
  }

  /** Starts the 30 Hz loop. `sample` builds a packet from the current sensor/touch state, or null to skip. */
  startInputs(sample: () => InputSample | null): void {
    this.sampler = sample;
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      if (!this.joined || !this.socket.connected || !this.sampler) return;
      const s = this.sampler();
      if (!s) return;
      const msg: InputMsg = { ...s, seq: ++this.seq };
      // Volatile on WebSocket: one packet per tick, dropped rather than queued while the link is down.
      // On the polling fallback the transport is "not writable" for a whole round trip, so volatile
      // would throw most packets away; let polling batch them instead.
      if (this.socket.io.engine.transport.name === 'websocket') this.socket.volatile.emit('in', msg);
      else this.socket.emit('in', msg);
    }, 1000 / NET.inputHz);
  }

  stopInputs(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.sampler = null;
  }

  swap(team?: number, role?: Role): void {
    const msg: ClientToServerEvents['swap'] extends (m: infer M) => void ? M : never = { t: 'swap' };
    if (team !== undefined) msg.team = team;
    if (role !== undefined) msg.role = role;
    this.socket.emit('swap', msg);
  }

  ready(ready: boolean): void {
    this.socket.emit('ready', { t: 'ready', ready });
  }

  calibrated(): void {
    this.socket.emit('calibrate', { t: 'calibrate' });
  }

  rename(name: string): void {
    this.name = name;
    this.socket.emit('rename', { t: 'rename', name });
  }

  leave(): void {
    this.socket.emit('leave', { t: 'leave' });
    this.joined = false;
  }

  destroy(): void {
    this.stopInputs();
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.socket.disconnect();
  }
}
