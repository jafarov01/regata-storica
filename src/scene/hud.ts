/**
 * Big-screen HUD as DOM overlays on top of the WebGL canvas (SPEC section 10).
 *
 * Track B owns it (docs/TASKS-B.md B7/B8):
 *   - lobby: join QR, roster with kick buttons, host buttons (Start, team size, add bot / keyboard crew)
 *   - top centre: round timer, live scoreboard, kill feed under it
 *   - per viewport: team and crew (top left), kills/deaths (top right), crosshair
 *     states (centre), weapon and ammo (bottom left), powers and the hull water bar
 *     (bottom right), bow-vs-aim arrow and protection / shield timers (bottom
 *     centre), blue flash when a Shield absorbs a hit, SUNK overlay with the
 *     kill-cam countdown, ELIMINATED in sudden death
 *   - minimap (Canvas 2D) where the layout puts it: walls, crates, and boats only
 *     while revealed (lagoon, fired in the last few seconds, sudden death)
 *   - countdown, results with top Gunner and best ram, Rematch / New lobby buttons
 * Updated at about 10 Hz; text is only written when it changed. Weapon and power
 * names carry data-* attributes so icons from public/assets/ui/ can replace them in CSS.
 */
import type { CameraView, Layout } from '@shared/api.ts';
import { MINIMAP, POWERS, WEAPONS } from '@shared/config.ts';
import type { ParsedMap } from '@shared/map.ts';
import { wrapAngle } from '@shared/math.ts';
import type { BoatState, GameState, KillCause, Role } from '@shared/state.ts';

const ROLE_ICON: Record<Role, string> = { pilot: 'Pilot', gunner: 'Gunner', engineer: 'Engineer' };
const CAUSE_LABEL: Record<KillCause, string> = {
  watercannon: 'the Water Cannon',
  cannon: 'a Cannon',
  torpedo: 'a Torpedo',
  mortar: 'the Fireworks Mortar',
  mine: 'a Mine',
  ram: 'a ram',
};
/** Kill feed entries stay this long (sim seconds). */
const FEED_SEC = 8;

export type HostAction = 'start' | 'teamSize' | 'addBot' | 'addKeyboard' | 'rematch' | 'newLobby' | 'kick';

export interface HudInfo {
  code: string | null;
  joinUrl: string | null;
  urlLooksLocal: boolean;
  link: string;
  canStart: { ok: boolean; reason?: string };
  stale: ReadonlySet<string>;
  focus: number;
  /** One per team: whose boat each viewport follows (kill-cam). */
  views: readonly CameraView[];
  /** Per team: performance.now() until which the Shield flash shows. */
  shieldFlashUntil: ReadonlyMap<number, number>;
}

function clock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function killFeedText(state: GameState, killer: number, victim: number, cause: KillCause): string {
  const k = state.teams[killer];
  const v = state.teams[victim];
  const ks = `<b style="color:${k?.colour ?? '#fff'}">${esc(k?.name ?? '?')}</b>`;
  const vs = `<b style="color:${v?.colour ?? '#fff'}">${esc(v?.name ?? '?')}</b>`;
  return cause === 'ram' ? `${ks} rammed ${vs}` : `${ks} sank ${vs} with ${CAUSE_LABEL[cause]}`;
}

/** Shared minimap rule: lagoon boats, boats that fired lately, and sudden-death crews are visible. */
export function isRevealed(state: GameState, map: ParsedMap, boat: BoatState): boolean {
  if (boat.status !== 'alive') return false;
  if (state.phase === 'suddendeath' && state.suddenDeathTeams.includes(boat.team)) return true;
  if (boat.lastFireAt > 0 && state.time - boat.lastFireAt <= MINIMAP.revealAfterFireSec) return true;
  return map.isLagoonAt(boat.pose.x, boat.pose.z);
}

