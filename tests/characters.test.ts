/**
 * Character picks: the roster, the parser and the character list. One person per player,
 * the gondolier for anyone, unknown ids ignored.
 */
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CHARACTERS, GONDOLIER_ID, characterById, isCharacterId, portraitUrl } from '../shared/characters.ts';
import { parseCharacter } from '../shared/protocol.ts';
import { createSim } from '../src/sim/index.ts';

describe('character list', () => {
  it('has 14 players with unique ids and a portrait for each', () => {
    expect(CHARACTERS).toHaveLength(14);
    expect(new Set(CHARACTERS.map((c) => c.id)).size).toBe(14);
    for (const c of CHARACTERS) {
      for (const size of [256, 512] as const) {
        const url = portraitUrl(c.id, size);
        expect(url).not.toBeNull();
        expect(existsSync(`public${url}`)).toBe(true);
      }
    }
    expect(portraitUrl(GONDOLIER_ID)).toBeNull();
    expect(characterById('justin-simon')?.short).toBe('Justin');
    expect(isCharacterId('nobody')).toBe(false);
  });
});

describe('parseCharacter', () => {
  it('keeps slugs and null, drops anything else', () => {
    expect(parseCharacter({ t: 'character', id: 'simon-moreau' })).toEqual({ t: 'character', id: 'simon-moreau' });
    expect(parseCharacter({ t: 'character', id: null })).toEqual({ t: 'character', id: null });
    expect(parseCharacter({ t: 'character', id: '<script>' })).toBeNull();
    expect(parseCharacter({ t: 'character', id: 5 })).toBeNull();
    expect(parseCharacter({ t: 'rename', id: 'simon-moreau' })).toBeNull();
  });
});

describe('roster picks', () => {
  it('gives each person to one player, the gondolier to anyone, and shows picks in the lobby', async () => {
    const sim = await createSim();
    sim.addPlayer('a', 'A');
    sim.addPlayer('b', 'B');
    sim.applyMessage('a', { t: 'character', id: 'justin-simon' });
    sim.applyMessage('b', { t: 'character', id: 'justin-simon' });
    expect(sim.state.players['a']?.character).toBe('justin-simon');
    expect(sim.state.players['b']?.character).toBeNull();
    sim.applyMessage('b', { t: 'character', id: 'not-a-player' });
    expect(sim.state.players['b']?.character).toBeNull();
    sim.applyMessage('a', { t: 'character', id: GONDOLIER_ID });
    sim.applyMessage('b', { t: 'character', id: GONDOLIER_ID });
    expect(sim.state.players['b']?.character).toBe(GONDOLIER_ID);
    // Justin is free again once A switched.
    sim.applyMessage('b', { t: 'character', id: 'justin-simon' });
    expect(sim.state.players['b']?.character).toBe('justin-simon');
    const members = sim.lobbySnapshot().teams.flatMap((t) => t.members);
    expect(members.find((m) => m.pid === 'b')?.character).toBe('justin-simon');
  });
});
