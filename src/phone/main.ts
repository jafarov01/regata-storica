/**
 * PLAYER mode (/play?room=CODE): join, lobby, Enable controls, role pads.
 *
 * BASELINE SHELL (Track A owns it). It is complete enough for Gate 1: a phone joins
 * by QR or code, appears in the lobby on the big screen, taps Enable controls, and
 * steers. Polish lives in docs/TASKS-A.md (A7 wheel graphic, A8 gunner screen,
 * A11 engineer screen, A12 sunk/results screens, A14 team-colour background).
 *
 * Flow: join screen (no ?room) -> PhoneClient hello -> lobby screen -> Enable controls
 * (one tap: motion permission + wake lock + fullscreen). The screen follows the match
 * phase (from the 10 Hz Hud, or the roster, whichever is newer): the lobby panel in the
 * lobby, the role pads plus the role graphic in every other phase.
 * The scene owns teams and roles; this page only shows the Lobby/Hud snapshots it gets.
 * Desktop testing without a phone: add ?sim=1 and steer with the arrow keys (sensorSim.ts).
 */
import './phone.css';
import './pads.css';
import { normalizeRoomCode, type Err, type Hud, type Lobby, type LobbyMember, type Phase, type Role } from '@shared/protocol.ts';
import { TEAM_COLOURS } from '@shared/config.ts';
import { PhoneClient, type LinkState } from '../net/client.ts';
import { getPlayerName, getPlayerToken, setPlayerName } from '../net/identity.ts';
import { startController, type PhoneController } from './controller.ts';
import type { MotionHealth } from './sensors.ts';
import { haptic } from './wake.ts';

const ROLE_LABEL: Record<Role, string> = { pilot: 'PILOT', gunner: 'GUNNER', engineer: 'ENGINEER' };
const ERR_TEXT: Partial<Record<Err['code'], string>> = {
  no_room: 'No room with that code. Check the code on the big screen.',
  room_full: 'This room is full.',
  match_running: 'A match is running. Wait for the next lobby.',
  room_closed: 'The big screen closed the room.',
  kicked: 'You were removed from the room.',
  replaced: 'This player opened in another tab.',
  bad_version: 'The game was updated. Reload the page.',
};

interface Me {
  pid: string | null;
  team: number;
  role: Role;
  member: LobbyMember | null;
}

export async function startPhone(root: HTMLElement): Promise<void> {
  const room = normalizeRoomCode(new URLSearchParams(location.search).get('room') ?? '');
  if (!room) {
    renderJoin(root);
    return;
  }
  runRoom(root, room);
}

/** Fallback join: type the code (the QR normally opens /play?room=CODE directly). */
function renderJoin(root: HTMLElement): void {
  root.innerHTML = `
    <main class="phone-page">
      <h1>Join a room</h1>
      <p class="muted">Scan the QR on the big screen with your camera, or type its 4-letter code.</p>
      <input id="code" class="code-input" maxlength="4" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="RIVA" />
      <button id="join" class="big-button primary" type="button">JOIN</button>
      <button id="scan" class="big-button" type="button">SCAN QR<small>Uses the camera in this page</small></button>
      <video id="scanner" playsinline muted hidden></video>
      <p id="msg" class="muted"></p>
    </main>`;
  const input = root.querySelector<HTMLInputElement>('#code');
  const msg = root.querySelector<HTMLElement>('#msg');
  const go = (code: string): void => window.location.assign(`/play?room=${code}`);
  root.querySelector('#join')?.addEventListener('click', () => {
    const code = normalizeRoomCode(input?.value ?? '');
    if (code) go(code);
    else if (msg) msg.textContent = 'A room code is 4 letters.';
  });
  root.querySelector('#scan')?.addEventListener('click', () => {
    const video = root.querySelector<HTMLVideoElement>('#scanner');
    if (!video) return;
    video.hidden = false;
    // Loaded on demand: qr-scanner and its worker only download when someone taps SCAN.
    void import('../net/scanner.ts').then(({ createRoomScanner }) => {
      const scanner = createRoomScanner(video, go, (text) => {
        if (msg) msg.textContent = text;
      });
      void scanner.start();
    });
  });
}

