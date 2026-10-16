/**
 * SCENE mode (/scene): the projector PC. It is the game: simulation, rendering,
 * HUD, and the room the phones join. Track B owns this file.
 *
 *   relay --joined/left/in/swap/...-->  SceneClient  -->  Sim (src/sim)
 *   keyboard harness ------------------------------->  Sim.applyInput
 *   rAF: fixed 60 Hz Sim.step with an accumulator  ->  Renderer.render(state, events, layout, views, alpha)
 *   10 Hz: Hud per phone, lobby roster on change, gate on phase change
 */
import './scene.css';
import type { Layout } from '@shared/api.ts';
import { NET } from '@shared/protocol.ts';
import { SIM } from '@shared/config.ts';
import { getMap } from '@shared/map.ts';
import { SceneClient, publicJoinUrl } from '../net/sceneClient.ts';
import { InputHold } from '../net/inputHold.ts';
import { renderJoinQr, joinUrlLooksLocal } from '../net/qr.ts';
import { createSim } from '../sim/index.ts';
import { createRenderer } from '../render/index.ts';
import { computeLayout } from './layout.ts';
import { KeyboardHarness } from './keyboard.ts';
import { SceneHud, type HostAction, type HudInfo } from './hud.ts';
import { LobbySync, buildHuds, forwardEvents } from './phoneFeed.ts';
import { CameraViews } from './views.ts';

