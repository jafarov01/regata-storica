/**
 * Scene-side socket client: create/re-claim the room, receive tagged inputs, push HUD/lobby.
 * The scene is the source of truth for teams, roles and the match; this file only moves bytes.
 */
import {
  NET,
  PROTOCOL_VERSION,
  joinUrl,
  type Calibrate,
  type Evt,
  type Gate,
  type HostMsg,
  type Hud,
  type InputMsg,
  type Lobby,
  type PickCharacter,
  type PlayerJoined,
  type PlayerLeft,
  type PlayerReconnected,
  type Ready,
  type Rename,
  type RoomCreated,
  type Swap,
} from '@shared/protocol.ts';
import { connectSocket, type LinkState, type RelayClientSocket } from './client.ts';
import { loadSceneSession, saveSceneSession } from './identity.ts';

export interface SceneHandlers {
  onLink(state: LinkState, detail?: string): void;
  onRoom(r: RoomCreated): void;
  onJoined(m: PlayerJoined): void;
  onLeft(m: PlayerLeft): void;
  onReconnected(m: PlayerReconnected): void;
  onInput(pid: string, m: InputMsg): void;
  onSwap(pid: string, m: Swap): void;
  onReady(pid: string, m: Ready): void;
  onCalibrate(pid: string, m: Calibrate): void;
  onRename(pid: string, m: Rename): void;
  onCharacter(pid: string, m: PickCharacter): void;
}

/** The URL the QR encodes. Override with VITE_PUBLIC_ORIGIN when the scene PC opens localhost but phones use a tunnel. */
export function publicJoinUrl(code: string): string {
  const env = import.meta.env as Record<string, string | undefined>;
  return joinUrl(env['VITE_PUBLIC_ORIGIN'] ?? window.location.origin, code);
}

export class SceneClient {
  readonly socket: RelayClientSocket;
  code: string | null = null;
  private hudTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly h: SceneHandlers) {
    this.socket = connectSocket();
    this.socket.on('connect', () => {
      this.h.onLink('online');
      void this.host();
    });
    this.socket.on('disconnect', (reason) => this.h.onLink('offline', reason));
    this.socket.on('connect_error', (e) => this.h.onLink('connecting', e.message));
    this.socket.on('joined', (m) => this.h.onJoined(m));
    this.socket.on('left', (m) => this.h.onLeft(m));
    this.socket.on('reconnected', (m) => this.h.onReconnected(m));
    this.socket.on('in', (pid, m) => this.h.onInput(pid, m));
    this.socket.on('swap', (pid, m) => this.h.onSwap(pid, m));
    this.socket.on('ready', (pid, m) => this.h.onReady(pid, m));
    this.socket.on('calibrate', (pid, m) => this.h.onCalibrate(pid, m));
    this.socket.on('rename', (pid, m) => this.h.onRename(pid, m));
    this.socket.on('character', (pid, m) => this.h.onCharacter(pid, m));
    this.h.onLink('connecting');
  }

  /** Re-claims the saved room if the relay still has it (grace period), else creates a new one. */
  private async host(): Promise<void> {
    const saved = loadSceneSession();
    const msg: HostMsg = saved
      ? { t: 'host', v: PROTOCOL_VERSION, code: saved.code, sceneToken: saved.sceneToken }
      : { t: 'host', v: PROTOCOL_VERSION };
    try {
      const res = await this.socket.timeout(5000).emitWithAck('host', msg);
      if (res.t === 'room') {
        this.code = res.code;
        saveSceneSession({ code: res.code, sceneToken: res.sceneToken });
        this.h.onRoom(res);
        return;
      }
      if (res.code === 'no_room' && saved) {
        saveSceneSession(null);
        await this.host();
        return;
      }
      this.h.onLink('connecting', `relay refused: ${res.code}`);
    } catch {
      this.h.onLink('connecting', 'no answer from relay');
    }
  }

  /**
   * Reliable, not volatile: the HUD loop emits up to 18 packets in one tick and the browser transport
   * is "not writable" after the first write until the next tick, so volatile would keep only the first.
   * The relay turns each one into a volatile per-phone delivery.
   */
  sendHud(pid: string, hud: Hud): void {
    this.socket.emit('hud', pid, hud);
  }

  /** `pid` null = every phone in the room. */
  sendEvt(pid: string | null, evt: Evt): void {
    this.socket.emit('evt', pid, evt);
  }

  /** Reliable: the roster is sent on change, not on a timer. */
  sendLobby(lobby: Lobby): void {
    this.socket.emit('lobby', lobby);
  }

  setGate(gate: Omit<Gate, 't'>): void {
    this.socket.emit('gate', { t: 'gate', ...gate });
  }

  kick(pid: string): void {
    this.socket.emit('kick', pid);
  }

  /** Runs `collect` 10 times a second and sends one HUD per player. */
  startHudLoop(collect: () => Iterable<[pid: string, hud: Hud]>): void {
    if (this.hudTimer !== null) return;
    this.hudTimer = setInterval(() => {
      if (!this.socket.connected) return;
      for (const [pid, hud] of collect()) this.sendHud(pid, hud);
    }, 1000 / NET.hudHz);
  }

  stopHudLoop(): void {
    if (this.hudTimer !== null) clearInterval(this.hudTimer);
    this.hudTimer = null;
  }

  destroy(): void {
    this.stopHudLoop();
    this.socket.disconnect();
  }
}
