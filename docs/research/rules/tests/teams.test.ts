import { describe, expect, it } from 'vitest';
import {
  balanceTable,
  canStart,
  controlsFor,
  createLobby,
  joinPlayer,
  leavePlayer,
  moveToTeam,
  rebalance,
  resetLobby,
  setTeamSize,
  slotOf,
  swapRoles,
  targetSizes,
  teamCount,
} from '../src/sim/teams.ts';
import type { Lobby, LobbyPlayer } from '../src/sim/teams.ts';

function player(i: number, kind: LobbyPlayer['kind'] = 'phone'): LobbyPlayer {
  return { id: `p${i}`, name: `P${i}`, joinOrder: i, pinned: false, connected: true, enabled: true, ready: false, calibrated: false, kind };
}

function fill(n: number, size: 2 | 3): Lobby {
  let lobby = createLobby(size);
  for (let i = 1; i <= n; i++) lobby = joinPlayer(lobby, player(i)).lobby;
  return lobby;
}

const sizes = (lobby: Lobby): number[] => lobby.teams.map((m) => m.length);

describe('balance table', () => {
  it('teams of 3: min(6, ceil(n/3)) teams, remainder spread, never 3+3+1', () => {
    const expected: Record<number, number[]> = {
      1: [1], 2: [2], 3: [3], 4: [2, 2], 5: [3, 2], 6: [3, 3], 7: [3, 2, 2], 8: [3, 3, 2], 9: [3, 3, 3],
      10: [3, 3, 2, 2], 11: [3, 3, 3, 2], 12: [3, 3, 3, 3], 13: [3, 3, 3, 2, 2], 14: [3, 3, 3, 3, 2],
      15: [3, 3, 3, 3, 3], 16: [3, 3, 3, 3, 2, 2], 17: [3, 3, 3, 3, 3, 2], 18: [3, 3, 3, 3, 3, 3],
    };
    for (const row of balanceTable(3)) {
      expect(row.sizes, `n=${row.n}`).toEqual(expected[row.n]);
      expect(row.spectators).toBe(0);
    }
  });
  it('teams of 2: capacity 12, the rest are spectators', () => {
    const expected: Record<number, number[]> = {
      1: [1], 2: [2], 3: [2, 1], 4: [2, 2], 5: [2, 2, 1], 6: [2, 2, 2], 7: [2, 2, 2, 1], 8: [2, 2, 2, 2],
      9: [2, 2, 2, 2, 1], 10: [2, 2, 2, 2, 2], 11: [2, 2, 2, 2, 2, 1], 12: [2, 2, 2, 2, 2, 2],
    };
    for (const row of balanceTable(2)) {
      expect(row.sizes, `n=${row.n}`).toEqual(expected[Math.min(row.n, 12)]);
      expect(row.spectators).toBe(Math.max(0, row.n - 12));
    }
    expect(teamCount(13, 2)).toBe(6);
    expect(targetSizes(100, 3)).toEqual([3, 3, 3, 3, 3, 3]);
  });
});

describe('join order and rebalance', () => {
  it('fills by join order and roles by index; seats already taken are kept when a team forms', () => {
    const three = fill(3, 3);
    expect(three.teams).toEqual([['p1', 'p2', 'p3']]);
    expect(slotOf(three, 'p1')).toEqual({ team: 0, role: 'pilot', index: 0 });
    expect(slotOf(three, 'p2')).toEqual({ team: 0, role: 'gunner', index: 1 });
    expect(slotOf(three, 'p3')?.role).toBe('engineer');
    const four = fill(4, 3); // 2+2: the most recent joiner (p3) opens team 1 with p4
    expect(four.teams).toEqual([['p1', 'p2'], ['p3', 'p4']]);
    const five = fill(5, 3); // 3+2: p5 fills the deficit, nobody else moves
    expect(five.teams).toEqual([['p1', 'p2', 'p5'], ['p3', 'p4']]);
    expect(slotOf(five, 'p3')).toEqual({ team: 1, role: 'pilot', index: 0 });
  });
  it('every join moves at most one existing player (the most recent joiner)', () => {
    let lobby = createLobby(3);
    for (let i = 1; i <= 18; i++) {
      const r = joinPlayer(lobby, player(i));
      const others = r.moves.filter((m) => m.id !== `p${i}`);
      expect(others.length, `join ${i}`).toBeLessThanOrEqual(1);
      if (others[0]) expect(others[0].id).toBe(`p${i - 1}`);
      lobby = r.lobby;
      expect(sizes(lobby)).toEqual(targetSizes(i, 3));
    }
  });
  it('7 in threes is 3+2+2; the 7th join moves exactly one person', () => {
    const six = fill(6, 3);
    expect(sizes(six)).toEqual([3, 3]);
    const r = joinPlayer(six, player(7));
    expect(sizes(r.lobby)).toEqual([3, 2, 2]);
    expect(r.moves.map((m) => m.id).sort()).toEqual(['p6', 'p7']);
    expect(slotOf(r.lobby, 'p6')).toEqual({ team: 2, role: 'pilot', index: 0 });
  });
  it('a leave closes up with the fewest moves and keeps the invariant', () => {
    const seven = fill(7, 3); // [1,2,3] [4,5] [6,7]
    const r = leavePlayer(seven, 'p4');
    expect(sizes(r.lobby)).toEqual([3, 3]);
    expect(r.moves.length).toBe(1);
    expect(r.lobby.players['p4']).toBeUndefined();
    const r2 = leavePlayer(seven, 'p1'); // [2,3] [4,5] [6,7] -> 6 players -> [3,3]
    expect(sizes(r2.lobby)).toEqual([3, 3]);
    expect(r2.moves.length).toBe(2);
  });
  it('beyond capacity joiners queue as spectators and are promoted on a leave', () => {
    let lobby = fill(19, 3);
    expect(lobby.spectators).toEqual(['p19']);
    lobby = leavePlayer(lobby, 'p3').lobby;
    expect(lobby.spectators).toEqual([]);
    expect(slotOf(lobby, 'p19')).not.toBeNull();
  });
  it('switching team size re-seats: 18 in threes -> 12 in twos + 6 spectators, and back', () => {
    const l18 = fill(18, 3);
    const twos = setTeamSize(l18, 2).lobby;
    expect(sizes(twos)).toEqual([2, 2, 2, 2, 2, 2]);
    expect(twos.spectators.length).toBe(6);
    const back = setTeamSize(twos, 3).lobby;
    expect(sizes(back)).toEqual([3, 3, 3, 3, 3, 3]);
    expect(back.spectators).toEqual([]);
  });
  it('rebalance is idempotent on a balanced lobby', () => {
    const lobby = fill(11, 3);
    const r = rebalance(lobby);
    expect(r.moves).toEqual([]);
    expect(r.renumbered).toBe(false);
    expect(r.lobby.teams).toEqual(lobby.teams);
  });
});

