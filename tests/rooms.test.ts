import { describe, expect, it } from 'vitest';
import { RoomRegistry } from '../server/rooms.ts';
import { ROOM_CODE_ALPHABET, normalizeRoomCode, parseInput, roomCodeFromText } from '@shared/protocol.ts';

describe('room codes', () => {
  it('are 4 letters from the look-alike-free alphabet, pronounceable, unique', () => {
    const reg = new RoomRegistry();
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const code = reg.create(`s${i}`, `tok-${i}`).code;
      expect(code).toMatch(/^[BCDFGHJKMNPRSTVWXYZ][AEU][BCDFGHJKMNPRSTVWXYZ][AEU]$/);
      for (const ch of code) expect(ROOM_CODE_ALPHABET).toContain(ch);
      expect(seen.has(code)).toBe(false);
      seen.add(code);
    }
  });

  it('falls back to random codes once the pronounceable space is exhausted', () => {
    const reg = new RoomRegistry({ rng: () => 0 }); // always "BABA"
    expect(reg.create('a', 't').code).toBe('BABA');
    expect(reg.create('b', 't').code).toBe('AAAA'); // first fallback pick with rng 0
  });

  it('normalizes user input and parses links', () => {
    expect(normalizeRoomCode(' dama ')).toBe('DAMA');
    expect(normalizeRoomCode('RIVA')).toBeNull(); // the spec's example contains I, which the alphabet drops
    expect(normalizeRoomCode('DAMO')).toBeNull(); // O is not in the alphabet either
    expect(roomCodeFromText('https://x.trycloudflare.com/play?room=dama')).toBe('DAMA');
    expect(roomCodeFromText('hello')).toBeNull();
  });
});

describe('registry', () => {
  it('keeps the slot for a token across disconnects and expires it after the grace period', () => {
    let now = 0;
    const reg = new RoomRegistry({ now: () => now, playerGraceMs: 100, sceneGraceMs: 100 });
    const room = reg.create('scene', 'tok');
    const j = reg.join(room.code, 'abcdefgh', 'Bepi', 'sock1');
    expect(j.ok && j.player.pid).toBe('p1');
    expect(reg.playerSocketLeft('abcdefgh', 'other-socket')).toBeNull();
    expect(reg.playerSocketLeft('abcdefgh', 'sock1')?.player.socketId).toBeNull();
    now = 50;
    expect(reg.sweep().expiredPlayers).toHaveLength(0);
    const again = reg.join(room.code, 'abcdefgh', 'Bepi', 'sock2');
    expect(again.ok && again.rejoined && again.player.pid === 'p1').toBe(true);
    reg.playerSocketLeft('abcdefgh', 'sock2');
    now = 200;
    expect(reg.sweep().expiredPlayers.map((e) => e.player.pid)).toEqual(['p1']);
    expect(reg.get(room.code)?.players.size).toBe(0);
  });

  it('closes a room whose scene stayed away, and a token moving rooms leaves the old one', () => {
    let now = 0;
    const reg = new RoomRegistry({ now: () => now, sceneGraceMs: 100 });
    const a = reg.create('sceneA', 'ta');
    const b = reg.create('sceneB', 'tb');
    reg.join(a.code, 'abcdefgh', 'Bepi', 's1');
    reg.join(b.code, 'abcdefgh', 'Bepi', 's1');
    expect(a.players.size).toBe(0);
    expect(b.players.size).toBe(1);
    reg.sceneLeft(a.code, 'sceneA');
    now = 99;
    expect(reg.sweep().closedRooms).toHaveLength(0);
    expect(reg.reclaim(a.code, 'ta', 'sceneA2')?.sceneLeftAt).toBeNull();
    reg.sceneLeft(a.code, 'sceneA2');
    now = 250;
    expect(reg.sweep().closedRooms.map((r) => r.code)).toEqual([a.code]);
    expect(reg.size).toBe(1);
  });
});

describe('parseInput', () => {
  it('rejects junk and clamps numbers', () => {
    expect(parseInput(null)).toBeNull();
    expect(parseInput({ t: 'in', role: 'pilot', steer: 0 })).toBeNull(); // no seq
    expect(parseInput({ t: 'in', seq: 1, role: 'engineer', use: 2, uc: 1, shake: 5 })).toEqual({
      t: 'in', seq: 1, role: 'engineer', use: null, uc: 1, shake: 1,
    });
    expect(parseInput({ t: 'in', seq: 1.7, role: 'pilot', steer: -3, gas: 1, brake: true })).toEqual({
      t: 'in', seq: 1, role: 'pilot', steer: -1, gas: false, brake: true,
    });
  });
});
