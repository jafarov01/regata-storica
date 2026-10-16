/**
 * PLAYER mode (/play?room=CODE): join, lobby, Enable controls, role pads.
 *
 * BASELINE SHELL (Track A owns it). It is complete enough for Gate 1: a phone joins
 * by QR or code, appears in the lobby on the big screen, taps Enable controls, and
 * steers. Polish lives in docs/TASKS-A.md (A7 wheel graphic, A8 gunner screen,
 * A11 engineer screen, A12 sunk/results screens, A14 team-colour background).
 *
 * Flow: join screen (no ?room) -> PhoneClient hello -> lobby screen -> Enable controls
 * (one tap: motion permission + wake lock + fullscreen) -> pads for the current role.
 * The scene owns teams and roles; this page only shows the Lobby/Hud snapshots it gets.
 * Desktop testing without a phone: add ?sim=1 and steer with the arrow keys (sensorSim.ts).
 */
import './phone.css';
import './pads.css';
import { normalizeRoomCode, type Err, type Hud, type Lobby, type LobbyMember, type Role } from '@shared/protocol.ts';
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
      <section id="pads-mount" class="pads-mount" hidden></section>
      <div id="hud" class="phone-hud" hidden></div>
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
  const hudEl = $<HTMLElement>('#hud');
  const lobbyEl = $<HTMLElement>('#lobby');
  const padsMount = $<HTMLElement>('#pads-mount');
  const rotateEl = $<HTMLElement>('#rotate');

  const me: Me = { pid: null, team: -1, role: 'pilot', member: null };
  let lobby: Lobby | null = null;
  let ready = false;
  let landscape = true;
  let controller: PhoneController | null = null;
  nameInput.value = getPlayerName();

  const client = new PhoneClient(room, getPlayerToken(), nameInput.value, {
    onLink: (state: LinkState, detail?: string) => {
      statusEl.textContent = state === 'online' ? '' : state === 'connecting' ? 'connecting...' : `offline${detail ? ` (${detail})` : ''}`;
    },
    onWelcome: (w) => {
      me.pid = w.pid;
      hintEl.textContent = w.queued ? 'A match is running: you join at the next lobby.' : w.sceneOnline ? '' : 'Waiting for the big screen...';
    },
    onLobby: (l) => {
      lobby = l;
      findMe();
      render();
    },
    onHud: (h) => renderHud(h),
    onEvt: (e) => {
      if (e.kind === 'fired') haptic('fire', phoneEl);
      if (e.kind === 'hit' || e.kind === 'sunk') haptic('hit', phoneEl);
    },
    onRoom: (r) => {
      hintEl.textContent = r.sceneOnline ? '' : 'The big screen is reconnecting...';
    },
    onError: (e) => {
      hintEl.textContent = ERR_TEXT[e.code] ?? `Error: ${e.code}`;
    },
  });

  function findMe(): void {
    me.member = null;
    me.team = -1;
    if (!lobby || !me.pid) return;
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
    $('#me-name').textContent = nameInput.value;
    $('#me-role').textContent = me.team >= 0 ? `${TEAM_COLOURS[me.team]?.name ?? ''} · ${ROLE_LABEL[me.role]}` : 'Spectator';
    const inLobby = (lobby?.phase ?? 'lobby') === 'lobby';
    lobbyEl.hidden = controller !== null && !inLobby;
    padsMount.hidden = controller === null;
    $('#ready').classList.toggle('on', ready);
    controller?.setRole(me.role, me.role === 'gunner' && hasPowers());
    rotateEl.classList.toggle('visible', controller !== null && !landscape && me.role !== 'engineer');
  }

  function renderHud(h: Hud): void {
    hudEl.hidden = controller === null;
    const t = Math.max(0, Math.ceil(h.timeLeft));
    const clock = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
    const parts = [`${h.phase.toUpperCase()} ${clock}`, `K ${h.kills} · D ${h.deaths}`];
    if (!h.alive) parts.push(`SUNK${h.sunkBy ? ` by ${h.sunkBy}` : ''} · back in ${Math.ceil(h.respawnIn)}`);
    if (h.role === 'gunner') parts.push(`${h.weapon} ${Number.isFinite(h.ammo) ? h.ammo : ''}`);
    if (h.hasPowers) parts.push(`powers: ${h.powers.map((p) => p ?? '-').join(' / ')}`);
    if (h.bail) parts.push(`SHAKE TO BAIL ${Math.round(h.water)}%`);
    hudEl.textContent = parts.join('   ');
  }

  nameInput.addEventListener('change', () => {
    const name = nameInput.value.trim().slice(0, 16);
    if (!name) return;
    setPlayerName(name);
    client.rename(name);
    render();
  });
  $('#swap-role').addEventListener('click', () => {
    const order: Role[] = ['pilot', 'gunner', 'engineer'];
    const size = lobby?.teamSize ?? 3;
    const next = order[(order.indexOf(me.role) + 1) % size] ?? 'pilot';
    client.swap(undefined, next);
  });
  $('#move-team').addEventListener('click', () => {
    const teams = lobby?.teams.length ?? 0;
    if (teams > 0) client.swap((me.team + 1) % teams);
  });
  $('#ready').addEventListener('click', () => {
    ready = !ready;
    client.ready(ready);
    render();
  });
  // Must stay synchronous up to startController(): iOS only grants motion inside the tap.
  $('#enable').addEventListener('click', () => {
    if (controller) return;
    void startController({
      role: me.role,
      gunnerHasPowers: hasPowers() && me.role === 'gunner',
      mount: padsMount,
      send: (sample) => client.sendInput(sample),
      onHealth: (health: MotionHealth) => {
        hintEl.textContent =
          health === 'ok' || health === 'waiting'
            ? ''
            : health === 'no-events'
              ? 'No motion sensors. Use HTTPS (the tunnel link) and allow motion access, or add ?sim=1 on a desktop.'
              : 'Sensors stopped. Tap Enable controls again.';
      },
      onOrientation: (isLandscape) => {
        landscape = isLandscape;
        render();
      },
      onCalibrate: (ok) => {
        if (ok) client.calibrated();
        else hintEl.textContent = 'Hold the phone upright like a wheel, then CALIBRATE.';
      },
    }).then((c) => {
      controller = c;
      $('#enable').textContent = 'CONTROLS ON';
      render();
    });
  });
  render();
}
