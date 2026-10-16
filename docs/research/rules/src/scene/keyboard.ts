/**
 * Keyboard harness: one keyboard plays every role of up to 6 teams.
 * Pure part: harnessInputs() turns the set of pressed KeyboardEvent.code
 * values into the same PilotIn / GunnerIn / EngIn packets a phone sends.
 * DOM part: KeyboardHarness listens on window and calls back for globals.
 *
 * Keys use KeyboardEvent.code (physical position: 'KeyA' is the same key on
 * AZERTY). F1..F6 are intercepted by Chrome outside fullscreen on some
 * platforms, so every F-key has a plain alternative (7 8 9 0 - =) and
 * startFullscreenCapture() asks for fullscreen + navigator.keyboard.lock().
 */
import { CONFIG } from '@shared/config.ts';
import type { GameConfig } from '@shared/config.ts';
import type { EngIn, GunnerIn, PilotIn } from '@shared/protocol.ts';
import { keyboardDYaw } from '../sim/aim.ts';

export type GlobalAction =
  | 'start'
  | 'pause'
  | 'debugOverlay'
  | 'colliders'
  | 'freeCamera'
  | 'addFakeTeam'
  | 'giveRandomWeapon'
  | 'sinkFocused'
  | 'toggleBots';

export const KEYS = {
  focusTeam: ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6'] as const,
  pilot: { left: 'KeyA', right: 'KeyD', gas: 'KeyW', brake: 'KeyS', calibrate: 'KeyC' },
  gunner: { left: 'ArrowLeft', right: 'ArrowRight', fire: 'Space', recenter: 'KeyR' },
  engineer: { power0: 'KeyQ', power1: 'KeyE', bail: 'KeyB' },
  globals: {
    start: ['Enter'],
    pause: ['KeyP'],
    debugOverlay: ['F1', 'Digit7'],
    colliders: ['F2', 'Digit8'],
    freeCamera: ['F3', 'Digit9'],
    addFakeTeam: ['F4', 'Digit0'],
    giveRandomWeapon: ['F5', 'Minus'],
    sinkFocused: ['F6', 'Equal'],
    toggleBots: ['KeyT'],
  } satisfies Record<GlobalAction, readonly string[]>,
} as const;

export interface HarnessFrame {
  pilot: PilotIn;
  gunner: GunnerIn;
  engineer: EngIn;
  calibrate: boolean;
}

/** Pure: pressed codes -> one frame of inputs for the focused team. `edge` = codes that went down this frame (taps). */
export function harnessInputs(
  pressed: ReadonlySet<string>,
  edge: ReadonlySet<string>,
  dt: number,
  cfg: GameConfig = CONFIG,
): HarnessFrame {
  const k = KEYS;
  const steer = (pressed.has(k.pilot.right) ? 1 : 0) - (pressed.has(k.pilot.left) ? 1 : 0);
  const use: 0 | 1 | null = edge.has(k.engineer.power0) ? 0 : edge.has(k.engineer.power1) ? 1 : null;
  return {
    pilot: { t: 'in', role: 'pilot', steer: steer * cfg.steer.sign, gas: pressed.has(k.pilot.gas), brake: pressed.has(k.pilot.brake) },
    gunner: {
      t: 'in',
      role: 'gunner',
      dYaw: keyboardDYaw(pressed.has(k.gunner.left), pressed.has(k.gunner.right), dt, cfg),
      fire: pressed.has(k.gunner.fire),
      recenter: edge.has(k.gunner.recenter),
    },
    engineer: { t: 'in', role: 'engineer', use, shake: pressed.has(k.engineer.bail) ? 1 : 0 },
    calibrate: edge.has(k.pilot.calibrate),
  };
}

export function globalActionFor(code: string): GlobalAction | null {
  for (const [action, codes] of Object.entries(KEYS.globals) as [GlobalAction, readonly string[]][]) {
    if (codes.includes(code)) return action;
  }
  return null;
}

export function focusTeamFor(code: string): number | null {
  const i = (KEYS.focusTeam as readonly string[]).indexOf(code);
  return i >= 0 ? i : null;
}

const HANDLED: ReadonlySet<string> = new Set<string>([
  ...KEYS.focusTeam,
  ...Object.values(KEYS.pilot),
  ...Object.values(KEYS.gunner),
  ...Object.values(KEYS.engineer),
  ...Object.values(KEYS.globals).flat(),
]);

export interface HarnessCallbacks {
  onGlobal: (action: GlobalAction) => void;
  onFocusTeam: (team: number) => void;
}

/** DOM side. Call sample(dt) once per render frame and feed the result to the sim for the focused team's slots. */
export class KeyboardHarness {
  readonly pressed = new Set<string>();
  private edge = new Set<string>();
  focusedTeam = 0;

  constructor(
    private readonly target: Window,
    private readonly callbacks: HarnessCallbacks,
    private readonly cfg: GameConfig = CONFIG,
  ) {}

  attach(): void {
    this.target.addEventListener('keydown', this.onKeyDown);
    this.target.addEventListener('keyup', this.onKeyUp);
    this.target.addEventListener('blur', this.onBlur);
  }

  detach(): void {
    this.target.removeEventListener('keydown', this.onKeyDown);
    this.target.removeEventListener('keyup', this.onKeyUp);
    this.target.removeEventListener('blur', this.onBlur);
  }

  sample(dt: number): HarnessFrame {
    const frame = harnessInputs(this.pressed, this.edge, dt, this.cfg);
    this.edge = new Set();
    return frame;
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (!HANDLED.has(e.code)) return;
    e.preventDefault();
    if (e.repeat) return; // auto-repeat: the key is still in `pressed`
    this.pressed.add(e.code);
    this.edge.add(e.code);
    const team = focusTeamFor(e.code);
    if (team !== null) {
      this.focusedTeam = team;
      this.callbacks.onFocusTeam(team);
      return;
    }
    const action = globalActionFor(e.code);
    if (action) this.callbacks.onGlobal(action);
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    if (!HANDLED.has(e.code)) return;
    e.preventDefault();
    this.pressed.delete(e.code);
  };

  private readonly onBlur = (): void => {
    this.pressed.clear(); // never leave GAS stuck when the window loses focus
  };
}

/**
 * Call from the Start button click (user activation): fullscreen makes Chrome
 * deliver F1..F6 to the page, and the Keyboard Lock API (Chrome, secure
 * context) captures them even where the OS would take them.
 */
export async function startFullscreenCapture(root: HTMLElement): Promise<void> {
  if (!document.fullscreenElement) await root.requestFullscreen();
  const kb = (navigator as Navigator & { keyboard?: { lock?: (codes?: string[]) => Promise<void> } }).keyboard;
  if (kb?.lock) await kb.lock(['F1', 'F2', 'F3', 'F4', 'F5', 'F6']);
}
