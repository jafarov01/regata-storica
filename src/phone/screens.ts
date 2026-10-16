/**
 * What a phone draws during a match, from the latest `Hud` (10 Hz) and the local
 * sensor snapshot (every frame). Pure DOM, no network: src/phone/main.ts owns the flow.
 *
 *   role graphic   Pilot wheel, Gunner compass + weapon/ammo, Engineer water meter
 *   pad labels     power buttons show the held power, greyed when the slot is empty
 *   overlays       SUNK + countdown, results, spectator, "big screen can't hear you"
 */
import type { Evt, Hud, Role } from '@shared/protocol.ts';
import type { PowerId, WeaponId } from '@shared/config.ts';
import type { ControllerSnapshot } from './sensors.ts';

const WEAPON_LABEL: Record<WeaponId, string> = { watercannon: 'WATER CANNON', cannon: 'CANNON', torpedo: 'TORPEDO', mortar: 'MORTAR' };
const POWER_LABEL: Record<PowerId, string> = { shield: 'SHIELD', mine: 'MINE', boost: 'BOOST', smoke: 'SMOKE', wave: 'WAVE' };

export const SCREENS_HTML = `
  <div id="role-view" class="role-view" hidden>
    <div class="weapon" id="weapon"></div>
    <div class="wheel" id="wheel"><div class="wheel-spoke"></div><div class="wheel-spoke wheel-spoke-2"></div><div class="wheel-hub"></div></div>
    <div class="compass" id="compass"><div class="needle" id="needle"></div><div class="bow-mark">BOW</div></div>
    <div class="meter" id="meter"><div class="meter-fill" id="meter-fill"></div><span>WATER</span></div>
    <div class="role-tip" id="role-tip"></div>
    <div class="role-name" id="role-name"></div>
  </div>
  <div id="sunk" class="phone-overlay sunk" hidden>
    <div class="big">SUNK</div><div id="sunk-by"></div><div class="count" id="sunk-count"></div>
  </div>
  <div id="results" class="phone-overlay results" hidden>
    <div class="big" id="results-title">MATCH OVER</div><div id="results-team"></div><div class="small">Next round starts from the big screen</div>
  </div>`;

function el<T extends HTMLElement>(root: ParentNode, sel: string): T {
  const e = root.querySelector<T>(sel);
  if (!e) throw new Error(`missing ${sel}`);
  return e;
}

export class PhoneScreens {
  private readonly roleView: HTMLElement;
  private readonly weapon: HTMLElement;
  private readonly wheel: HTMLElement;
  private readonly compass: HTMLElement;
  private readonly needle: HTMLElement;
  private readonly meterFill: HTMLElement;
  private readonly tip: HTMLElement;
  private readonly roleName: HTMLElement;
  private readonly sunk: HTMLElement;
  private readonly sunkBy: HTMLElement;
  private readonly sunkCount: HTMLElement;
  private readonly results: HTMLElement;
  private readonly resultsTitle: HTMLElement;
  private readonly resultsTeam: HTMLElement;
  private winner: string | null = null;
  private recenterUntil = 0;

  constructor(
    root: ParentNode,
    private readonly padsMount: HTMLElement,
  ) {
    this.roleView = el(root, '#role-view');
    this.weapon = el(root, '#weapon');
    this.wheel = el(root, '#wheel');
    this.compass = el(root, '#compass');
    this.needle = el(root, '#needle');
    this.meterFill = el(root, '#meter-fill');
    this.tip = el(root, '#role-tip');
    this.roleName = el(root, '#role-name');
    this.sunk = el(root, '#sunk');
    this.sunkBy = el(root, '#sunk-by');
    this.sunkCount = el(root, '#sunk-count');
    this.results = el(root, '#results');
    this.resultsTitle = el(root, '#results-title');
    this.resultsTeam = el(root, '#results-team');
    // RECENTER feedback: the pads consume the tap, we only flash a word.
    padsMount.addEventListener('pointerdown', (e) => {
      if (e.target instanceof Element && e.target.closest('[data-zone="recenter"]')) this.recenterUntil = performance.now() + 500;
    });
  }

  /** Show or hide the match screens. */
  setPlaying(playing: boolean, role: Role): void {
    this.roleView.hidden = !playing;
    this.roleView.dataset['role'] = role;
    this.roleName.textContent = role.toUpperCase();
    if (!playing) {
      this.sunk.hidden = true;
      this.results.hidden = true;
    }
  }

  onEvt(e: Evt): void {
    if (e.kind === 'win' && e.detail) this.winner = e.detail;
    if (e.kind === 'start' || e.kind === 'countdown') this.winner = null;
  }

  /** 10 Hz: everything that comes from the scene. */
  onHud(h: Hud, playing: boolean): void {
    this.sunk.hidden = !playing || h.alive || h.phase === 'results';
    if (!this.sunk.hidden) {
      this.sunkBy.textContent = h.sunkBy ? `by ${h.sunkBy}` : '';
      this.sunkCount.textContent = h.respawnIn > 0 ? `back in ${Math.ceil(h.respawnIn)}` : '';
    }
    this.results.hidden = !playing || h.phase !== 'results';
    if (!this.results.hidden) {
      this.resultsTitle.textContent = this.winner ? (this.winner === h.teamName ? 'YOU WIN!' : `${this.winner.toUpperCase()} WINS`) : 'MATCH OVER';
      this.resultsTeam.textContent = `${h.teamName}: ${h.kills} kills · ${h.deaths} deaths`;
    }

    if (h.role === 'gunner') {
      const ammo = Number.isFinite(h.ammo) ? ` · ${h.ammo}` : '';
      this.weapon.textContent = `${WEAPON_LABEL[h.weapon] ?? h.weapon.toUpperCase()}${ammo}`;
    } else this.weapon.textContent = '';
    this.compass.classList.toggle('on-target', h.onTarget);
    this.compass.classList.toggle('locked', h.locked);
    this.meterFill.style.height = `${Math.round(h.water)}%`;

    // Power buttons (Engineer, or Gunner in teams of 2) show what is held.
    for (const slot of [0, 1] as const) {
      const zone = this.padsMount.querySelector<HTMLElement>(`[data-zone="power${slot}"]`);
      if (!zone) continue;
      const power = h.powers[slot];
      const label = power ? POWER_LABEL[power] : 'EMPTY';
      if (zone.textContent !== label) zone.textContent = label;
      zone.classList.toggle('empty', !power);
    }
  }

  /** Every frame: the parts that follow the phone's own sensors. */
  frame(role: Role, snap: ControllerSnapshot, hud: Hud | null): void {
    if (this.roleView.hidden) return;
    let tip = '';
    if (role === 'pilot') {
      this.wheel.style.transform = `rotate(${(snap.steer * 90).toFixed(1)}deg)`;
      tip = !snap.steerCalibrated ? 'Tap CALIBRATE to steer' : snap.steerWeak ? 'Hold the phone more upright' : '';
    } else if (role === 'gunner') {
      // The scene's aim relative to the bow; before the first Hud, the phone's own yaw.
      const rel = hud ? hud.aimRel : snap.yawSinceRecenterRad;
      this.needle.style.transform = `rotate(${((-rel * 180) / Math.PI).toFixed(1)}deg)`;
      tip = hud?.locked ? 'TORPEDO LOCKED' : hud?.onTarget ? 'ON TARGET' : '';
    } else {
      tip = hud?.bail ? 'SHAKE TO BAIL' : '';
    }
    if (role === 'gunner' && performance.now() < this.recenterUntil) tip = 'RECENTERED';
    if (this.tip.textContent !== tip) this.tip.textContent = tip;
  }
}
