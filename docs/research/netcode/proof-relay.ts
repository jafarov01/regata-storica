// Proof script: socket.io 4.8.4 relay patterns on node 24 via tsx.
// Starts express 5 + socket.io on port 0, connects a scene + two players,
// asserts forwarding via io.to / socket.to / volatile, socket.data, rooms,
// connectionStateRecovery `recovered` flag, and express 5 wildcard fallback.
import express from 'express';
import { createServer } from 'node:http';
import { Server, type Socket as ServerSocket } from 'socket.io';
import { io as ioc, type Socket as ClientSocket } from 'socket.io-client';
import type { AddressInfo } from 'node:net';

type Kind = 'scene' | 'player';
interface SocketData { kind?: Kind; room?: string; pid?: string }
interface C2S {
  host: (ack: (res: { code: string }) => void) => void;
  hello: (msg: { room: string; token: string; name: string }, ack: (res: { pid: string } | { err: string }) => void) => void;
  in: (msg: { seq: number; v: number }) => void;
  hud: (pid: string, msg: { ammo: number }) => void;
  lobby: (msg: { n: number }) => void;
}
interface S2C {
  in: (pid: string, msg: { seq: number; v: number }) => void;
  hud: (msg: { ammo: number }) => void;
  lobby: (msg: { n: number }) => void;
  joined: (pid: string) => void;
}

const app = express();
app.get('/api/health', (_req, res) => { res.json({ ok: true }); });
// express 5 / path-to-regexp 8: named wildcard, braces make it optional so '/' matches too.
app.get('/{*splat}', (req, res) => { res.type('html').send(`<spa path="${req.path}">`); });
const http = createServer(app);
const io = new Server<C2S, S2C, Record<string, never>, SocketData>(http, {
  transports: ['websocket'],
  connectionStateRecovery: { maxDisconnectionDuration: 120_000, skipMiddlewares: true },
  maxHttpBufferSize: 4096,
});

const rooms = new Map<string, { scene: ServerSocket<C2S, S2C, Record<string, never>, SocketData>; players: Map<string, string> }>();

io.on('connection', (socket) => {
  socket.on('host', (ack) => {
    const code = 'RIVA';
    socket.data.kind = 'scene';
    socket.data.room = code;
    void socket.join(`${code}:scene`);
    rooms.set(code, { scene: socket, players: new Map() });
    ack({ code });
  });
  socket.on('hello', (msg, ack) => {
    const room = rooms.get(msg.room);
    if (!room) { ack({ err: 'no_room' }); return; }
    const pid = `p${room.players.size + 1}`;
    room.players.set(msg.token, pid);
    socket.data.kind = 'player'; socket.data.room = msg.room; socket.data.pid = pid;
    void socket.join([`${msg.room}:players`, `${msg.room}:${pid}`]);
    room.scene.emit('joined', pid);
    ack({ pid });
  });
  socket.on('in', (msg) => {
    const { room, pid } = socket.data;
    if (!room || !pid) return;
    io.to(`${room}:scene`).volatile.emit('in', pid, msg);
  });
  socket.on('hud', (pid, msg) => {
    const { room } = socket.data;
    if (!room) return;
    io.to(`${room}:${pid}`).emit('hud', msg);
  });
  socket.on('lobby', (msg) => {
    const { room } = socket.data;
    if (!room) return;
    io.to(`${room}:players`).emit('lobby', msg);
  });
});

function once<T>(s: ClientSocket, ev: string): Promise<T> {
  return new Promise((resolve) => { s.once(ev as never, ((...a: unknown[]) => resolve(a as T)) as never); });
}

setTimeout(() => { console.error("WATCHDOG TIMEOUT"); process.exit(2); }, 40_000);
await new Promise<void>((r) => http.listen(0, r));
const port = (http.address() as AddressInfo).port;
const url = `http://localhost:${port}`;
console.log('listening', url);

// express 5 wildcard check
const h = await (await fetch(`${url}/api/health`)).json();
const spaRoot = await (await fetch(`${url}/`)).text();
const spaScene = await (await fetch(`${url}/scene`)).text();
const spaPlay = await (await fetch(`${url}/play?room=RIVA`)).text();
console.log('health', h, '| / ->', spaRoot, '| /scene ->', spaScene, '| /play ->', spaPlay);

const scene: ClientSocket<S2C, C2S> = ioc(url, { transports: ['websocket'] });
const p1: ClientSocket<S2C, C2S> = ioc(url, { transports: ['websocket'], forceNew: true });
const p2: ClientSocket<S2C, C2S> = ioc(url, { transports: ['websocket'], forceNew: true });
await Promise.all([once(scene, 'connect'), once(p1, 'connect'), once(p2, 'connect')]);

const { code } = await scene.emitWithAck('host');
console.log('room code', code);
const w1 = await p1.emitWithAck('hello', { room: code, token: 't1', name: 'Marco' });
const w2 = await p2.emitWithAck('hello', { room: code, token: 't2', name: 'Anna' });
console.log('welcome', w1, w2);
const bad = await p2.emitWithAck('hello', { room: 'ZZZZ', token: 't2', name: 'Anna' });
console.log('bad room ->', bad);

// input forwarding with volatile
const gotIn = once<[string, { seq: number; v: number }]>(scene, 'in');
p1.volatile.emit('in', { seq: 1, v: 1 });
console.log('scene got input', await gotIn);

// hud to one player only
let p2got = 0;
p2.on('hud', () => { p2got++; });
const gotHud = once<[{ ammo: number }]>(p1, 'hud');
scene.emit('hud', 'p1', { ammo: 5 });
console.log('p1 got hud', await gotHud, 'p2 count', p2got);

// lobby broadcast to all players, not the scene
let sceneGotLobby = 0;
scene.on('lobby', () => { sceneGotLobby++; });
const l1 = once(p1, 'lobby'); const l2 = once(p2, 'lobby');
scene.emit('lobby', { n: 2 });
console.log('lobby both', await l1, await l2, 'scene count', sceneGotLobby);

// oversized packet: > maxHttpBufferSize closes the connection
const dis = once<[string]>(p2, 'disconnect');
p2.emit('in', { seq: 2, v: 'x'.repeat(10_000) as unknown as number });
console.log('oversize ->', await dis);

// connection state recovery: simulate a dropped transport on p1
const serverSideP1 = [...io.sockets.sockets.values()].find((s) => s.data.pid === 'p1');
console.log('server data p1', serverSideP1?.data, 'rooms', serverSideP1 ? [...serverSideP1.rooms] : null);
const reconn = once<[]>(p1, 'connect');
const oldId = p1.id;
p1.io.engine.close();
await reconn;
console.log('old id', oldId);
console.log('p1 recovered?', p1.recovered, 'id same?', p1.id);
const serverSideP1b = [...io.sockets.sockets.values()].find((s) => s.data.pid === 'p1');
console.log('server socket recovered?', serverSideP1b?.recovered, 'data', serverSideP1b?.data, 'rooms', serverSideP1b ? [...serverSideP1b.rooms] : null);

// disconnect reasons when the server kicks
const kicked = once<[string]>(p1, 'disconnect');
serverSideP1b?.disconnect(true);
console.log('kicked reason', await kicked, 'active?', p1.active);

scene.close(); p1.close(); p2.close();
await io.close();
console.log("OK"); process.exit(0);
