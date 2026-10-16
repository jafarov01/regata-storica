// 18 fake phones at 30 Hz for 5 s + scene HUD fan-out at 10 Hz. Measures loss and relay latency on localhost.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as ioc, type Socket } from 'socket.io-client';
import { createRelay } from './server/relay.ts';
import { PROTOCOL_VERSION, type ClientToServerEvents, type ServerToClientEvents, type Hud, type InputMsg } from '@shared/protocol.ts';

type C = Socket<ServerToClientEvents, ClientToServerEvents>;
const http = createServer();
const relay = createRelay(http, { log: () => undefined });
await new Promise<void>((r) => http.listen(0, r));
const url = `http://localhost:${(http.address() as AddressInfo).port}`;
const mk = (): C => ioc(url, { transports: ['websocket'], forceNew: true, auth: { v: PROTOCOL_VERSION } });
const connected = (s: C): Promise<void> => new Promise((r) => s.once('connect', () => r()));

const scene = mk();
await connected(scene);
const room = await scene.emitWithAck('host', { t: 'host', v: PROTOCOL_VERSION });
if (room.t !== 'room') throw new Error('host failed');
const N = 18;
const phones: C[] = [];
for (let i = 0; i < N; i++) {
  const p = mk();
  await connected(p);
  await p.emitWithAck('hello', { t: 'hello', v: PROTOCOL_VERSION, room: room.code, token: `token-${String(i).padStart(8, '0')}`, name: `P${i}` });
  phones.push(p);
}

const sentAt = new Map<string, number>();
let received = 0;
const lat: number[] = [];
scene.on('in', (pid, m: InputMsg) => {
  received++;
  const t0 = sentAt.get(`${pid}:${m.seq}`);
  if (t0 !== undefined) lat.push(performance.now() - t0);
});
let hudGot = 0;
for (const p of phones) p.on('hud', () => void hudGot++);

const seqs = new Array<number>(N).fill(0);
let sent = 0;
const timers = phones.map((p, i) =>
  setInterval(() => {
    const seq = ++seqs[i]!;
    const m: InputMsg = { t: 'in', seq, role: 'pilot', steer: Math.sin(seq / 10), gas: true, brake: false };
    sentAt.set(`p${i + 1}:${seq}`, performance.now());
    sent++;
    p.volatile.emit('in', m);
  }, 1000 / 30),
);
let hudSent = 0;
const hudTimer = setInterval(() => {
  for (let i = 0; i < N; i++) {
    const h: Hud = { t: 'hud', phase: 'battle', team: i % 6, role: 'pilot', kills: 0, deaths: 0, respawnIn: 0, weapon: 'cannon', ammo: 5, powers: [null, null], water: 0, alive: true };
    scene.emit('hud', `p${i + 1}`, h);
    hudSent++;
  }
}, 100);

await new Promise((r) => setTimeout(r, 5000));
for (const t of timers) clearInterval(t);
clearInterval(hudTimer);
await new Promise((r) => setTimeout(r, 300));
lat.sort((a, b) => a - b);
const q = (p: number): string => (lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] ?? 0).toFixed(2);
console.log(`inputs: sent ${sent}, scene received ${received}, loss ${(100 * (1 - received / sent)).toFixed(2)}%`);
console.log(`relay one-hop latency ms (phone->relay->scene, localhost): p50 ${q(0.5)} p90 ${q(0.9)} p99 ${q(0.99)} max ${q(1)}`);
console.log(`huds: scene sent ${hudSent}, phones received ${hudGot}, loss ${(100 * (1 - hudGot / hudSent)).toFixed(2)}%`);
for (const p of phones) p.disconnect();
scene.disconnect();
await relay.close();
process.exit(0);
