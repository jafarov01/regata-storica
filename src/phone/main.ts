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
import { saveInvertAim, loadInvertAim, type MotionHealth } from './sensors.ts';
import { PhoneScreens, SCREENS_HTML } from './screens.ts';
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
      ${SCREENS_HTML}
      <section id="lobby" class="phone-lobby">
        <input id="name" class="name-input" maxlength="16" aria-label="Your name" />
        <div class="row">
          <button id="swap-role" class="chip" type="button">Swap role</button>
          <button id="move-team" class="chip" type="button">Move team</button>
          <button id="ready" class="chip" type="button">Ready</button>
        </div>
        <button id="enable" class="big-button primary" type="button">ENABLE CONTROLS<small>One tap: motion sensors and screen wake</small></button>
        <div class="row" id="after-enable" hidden>
          <button id="try" class="chip" type="button">Try controls</button>
          <button id="invert" class="chip" type="button">Invert aim: off</button>
        </div>
        <p id="hint" class="muted"></p>
        <a id="rejoin" class="chip" href="/play" hidden>Enter another code</a>
      </section>
      <section id="resume" class="phone-overlay resume" hidden>
        <div class="big">MATCH ON</div>
        <button id="resume-btn" class="big-button primary" type="button">TAP TO RESUME CONTROLS</button>
      </section>
      <section id="spectate" class="phone-overlay spectate" hidden>
        <div class="big">YOU'RE UP NEXT</div><div>The match is full or already running. You join at the next lobby.</div>
      </section>
      <button id="back-lobby" class="chip back-lobby" type="button" hidden>Back to lobby</button>
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
  const rotateEl = $<HTMLElement>('#rotate');
  const enableBtn = $<HTMLButtonElement>('#enable');
  const resumeEl = $<HTMLElement>('#resume');
  const spectateEl = $<HTMLElement>('#spectate');
  const backLobby = $<HTMLButtonElement>('#back-lobby');
  const invertBtn = $<HTMLButtonElement>('#invert');
  const screens = new PhoneScreens(root, padsMount);

  const me: Me = { pid: null, team: -1, role: 'pilot', member: null };
  let lobby: Lobby | null = null;
  let hud: Hud | null = null;
  let phase: Phase = 'lobby';
  let ready = false;
  let landscape = true;
  let trying = false;
  let online = false;
  let controller: PhoneController | null = null;
  let enabling = false;
  let message = '';
  let messageTimer: number | null = null;
  nameInput.value = getPlayerName();
  invertBtn.textContent = `Invert aim: ${loadInvertAim() ? 'on' : 'off'}`;

  /** One message line: in the lobby under the buttons, during a match as a banner over the pads. */
  function say(text: string, ms = 0): void {
    message = text;
    if (messageTimer !== null) window.clearTimeout(messageTimer);
    messageTimer = ms > 0 && text ? window.setTimeout(() => say(''), ms) : null;
    renderMessage();
  }

  function renderMessage(): void {
    const warn = !online ? 'Reconnecting to the big screen...' : hud?.stale && isPlaying() ? "The big screen can't hear you. Check your connection." : '';
    const text = message || warn;
    hintEl.textContent = text || (controller && phase === 'lobby' ? 'Controls on. Waiting for the host to start.' : '');
    alertEl.textContent = text;
    alertEl.hidden = text === '' || !isPlaying();
  }

  const client = new PhoneClient(room, getPlayerToken(), nameInput.value, {
    onLink: (state: LinkState, detail?: string) => {
      online = state === 'online';
      statusEl.textContent = online ? '' : state === 'connecting' ? 'connecting...' : `offline${detail ? ` (${detail})` : ''}`;
      renderMessage();
    },
    onWelcome: (w) => {
      me.pid = w.pid;
      $('#rejoin').hidden = true;
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
      screens.onHud(h, isPlaying());
      renderMessage();
    },
    onEvt: (e) => {
      screens.onEvt(e);
      if (e.kind === 'fired') haptic('fire', phoneEl);
      if (e.kind === 'hit' || e.kind === 'sunk') haptic('hit', phoneEl);
    },
    onRoom: (r) => say(r.sceneOnline ? '' : 'The big screen is reconnecting...'),
    onError: (e) => {
      say(ERR_TEXT[e.code] ?? `Error: ${e.code}`);
      if (e.code === 'no_room' || e.code === 'room_full' || e.code === 'room_closed' || e.code === 'kicked') $('#rejoin').hidden = false;
    },
  });

  function isPlaying(): boolean {
    return controller !== null && (phase !== 'lobby' || trying) && me.team >= 0;
  }

  function setPhase(next: Phase): void {
    if (next === phase) return;
    phase = next;
    if (phase !== 'lobby') trying = false;
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
    const teamSize = lobby?.teamSize ?? (hud?.hasPowers ? 2 : 3);
    return me.role === 'engineer' || (me.role === 'gunner' && teamSize === 2);
  }

  function render(): void {
    const colour = me.team >= 0 ? (TEAM_COLOURS[me.team]?.hex ?? '#333') : '#333';
    phoneEl.style.setProperty('--team', colour);
    phoneEl.dataset['role'] = me.role;
    phoneEl.dataset['phase'] = phase;
    $('#me-name').textContent = nameInput.value;
    $('#me-role').textContent = me.team >= 0 ? `${TEAM_COLOURS[me.team]?.name ?? ''} · ${ROLE_LABEL[me.role]}` : 'Waiting';
    const inLobby = phase === 'lobby';
    const playing = isPlaying();
    const seatedInMatch = !inLobby && me.team >= 0;
    lobbyEl.hidden = playing || seatedInMatch || (!inLobby && me.pid !== null);
    resumeEl.hidden = !(seatedInMatch && controller === null);
    spectateEl.hidden = !(!inLobby && me.pid !== null && me.team < 0);
    padsMount.hidden = !playing;
    hudEl.hidden = !playing || trying;
    backLobby.hidden = !(playing && trying);
    screens.setPlaying(playing, me.role);
    $('#ready').classList.toggle('on', ready);
    enableBtn.hidden = controller !== null;
    $('#after-enable').hidden = controller === null;
    invertBtn.hidden = me.role !== 'gunner';
    controller?.setRole(me.role, me.role === 'gunner' && hasPowers());
    rotateEl.classList.toggle('visible', playing && !landscape && me.role !== 'engineer');
    renderMessage();
  }

  function renderHud(h: Hud): void {
    const t = Math.max(0, Math.ceil(h.timeLeft));
    const clock = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
    const parts = [`${h.phase === 'countdown' ? 'STARTS IN' : h.phase.toUpperCase()} ${clock}`, `${h.teamName} K ${h.kills} · D ${h.deaths}`];
    if (h.protectedFor > 0) parts.push(`protected ${Math.ceil(h.protectedFor)}`);
    hudEl.textContent = parts.join('   ');
  }

  // Sensor-driven parts of the role screen, every animation frame.
  const animate = (): void => {
    if (controller) screens.frame(me.role, controller.snapshot(), hud);
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
  $('#try').addEventListener('click', () => {
    trying = true;
    render();
  });
  backLobby.addEventListener('click', () => {
    trying = false;
    render();
  });
  invertBtn.addEventListener('click', () => {
    const on = !loadInvertAim();
    saveInvertAim(on);
    controller?.pipeline.setInvertAim(on);
    invertBtn.textContent = `Invert aim: ${on ? 'on' : 'off'}`;
  });

  /** Must stay synchronous up to startController(): iOS only grants motion inside the tap. */
  function enable(): void {
    if (controller || enabling) return;
    enabling = true;
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
    }).then(
      (c) => {
        controller = c;
        enabling = false;
        if (!c.enable.motion.ok) say(c.enable.motion.message);
        render();
      },
      (err: unknown) => {
        enabling = false;
        enableBtn.disabled = false;
        say(`Could not enable controls: ${err instanceof Error ? err.message : String(err)}`);
      },
    );
  }
  enableBtn.addEventListener('click', enable);
  $('#resume-btn').addEventListener('click', enable);
  render();
}
