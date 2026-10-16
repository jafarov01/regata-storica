/**
 * Relay integration tests: a real socket.io server on port 0, real socket.io-client sockets.
 * No phones needed. Run with `npm test` (vitest 5, node environment).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as ioc, type Socket } from 'socket.io-client';
import { createRelay, type Relay } from '../server/relay.ts';
import { RoomRegistry } from '../server/rooms.ts';
import {
  PROTOCOL_VERSION,
  type ClientToServerEvents,
  type Hud,
  type InputMsg,
  type Lobby,
  type PlayerJoined,
  type PlayerLeft,
  type PlayerReconnected,
  type ServerToClientEvents,
  type Welcome,
  type Err,
  type RoomCreated,
} from '@shared/protocol.ts';

type C = Socket<ServerToClientEvents, ClientToServerEvents>;

let http: HttpServer;
let relay: Relay;
let url = '';
let now = 1_000_000;
const clients: C[] = [];

function connect(v: number = PROTOCOL_VERSION): C {
  const s: C = ioc(url, { transports: ['websocket'], forceNew: true, auth: { v }, reconnection: false });
  clients.push(s);
  return s;
}

function connected(s: C): Promise<void> {
  return new Promise((resolve, reject) => {
    s.once('connect', () => resolve());
    s.once('connect_error', (e) => reject(e));
  });
}

/** Resolves with the arguments of the next `ev` event. */
function next<Ev extends keyof ServerToClientEvents>(s: C, ev: Ev): Promise<Parameters<ServerToClientEvents[Ev]>> {
  return new Promise((resolve) => {
    const listener = (event: string, ...args: unknown[]): void => {
      if (event !== ev) return;
      s.offAny(listener);
      resolve(args as Parameters<ServerToClientEvents[Ev]>);
    };
    s.onAny(listener);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const hud: Hud = {
  t: 'hud', phase: 'battle', team: 0, role: 'pilot', teamName: 'Rosso', colour: '#e04a3a', kills: 1, deaths: 0, respawnIn: 0,
  sunkBy: null, weapon: 'cannon', ammo: 5, powers: [null, null], water: 0, alive: true, protectedFor: 0, timeLeft: 120,
  aimRel: 0, onTarget: false, locked: false, hasPowers: false, bail: false, stale: false,
};
const lobby: Lobby = { t: 'lobby', phase: 'lobby', teamSize: 2, teams: [], spectators: [] };
const pilotIn = (seq: number): InputMsg => ({ t: 'in', seq, role: 'pilot', steer: 0.5, gas: true, brake: false });

async function hostRoom(scene: C): Promise<RoomCreated> {
  const res = await scene.emitWithAck('host', { t: 'host', v: PROTOCOL_VERSION });
  if (res.t !== 'room') throw new Error(`host refused: ${res.code}`);
  return res;
}

async function joinRoom(phone: C, room: string, token: string, name = 'Bepi'): Promise<Welcome | Err> {
  return phone.emitWithAck('hello', { t: 'hello', v: PROTOCOL_VERSION, room, token, name });
}

beforeEach(async () => {
  http = createServer();
  const registry = new RoomRegistry({ now: () => now, sceneGraceMs: 1000, playerGraceMs: 1000 });
  relay = createRelay(http, { registry, log: () => undefined, sweepIntervalMs: 50 });
  await new Promise<void>((r) => http.listen(0, r));
  url = `http://localhost:${(http.address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.disconnect();
  await relay.close();
});

describe('relay', () => {
  it('creates a room with a 4-letter code and refuses a bad protocol version', async () => {
    const scene = connect();
    await connected(scene);
    const room = await hostRoom(scene);
    expect(room.code).toMatch(/^[ABCDEFGHJKMNPRSTUVWXYZ]{4}$/);
    expect(room.reclaimed).toBe(false);
    expect(room.sceneToken.length).toBeGreaterThan(8);

    const old = connect(0);
    await expect(connected(old)).rejects.toMatchObject({ message: 'bad_version' });
  });

  it('forwards inputs to the scene tagged with the pid, and HUD to one phone only', async () => {
    const scene = connect();
    const p1 = connect();
    const p2 = connect();
    await Promise.all([connected(scene), connected(p1), connected(p2)]);
    const { code } = await hostRoom(scene);

    const joined1 = next(scene, 'joined');
    const w1 = await joinRoom(p1, code, 'token-1111', 'Bepi');
    const w2 = await joinRoom(p2, code, 'token-2222', 'Nane');
    expect(w1.t).toBe('welcome');
    expect(w2.t).toBe('welcome');
    const [j1] = await joined1;
    expect(j1).toMatchObject<Partial<PlayerJoined>>({ pid: 'p1', name: 'Bepi', queued: false });

    const got = next(scene, 'in');
    p1.volatile.emit('in', pilotIn(1));
    const [pid, msg] = await got;
    expect(pid).toBe('p1');
    expect(msg).toEqual(pilotIn(1));

    let p2Huds = 0;
    p2.on('hud', () => void p2Huds++);
    const hudP1 = next(p1, 'hud');
    scene.emit('hud', 'p1', hud);
    expect((await hudP1)[0]).toEqual(hud);

    const l1 = next(p1, 'lobby');
    const l2 = next(p2, 'lobby');
    scene.emit('lobby', lobby);
    expect((await l1)[0]).toEqual(lobby);
    expect((await l2)[0]).toEqual(lobby);
    expect(p2Huds).toBe(0);
  });

  it('forwards a character pick to the scene, and drops a malformed one', async () => {
    const scene = connect();
    const p1 = connect();
    await Promise.all([connected(scene), connected(p1)]);
    const { code } = await hostRoom(scene);
    await joinRoom(p1, code, 'token-3333', 'Bepi');
    const seen: unknown[] = [];
    scene.on('character', (pid, msg) => void seen.push([pid, msg]));
    p1.emit('character', { t: 'character', id: '<b>bad</b>' });
    const got = next(scene, 'character');
    p1.emit('character', { t: 'character', id: 'justin-simon' });
    expect(await got).toEqual(['p1', { t: 'character', id: 'justin-simon' }]);
    expect(seen).toEqual([['p1', { t: 'character', id: 'justin-simon' }]]);
  });

  it('clamps and drops malformed inputs', async () => {
    const scene = connect();
    const p1 = connect();
    await Promise.all([connected(scene), connected(p1)]);
    const { code } = await hostRoom(scene);
    await joinRoom(p1, code, 'token-1111');

    const received: InputMsg[] = [];
    scene.on('in', (_pid, m) => void received.push(m));
    p1.emit('in', { t: 'in', seq: 1, role: 'pilot', steer: 7, gas: 'yes', brake: false } as unknown as InputMsg);
    p1.emit('in', { t: 'in', seq: 2, role: 'pilot', steer: Number.NaN, gas: true, brake: false } as unknown as InputMsg);
    p1.emit('in', { t: 'in', seq: 3, role: 'gunner', dYaw: 0.1, yaw: 1, ep: 0, fire: true, fc: 1, recenter: false, use: null, uc: 0 });
    await sleep(50);
    expect(received).toEqual([
      { t: 'in', seq: 1, role: 'pilot', steer: 1, gas: false, brake: false },
      { t: 'in', seq: 3, role: 'gunner', dYaw: 0.1, yaw: 1, ep: 0, fire: true, fc: 1, recenter: false, use: null, uc: 0 },
    ]);
  });

  it('delivers a same-tick burst from one phone to the scene complete and in order', async () => {
    const scene = connect();
    const p1 = connect();
    await Promise.all([connected(scene), connected(p1)]);
    const { code } = await hostRoom(scene);
    await joinRoom(p1, code, 'token-1111');
    const seqs: number[] = [];
    scene.on('in', (_pid, m) => void seqs.push(m.seq));
    for (let i = 1; i <= 10; i++) p1.emit('in', pilotIn(i));
    await sleep(80);
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('fans one scene HUD loop out to every phone in the same tick', async () => {
    const scene = connect();
    const phones = [connect(), connect(), connect()];
    await Promise.all([connected(scene), ...phones.map(connected)]);
    const { code } = await hostRoom(scene);
    await Promise.all(phones.map((p, i) => joinRoom(p, code, `token-${i}${i}${i}${i}${i}${i}${i}${i}`)));
    const got = phones.map((p) => next(p, 'hud'));
    for (let i = 0; i < phones.length; i++) scene.emit('hud', `p${i + 1}`, { ...hud, team: i });
    const huds = await Promise.all(got);
    expect(huds.map((h) => h[0].team)).toEqual([0, 1, 2]);
  });

  it('rejoins the same slot with the same token and tells the scene', async () => {
    const scene = connect();
    const p1 = connect();
    await Promise.all([connected(scene), connected(p1)]);
    const { code } = await hostRoom(scene);
    const w1 = await joinRoom(p1, code, 'token-1111', 'Bepi');
    expect(w1).toMatchObject({ pid: 'p1', rejoined: false });

    const left = next(scene, 'left');
    p1.disconnect();
    expect((await left)[0]).toMatchObject<Partial<PlayerLeft>>({ pid: 'p1', reason: 'disconnect' });

    const again = connect();
    await connected(again);
    const re = next(scene, 'reconnected');
    const w2 = await joinRoom(again, code, 'token-1111', 'Bepi');
    expect(w2).toMatchObject({ pid: 'p1', rejoined: true });
    expect((await re)[0]).toMatchObject<Partial<PlayerReconnected>>({ pid: 'p1' });

    // a second device with the same token replaces the first
    const twin = connect();
    await connected(twin);
    const replaced = next(again, 'err');
    await joinRoom(twin, code, 'token-1111', 'Bepi');
    expect((await replaced)[0]).toMatchObject({ code: 'replaced' });
  });

  it('explicit leave frees the slot: the next hello is a fresh join', async () => {
    const scene = connect();
    const p1 = connect();
    await Promise.all([connected(scene), connected(p1)]);
    const { code } = await hostRoom(scene);
    await joinRoom(p1, code, 'token-1111');
    const left = next(scene, 'left');
    p1.emit('leave', { t: 'leave' });
    expect((await left)[0]).toMatchObject({ pid: 'p1', reason: 'leave' });
    const w = await joinRoom(p1, code, 'token-1111');
    expect(w).toMatchObject({ pid: 'p2', rejoined: false });
  });

  it('enforces the gate: full room and locked match', async () => {
    const scene = connect();
    await connected(scene);
    const { code } = await hostRoom(scene);
    scene.emit('gate', { t: 'gate', max: 1, locked: false, late: 'queue' });
    await sleep(20);
    const a = connect();
    const b = connect();
    await Promise.all([connected(a), connected(b)]);
    expect((await joinRoom(a, code, 'token-aaaa')).t).toBe('welcome');
    expect(await joinRoom(b, code, 'token-bbbb')).toMatchObject({ t: 'err', code: 'room_full' });

    scene.emit('gate', { t: 'gate', max: 18, locked: true, late: 'queue' });
    await sleep(20);
    expect(await joinRoom(b, code, 'token-bbbb')).toMatchObject({ t: 'welcome', queued: true });

    scene.emit('gate', { t: 'gate', max: 18, locked: true, late: 'reject' });
    await sleep(20);
    const c = connect();
    await connected(c);
    expect(await joinRoom(c, code, 'token-cccc')).toMatchObject({ t: 'err', code: 'match_running' });
    expect(await joinRoom(c, 'ZZZZ', 'token-cccc')).toMatchObject({ t: 'err', code: 'no_room' });
  });

  it('a phone queued during a match is no longer queued once the scene unlocks the gate', async () => {
    const scene = connect();
    const p = connect();
    await Promise.all([connected(scene), connected(p)]);
    const { code } = await hostRoom(scene);
    scene.emit('gate', { t: 'gate', max: 18, locked: true, late: 'queue' });
    await sleep(20);
    expect(await joinRoom(p, code, 'token-late')).toMatchObject({ t: 'welcome', queued: true });
    scene.emit('gate', { t: 'gate', max: 18, locked: false, late: 'queue' });
    await sleep(20);
    // Rejoin after a lock/unlock of the phone: same slot, and not told to wait again.
    expect(await joinRoom(p, code, 'token-late')).toMatchObject({ t: 'welcome', pid: 'p1', rejoined: true, queued: false });
  });

  it('a socket cannot be scene and phone at once', async () => {
    const scene = connect();
    const p = connect();
    await Promise.all([connected(scene), connected(p)]);
    const { code } = await hostRoom(scene);
    expect(await joinRoom(scene, code, 'token-scene')).toMatchObject({ t: 'err', code: 'bad_hello' });
    expect((await joinRoom(p, code, 'token-pppp')).t).toBe('welcome');
    expect(await p.emitWithAck('host', { t: 'host', v: PROTOCOL_VERSION })).toMatchObject({ t: 'err', code: 'bad_hello' });
    // The scene still owns its room and still gets inputs.
    const got = next(scene, 'in');
    p.emit('in', pilotIn(1));
    expect((await got)[0]).toBe('p1');
  });

  it('scene reload: phones see the big screen go away and come back, the room is re-claimed', async () => {
    const scene = connect();
    const p1 = connect();
    await Promise.all([connected(scene), connected(p1)]);
    const room = await hostRoom(scene);
    await joinRoom(p1, room.code, 'token-1111');

    const offline = next(p1, 'room');
    scene.disconnect();
    expect((await offline)[0]).toEqual({ t: 'room', sceneOnline: false });

    const scene2 = connect();
    await connected(scene2);
    const online = next(p1, 'room');
    const res = await scene2.emitWithAck('host', { t: 'host', v: PROTOCOL_VERSION, code: room.code, sceneToken: room.sceneToken });
    expect(res).toMatchObject({ t: 'room', code: room.code, reclaimed: true, players: [{ pid: 'p1', connected: true }] });
    expect((await online)[0]).toEqual({ t: 'room', sceneOnline: true });

    const got = next(scene2, 'in');
    p1.emit('in', pilotIn(1));
    expect((await got)[0]).toBe('p1');

    const wrong = connect();
    await connected(wrong);
    expect(await wrong.emitWithAck('host', { t: 'host', v: PROTOCOL_VERSION, code: room.code, sceneToken: 'not-the-token' })).toMatchObject({ code: 'no_room' });

    // a duplicated scene tab re-claims while scene2 is still live: scene2 is replaced and stops receiving inputs
    const scene3 = connect();
    await connected(scene3);
    const replaced = next(scene2, 'err');
    const res3 = await scene3.emitWithAck('host', { t: 'host', v: PROTOCOL_VERSION, code: room.code, sceneToken: room.sceneToken });
    expect(res3).toMatchObject({ t: 'room', reclaimed: true });
    expect((await replaced)[0]).toMatchObject({ code: 'replaced' });
    let scene2Inputs = 0;
    scene2.on('in', () => void scene2Inputs++);
    const got3 = next(scene3, 'in');
    p1.emit('in', pilotIn(2));
    expect((await got3)[0]).toBe('p1');
    expect(scene2Inputs).toBe(0);
  });

  it('closes the room after the scene grace period and tells the phones', async () => {
    const scene = connect();
    const p1 = connect();
    await Promise.all([connected(scene), connected(p1)]);
    const room = await hostRoom(scene);
    await joinRoom(p1, room.code, 'token-1111');
    const offline = next(p1, 'room');
    const closed = next(p1, 'err');
    scene.disconnect();
    await offline; // the relay has recorded sceneLeftAt; now let the fake clock pass the grace period
    now += 1001;
    expect((await closed)[0]).toMatchObject({ code: 'room_closed' });
    expect(relay.registry.get(room.code)).toBeUndefined();
    expect(await joinRoom(p1, room.code, 'token-1111')).toMatchObject({ code: 'no_room' });
  });
});
