import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from 'socket.io';
import { io as ioc, type Socket as ClientSocket } from 'socket.io-client';

interface C2S { host: (ack: (code: string) => void) => void; hello: (room: string, ack: (pid: string) => void) => void; in: (seq: number) => void }
interface S2C { in: (pid: string, seq: number) => void }

let http: HttpServer;
let io: Server<C2S, S2C>;
let url = '';
const clients: ClientSocket[] = [];

function connect(): ClientSocket<S2C, C2S> {
  const s = ioc(url, { transports: ['websocket'], forceNew: true });
  clients.push(s);
  return s;
}
function waitFor<T extends unknown[]>(s: ClientSocket, ev: string): Promise<T> {
  return new Promise((resolve) => s.once(ev as never, ((...a: unknown[]) => resolve(a as T)) as never));
}

beforeAll(async () => {
  http = createServer();
  io = new Server<C2S, S2C>(http, { transports: ['websocket'] });
  let sceneId = '';
  io.on('connection', (socket) => {
    socket.on('host', (ack) => { sceneId = socket.id; void socket.join('RIVA:scene'); ack('RIVA'); });
    socket.on('hello', (_room, ack) => { void socket.join('RIVA:players'); ack(`p-${socket.id.slice(0, 4)}`); });
    socket.on('in', (seq) => { io.to('RIVA:scene').volatile.emit('in', socket.id, seq); void sceneId; });
  });
  await new Promise<void>((r) => http.listen(0, r));
  url = `http://localhost:${(http.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const c of clients) c.disconnect();
  await io.close();
});

describe('relay', () => {
  it('forwards a player input to the scene socket', async () => {
    const scene = connect();
    const player = connect();
    await Promise.all([waitFor(scene, 'connect'), waitFor(player, 'connect')]);
    expect(await scene.emitWithAck('host')).toBe('RIVA');
    expect(await player.emitWithAck('hello', 'RIVA')).toMatch(/^p-/);
    const got = waitFor<[string, number]>(scene, 'in');
    player.volatile.emit('in', 7);
    const [pid, seq] = await got;
    expect(pid).toBe(player.id);
    expect(seq).toBe(7);
  });
});
