/**
 * PLAYER mode (/play?room=CODE): join, lobby, Enable controls, role pads.
 *
 * Track A owns it. Flow: join screen (no ?room) -> PhoneClient hello -> lobby screen -> Enable
 * controls (one tap: motion permission + wake lock + fullscreen). The screen follows the match
 * phase (from the 10 Hz Hud, or the roster, whichever is newer): the lobby panel in the lobby,
 * the role pads plus the role graphic in every other phase. Which layer shows is decided by
 * phoneView() in view.ts (pure, tested); this file wires sockets, sensors and DOM to it.
 *
 * Look (SPEC section 3, A7): the page background is the team colour, the role name is in large
 * type, Pilot and Gunner get the rotate-your-phone overlay in portrait (and their inputs coast
 * while it is up), fire and hit vibrate on Android and flash red on iOS.
 *
 * Resume (A6): a lock or app switch keeps the controller; PhoneClient reconnects into the same
 * slot on wake, the wake lock is re-requested, and sensors that stay silent are restarted once,
 * then the player is asked to tap again. A page reload in a match shows "Tap to resume controls"
 * (iOS only grants motion inside a tap).
 *
 * The scene owns teams and roles; this page only shows the Lobby/Hud snapshots it gets.
 * Desktop testing without a phone: add ?sim=1 and steer with the arrow keys (sensorSim.ts).
 */
import './phone.css';
import './pads.css';
import { normalizeRoomCode, type Hud, type Lobby, type LobbyMember, type Phase, type Role } from '@shared/protocol.ts';
import { TEAM_COLOURS } from '@shared/config.ts';
import { PhoneClient, type LinkState } from '../net/client.ts';
import { getPlayerName, getPlayerToken, setPlayerName } from '../net/identity.ts';
import { startController, type PhoneController } from './controller.ts';
import { saveInvertAim, loadInvertAim, type MotionHealth } from './sensors.ts';
import { PhoneScreens, SCREENS_HTML } from './screens.ts';
import { clock, describeErr, linkWarning, nextRole, nextTeam, phoneView, type ErrView, type ViewState } from './view.ts';
import { haptic } from './wake.ts';

const ROLE_LABEL: Record<Role, string> = { pilot: 'PILOT', gunner: 'GUNNER', engineer: 'ENGINEER' };
const PHASE_LABEL: Record<Phase, string> = { lobby: 'LOBBY', countdown: 'STARTS IN', battle: 'BATTLE', suddendeath: 'SUDDEN DEATH', results: 'RESULTS' };
const NO_MOTION = 'No motion sensors. Open the https link from the QR and allow motion access (or add ?sim=1 on a desktop).';
const SENSORS_STOPPED = 'The motion sensors stopped. Tap to resume controls.';

interface Me {
  pid: string | null;
  team: number;
  role: Role;
  member: LobbyMember | null;
}

export async function startPhone(root: HTMLElement): Promise<void> {
  const raw = new URLSearchParams(location.search).get('room');
  const room = normalizeRoomCode(raw ?? '');
  if (!room) {
    renderJoin(root, raw);
    return;
  }
  runRoom(root, room);
}

/** Asks the relay whether a typed code exists. Null when it cannot tell (offline, old relay): just try. */
async function probeRoom(code: string): Promise<{ exists: boolean; full: boolean } | null> {
  try {
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => ctrl.abort(), 2500);
    const res = await fetch(`/api/rooms/${code}`, { signal: ctrl.signal, cache: 'no-store' });
    window.clearTimeout(timer);
    if (!res.ok) return null;
    const body = (await res.json()) as { exists?: unknown; full?: unknown };
    return typeof body.exists === 'boolean' ? { exists: body.exists, full: body.full === true } : null;
  } catch {
    return null;
  }
}