export async function startScene(root: HTMLElement): Promise<void> {
  root.innerHTML = `<div class="scene"><canvas class="gl"></canvas><div class="hud"></div></div>`;
  const canvas = root.querySelector<HTMLCanvasElement>('canvas.gl');
  const hudRoot = root.querySelector<HTMLElement>('.hud');
  if (!canvas || !hudRoot) throw new Error('scene markup missing');

  const map = getMap();
  const sim = await createSim(map);
  const renderer = createRenderer(canvas, map);
  const hold = new InputHold();
  const lobbySync = new LobbySync();
  const cameraViews = new CameraViews();
  const shieldFlashUntil = new Map<number, number>();
  const info: HudInfo = {
    code: null,
    joinUrl: null,
    urlLooksLocal: false,
    link: 'Connecting to the relay...',
    canStart: sim.canStart(),
    stale: new Set(),
    focus: 0,
    views: [],
    shieldFlashUntil,
  };
  // Host buttons on the big screen; the keyboard keys do the same (B8).
  const onAction = (action: HostAction, pid?: string): void => {
    switch (action) {
      case 'start':
        if (sim.state.phase === 'lobby') sim.start();
        break;
      case 'teamSize':
        sim.setTeamSize(sim.state.teamSize === 3 ? 2 : 3);
        break;
      case 'addBot':
        sim.debug.addBotTeam();
        break;
      case 'addKeyboard':
        addKeyboardCrew();
        break;
      case 'rematch':
        if (sim.state.phase === 'results') sim.rematch();
        break;
      case 'newLobby':
        sim.newLobby();
        break;
      case 'kick': {
        const p = pid ? sim.state.players[pid] : undefined;
        if (!p || !pid) break;
        // Phones go through the relay (it confirms with `left`); keyboard and bot seats live only here.
        if (p.virtual) sim.removePlayer(pid);
        else net.kick(pid);
        break;
      }
    }
  };
  const hud = new SceneHud(hudRoot, map, onAction);

  const net = new SceneClient({
    onLink: (state, detail) => {
      info.link = state === 'online' ? 'Relay online' : `Relay ${state}${detail ? `: ${detail}` : ''} (is \`npm run dev\` running?)`;
    },
    onRoom: (r) => {
      info.code = r.code;
      info.joinUrl = publicJoinUrl(r.code);
      info.urlLooksLocal = joinUrlLooksLocal(info.joinUrl);
      void renderJoinQr(r.code, hud.qrCanvas, 360);
      // After a scene reload the relay still holds the phones: seat them again.
      for (const p of r.players) {
        sim.addPlayer(p.pid, p.name);
        sim.setConnected(p.pid, p.connected);
      }
      lobbySync.invalidate();
    },
    // A rejoin into the same seat leaves the roster unchanged: resend it anyway, or the phone waits forever.
    onJoined: (m) => {
      sim.addPlayer(m.pid, m.name);
      lobbySync.invalidate();
    },
    onReconnected: (m) => {
      sim.addPlayer(m.pid, m.name);
      lobbySync.invalidate();
    },
    onLeft: (m) => {
      lobbySync.invalidate();
      if (m.reason === 'disconnect') {
        sim.setConnected(m.pid, false);
        return;
      }
      sim.removePlayer(m.pid);
      hold.forget(m.pid);
    },
    onInput: (pid, m) => {
      if (hold.offer(pid, m)) sim.applyInput(pid, m);
    },
    onSwap: (pid, m) => sim.applyMessage(pid, m),
    onReady: (pid, m) => sim.applyMessage(pid, m),
    onCalibrate: (pid, m) => sim.applyMessage(pid, m),
    onRename: (pid, m) => sim.applyMessage(pid, m),
  });

  let kbCrews = 0;
  const addKeyboardCrew = (): void => {
    if (sim.state.phase !== 'lobby' || sim.state.teams.length >= 6) return;
    const team = sim.state.teams.length;
    kbCrews += 1;
    sim.addPlayer(`kb-${kbCrews}-pilot`, `Keys ${kbCrews}P`, { virtual: true, team, role: 'pilot' });
    sim.addPlayer(`kb-${kbCrews}-gunner`, `Keys ${kbCrews}G`, { virtual: true, team, role: 'gunner' });
    keyboard.focus = team;
  };
  const keyboard = new KeyboardHarness(sim, {
    start: () => {
      if (sim.state.phase === 'lobby') sim.start();
      else if (sim.state.phase === 'results') sim.rematch();
    },
    pause: () => sim.pause(!sim.state.paused),
    toLobby: () => sim.newLobby(),
    addKeyboardCrew,
    addBotTeam: () => void sim.debug.addBotTeam(),
    toggleTeamSize: () => sim.setTeamSize(sim.state.teamSize === 3 ? 2 : 3),
  });
  window.addEventListener('pointerdown', () => renderer.unlockAudio(), { once: true });
  // Dev console handle: gr.sim.state, gr.sim.debug.giveWeapon(0, 'cannon'), ...
  if (import.meta.env.DEV) Object.assign(window, { gr: { sim, renderer, net, hold } });

  // ---- layout (fixed during a round: team count cannot change outside the lobby)
  let layout: Layout = computeLayout(1, window.innerWidth, window.innerHeight);
  let layoutKey = '';
  const resize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.width = w;
    canvas.height = h;
    renderer.resize(w, h);
    layoutKey = '';
  };
  window.addEventListener('resize', resize);
  resize();

  // ---- 10 Hz: phone HUDs, roster on change, gate on phase change
  let lastGate = '';
  net.startHudLoop(() => buildHuds(sim.state, new Set(hold.droppedPids())));
  window.setInterval(() => {
    if (net.code) {
      const lobby = lobbySync.take(sim.lobbySnapshot());
      if (lobby) net.sendLobby(lobby);
    }
    const locked = sim.state.phase !== 'lobby';
    const gate = `${locked}`;
    if (gate !== lastGate && net.code) {
      lastGate = gate;
      net.setGate({ max: NET.maxPlayers, locked, late: 'queue' });
    }
    info.canStart = sim.canStart();
    info.stale = new Set(hold.droppedPids());
    info.focus = keyboard.focus;
    info.views = cameraViews.update(sim.state);
    hud.update(sim.state, layout, info);
  }, 100);

  // ---- the loop
  let acc = 0;
  let last = performance.now();
  const frame = (now: number): void => {
    const dt = Math.min(0.25, (now - last) / 1000);
    last = now;
    keyboard.update(dt);
    acc += dt;
    let steps = 0;
    while (acc >= SIM.dt && steps < SIM.maxStepsPerFrame) {
      sim.step(SIM.dt);
      acc -= SIM.dt;
      steps++;
    }
    if (steps === SIM.maxStepsPerFrame) acc = 0; // spiral-of-death guard
    const events = sim.drainEvents();
    forwardEvents(sim.state, events, (pid, evt) => net.sendEvt(pid, evt));
    for (const e of events) if (e.kind === 'shielded') shieldFlashUntil.set(e.team, now + 450);

    const teams = sim.state.teams.length;
    const key = `${teams}:${window.innerWidth}x${window.innerHeight}`;
    if (key !== layoutKey) {
      layoutKey = key;
      layout = computeLayout(Math.max(1, teams), window.innerWidth, window.innerHeight);
    }
    renderer.render(sim.state, events, layout, cameraViews.update(sim.state), acc / SIM.dt);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
