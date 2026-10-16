/**
 * Keyboard harness: every role of the focused team from the scene PC keyboard.
 * It is the dev test bench and the backup when a phone fails mid-demo (SPEC section 1).
 *
 *   1-6        focus a team            K   add a keyboard crew (lobby)
 *   A / D      steer                   O   add a bot team (lobby)
 *   W / S      gas / brake-reverse     T   team size 3 <-> 2 (lobby)
 *   Left/Right aim                     Enter  start / rematch
 *   Space      fire                    P   pause      Esc  back to the lobby
 *   R          recenter aim
 *   Q / E      power slot 1 / 2        B   bail (hold)
 *   (Q / E go to the Gunner when the crew has no Engineer.)
 *
 * Keys override a phone only while they are held; keyboard crews (virtual players)
 * get a packet every frame. Track B owns this file (docs/TASKS-B.md B13).
 */
import type { Sim } from '@shared/api.ts';
import { KEYBOARD } from '@shared/config.ts';
import type { InputMsg } from '@shared/protocol.ts';
import { gunnerHasPowers } from '../sim/ctx.ts';

export interface HarnessActions {
  start(): void;
  pause(): void;
  toLobby(): void;
  addKeyboardCrew(): void;
  addBotTeam(): void;
  toggleTeamSize(): void;
}

const PILOT_KEYS = ['KeyA', 'KeyD', 'KeyW', 'KeyS'];
const GUNNER_KEYS = ['ArrowLeft', 'ArrowRight', 'Space'];
const ENGINEER_KEYS = ['KeyB'];

export class KeyboardHarness {
  focus = 0;
  private readonly held = new Set<string>();
  private steer = 0;
  private yaw = 0;
  private ep = 0;
  private fc = 0;
  private uc = 0;
  private lastUse: 0 | 1 | null = null;
  private recenter = false;
  private seq = 0;
  private wasActive = { pilot: false, gunner: false, engineer: false };

  constructor(
    private readonly sim: Sim,
    private readonly actions: HarnessActions,
  ) {
    window.addEventListener('keydown', this.onDown);
    window.addEventListener('keyup', this.onUp);
    window.addEventListener('blur', () => this.held.clear());
  }

  private readonly onDown = (e: KeyboardEvent): void => {
    if (e.target instanceof HTMLInputElement) return;
    if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    if (e.repeat) return;
    this.held.add(e.code);
    const digit = /^Digit([1-6])$/.exec(e.code);
    if (digit) {
      this.focus = Number(digit[1]) - 1;
      return;
    }
    switch (e.code) {
      case 'Space':
        this.fc += 1;
        break;
      case 'KeyR':
        this.yaw = 0;
        this.ep += 1;
        this.recenter = true;
        break;
      case 'KeyQ':
      case 'KeyE':
        this.uc += 1;
        this.lastUse = e.code === 'KeyQ' ? 0 : 1;
        break;
      case 'Enter':
        this.actions.start();
        break;
      case 'KeyP':
        this.actions.pause();
        break;
      case 'Escape':
        this.actions.toLobby();
        break;
      case 'KeyK':
        this.actions.addKeyboardCrew();
        break;
      case 'KeyO':
        this.actions.addBotTeam();
        break;
      case 'KeyT':
        this.actions.toggleTeamSize();
        break;
    }
  };

  private readonly onUp = (e: KeyboardEvent): void => {
    this.held.delete(e.code);
  };

  private any(keys: readonly string[]): boolean {
    return keys.some((k) => this.held.has(k));
  }

  /** Call once per rendered frame, before the sim steps. */
  update(dt: number): void {
    const team = this.sim.state.teams[this.focus];
    if (!team) return;
    const [pilotId, gunnerIdRaw, engineerId] = team.members;
    const gunnerId = gunnerIdRaw ?? pilotId;
    const isVirtual = (id: string | undefined): boolean => (id ? (this.sim.state.players[id]?.virtual ?? false) : false);

    // Pilot: steering ramps to full lock in KEYBOARD.steerRampSec.
    const want = (this.held.has('KeyD') ? 1 : 0) - (this.held.has('KeyA') ? 1 : 0);
    const ramp = dt / KEYBOARD.steerRampSec;
    this.steer = want === 0 ? 0 : Math.max(-1, Math.min(1, this.steer + Math.sign(want - this.steer) * ramp));
    const pilotActive = this.any(PILOT_KEYS);
    if (pilotId && (pilotActive || this.wasActive.pilot || isVirtual(pilotId))) {
      this.send(pilotId, { t: 'in', seq: ++this.seq, role: 'pilot', steer: this.steer, gas: this.held.has('KeyW'), brake: this.held.has('KeyS') });
    }
    this.wasActive.pilot = pilotActive;

    // Gunner: left arrow turns the view left (positive yaw).
    const turn = (this.held.has('ArrowLeft') ? 1 : 0) - (this.held.has('ArrowRight') ? 1 : 0);
    const dYaw = turn * KEYBOARD.aimRate * dt;
    this.yaw += dYaw;
    const gunnerPowers = gunnerHasPowers(this.sim.state, this.focus);
    const gunnerActive = this.any(GUNNER_KEYS) || this.recenter || (gunnerPowers && (this.held.has('KeyQ') || this.held.has('KeyE')));
    if (gunnerId && gunnerId !== pilotId && (gunnerActive || this.wasActive.gunner || isVirtual(gunnerId))) {
      this.send(gunnerId, {
        t: 'in',
        seq: ++this.seq,
        role: 'gunner',
        dYaw,
        yaw: this.yaw,
        ep: this.ep,
        fire: this.held.has('Space'),
        fc: this.fc,
        recenter: this.recenter,
        // Without an Engineer aboard (teams of 2, or a 2-member team in teams of 3) Q/E go to the Gunner.
        use: gunnerPowers ? this.lastUse : null,
        uc: gunnerPowers ? this.uc : 0,
      });
    }
    this.recenter = false;
    this.wasActive.gunner = gunnerActive;

    const engineerActive = this.any(ENGINEER_KEYS) || this.held.has('KeyQ') || this.held.has('KeyE');
    if (engineerId && (engineerActive || this.wasActive.engineer || isVirtual(engineerId))) {
      this.send(engineerId, { t: 'in', seq: ++this.seq, role: 'engineer', use: this.lastUse, uc: this.uc, shake: this.held.has('KeyB') ? 1 : 0 });
    }
    this.wasActive.engineer = engineerActive;
  }

  private send(id: string, input: InputMsg): void {
    this.sim.applyInput(id, input);
  }
}
