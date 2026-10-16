/**
 * What a phone draws during a match, from the latest `Hud` (10 Hz) and the local
 * sensor snapshot (every frame). Pure DOM, no network: src/phone/main.ts owns the flow.
 *
 *   role graphic   Pilot wheel, Gunner compass + weapon/ammo, Engineer water meter
 *   pad labels     power buttons show the held power, greyed when the slot is empty
 *   overlays       SUNK + countdown, results with the time to the next lobby
 *   cues           short words over the role graphic for one-shot events (shot landed, kill)
 */
import type { Evt, Hud, Role } from '@shared/protocol.ts';
import type { PowerId, WeaponId } from '@shared/config.ts';
import type { ControllerSnapshot } from './sensors.ts';
import { clock } from './view.ts';
import { dropIcon, powerIcon, weaponIcon } from '../ui/icons.ts';

const WEAPON_LABEL: Record<WeaponId, string> = { watercannon: 'WATER CANNON', cannon: 'CANNON', torpedo: 'TORPEDO', mortar: 'MORTAR' };
const POWER_LABEL: Record<PowerId, string> = { shield: 'SHIELD', mine: 'MINE', boost: 'BOOST', smoke: 'SMOKE', wave: 'WAVE' };
const ROLE_LABEL: Record<Role, string> = { pilot: 'Pilot', gunner: 'Gunner', engineer: 'Engineer' };
/** How long a one-shot cue stays over the role graphic. */
const CUE_MS = 1200;

export const SCREENS_HTML = `
  <div id="role-view" class="role-view" hidden>
    <div class="weapon" id="weapon"></div>
    <svg class="wheel" id="wheel" viewBox="-110 -110 220 220" aria-hidden="true">
      <g fill="currentColor"><rect x="-3" y="-96" width="6" height="40" rx="3" transform="rotate(0)"/><circle cy="-96" r="9" transform="rotate(0)"/><rect x="-3" y="-96" width="6" height="40" rx="3" transform="rotate(45)"/><circle cy="-96" r="9" transform="rotate(45)"/><rect x="-3" y="-96" width="6" height="40" rx="3" transform="rotate(90)"/><circle cy="-96" r="9" transform="rotate(90)"/><rect x="-3" y="-96" width="6" height="40" rx="3" transform="rotate(135)"/><circle cy="-96" r="9" transform="rotate(135)"/><rect x="-3" y="-96" width="6" height="40" rx="3" transform="rotate(180)"/><circle cy="-96" r="9" transform="rotate(180)"/><rect x="-3" y="-96" width="6" height="40" rx="3" transform="rotate(225)"/><circle cy="-96" r="9" transform="rotate(225)"/><rect x="-3" y="-96" width="6" height="40" rx="3" transform="rotate(270)"/><circle cy="-96" r="9" transform="rotate(270)"/><rect x="-3" y="-96" width="6" height="40" rx="3" transform="rotate(315)"/><circle cy="-96" r="9" transform="rotate(315)"/></g>
      <circle r="62" fill="none" stroke="currentColor" stroke-width="13"/>
      <circle r="22" fill="currentColor"/><circle r="9" class="wheel-hub"/>
      <rect x="-5" y="-78" width="10" height="20" rx="3" class="wheel-top"/>
    </svg>
    <div class="compass" id="compass">
      <svg viewBox="-100 -100 200 200" aria-hidden="true">
        <circle r="84" class="compass-face"/>
        <g class="compass-ticks"><rect x="-1.5" y="-92" width="3" height="14" transform="rotate(0)"/><rect x="-1.5" y="-92" width="3" height="8" transform="rotate(30)"/><rect x="-1.5" y="-92" width="3" height="8" transform="rotate(60)"/><rect x="-1.5" y="-92" width="3" height="14" transform="rotate(90)"/><rect x="-1.5" y="-92" width="3" height="8" transform="rotate(120)"/><rect x="-1.5" y="-92" width="3" height="8" transform="rotate(150)"/><rect x="-1.5" y="-92" width="3" height="14" transform="rotate(180)"/><rect x="-1.5" y="-92" width="3" height="8" transform="rotate(210)"/><rect x="-1.5" y="-92" width="3" height="8" transform="rotate(240)"/><rect x="-1.5" y="-92" width="3" height="14" transform="rotate(270)"/><rect x="-1.5" y="-92" width="3" height="8" transform="rotate(300)"/><rect x="-1.5" y="-92" width="3" height="8" transform="rotate(330)"/></g>
        <path class="compass-bow" d="M0 -99 11 -80H-11z"/>
      </svg>
      <div class="needle" id="needle"></div>
      <span class="bow-mark">Bow</span>
    </div>
    <div class="meter" id="meter"><div class="meter-fill" id="meter-fill"></div><span>${dropIcon()} Hull water</span></div>
    <div class="role-tip" id="role-tip"></div>
    <div class="role-name" id="role-name"></div>
  </div>
  <div id="sunk" class="phone-overlay sunk" hidden>
    <div class="big">Sunk</div><div id="sunk-by" class="sunk-by"></div><div class="count" id="sunk-count"></div>
  </div>
  <div id="results" class="phone-overlay results" hidden>
    <div class="result-pennant"><div class="big" id="results-title">Match over</div><div id="results-team" class="results-team"></div></div><div class="small" id="results-next">Next round starts from the big screen</div>
  </div>`;

