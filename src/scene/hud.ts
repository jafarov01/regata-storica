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
import { MATCH, MINIMAP, POWERS, WEAPONS } from '@shared/config.ts';
import type { ParsedMap } from '@shared/map.ts';
import { wrapAngle } from '@shared/math.ts';
import type { BoatState, GameState, KillCause, Role } from '@shared/state.ts';
import { dropIcon, ferroMark, powerIcon, roleIcon, weaponIcon } from '../ui/icons.ts';

const ROLE_LABEL: Record<Role, string> = { pilot: 'Pilot', gunner: 'Gunner', engineer: 'Engineer' };
const ROLES_IN_ORDER: readonly Role[] = ['pilot', 'gunner', 'engineer'];
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

/** The icon for what sank a boat: the weapon, the Mine, or the Boost for a ram. */
function causeIcon(cause: KillCause): string {
  if (cause === 'mine') return powerIcon('mine');
  if (cause === 'ram') return powerIcon('boost');
  return weaponIcon(cause);
}

/** One kill feed row: killer, what sank it, victim; the sentence is there for screen readers. */
export function killFeedText(state: GameState, killer: number, victim: number, cause: KillCause): string {
  const k = state.teams[killer];
  const v = state.teams[victim];
  const ks = `<b style="--team:${k?.colour ?? '#fff'}">${esc(k?.name ?? '?')}</b>`;
  const vs = `<b style="--team:${v?.colour ?? '#fff'}">${esc(v?.name ?? '?')}</b>`;
  const sentence = cause === 'ram' ? `${k?.name ?? '?'} rammed ${v?.name ?? '?'}` : `${k?.name ?? '?'} sank ${v?.name ?? '?'} with ${CAUSE_LABEL[cause]}`;
  return `${ks}<span class="cause" title="${esc(CAUSE_LABEL[cause])}">${causeIcon(cause)}</span>${vs}<span class="sr-only">${esc(sentence)}</span>`;
}

