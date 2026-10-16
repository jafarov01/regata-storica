/**
 * Phone-side socket client: connect, say hello, stream inputs at 30 Hz, receive HUD/lobby.
 *
 * Reconnect story (in order of what actually happens on an iPhone that slept 30 s):
 *   1. iOS freezes the page; the WebSocket dies. On wake, socket.io's throttled ping timer fires,
 *      the Manager reconnects with backoff (500 ms .. 3 s).
 *   2. On every `connect` we send `hello` again with the same token. The relay re-attaches the
 *      socket to the same pid and tells the scene `reconnected`. This does not depend on
 *      Socket.IO's connection-state-recovery; if that also succeeded, hello is a harmless no-op.
 *   3. On `visibilitychange` -> visible (and `pageshow` after the back/forward cache) we skip the
 *      reconnect backoff if the socket is down, or force a fresh transport if the link looks
 *      half-open: no HUD for 4 s while the big screen is online, or no ping for 2 intervals.
 *   4. While visible, a 1 s watchdog does the same half-open check, so a phone that lost wifi for
 *      a few seconds is back without waiting the 20 s ping timeout.
 *
 * Terminal errors (kicked, replaced by another tab, room closed, protocol mismatch) halt the client:
 * it disconnects and never says hello again on its own, so two tabs with one token cannot steal the
 * slot back and forth. `retry()` is the explicit "use this phone" / "try again" from the screen.
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

/** Errors after which the phone stops reconnecting until the player taps something. */
export const TERMINAL_ERRORS: ReadonlySet<Err['code']> = new Set(['kicked', 'replaced', 'room_closed', 'bad_version']);

/** No HUD for this long while the big screen is online means the link is half-open (HUD is 10 Hz). */
export const HUD_SILENCE_MS = 4000;
/** At most one forced transport restart per this period, so a quiet scene cannot cause a reconnect loop. */
const FORCE_RECONNECT_EVERY_MS = 15_000;

/**
 * Pure: should the phone drop its transport and reconnect? `hudAgeMs` is null before the first HUD
 * of this connection (the scene may not have seated us yet, which is not a dead link).
 */
export function linkLooksDead(o: { connected: boolean; sceneOnline: boolean; hudAgeMs: number | null; serverAgeMs: number; pingIntervalMs: number }): boolean {
  if (!o.connected) return false;
  if (o.sceneOnline && o.hudAgeMs !== null && o.hudAgeMs > HUD_SILENCE_MS) return true;
  return o.serverAgeMs > 2 * o.pingIntervalMs;
}

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
  /** Date.now() of the last HUD on this connection, 0 before the first one. */
  private lastHudAt = 0;
  private lastForcedAt = 0;
  private sceneOnline = false;
  private joined = false;
  private halted = false;
  private readonly watchdog: ReturnType<typeof setInterval>;
  private readonly onVisibility = (): void => {
    if (document.visibilityState === 'visible') this.wake();
  };
  private readonly onPageShow = (e: PageTransitionEvent): void => {
    // Restored from the back/forward cache: the old transport is gone, visibilitychange may not fire.
    if (e.persisted) this.wake();
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
      this.lastHudAt = 0;
      if (this.halted) return;
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
        this.halt();
        this.h.onError({ t: 'err', code: 'bad_version', msg: 'Reload the page: the game was updated.' });
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
      this.lastHudAt = this.lastServerAt;
      this.sceneOnline = true;
      this.h.onHud(m);
    });
    this.socket.on('evt', (m) => {
      touch();
      this.h.onEvt(m);
    });
    this.socket.on('room', (m) => {
      touch();
      this.sceneOnline = m.sceneOnline;
      if (!m.sceneOnline) this.lastHudAt = 0;
      this.h.onRoom(m);
    });
    this.socket.on('err', (m) => {
      touch();
      if (TERMINAL_ERRORS.has(m.code)) this.halt();
      this.h.onError(m);
    });
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('pageshow', this.onPageShow);
    this.watchdog = setInterval(() => {
      if (document.visibilityState === 'visible' && this.joined) this.checkLink();
    }, 1000);
    this.h.onLink('connecting');
  }

  /** Milliseconds since the last HUD on this connection, or null before the first one. */
  get hudAgeMs(): number | null {
    return this.lastHudAt === 0 ? null : Date.now() - this.lastHudAt;
  }

  get isSceneOnline(): boolean {
    return this.sceneOnline;
  }

  get isHalted(): boolean {
    return this.halted;
  }

  /** The player asked to try again (after an error) or to take this slot back from another tab. */
  retry(): void {
    this.halted = false;
    if (this.socket.connected) void this.hello();
    else this.reconnectNow();
  }

  /** Page visible again after a lock, an app switch or the bfcache: get back into the slot fast. */
  private wake(): void {
    if (this.halted) return;
    if (!this.socket.connected) this.reconnectNow();
    else this.checkLink();
  }

  private checkLink(): void {
    const now = Date.now();
    const dead = linkLooksDead({
      connected: this.socket.connected,
      sceneOnline: this.sceneOnline,
      hudAgeMs: this.hudAgeMs,
      serverAgeMs: now - this.lastServerAt,
      pingIntervalMs: NET.pingIntervalMs,
    });
    if (!dead || now - this.lastForcedAt < FORCE_RECONNECT_EVERY_MS) return;
    this.lastForcedAt = now;
    // Half-open after sleep or a wifi blip: drop the transport, the Manager reconnects at once.
    this.socket.io.engine.close();
  }

  /**
   * Skips the Manager's backoff timer (iOS throttles timers while locked, so it can still be
   * seconds away): disconnect() clears the pending attempt, connect() opens a new one now.
   */
  private reconnectNow(): void {
    this.socket.disconnect();
    this.socket.connect();
  }

  private halt(): void {
    this.halted = true;
    this.joined = false;
    this.socket.disconnect();
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
        this.sceneOnline = res.sceneOnline;
        this.h.onWelcome(res);
      } else {
        if (TERMINAL_ERRORS.has(res.code)) this.halt();
        this.h.onError(res);
      }
    } catch {
      // Ack timeout. A dead socket reconnects and says hello again on 'connect'; a live one that
      // lost the ack (rate limit, relay restart) would otherwise sit unjoined forever, so ask again.
      this.h.onLink('connecting', 'no answer from relay');
      setTimeout(() => {
        if (this.socket.connected && !this.joined && !this.halted) void this.hello();
      }, 1000);
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

  /**
   * Sends one packet now (src/phone/sender.ts owns the 30 Hz timing). Same transport rule as
   * startInputs: volatile on WebSocket, reliable on the polling fallback.
   */
  sendInput(sample: InputSample): void {
    if (!this.joined || !this.socket.connected) return;
    const msg: InputMsg = { ...sample, seq: ++this.seq };
    if (this.socket.io.engine.transport.name === 'websocket') this.socket.volatile.emit('in', msg);
    else this.socket.emit('in', msg);
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
    clearInterval(this.watchdog);
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('pageshow', this.onPageShow);
    this.socket.disconnect();
  }
}