/** A weapon or power id from an Evt detail as the pads write it; anything else in capitals. */
export function itemLabel(detail: string): string {
  if (detail in WEAPON_LABEL) return WEAPON_LABEL[detail as WeaponId];
  if (detail in POWER_LABEL) return POWER_LABEL[detail as PowerId];
  return detail.toUpperCase();
}

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
  private readonly resultsNext: HTMLElement;
  private winner: string | null = null;
  private weaponHtml = '';
  private recenterUntil = 0;
  private cueText = '';
  private cueUntil = 0;

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
    this.resultsNext = el(root, '#results-next');
    // RECENTER feedback: the pads consume the tap, we only flash a word.
    padsMount.addEventListener('pointerdown', (e) => {
      if (e.target instanceof Element && e.target.closest('[data-zone="recenter"]')) this.recenterUntil = performance.now() + 500;
    });
  }

  /** Show or hide the match screens. */
  setPlaying(playing: boolean, role: Role): void {
    this.roleView.hidden = !playing;
    this.roleView.dataset['role'] = role;
    this.roleName.textContent = ROLE_LABEL[role];
    if (!playing) {
      this.sunk.hidden = true;
      this.results.hidden = true;
    }
  }

  onEvt(e: Evt): void {
    if (e.kind === 'win' && e.detail) this.winner = e.detail;
    if (e.kind === 'start' || e.kind === 'countdown') this.winner = null;
    // Short words for the cues the scene sends (src/scene/phoneFeed.ts decides who gets which).
    if (e.kind === 'kill') this.cue(e.detail ? `SUNK ${e.detail.toUpperCase()}!` : 'SUNK THEM!');
    if (e.kind === 'pickup') this.cue(e.detail ? `+ ${itemLabel(e.detail)}` : 'PICKED UP');
    if (e.kind === 'power') this.cue(e.detail ? `${itemLabel(e.detail)}!` : 'POWER USED');
    if (e.kind === 'shielded') this.cue('SHIELD HELD');
    if (e.kind === 'rammed') this.cue('RAMMED!');
    if (e.kind === 'respawn') this.cue('BACK IN!');
    // Our own shot landed: phoneFeed sends the shooter's Gunner 'hit' with a 'landed' detail
    // (SPEC section 3: "a flash when a shot lands").
    if (e.kind === 'hit' && e.detail === 'landed') {
      this.cue('HIT!');
      this.compass.classList.remove('landed');
      void this.compass.offsetWidth; // restart the ring animation
      this.compass.classList.add('landed');
    }
  }

  /** A word over the role graphic for a moment. */
  cue(text: string): void {
    this.cueText = text;
    this.cueUntil = performance.now() + CUE_MS;
  }

  /** 10 Hz: everything that comes from the scene. */
  onHud(h: Hud, playing: boolean): void {
    this.sunk.hidden = !playing || h.alive || h.phase === 'results';
    if (!this.sunk.hidden) {
      this.sunkBy.textContent = h.sunkBy ? `by ${h.sunkBy}` : '';
      // Sudden death: a sunk team that is not tied stays out ('out' boats never respawn).
      const count = h.respawnIn > 0 ? `<b>${Math.ceil(h.respawnIn)}</b><span>back in</span>` : h.phase === 'suddendeath' ? '<span>Out until the end</span>' : '';
      if (this.sunkCount.innerHTML !== count) this.sunkCount.innerHTML = count;
      this.sunkCount.classList.toggle('ring', h.respawnIn > 0);
    }
    this.results.hidden = !playing || h.phase !== 'results';
    if (!this.results.hidden) {
      const won = this.winner !== null && this.winner === h.teamName;
      this.resultsTitle.textContent = this.winner ? (won ? 'You win!' : `${this.winner} wins`) : 'Match over';
      this.results.classList.toggle('won', won);
      this.resultsTeam.textContent = `${h.teamName}: ${h.kills} sunk, ${h.deaths} lost`;
      this.resultsNext.textContent = h.timeLeft > 0 ? `Back to the lobby in ${clock(h.timeLeft)}, same teams` : 'Next round starts from the big screen';
    }

    let weapon = '';
    if (h.role === 'gunner') {
      const ammo = !Number.isFinite(h.ammo) ? '<span class="ammo">&infin;</span>' : h.ammo > 10 ? `<span class="ammo">${h.ammo}</span>` : `<span class="pips">${'<i></i>'.repeat(Math.max(0, h.ammo))}</span>`;
      const icon = h.weapon in WEAPON_LABEL ? weaponIcon(h.weapon) : '';
      weapon = `${icon}<span><b>${WEAPON_LABEL[h.weapon] ?? h.weapon.toUpperCase()}</b>${ammo}</span>`;
    }
    if (this.weaponHtml !== weapon) {
      this.weaponHtml = weapon;
      this.weapon.innerHTML = weapon;
    }
    this.compass.classList.toggle('on-target', h.onTarget);
    this.compass.classList.toggle('locked', h.locked);
    this.meterFill.style.height = `${Math.round(h.water)}%`;

    // Power buttons (Engineer, or Gunner in teams of 2) show what is held.
    for (const slot of [0, 1] as const) {
      const zone = this.padsMount.querySelector<HTMLElement>(`[data-zone="power${slot}"]`);
      if (!zone) continue;
      const power = h.powers[slot];
      const key = power ?? 'empty';
      if (zone.dataset['power'] === key) continue;
      zone.dataset['power'] = key;
      zone.innerHTML = power ? `${powerIcon(power, 'icon zone-icon')}<span class="zone-label">${POWER_LABEL[power]}</span>` : `<span class="zone-label">Empty</span><small>Blue crates fill it</small>`;
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
    const now = performance.now();
    if (role === 'gunner' && now < this.recenterUntil) tip = 'RECENTERED';
    if (now < this.cueUntil) tip = this.cueText;
    if (this.tip.textContent !== tip) this.tip.textContent = tip;
  }
}
