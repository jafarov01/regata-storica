/**
 * shared/api.ts: the interfaces between the three tracks.
 *
 * CONTRACT FILE.
 *   Track B (src/sim) implements `Sim`.
 *   Track C (src/render) implements `Renderer`.
 *   Track B (src/scene) owns the loop that wires them, the layout, the HUD and
 *   the keyboard harness; Track A (src/net) feeds InputMsgs and PhoneControl messages in.
 *
 * Nothing outside src/sim mutates GameState. The renderer never changes game
 * state. The relay never sees any of this.
 */
import type { InputMsg, Lobby, PhoneControl } from './protocol.ts';
import type { GameState, Role, SimEvent } from './state.ts';
import type { ParsedMap } from './map.ts';

export interface AddPlayerOptions {
  /** Keyboard harness or bot: no phone, never flagged stale. */
  virtual?: boolean;
  /** Ask for a specific team/role (keyboard harness); falls back to join order. */
  team?: number;
  role?: Role;
}

export interface Sim {
  /** Read-only outside src/sim. */
  readonly state: GameState;
  readonly map: ParsedMap;

  // Lobby and roster -------------------------------------------------------
  addPlayer(id: string, name: string, opts?: AddPlayerOptions): void;
  removePlayer(id: string): void;
  setConnected(id: string, connected: boolean): void;
  /** Handles swap / ready / calibrate / rename / leave from a phone. */
  applyMessage(id: string, msg: PhoneControl): void;
  setTeamSize(size: 2 | 3): void;
  /** Lobby snapshot for the phones; built from the state. */
  lobbySnapshot(): Lobby;

  // Flow -------------------------------------------------------------------
  /** Lobby -> countdown. Returns false (and does nothing) when the roster is not startable. */
  start(): boolean;
  canStart(): { ok: boolean; reason?: string };
  pause(paused: boolean): void;
  /** Results -> countdown with the same teams. */
  rematch(): void;
  /** Any phase -> lobby, keeping the players. */
  newLobby(): void;
  /** Battle -> results immediately (host abort). */
  abort(): void;

  // Inputs -----------------------------------------------------------------
  /**
   * From phones (via src/net/inputHold.ts, which already drops stale seq) or the
   * keyboard harness. The sim holds the last packet per player until the next one.
   * Gunner aim: world aim = base + input.yaw, re-based behind the bow whenever
   * input.ep changes or the boat respawns (see AimTracker in src/net/inputHold.ts).
   * Fire taps and power taps count by `fc` / `uc` changes, never by edges.
   */
  applyInput(id: string, input: InputMsg): void;

  // Time -------------------------------------------------------------------
  /** Advance by one fixed step (SIM.dt). */
  step(dt: number): void;
  /** Events since the last drain; the scene passes them to VFX, audio and phones. */
  drainEvents(): SimEvent[];

  // Debug ------------------------------------------------------------------
  debug: {
    /** Give the team's Gunner a weapon with full ammo. */
    giveWeapon(team: number, weapon: string): void;
    givePower(team: number, power: string): void;
    sink(team: number, killerTeam?: number): void;
    /** Teleport a boat (keyboard harness, tests). */
    teleport(team: number, x: number, z: number, yaw: number): void;
    /** Add a bot-driven team for testing viewports without phones. */
    addBotTeam(): number | null;
    /** Wall rectangles and boat polygons in metres for the collider overlay. */
    colliders(): { rects: { x: number; z: number; w: number; d: number }[] };
  };
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Rects on the big screen in CSS pixels, origin top-left (DOM overlays use them
 * as-is; WebGL setViewport/setScissor need y flipped: glY = height - y - h).
 * Fixed for the whole round. Built by src/scene/layout.ts.
 */
export interface Layout {
  width: number;
  height: number;
  /** One viewport per team, index = team. */
  cells: Rect[];
  /** Spare grid cell for the live overview map (3 or 5 teams), else null. */
  spare: Rect | null;
  /** Minimap square: inside the spare cell, or where the cells meet. */
  minimap: Rect;
}

export interface CameraView {
  /** Team whose viewport this is. */
  team: number;
  /** Boat the camera follows: the team's own, or the killer during the kill-cam. */
  followTeam: number;
  killCam: boolean;
}

export interface RenderDebug {
  showColliders: boolean;
  freeCamera: boolean;
  stats: boolean;
  wireframe: boolean;
}

export interface Renderer {
  /**
   * Draw every viewport. `alpha` in 0..1 interpolates prevPose -> pose.
   * `views[i]` says what cell i looks at. Events drive VFX and audio.
   */
  render(state: GameState, events: readonly SimEvent[], layout: Layout, views: readonly CameraView[], alpha: number): void;
  resize(width: number, height: number): void;
  setDebug(flags: Partial<RenderDebug>): void;
  /** Unlock audio after the host's first click. */
  unlockAudio(): void;
  dispose(): void;
}