/** Ammo as pips while they fit, as a number past that; the Water Cannon never runs out. */
function ammoHtml(ammo: number): string {
  if (!Number.isFinite(ammo)) return '<span class="ammo-inf" title="Unlimited">&infin;</span>';
  if (ammo > 10) return `<span class="ammo-num">${ammo}</span>`;
  return `<span class="pips" title="${ammo} shots">${'<i></i>'.repeat(Math.max(0, ammo))}</span>`;
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
  private readonly minimapFrame: HTMLElement;
  /** Players already shown in the lobby: only newcomers get the join animation. */
  private readonly seen = new Set<string>();
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
        <header class="lobby-head">
          ${ferroMark()}
          <h1 class="display">Gondola Royale</h1>
        </header>
        <div class="join">
          <p class="join-step">Scan with your phone camera to join</p>
          <div class="qr-plate"><canvas class="qr"></canvas></div>
          <div class="code-sign sign"><span>Room code</span><b class="code"></b></div>
          <div class="url"></div>
        </div>
        <div class="lobby-side">
          <div class="roster"></div>
          <div class="lobby-foot">
            <p class="start"></p>
            <div class="host-buttons"></div>
            <p class="keys"><kbd>Enter</kbd> start <kbd>K</kbd> keyboard crew <kbd>O</kbd> bot crew <kbd>T</kbd> team size <kbd>1</kbd>-<kbd>6</kbd> focus a crew <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> drive <kbd>&larr;</kbd><kbd>&rarr;</kbd> aim <kbd>Space</kbd> fire <kbd>R</kbd> recenter <kbd>Q</kbd><kbd>E</kbd> powers <kbd>B</kbd> bail <kbd>P</kbd> pause <kbd>Esc</kbd> lobby</p>
          </div>
        </div>
      </section>
      <div class="top-bar"></div>
      <div class="kill-feed"></div>
      <div class="cells"></div>
      <div class="minimap-frame"><canvas class="minimap"></canvas></div>
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
    this.minimapFrame = q('.minimap-frame');
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
    this.feed.hidden = inLobby || state.phase === 'results';
    this.minimapFrame.hidden = inLobby || state.phase === 'results';
    this.root.dataset['phase'] = state.phase;

    if (inLobby) this.updateLobby(state, info);
    else {
      const timeLeft = state.phaseEndsAt > 0 ? state.phaseEndsAt - state.time : 0;
      const fighting = state.phase === 'battle' || state.phase === 'suddendeath';
      // Scores in team colours; the leaders get the stone outline. Teams out of the sudden death fade.
      const best = Math.max(0, ...state.teams.map((t) => t.kills));
      const scoreHtml = (t: GameState['teams'][number]): string => {
        const out = state.phase === 'suddendeath' && !state.suddenDeathTeams.includes(t.index) ? ' out' : '';
        const lead = best > 0 && t.kills === best ? ' lead' : '';
        return `<span class="score${out}${lead}" style="--team:${t.colour}" title="${esc(t.name)}"><i class="palina"></i><b>${t.kills}</b></span>`;
      };
      const half = Math.ceil(state.teams.length / 2);
      const left = state.teams.slice(0, half).map(scoreHtml).join('');
      const right = state.teams.slice(half).map(scoreHtml).join('');
      const late = fighting && timeLeft <= 60 ? ' late' : '';
      const label = state.phase === 'suddendeath' ? '<span class="tag sd">Sudden death</span>' : state.phase === 'countdown' ? '<span class="tag">Get ready</span>' : state.phase === 'results' ? '<span class="tag">Final</span>' : '';
      const paused = state.paused ? '<span class="tag paused">Paused</span>' : '';
      // The countdown shows the battle length to come; the results need no clock.
      const shown = fighting ? clock(timeLeft) : state.phase === 'countdown' ? clock(MATCH.battleSec) : '';
      const timer = shown ? `<span class="timer sign${late}">${shown}</span>` : '';
      this.set(
        this.topBar,
        `<div class="scores">${left}</div><div class="clock">${timer}${label}${paused}</div><div class="scores">${right}</div>`,
      );
      const feed = state.killFeed
        .filter((k) => state.time - k.at <= FEED_SEC)
        .map((k) => `<div class="feed-row">${killFeedText(state, k.killerTeam, k.victimTeam, k.cause)}</div>`)
        .join('');
      this.set(this.feed, feed);
      if (state.phase !== 'results') this.drawMinimap(state, layout);
    }

    this.set(this.cells, inLobby ? '' : layout.cells.map((c, i) => this.cellHtml(state, i, c, info)).join(''));
    this.set(this.centre, this.centreHtml(state));
  }

  private updateLobby(state: GameState, info: HudInfo): void {
    this.set(this.codeEl, esc(info.code ?? '····'));
    this.set(
      this.urlEl,
      info.joinUrl
        ? `No camera? Open <b>${esc(info.joinUrl.replace(/^https?:\/\//, '').replace(/\?.*$/, ''))}</b> and type the code.${
            info.urlLooksLocal ? '<span class="url-warn">Phones cannot reach this address. Run <code>npm run tunnel</code> and open the big screen on the tunnel URL.</span>' : ''
          }`
        : esc(info.link),
    );
    const size = state.teamSize;
    const teams = state.teams
      .map((t) => {
        // Bot crews are closed to phones: no open seats to advertise.
        const bots = t.members.some((id) => id.startsWith('bot-'));
        const seats = ROLES_IN_ORDER.slice(0, bots ? t.members.length : size).map((role, i) => {
          const id = t.members[i];
          const p = id ? state.players[id] : undefined;
          if (!p || !id) return `<li class="seat open">${roleIcon(role)}<span class="who">Open seat</span><span class="role">${ROLE_LABEL[role]}</span></li>`;
          const fresh = this.seen.has(id) ? '' : ' fresh';
          this.seen.add(id);
          const tags = [
            p.virtual && !id.startsWith('bot-') ? '<em class="tag-mini">Keys</em>' : '',
            !p.connected ? '<em class="tag-mini warn">Offline</em>' : '',
            p.calibrated && !p.virtual ? '<em class="tag-mini">Controls on</em>' : '',
            p.ready ? '<em class="tag-mini ok">Ready</em>' : '',
          ].join('');
          return `<li class="seat${fresh}">${roleIcon(p.role)}<span class="who">${esc(p.name)}</span>${tags}<span class="role">${ROLE_LABEL[p.role]}</span><button class="kick" data-action="kick" data-pid="${esc(id)}" title="Remove ${esc(p.name)}" aria-label="Remove ${esc(p.name)}">&times;</button></li>`;
        });
        // A crew beyond the team size (should not happen) still shows everyone.
        for (const id of t.members.slice(size)) seats.push(`<li class="seat">${roleIcon('engineer')}<span class="who">${esc(state.players[id]?.name ?? id)}</span></li>`);
        return `<div class="team" style="--team:${t.colour}"><i class="palina"></i><div class="team-body"><h3 class="display">${esc(t.name)}</h3><ul>${seats.join('')}</ul></div></div>`;
      })
      .join('');
    // Forget players who left so a rejoin animates again.
    for (const id of this.seen) if (!state.players[id]) this.seen.delete(id);
    const empty = `<div class="roster-empty"><p class="display">The canals are empty</p><p>Scan the QR to take a seat, or press <kbd>K</kbd> for a keyboard crew and <kbd>O</kbd> for a bot crew.</p></div>`;
    const spectators = state.spectators.length ? `<p class="waiting">Waiting for a seat: ${state.spectators.map((id) => esc(state.players[id]?.name ?? id)).join(', ')}</p>` : '';
    const count = Object.keys(state.players).length;
    this.set(
      this.roster,
      `<div class="roster-head"><h2>Crews</h2><span>${count} ${count === 1 ? 'player' : 'players'}, teams of ${size}</span></div><div class="teams n${Math.min(6, state.teams.length)}">${teams || empty}</div>${spectators}`,
    );
    this.set(this.startEl, info.canStart.ok ? 'Everyone aboard? Press <kbd>Enter</kbd> or Start match.' : esc(info.canStart.reason ?? ''));
    const full = state.teams.length >= 6;
    this.set(
      this.buttonsEl,
      `<button data-action="start" class="plate-btn"${info.canStart.ok ? '' : ' disabled'}>Start match</button>` +
        `<button data-action="teamSize" class="ghost-btn">Teams of ${size === 3 ? '2' : '3'}</button>` +
        `<button data-action="addBot" class="ghost-btn"${full ? ' disabled' : ''}>Add bot crew</button>` +
        `<button data-action="addKeyboard" class="ghost-btn"${full ? ' disabled' : ''}>Add keyboard crew</button>`,
    );
  }

  private cellHtml(state: GameState, i: number, c: Layout['cells'][number], info: HudInfo): string {
    const t = state.teams[i];
    const boat = state.boats[i];
    if (!t || !boat) return '';
    const now = state.time;
    const crew = t.members
      .map((id) => {
        const p = state.players[id];
        const lost = info.stale.has(id) ? '<em class="lost" title="Phone not heard from">no signal</em>' : '';
        return `<span>${p ? roleIcon(p.role) : ''}${esc(p?.name ?? '?')}${lost}</span>`;
      })
      .join('');
    const focus = info.focus === i ? ' focus' : '';
    const view = info.views[i];
    const weapon = WEAPONS[boat.weapon];
    const powers = boat.powers
      .map((p) => (p ? `<span class="power" data-power="${p}" title="${esc(POWERS[p].label)}">${powerIcon(p)}</span>` : '<span class="power empty"></span>'))
      .join('');
    const water = Math.round(boat.water);
    // Bow against the view: the camera looks along the aim, so the arrow turns by (bow - aim); positive = bow to the left.
    const bowDeg = (wrapAngle(boat.pose.yaw - boat.aimYaw) * 180) / Math.PI;
    const timers: string[] = [];
    if (boat.status === 'alive' && boat.protectedUntil > now) timers.push(`<span class="pill protect">Protected ${(boat.protectedUntil - now).toFixed(1)}</span>`);
    if (boat.status === 'alive' && boat.shieldUntil > now) timers.push(`<span class="pill shield">${powerIcon('shield')}Shield ${Math.ceil(boat.shieldUntil - now)}</span>`);
    if (boat.status === 'alive' && boat.boostUntil > now) timers.push(`<span class="pill boost">${powerIcon('boost')}Boost</span>`);
    const flash = (info.shieldFlashUntil.get(i) ?? 0) > performance.now() ? '<div class="flash shield-flash"></div>' : '';
    let overlay = '';
    if (state.phase === 'results') overlay = '';
    else if (boat.status === 'sinking' || boat.status === 'respawning') {
      const killer = boat.killerTeam !== null ? state.teams[boat.killerTeam] : undefined;
      const by = killer ? `<div class="sunk-by">by <b style="--team:${killer.colour}">${esc(killer.name)}</b></div>` : '';
      const left = Math.max(0, Math.ceil(boat.respawnAt - now));
      const cam = view?.killCam && killer ? `<div class="sunk-note">Watching ${esc(killer.name)}</div>` : '';
      overlay = `<div class="sunk"><div class="sunk-title">Sunk</div>${by}<div class="sunk-count"><b>${left}</b><span>back in</span></div>${cam}</div>`;
    } else if (boat.status === 'out') {
      overlay = '<div class="sunk out"><div class="sunk-title">Out</div><div class="sunk-note">Watch the sudden death</div></div>';
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
      <div class="tl"${side(true, true)}><i class="palina"></i><div><b class="team-name">${esc(t.name)}</b><div class="crew">${crew}</div></div></div>
      <div class="tr"${side(true, false)}><span class="stat"><b>${t.kills}</b>sunk</span><span class="stat lost-stat"><b>${t.deaths}</b>lost</span></div>
      ${fighting ? `<div class="crosshair ${boat.crosshair}"><i></i></div>` : ''}
      ${fighting ? `<div class="bl"${side(false, true)}><span class="weapon-icon" data-weapon="${boat.weapon}">${weaponIcon(boat.weapon)}</span><span class="weapon-text"><span class="weapon">${esc(weapon.label)}</span>${ammoHtml(boat.ammo)}</span></div>` : ''}
      ${fighting ? `<div class="br"${side(false, false)}><div class="powers">${powers}</div><div class="water${water >= 50 ? ' high' : ''}" title="Hull water">${dropIcon()}<span class="bar"><i style="width:${water}%"></i></span></div></div>` : ''}
      ${fighting ? `<div class="bc"><div class="bow" style="transform:rotate(${(-bowDeg).toFixed(1)}deg)"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2 20 21l-8-4.5L4 21z"/></svg></div>${timers.join('')}</div>` : ''}
      ${flash}${overlay}
    </div>`;
  }

  private centreHtml(state: GameState): string {
    if (state.phase === 'countdown') {
      const n = Math.ceil(state.phaseEndsAt - state.time);
      // The key changes every second, so the number element is new and its pop animation replays.
      return `<div class="countdown"><div class="big display" data-n="${n}">${n}</div><p>Pilots and Gunners: hold your phone and tap <b>Calibrate</b></p></div>`;
    }
    if (state.phase !== 'results' || !state.results) return '';
    const r = state.results;
    const pennants = r.ranking
      .map((ti, rank) => {
        const t = state.teams[ti];
        return t
          ? `<li class="pennant${rank === 0 ? ' first' : ''}" style="--team:${t.colour};--i:${rank}"><span class="rank display">${rank + 1}</span><span class="pn-name">${esc(t.name)}</span><span class="pn-stat"><b>${t.kills}</b> sunk</span><span class="pn-stat"><b>${t.deaths}</b> lost</span></li>`
          : '';
      })
      .join('');
    const awards: string[] = [];
    if (r.topGunner) {
      const p = state.players[r.topGunner];
      if (p) awards.push(`<li>${roleIcon('gunner')}<span>Top Gunner</span><b>${esc(p.name)}</b><em>${p.kills - p.ramKills} sunk</em></li>`);
    }
    if (r.bestRam) {
      const p = state.players[r.bestRam];
      if (p) awards.push(`<li>${powerIcon('boost')}<span>Best ram</span><b>${esc(p.name)}</b></li>`);
    }
    const winner = state.teams[r.winner];
    const sd = r.suddenDeath ? '<p class="results-note">Decided in sudden death</p>' : '';
    return `<div class="results" style="--team:${winner?.colour ?? '#fff'}">
      <h2 class="display">${esc(winner?.name ?? '')} wins the regatta</h2>${sd}
      <div class="rod"></div>
      <ol class="pennants">${pennants}</ol>
      ${awards.length ? `<ul class="awards">${awards.join('')}</ul>` : ''}
      <div class="host-buttons"><button data-action="rematch" class="plate-btn">Rematch</button><button data-action="newLobby" class="ghost-btn">New lobby</button></div>
      <p class="keys"><kbd>Enter</kbd> rematch with the same crews <kbd>Esc</kbd> new lobby</p></div>`;
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
        lg.fillStyle = '#123b3c';
        lg.fillRect(0, 0, w, h);
        lg.fillStyle = '#e6dcc4';
        for (const wall of m.walls) lg.fillRect(px(wall.x - wall.w / 2), pz(wall.z - wall.d / 2), (wall.w / m.worldW) * w + 0.5, (wall.d / m.worldD) * h + 0.5);
      }
      this.wallsLayer = layer;
    }
    g.drawImage(this.wallsLayer, 0, 0);
    const dot = Math.max(2, w / 110);
    for (const c of state.crates) {
      if (!c.active) continue;
      g.fillStyle = c.category === 'weapon' ? '#ff5a46' : '#6fb8ff';
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