describe('explicit moves', () => {
  it('swap role with a teammate pins both', () => {
    const lobby = fill(3, 3);
    const r = swapRoles(lobby, 'p1', 'p3');
    expect(r.lobby.teams[0]).toEqual(['p3', 'p2', 'p1']);
    expect(r.lobby.players['p1']?.pinned).toBe(true);
    expect(r.lobby.players['p3']?.pinned).toBe(true);
    expect(swapRoles(lobby, 'p1', 'p1').lobby.teams).toEqual(lobby.teams);
  });
  it('move to a team with a free slot; the balancer bumps someone else, never the pinned mover', () => {
    const seven = fill(7, 3);
    expect(seven.teams).toEqual([['p1', 'p2', 'p5'], ['p3', 'p4'], ['p6', 'p7']]);
    expect(moveToTeam(seven, 'p3', 0).lobby.teams).toEqual(seven.teams); // team 0 is full: refused
    const r = moveToTeam(seven, 'p7', 1); // team 1 had a free slot -> 3+3+1, the balancer restores {3,2,2}
    expect([...sizes(r.lobby)].sort()).toEqual([2, 2, 3]);
    expect(slotOf(r.lobby, 'p7')?.team).toBe(1);
    expect(r.lobby.players['p7']?.pinned).toBe(true);
    expect(r.lobby.teams[1]?.length).toBe(3); // the team holding the pinned mover keeps its 3
    expect(r.moves.filter((m) => m.id !== 'p7').length).toBe(1); // exactly one other person moved
  });
});

describe('roles, start check, reset', () => {
  it('merges roles for short-handed teams', () => {
    const three = fill(3, 3);
    expect(controlsFor(three, 'p2')?.powers).toBe(false);
    const two = fill(2, 2);
    expect(controlsFor(two, 'p2')).toMatchObject({ aim: true, fire: true, powers: true, bail: false });
    const one = fill(1, 3);
    expect(controlsFor(one, 'p1')?.solo).toBe(true);
  });
  it('start needs 2 teams with a connected Pilot; missing Enable controls is only a warning', () => {
    expect(canStart(fill(3, 3)).ok).toBe(false);
    const four = fill(4, 3);
    expect(canStart(four)).toMatchObject({ ok: true, problems: [], warnings: [] });
    const notEnabled: Lobby = { ...four, players: { ...four.players, p2: { ...player(2), enabled: false } } };
    expect(canStart(notEnabled).ok).toBe(true);
    expect(canStart(notEnabled).warnings.length).toBe(1);
    const pilotGone: Lobby = { ...four, players: { ...four.players, p1: { ...player(1), connected: false } } };
    expect(canStart(pilotGone).ok).toBe(false);
  });
  it('new lobby drops pins and disconnected players, keeps join order', () => {
    const seven = fill(7, 3);
    const pinned = moveToTeam(seven, 'p7', 1).lobby;
    const gone: Lobby = { ...pinned, players: { ...pinned.players, p2: { ...player(2), connected: false } } };
    const fresh = resetLobby(gone).lobby;
    expect(fresh.players['p2']).toBeUndefined();
    expect(fresh.teams).toEqual([['p1', 'p3', 'p4'], ['p5', 'p6', 'p7']]);
    expect(Object.values(fresh.players).every((p) => !p.pinned)).toBe(true);
  });
});