function runRoom(root: HTMLElement, room: string): void {
  root.innerHTML = `
    <div class="phone-root" id="phone">
      <header class="phone-bar">
        <span id="me-name"></span><span id="me-role"></span><span id="status"></span>
      </header>
      <section id="pads-mount" class="pads-mount" hidden></section>
      <div id="role-view" class="role-view" hidden>
        <div class="role-name" id="role-name"></div>
        <div class="wheel" id="wheel"><div class="wheel-spoke"></div><div class="wheel-spoke wheel-spoke-2"></div><div class="wheel-hub"></div></div>
        <div class="compass" id="compass"><div class="needle" id="needle"></div><div class="bow-mark">BOW</div></div>
        <div class="meter" id="meter"><div class="meter-fill" id="meter-fill"></div><span>WATER</span></div>
        <div class="role-tip" id="role-tip"></div>
      </div>
      <section id="lobby" class="phone-lobby">
        <input id="name" class="name-input" maxlength="16" />
        <div class="row">
          <button id="swap-role" class="chip" type="button">Swap role</button>
          <button id="move-team" class="chip" type="button">Move team</button>
          <button id="ready" class="chip" type="button">Ready</button>
        </div>
        <button id="enable" class="big-button primary" type="button">ENABLE CONTROLS<small>One tap: motion sensors and screen wake</small></button>
        <p id="hint" class="muted"></p>
      </section>
      <div id="hud" class="phone-hud" hidden></div>
      <div id="alert" class="phone-alert" hidden></div>
      <div id="rotate" class="rotate-overlay">Turn your phone sideways</div>
    </div>`;
  const $ = <T extends HTMLElement>(sel: string): T => {
    const el = root.querySelector<T>(sel);
    if (!el) throw new Error(`missing ${sel}`);
    return el;
  };
  const phoneEl = $<HTMLElement>('#phone');
  const nameInput = $<HTMLInputElement>('#name');
  const statusEl = $<HTMLElement>('#status');
  const hintEl = $<HTMLElement>('#hint');
  const alertEl = $<HTMLElement>('#alert');
  const hudEl = $<HTMLElement>('#hud');
  const lobbyEl = $<HTMLElement>('#lobby');
  const padsMount = $<HTMLElement>('#pads-mount');
  const roleView = $<HTMLElement>('#role-view');
  const rotateEl = $<HTMLElement>('#rotate');
  const enableBtn = $<HTMLButtonElement>('#enable');

  const me: Me = { pid: null, team: -1, role: 'pilot', member: null };
  let lobby: Lobby | null = null;
  let hud: Hud | null = null;
  let phase: Phase = 'lobby';
  let ready = false;
  let landscape = true;
  let controller: PhoneController | null = null;
  let alertTimer: number | null = null;
  nameInput.value = getPlayerName();

  /** A message that stays readable over the pads (the lobby hint is hidden during a match). */
  function say(text: string, ms = 0): void {
    hintEl.textContent = text || (controller && phase === 'lobby' ? 'Controls on. Waiting for the host to start.' : '');
    alertEl.textContent = text;
    alertEl.hidden = text === '' || phase === 'lobby';
    if (alertTimer !== null) window.clearTimeout(alertTimer);
    alertTimer = ms > 0 && text ? window.setTimeout(() => say(''), ms) : null;
  }

  const client = new PhoneClient(room, getPlayerToken(), nameInput.value, {
    onLink: (state: LinkState, detail?: string) => {
      statusEl.textContent = state === 'online' ? '' : state === 'connecting' ? 'connecting...' : `offline${detail ? ` (${detail})` : ''}`;
    },
    onWelcome: (w) => {
      me.pid = w.pid;
      say(w.queued ? 'A match is running: you join at the next lobby.' : w.sceneOnline ? '' : 'Waiting for the big screen...');
      findMe();
      render();
    },
    onLobby: (l) => {
      lobby = l;
      setPhase(l.phase);
      findMe();
      render();
    },
    onHud: (h) => {
      hud = h;
      if (h.team >= 0) {
        me.team = h.team;
        me.role = h.role;
      }
      setPhase(h.phase);
      renderHud(h);
    },
    onEvt: (e) => {
      if (e.kind === 'fired') haptic('fire', phoneEl);
      if (e.kind === 'hit' || e.kind === 'sunk') haptic('hit', phoneEl);
    },
    onRoom: (r) => say(r.sceneOnline ? '' : 'The big screen is reconnecting...'),
    onError: (e) => say(ERR_TEXT[e.code] ?? `Error: ${e.code}`),
  });

  function setPhase(next: Phase): void {
    if (next === phase) return;
    phase = next;
    if (phase === 'countdown' && controller && (me.role === 'pilot' || me.role === 'gunner')) {
      say(me.role === 'pilot' ? 'Hold the phone like a wheel and tap CALIBRATE' : 'Point the phone at the big screen and tap CALIBRATE', 6000);
    }
    render();
  }

  function findMe(): void {
    me.member = null;
    if (!lobby || !me.pid) return;
    me.team = -1;
    for (const team of lobby.teams) {
      const m = team.members.find((x) => x.pid === me.pid);
      if (m) {
        me.member = m;
        me.team = team.index;
        me.role = m.role;
        return;
      }
    }
  }

  function hasPowers(): boolean {
    return me.role === 'engineer' || (me.role === 'gunner' && (lobby?.teamSize ?? 3) === 2);
  }

  function render(): void {
    const colour = me.team >= 0 ? (TEAM_COLOURS[me.team]?.hex ?? '#333') : '#333';
    phoneEl.style.setProperty('--team', colour);
    phoneEl.dataset['role'] = me.role;
    phoneEl.dataset['phase'] = phase;
    $('#me-name').textContent = nameInput.value;
    $('#me-role').textContent = me.team >= 0 ? `${TEAM_COLOURS[me.team]?.name ?? ''} · ${ROLE_LABEL[me.role]}` : 'Spectator';
    $('#role-name').textContent = ROLE_LABEL[me.role];
    const inLobby = phase === 'lobby';
    const playing = controller !== null && !inLobby;
    lobbyEl.hidden = playing;
    padsMount.hidden = !playing;
    roleView.hidden = !playing;
    hudEl.hidden = !playing;
    alertEl.hidden = !playing || alertEl.textContent === '';
    $('#ready').classList.toggle('on', ready);
    enableBtn.hidden = controller !== null;
    if (controller && inLobby && !hintEl.textContent) hintEl.textContent = 'Controls on. Waiting for the host to start.';
    controller?.setRole(me.role, me.role === 'gunner' && hasPowers());
    rotateEl.classList.toggle('visible', playing && !landscape && me.role !== 'engineer');
  }

  function renderHud(h: Hud): void {
    const t = Math.max(0, Math.ceil(h.timeLeft));
    const clock = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
    const parts = [`${h.phase === 'countdown' ? 'STARTS IN' : h.phase.toUpperCase()} ${clock}`, `${h.teamName} K ${h.kills} · D ${h.deaths}`];
    if (!h.alive) parts.push(`SUNK${h.sunkBy ? ` by ${h.sunkBy}` : ''} · back in ${Math.ceil(h.respawnIn)}`);
    if (h.role === 'gunner') parts.push(`${h.weapon}${Number.isFinite(h.ammo) ? ` ${h.ammo}` : ''}`);
    if (h.hasPowers) parts.push(`powers: ${h.powers.map((p) => p ?? '-').join(' / ')}`);
    if (h.stale) parts.push('big screen not hearing you');
    hudEl.textContent = parts.join('   ');
  }

  // Role graphic, every animation frame while playing: wheel (Pilot), compass (Gunner), water meter (Engineer).
  const wheel = $<HTMLElement>('#wheel');
  const needle = $<HTMLElement>('#needle');
  const meterFill = $<HTMLElement>('#meter-fill');
  const tip = $<HTMLElement>('#role-tip');
  const animate = (): void => {
    if (controller && !roleView.hidden) {
      const snap = controller.snapshot();
      if (me.role === 'pilot') {
        wheel.style.transform = `rotate(${(snap.steer * 90).toFixed(1)}deg)`;
        tip.textContent = snap.steerCalibrated ? (snap.steerWeak ? 'Hold the phone more upright' : '') : 'Tap CALIBRATE to steer';
      } else if (me.role === 'gunner') {
        // Needle = aim relative to the bow from the scene (falls back to the local yaw before the first Hud).
        const rel = hud ? hud.aimRel : snap.yawSinceRecenterRad;
        needle.style.transform = `rotate(${(-rel * 180 / Math.PI).toFixed(1)}deg)`;
        tip.textContent = hud?.onTarget ? 'ON TARGET' : '';
      } else {
        meterFill.style.height = `${Math.round(hud?.water ?? 0)}%`;
        tip.textContent = hud?.bail ? 'SHAKE TO BAIL' : '';
      }
    }
    requestAnimationFrame(animate);
  };
  requestAnimationFrame(animate);

  nameInput.addEventListener('change', () => {
    const name = nameInput.value.trim().slice(0, 16);
    if (!name) return;
    setPlayerName(name);
    client.rename(name);
    render();
  });
  $('#swap-role').addEventListener('click', () => {
    const order: Role[] = ['pilot', 'gunner', 'engineer'];
    const teamSize = lobby?.teamSize ?? 3;
    const members = lobby?.teams[me.team]?.members.length ?? 1;
    if (members < 2) {
      say('Nobody to swap with yet: you are alone in this team.', 3000);
      return;
    }
    const next = order[(order.indexOf(me.role) + 1) % Math.min(teamSize, members)] ?? 'pilot';
    client.swap(undefined, next);
  });
  $('#move-team').addEventListener('click', () => {
    if (!lobby || lobby.teams.length < 2) {
      say('Only one team so far.', 3000);
      return;
    }
    for (let k = 1; k < lobby.teams.length; k++) {
      const t = lobby.teams[(me.team + k) % lobby.teams.length];
      if (t && t.members.length < t.capacity) {
        client.swap(t.index);
        return;
      }
    }
    say('Every other team is full.', 3000);
  });
  $('#ready').addEventListener('click', () => {
    ready = !ready;
    client.ready(ready);
    render();
  });
  // Must stay synchronous up to startController(): iOS only grants motion inside the tap.
  enableBtn.addEventListener('click', () => {
    if (controller) return;
    enableBtn.disabled = true;
    void startController({
      role: me.role,
      gunnerHasPowers: hasPowers() && me.role === 'gunner',
      mount: padsMount,
      send: (sample) => client.sendInput(sample),
      onHealth: (health: MotionHealth) => {
        if (health === 'no-events') say('No motion sensors. Open the https link from the QR and allow motion access (or add ?sim=1 on a desktop).');
        else if (health === 'stalled') say('Sensors stopped. Reload the page and tap Enable controls again.');
        else if (health === 'ok') say('');
      },
      onOrientation: (isLandscape) => {
        landscape = isLandscape;
        render();
      },
      onCalibrate: (ok) => {
        if (ok) {
          client.calibrated();
          say('Calibrated', 1500);
        } else say('Hold the phone upright like a wheel, then tap CALIBRATE again.', 3000);
      },
    }).then((c) => {
      controller = c;
      if (!c.enable.motion.ok) say(c.enable.motion.message);
      render();
    }, (err: unknown) => {
      enableBtn.disabled = false;
      say(`Could not enable controls: ${err instanceof Error ? err.message : String(err)}`);
    });
  });
  render();
}
