/**
 * Big-screen HUD as DOM overlays on top of the WebGL canvas (SPEC section 10).
 *
 * BASELINE (Track B owns it, docs/TASKS-B.md B11/B14): lobby with the join QR and
 * the roster, round timer and scoreboard, per-viewport team label, kills/deaths
 * and crosshair, countdown, results. Still to do: weapon/ammo, powers, water bar,
 * bow-vs-aim arrow, protection timer, kill-cam overlay, kill feed, minimap.
 * Updated at about 10 Hz; text is only written when it changed.
 */
import type { Layout } from '@shared/api.ts';
import type { GameState, Role } from '@shared/state.ts';

const ROLE_ICON: Record<Role, string> = { pilot: 'Pilot', gunner: 'Gunner', engineer: 'Engineer' };

export interface HudInfo {
  code: string | null;
  joinUrl: string | null;
  urlLooksLocal: boolean;
  link: string;
  canStart: { ok: boolean; reason?: string };
  stale: ReadonlySet<string>;
  focus: number;
}

function clock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export class SceneHud {
  readonly qrCanvas: HTMLCanvasElement;
  private readonly lobby: HTMLElement;
  private readonly roster: HTMLElement;
  private readonly codeEl: HTMLElement;
  private readonly urlEl: HTMLElement;
  private readonly startEl: HTMLElement;
  private readonly topBar: HTMLElement;
  private readonly cells: HTMLElement;
  private readonly centre: HTMLElement;
  private readonly cache = new WeakMap<HTMLElement, string>();

  constructor(private readonly root: HTMLElement) {
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
          <p class="keys">Enter start · K keyboard crew · O bot team · T team size · 1-6 focus · WASD drive · arrows aim · Space fire · R recenter · Q/E powers · P pause · Esc lobby</p>
        </div>
      </section>
      <div class="top-bar"></div>
      <div class="cells"></div>
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
    this.topBar = q('.top-bar');
    this.cells = q('.cells');
    this.centre = q('.centre');
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
    this.root.dataset['phase'] = state.phase;

    if (inLobby) {
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
              const flags = [p.ready ? 'ready' : '', p.calibrated ? 'calibrated' : '', !p.connected ? 'offline' : '', p.virtual ? 'keys/bot' : '']
                .filter(Boolean)
                .join(', ');
              return `<li><b>${ROLE_ICON[p.role]}</b> ${esc(p.name)}${flags ? ` <small>(${flags})</small>` : ''}</li>`;
            })
            .join('');
          return `<div class="team" style="--team:${t.colour}"><h3>${esc(t.name)}</h3><ul>${crew}</ul></div>`;
        })
        .join('');
      const spectators = state.spectators.length ? `<p class="muted">Waiting: ${state.spectators.map((id) => esc(state.players[id]?.name ?? id)).join(', ')}</p>` : '';
      this.set(this.roster, `<p class="muted">Teams of ${state.teamSize}</p>${teams || '<p class="muted">Scan the QR to join.</p>'}${spectators}`);
      this.set(this.startEl, info.canStart.ok ? 'Press <b>Enter</b> to start' : esc(info.canStart.reason ?? ''));
    } else {
      const scores = state.teams.map((t) => `<span class="score" style="--team:${t.colour}">${esc(t.name)} ${t.kills}</span>`).join('');
      const timeLeft = state.phaseEndsAt > 0 ? state.phaseEndsAt - state.time : 0;
      this.set(this.topBar, `<span class="timer">${state.phase === 'battle' || state.phase === 'suddendeath' ? clock(timeLeft) : ''}</span>${scores}${state.paused ? '<span class="paused">PAUSED</span>' : ''}`);
    }

    // Per-viewport overlays.
    const html = inLobby
      ? ''
      : layout.cells
          .map((c, i) => {
            const t = state.teams[i];
            if (!t) return '';
            const crew = t.members.map((id) => esc(state.players[id]?.name ?? '?') + (info.stale.has(id) ? ' ⚠' : '')).join(' · ');
            const focus = info.focus === i ? ' focus' : '';
            return `<div class="cell${focus}" style="left:${c.x}px;top:${c.y}px;width:${c.w}px;height:${c.h}px;--team:${t.colour}">
              <div class="tl"><b>${esc(t.name)}</b> ${crew}</div>
              <div class="tr">K ${t.kills} · D ${t.deaths}</div>
              <div class="crosshair"></div>
            </div>`;
          })
          .join('');
    this.set(this.cells, html);

    let centre = '';
    if (state.phase === 'countdown') centre = `<div class="big">${Math.ceil(state.phaseEndsAt - state.time)}</div><div>Pilots and Gunners: CALIBRATE now</div>`;
    else if (state.phase === 'results' && state.results) {
      const rows = state.results.ranking
        .map((ti, rank) => {
          const t = state.teams[ti];
          return t ? `<li style="--team:${t.colour}">${rank + 1}. ${esc(t.name)}: ${t.kills} kills, ${t.deaths} deaths</li>` : '';
        })
        .join('');
      centre = `<div class="results"><h2>${esc(state.teams[state.results.winner]?.name ?? '')} wins</h2><ol>${rows}</ol><p>Enter: rematch · Esc: new lobby</p></div>`;
    }
    this.set(this.centre, centre);
  }
}