export class SceneHud {
  readonly qrCanvas: HTMLCanvasElement;
  private readonly lobby: HTMLElement;
  private readonly roster: HTMLElement;
  private readonly codeEl: HTMLElement;
  private readonly urlEl: HTMLElement;
  private readonly startEl: HTMLElement;
  private readonly buttonsEl: HTMLElement;
  private readonly topBar: HTMLElement;
  private readonly feed: HTMLElement;
  private readonly cells: HTMLElement;
  private readonly centre: HTMLElement;
  private readonly minimap: HTMLCanvasElement;
  private readonly cache = new WeakMap<HTMLElement, string>();
  private wallsLayer: HTMLCanvasElement | null = null;
  /** Where the minimap is actually drawn (CSS px), so corner boxes can step aside. */
  private mmRect = { x: 0, y: 0, w: 0, h: 0 };

  constructor(
    private readonly root: HTMLElement,
    private readonly map: ParsedMap,
    onAction: (action: HostAction, pid?: string) => void,
  ) {
    root.innerHTML = `
      <section class="lobby-panel">
        <div class="join">
          <canvas class="qr"></canvas>
          <div class="code"></div>
          <div class="url"></div>
        </div>
        <div class="lobby-side">
          <h1>Gondola Royale</h1>
          <div class="roster"></div>
          <p class="start"></p>
          <div class="host-buttons"></div>
          <p class="keys">Enter start · K keyboard crew · O bot team · T team size · 1-6 focus · WASD drive · arrows aim · Space fire · R recenter · Q/E powers · B bail · P pause · Esc lobby</p>
        </div>
      </section>
      <div class="top-bar"></div>
      <div class="kill-feed"></div>
      <div class="cells"></div>
      <canvas class="minimap"></canvas>
      <div class="centre"></div>`;
    const q = <T extends HTMLElement>(sel: string): T => {
      const el = root.querySelector<T>(sel);
      if (!el) throw new Error(`missing ${sel}`);
      return el;
    };
    this.qrCanvas = q<HTMLCanvasElement>('.qr');
    this.lobby = q('.lobby-panel');
    this.roster = q('.roster');
    this.codeEl = q('.code');
    this.urlEl = q('.url');
    this.startEl = q('.start');
    this.buttonsEl = q('.host-buttons');
    this.topBar = q('.top-bar');
    this.feed = q('.kill-feed');
    this.cells = q('.cells');
    this.centre = q('.centre');
    this.minimap = q<HTMLCanvasElement>('.minimap');
    root.addEventListener('click', (e) => {
      const button = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-action]');
      if (!button) return;
      e.preventDefault();
      onAction(button.dataset['action'] as HostAction, button.dataset['pid']);
      button.blur(); // keep Enter / Space for the keyboard harness
    });
  }

  private set(el: HTMLElement, html: string): void {
    if (this.cache.get(el) === html) return;
    this.cache.set(el, html);
    el.innerHTML = html;
  }

  update(state: GameState, layout: Layout, info: HudInfo): void {
    const inLobby = state.phase === 'lobby';
    this.lobby.hidden = !inLobby;
    this.topBar.hidden = inLobby;
    this.feed.hidden = inLobby;
    this.minimap.hidden = inLobby || state.phase === 'results';
    this.root.dataset['phase'] = state.phase;

    if (inLobby) this.updateLobby(state, info);
    else {
      const timeLeft = state.phaseEndsAt > 0 ? state.phaseEndsAt - state.time : 0;
      const fighting = state.phase === 'battle' || state.phase === 'suddendeath';
      const scores = state.teams
        .map((t) => `<span class="score${state.phase === 'suddendeath' && !state.suddenDeathTeams.includes(t.index) ? ' out' : ''}" style="--team:${t.colour}">${esc(t.name)} ${t.kills}</span>`)
        .join('');
      const label = state.phase === 'suddendeath' ? '<span class="sd">SUDDEN DEATH</span>' : '';
      const late = fighting && timeLeft <= 60 ? ' late' : '';
      this.set(this.topBar, `${label}<span class="timer${late}">${fighting ? clock(timeLeft) : ''}</span>${scores}${state.paused ? '<span class="paused">PAUSED</span>' : ''}`);
      const feed = state.killFeed
        .filter((k) => state.time - k.at <= FEED_SEC)
        .map((k) => `<div>${killFeedText(state, k.killerTeam, k.victimTeam, k.cause)}</div>`)
        .join('');
      this.set(this.feed, feed);
      if (state.phase !== 'results') this.drawMinimap(state, layout);
    }

    this.set(this.cells, inLobby ? '' : layout.cells.map((c, i) => this.cellHtml(state, i, c, info)).join(''));
    this.set(this.centre, this.centreHtml(state));
  }

  private updateLobby(state: GameState, info: HudInfo): void {
    this.set(this.codeEl, esc(info.code ?? '....'));
    this.set(
      this.urlEl,
      info.joinUrl
        ? `${esc(info.joinUrl)}${info.urlLooksLocal ? '<br><b>Phones cannot open this address: run <code>npm run tunnel</code> and open the scene on the tunnel URL.</b>' : ''}`
        : esc(info.link),
    );
    const teams = state.teams
      .map((t) => {
        const crew = t.members
          .map((id) => {
            const p = state.players[id];
            if (!p) return '';
            const flags = [p.ready ? 'ready' : '', p.calibrated ? 'calibrated' : '', !p.connected ? 'offline' : '', p.virtual ? 'keys/bot' : ''].filter(Boolean).join(', ');
            return `<li><b>${ROLE_ICON[p.role]}</b> ${esc(p.name)}${flags ? ` <small>(${flags})</small>` : ''} <button class="kick" data-action="kick" data-pid="${esc(p.id)}" title="Remove ${esc(p.name)}">✕</button></li>`;
          })
          .join('');
        return `<div class="team" style="--team:${t.colour}"><h3>${esc(t.name)}</h3><ul>${crew}</ul></div>`;
      })
      .join('');
    const spectators = state.spectators.length ? `<p class="muted">Waiting: ${state.spectators.map((id) => esc(state.players[id]?.name ?? id)).join(', ')}</p>` : '';
    this.set(this.roster, `<p class="muted">Teams of ${state.teamSize}</p>${teams || '<p class="muted">Scan the QR to join.</p>'}${spectators}`);
    this.set(this.startEl, info.canStart.ok ? 'Press <b>Enter</b> or <b>Start</b>' : esc(info.canStart.reason ?? ''));
    const full = state.teams.length >= 6;
    this.set(
      this.buttonsEl,
      `<button data-action="start" class="primary"${info.canStart.ok ? '' : ' disabled'}>Start</button>` +
        `<button data-action="teamSize">Teams of ${state.teamSize === 3 ? '2' : '3'}</button>` +
        `<button data-action="addBot"${full ? ' disabled' : ''}>Add bot team</button>` +
        `<button data-action="addKeyboard"${full ? ' disabled' : ''}>Add keyboard crew</button>`,
    );
  }

  private cellHtml(state: GameState, i: number, c: Layout['cells'][number], info: HudInfo): string {
    const t = state.teams[i];
    const boat = state.boats[i];
    if (!t || !boat) return '';
    const now = state.time;
    const crew = t.members.map((id) => esc(state.players[id]?.name ?? '?') + (info.stale.has(id) ? ' ⚠' : '')).join(' · ');
    const focus = info.focus === i ? ' focus' : '';
    const view = info.views[i];
    const weapon = WEAPONS[boat.weapon];
    const ammo = Number.isFinite(boat.ammo) ? String(boat.ammo) : '∞';
    const powers = boat.powers.map((p) => (p ? `<span class="power" data-power="${p}">${esc(POWERS[p].label)}</span>` : '<span class="power empty">empty</span>')).join('');
    const water = Math.round(boat.water);
    // Bow against the view: the camera looks along the aim, so the arrow turns by (bow - aim); positive = bow to the left.
    const bowDeg = (wrapAngle(boat.pose.yaw - boat.aimYaw) * 180) / Math.PI;
    const timers: string[] = [];
    if (boat.status === 'alive' && boat.protectedUntil > now) timers.push(`<span class="protect">PROTECTED ${(boat.protectedUntil - now).toFixed(1)}</span>`);
    if (boat.status === 'alive' && boat.shieldUntil > now) timers.push(`<span class="shield">SHIELD ${Math.ceil(boat.shieldUntil - now)}</span>`);
    if (boat.status === 'alive' && boat.boostUntil > now) timers.push(`<span class="boost">BOOST</span>`);
    const flash = (info.shieldFlashUntil.get(i) ?? 0) > performance.now() ? '<div class="flash shield-flash"></div>' : '';
    let overlay = '';
    if (state.phase === 'results') overlay = '';
    else if (boat.status === 'sinking' || boat.status === 'respawning') {
      const killer = boat.killerTeam !== null ? state.teams[boat.killerTeam] : undefined;
      const by = killer ? ` by <b style="color:${killer.colour}">${esc(killer.name)}</b>` : '';
      overlay = `<div class="sunk"><div class="sunk-title">SUNK${by}</div><div class="sunk-count">${Math.max(0, Math.ceil(boat.respawnAt - now))}</div>${view?.killCam ? '<div class="muted">kill-cam</div>' : ''}</div>`;
    } else if (boat.status === 'out') {
      overlay = '<div class="sunk"><div class="sunk-title">ELIMINATED</div><div class="muted">watch the sudden death</div></div>';
    }
    const fighting = boat.status === 'alive' && state.phase !== 'results';
    // Corner boxes that would sit under the minimap move above it (bottom row) or below it (top row).
    const mm = this.mmRect;
    const side = (top: boolean, left: boolean): string => {
      if (mm.w === 0) return '';
      const overlapsX = left ? mm.x <= c.x + 260 && mm.x + mm.w > c.x : mm.x + mm.w >= c.x + c.w - 260 && mm.x < c.x + c.w;
      if (!overlapsX) return '';
      if (top && mm.y < c.y + 110 && mm.y + mm.h > c.y + 40) return ` style="top:${Math.round(mm.y + mm.h - c.y + 8)}px"`;
      if (!top && mm.y < c.y + c.h && mm.y + mm.h > c.y + c.h - 70) return ` style="bottom:${Math.round(c.y + c.h - mm.y + 8)}px"`;
      return '';
    };
    return `<div class="cell${focus}" style="left:${c.x}px;top:${c.y}px;width:${c.w}px;height:${c.h}px;--team:${t.colour}">
      <div class="tl"${side(true, true)}><b>${esc(t.name)}</b> ${crew}</div>
      <div class="tr"${side(true, false)}>K ${t.kills} · D ${t.deaths}</div>
      ${fighting ? `<div class="crosshair ${boat.crosshair}"></div>` : ''}
      ${fighting ? `<div class="bl"${side(false, true)}><span class="weapon" data-weapon="${boat.weapon}">${esc(weapon.label)}</span> <b class="ammo">${ammo}</b></div>` : ''}
      ${fighting ? `<div class="br"${side(false, false)}>${powers}<div class="water" title="Hull water"><i style="width:${water}%"></i></div></div>` : ''}
      ${fighting ? `<div class="bc"><div class="bow" style="transform:rotate(${(-bowDeg).toFixed(1)}deg)">▲</div>${timers.join('')}</div>` : ''}
      ${flash}${overlay}
    </div>`;
  }

  private centreHtml(state: GameState): string {
    if (state.phase === 'countdown') return `<div class="big">${Math.ceil(state.phaseEndsAt - state.time)}</div><div>Pilots and Gunners: CALIBRATE now</div>`;
    if (state.phase !== 'results' || !state.results) return '';
    const r = state.results;
    const rows = r.ranking
      .map((ti, rank) => {
        const t = state.teams[ti];
        return t ? `<li style="--team:${t.colour}">${esc(t.name)}: ${t.kills} kills, ${t.deaths} deaths${rank === 0 ? ' 🏆' : ''}</li>` : '';
      })
      .join('');
    const extras: string[] = [];
    if (r.topGunner) {
      const p = state.players[r.topGunner];
      if (p) extras.push(`Top Gunner: <b>${esc(p.name)}</b> (${p.kills - p.ramKills} kills)`);
    }
    if (r.bestRam) {
      const p = state.players[r.bestRam];
      if (p) extras.push(`Best ram: <b>${esc(p.name)}</b>`);
    }
    if (r.suddenDeath) extras.push('Decided in sudden death');
    return `<div class="results"><h2>${esc(state.teams[r.winner]?.name ?? '')} wins</h2><ol>${rows}</ol>${extras.length ? `<p>${extras.join(' · ')}</p>` : ''}
      <div class="host-buttons"><button data-action="rematch" class="primary">Rematch</button><button data-action="newLobby">New lobby</button></div>
      <p class="muted">Enter: rematch · Esc: new lobby</p></div>`;
  }

  // ---------------------------------------------------------------- minimap

  private drawMinimap(state: GameState, layout: Layout): void {
    const r = layout.minimap;
    const m = this.map;
    // Fit the map's aspect inside the layout square.
    const scale = Math.min(r.w / m.worldW, r.h / m.worldD);
    const w = Math.max(1, Math.round(m.worldW * scale));
    const h = Math.max(1, Math.round(m.worldD * scale));
    const cv = this.minimap;
    this.mmRect = { x: r.x + (r.w - w) / 2, y: r.y + (r.h - h) / 2, w, h };
    cv.style.left = `${this.mmRect.x}px`;
    cv.style.top = `${this.mmRect.y}px`;
    cv.style.width = `${w}px`;
    cv.style.height = `${h}px`;
    if (cv.width !== w || cv.height !== h) {
      cv.width = w;
      cv.height = h;
      this.wallsLayer = null;
    }
    const g = cv.getContext('2d');
    if (!g) return;
    const px = (x: number): number => ((x + m.worldW / 2) / m.worldW) * w;
    const pz = (z: number): number => ((z + m.worldD / 2) / m.worldD) * h;
    if (!this.wallsLayer) {
      const layer = document.createElement('canvas');
      layer.width = w;
      layer.height = h;
      const lg = layer.getContext('2d');
      if (lg) {
        lg.fillStyle = '#163846';
        lg.fillRect(0, 0, w, h);
        lg.fillStyle = '#c9b48f';
        for (const wall of m.walls) lg.fillRect(px(wall.x - wall.w / 2), pz(wall.z - wall.d / 2), (wall.w / m.worldW) * w + 0.5, (wall.d / m.worldD) * h + 0.5);
      }
      this.wallsLayer = layer;
    }
    g.drawImage(this.wallsLayer, 0, 0);
    const dot = Math.max(2, w / 110);
    for (const c of state.crates) {
      if (!c.active) continue;
      g.fillStyle = c.category === 'weapon' ? '#ff4a3a' : '#3a8fff';
      g.fillRect(px(c.x) - dot / 2, pz(c.z) - dot / 2, dot, dot);
    }
    for (const b of state.boats) {
      if (!isRevealed(state, m, b)) continue;
      const colour = state.teams[b.team]?.colour ?? '#fff';
      g.save();
      g.translate(px(b.pose.x), pz(b.pose.z));
      // Screen y is +z; a yaw of 0 points up (-z). Canvas rotation is clockwise, yaw is counter-clockwise.
      g.rotate(-b.pose.yaw);
      g.fillStyle = colour;
      g.strokeStyle = '#000';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(0, -dot * 2.2);
      g.lineTo(dot * 1.3, dot * 1.6);
      g.lineTo(-dot * 1.3, dot * 1.6);
      g.closePath();
      g.fill();
      g.stroke();
      g.restore();
    }
  }
}