/** Fallback join: type the code (the QR normally opens /play?room=CODE directly). */
function renderJoin(root: HTMLElement, badCode: string | null): void {
  root.innerHTML = `
    <main class="phone-page">
      <h1>Join a room</h1>
      <p class="muted">Scan the QR on the big screen with your camera, or type its 4-letter code.</p>
      <input id="code" class="code-input" maxlength="4" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="DAMU" enterkeyhint="go" />
      <button id="join" class="big-button primary" type="button">JOIN</button>
      <button id="scan" class="big-button" type="button">SCAN QR<small>Uses the camera in this page</small></button>
      <video id="scanner" playsinline muted hidden></video>
      <p id="msg" class="muted join-msg" role="alert"></p>
    </main>`;
  const input = root.querySelector<HTMLInputElement>('#code');
  const msg = root.querySelector<HTMLElement>('#msg');
  const joinBtn = root.querySelector<HTMLButtonElement>('#join');
  const show = (text: string): void => {
    if (msg) msg.textContent = text;
  };
  if (badCode) show(`"${badCode.slice(0, 12)}" is not a room code. Type the 4 letters from the big screen.`);
  const go = (code: string): void => window.location.assign(`/play?room=${code}`);
  const join = async (): Promise<void> => {
    const code = normalizeRoomCode(input?.value ?? '');
    if (!code) {
      show('A room code is 4 letters from the big screen (there is no I, L, O or Q).');
      return;
    }
    if (joinBtn) joinBtn.disabled = true;
    show('Checking...');
    const probe = await probeRoom(code);
    if (joinBtn) joinBtn.disabled = false;
    if (probe && !probe.exists) {
      show(`There is no room ${code}. Check the 4 letters on the big screen.`);
      return;
    }
    // A full room still opens: a phone that was already in it gets its old seat back.
    go(code);
  };
  joinBtn?.addEventListener('click', () => void join());
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void join();
  });
  let scanning = false;
  root.querySelector('#scan')?.addEventListener('click', () => {
    const video = root.querySelector<HTMLVideoElement>('#scanner');
    if (!video || scanning) return;
    scanning = true;
    video.hidden = false;
    // Loaded on demand: qr-scanner and its worker only download when someone taps SCAN.
    void import('../net/scanner.ts').then(({ createRoomScanner }) => {
      const scanner = createRoomScanner(video, go, (text) => {
        show(text);
        video.hidden = true;
        scanning = false;
        scanner.destroy();
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
        <div class="lobby-seat"><span id="seat-team"></span><b id="seat-role"></b></div>
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
      </section>
      <section id="resume" class="phone-overlay resume" hidden>
        <div class="big">MATCH ON</div>
        <div id="resume-seat"></div>
        <button id="resume-btn" class="big-button primary" type="button">TAP TO RESUME CONTROLS</button>
      </section>
      <section id="spectate" class="phone-overlay spectate" hidden>
        <div class="big">YOU'RE UP NEXT</div><div>The match is full or already running. You join at the next lobby.</div>
      </section>
      <section id="blocked" class="phone-overlay blocked" hidden>
        <div class="big" id="blocked-code-label"></div>
        <div id="blocked-text" class="blocked-text"></div>
        <button id="blocked-action" class="big-button primary" type="button"></button>
        <a id="blocked-other" class="chip" href="/play">Enter another code</a>
      </section>
      <button id="back-lobby" class="chip back-lobby" type="button" hidden>Back to lobby</button>
      <div id="hud" class="phone-hud" hidden></div>
      <div id="alert" class="phone-alert" hidden></div>
      <div id="rotate" class="rotate-overlay"><div>Turn your phone sideways<small>Hold it like a wheel, landscape</small></div></div>
      <div id="flash" class="phone-flash"></div>
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
  const seatTeam = $<HTMLElement>('#seat-team');
  const seatRole = $<HTMLElement>('#seat-role');
  const padsMount = $<HTMLElement>('#pads-mount');
  const rotateEl = $<HTMLElement>('#rotate');
  const flashEl = $<HTMLElement>('#flash');
  const enableBtn = $<HTMLButtonElement>('#enable');
  const resumeEl = $<HTMLElement>('#resume');
  const spectateEl = $<HTMLElement>('#spectate');
  const blockedEl = $<HTMLElement>('#blocked');
  const blockedAction = $<HTMLButtonElement>('#blocked-action');
  const backLobby = $<HTMLButtonElement>('#back-lobby');
  const invertBtn = $<HTMLButtonElement>('#invert');
  const themeMeta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
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
  let blocked: ErrView | null = null;
  let message = '';
  let messageTimer: number | null = null;
  /** Motion data arrived at least once on this page: a later silence is a stall, not "no sensors". */
  let sawMotion = false;
  let stallRestarts = 0;
  // Link state for the warning line, kept here (the client calls onLink from its own constructor).
  let sceneOnline = false;
  let lastHudAt = 0;
  let view: ViewState = computeView();
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
    const warn = linkWarning({
      online,
      // Before the welcome nobody knows; "Waiting for the big screen" comes from the welcome itself.
      sceneOnline: me.pid === null || sceneOnline,
      hudAgeMs: lastHudAt > 0 ? performance.now() - lastHudAt : null,
      hudStale: hud?.stale ?? false,
      playing: view.playing,
    });
    const text = message || warn;
    hintEl.textContent = text || (controller && phase === 'lobby' ? 'Controls on. Waiting for the host to start.' : '');
    if (alertEl.textContent !== text) alertEl.textContent = text;
    alertEl.hidden = text === '' || !view.playing;
  }

  const client = new PhoneClient(room, getPlayerToken(), nameInput.value, {
    onLink: (state: LinkState, detail?: string) => {
      online = state === 'online';
      // lastHudAt survives a reconnect on purpose: the warning stays until a HUD really arrives.
      statusEl.textContent = online ? '' : state === 'connecting' ? 'connecting...' : `offline${detail ? ` (${detail})` : ''}`;
      renderMessage();
    },
    onWelcome: (w) => {
      me.pid = w.pid;
      blocked = null;
      sceneOnline = w.sceneOnline;
      say(w.queued ? 'A match is running: you join at the next lobby.' : w.sceneOnline ? '' : 'Waiting for the big screen...');
      findMe();
      render();
    },
    onLobby: (l) => {
      lobby = l;
      findMe();
      setPhase(l.phase);
      render();
    },
    onHud: (h) => {
      // The Hud is per player and 10 Hz: it is the freshest word on our seat. The roster is only
      // sent on change, so after a reload or a quick reconnect it may never come.
      const seatChanged = h.team !== me.team || h.role !== me.role || h.hasPowers !== hud?.hasPowers || h.colour !== hud?.colour;
      hud = h;
      lastHudAt = performance.now();
      sceneOnline = true;
      me.team = h.team;
      me.role = h.role;
      setPhase(h.phase);
      if (seatChanged) render();
      renderHud(h);
      screens.onHud(h, view.playing);
      renderMessage();
    },
    onEvt: (e) => {
      screens.onEvt(e);
      if (e.kind === 'fired') haptic('fire', flashEl);
      if ((e.kind === 'hit' && e.detail !== 'landed') || e.kind === 'sunk') haptic('hit', flashEl);
    },
    onRoom: (r) => {
      sceneOnline = r.sceneOnline;
      if (!r.sceneOnline) lastHudAt = 0;
      renderMessage();
    },
    onError: (e) => {
      const v = describeErr(e.code, room);
      if (v.blocking) {
        blocked = v;
        render();
      } else say(v.text, v.ms);
    },
  });

  function computeView(): ViewState {
    return phoneView({ phase, hasPid: me.pid !== null, team: me.team, controller: controller !== null, trying, landscape, role: me.role, blocked: blocked !== null });
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
        ready = m.ready;
        return;
      }
    }
  }

  function teamSize(): 2 | 3 {
    return lobby?.teamSize ?? (hud?.hasPowers && hud.role === 'gunner' ? 2 : 3);
  }

  /**
   * The scene decides (Hud.hasPowers): a Gunner gets the power buttons whenever the crew has no
   * Engineer, which includes the 2-member crews of a 3+2+2 split in teams of 3. lobby.teamSize
   * alone would miss those. Until a Hud for this role arrives, only the Engineer has them.
   */
  function hasPowers(): boolean {
    if (hud && hud.team === me.team && hud.role === me.role) return hud.hasPowers;
    return me.role === 'engineer';
  }

  function teamColour(): string {
    if (hud && hud.team === me.team && me.team >= 0) return hud.colour;
    return me.team >= 0 ? (TEAM_COLOURS[me.team]?.hex ?? '#333') : '#333';
  }

  function teamName(): string {
    if (hud && hud.team === me.team && me.team >= 0) return hud.teamName;
    return TEAM_COLOURS[me.team]?.name ?? '';
  }

  function render(): void {
    view = computeView();
    const colour = teamColour();
    phoneEl.style.setProperty('--team', colour);
    themeMeta?.setAttribute('content', me.team >= 0 ? colour : '#0b1a24');
    phoneEl.dataset['role'] = me.role;
    phoneEl.dataset['phase'] = phase;
    $('#me-name').textContent = nameInput.value;
    const seat = me.team >= 0 ? `${teamName()} · ${ROLE_LABEL[me.role]}` : 'Waiting';
    $('#me-role').textContent = seat;
    // Role name in large type with the team name over it (SPEC section 3, "check at a glance").
    seatTeam.textContent = me.team >= 0 ? teamName().toUpperCase() : 'NO TEAM YET';
    seatRole.textContent = me.team >= 0 ? ROLE_LABEL[me.role] : 'WAITING';
    $('#resume-seat').textContent = me.team >= 0 ? seat : '';
    lobbyEl.hidden = !view.lobby;
    resumeEl.hidden = !view.resume;
    spectateEl.hidden = !view.spectate;
    padsMount.hidden = !view.playing;
    hudEl.hidden = !view.strip;
    backLobby.hidden = !view.backToLobby;
    blockedEl.hidden = blocked === null;
    if (blocked) {
      statusEl.textContent = ''; // the panel says why; "offline (io client disconnect)" would only confuse
      $('#blocked-code-label').textContent = room;
      $('#blocked-text').textContent = blocked.text;
      blockedAction.hidden = blocked.action === null;
      blockedAction.textContent = blocked.action === 'takeover' ? 'USE THIS PHONE' : blocked.action === 'reload' ? 'RELOAD' : 'TRY AGAIN';
      $('#blocked-other').hidden = !blocked.otherCode;
    }
    screens.setPlaying(view.playing, me.role);
    $('#ready').classList.toggle('on', ready);
    enableBtn.hidden = controller !== null;
    enableBtn.disabled = enabling;
    $('#after-enable').hidden = controller === null;
    invertBtn.hidden = me.role !== 'gunner';
    controller?.setRole(me.role, me.role === 'gunner' && hasPowers());
    controller?.setSuspended(view.suspended);
    rotateEl.classList.toggle('visible', view.rotate);
    renderMessage();
  }

  function renderHud(h: Hud): void {
    const parts = [`${PHASE_LABEL[h.phase]} ${clock(h.timeLeft)}`, `${h.teamName} K ${h.kills} · D ${h.deaths}`];
    if (h.protectedFor > 0) parts.push(`protected ${Math.ceil(h.protectedFor)}`);
    const text = parts.join('   ');
    if (hudEl.textContent !== text) hudEl.textContent = text;
  }

  // Sensor-driven parts of the role screen, every animation frame.
  const animate = (): void => {
    if (controller) screens.frame(me.role, controller.snapshot(), hud);
    requestAnimationFrame(animate);
  };
  requestAnimationFrame(animate);
  // The HUD-silence warning has no event of its own: re-check twice a second.
  window.setInterval(renderMessage, 500);

  nameInput.addEventListener('change', () => {
    const name = nameInput.value.trim().slice(0, 16);
    if (!name) return;
    setPlayerName(name);
    client.rename(name);
    render();
  });
  $('#swap-role').addEventListener('click', () => {
    const members = lobby?.teams.find((t) => t.index === me.team)?.members.length ?? 1;
    const next = nextRole(me.role, teamSize(), members);
    if (next === null) say('Nobody to swap with yet: you are alone in this team.', 3000);
    else client.swap(undefined, next);
  });
  $('#move-team').addEventListener('click', () => {
    if (!lobby || lobby.teams.length < 2) {
      say('Only one team so far.', 3000);
      return;
    }
    const next = nextTeam(lobby, me.team);
    if (next === null) say('Every other team is full.', 3000);
    else client.swap(next);
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
  blockedAction.addEventListener('click', () => {
    if (blocked?.action === 'reload') {
      window.location.reload();
      return;
    }
    blocked = null;
    say('Joining...', 4000);
    client.retry();
    render();
  });

  /**
   * Sensors went quiet while the page is visible (iOS after a lock sometimes stops devicemotion).
   * First restart the listeners; if that does not help, drop the controller so the player gets
   * the Enable / Tap to resume button, whose tap re-runs the permission flow.
   */
  function onSensorsStalled(): void {
    if (!controller) return;
    if (stallRestarts < 1) {
      stallRestarts += 1;
      controller.restartSensors();
      return;
    }
    controller.dispose();
    controller = null;
    say(SENSORS_STOPPED);
    render();
  }

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
        if (health === 'ok') {
          sawMotion = true;
          stallRestarts = 0;
          if (message === NO_MOTION || message === SENSORS_STOPPED) say('');
        } else if (health === 'no-events' && !sawMotion) say(NO_MOTION);
        else if (health === 'stalled' || health === 'no-events') onSensorsStalled();
      },
      onOrientation: (isLandscape) => {
        if (isLandscape === landscape) return;
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
        stallRestarts = 0;
        if (!c.enable.motion.ok) say(c.enable.motion.message);
        else if (message === SENSORS_STOPPED) say('');
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
