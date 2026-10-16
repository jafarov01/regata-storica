/**
 * Baseline behaviour every track builds on: roster balancing, match flow, the
 * kinematic placeholder boat, split-screen layout and the phone HUD feed.
 * When Track B swaps internals of src/sim, these must keep passing.
 */
import { describe, expect, it } from 'vitest';
import { MATCH, SIM } from '../shared/config.ts';
import { createSim } from '../src/sim/index.ts';
import { computeLayout } from '../src/scene/layout.ts';
import { buildHud } from '../src/scene/phoneFeed.ts';

function sizes(n: number, teamSize: 2 | 3 = 3): number[] {
  const sim = createSim();
  sim.setTeamSize(teamSize);
  for (let i = 0; i < n; i++) sim.addPlayer(`p${i}`, `P${i}`);
  return sim.state.teams.map((t) => t.members.length);
}

describe('roster', () => {
  it('balances teams in join order (7 in threes = 3+2+2, never 3+3+1)', () => {
    expect(sizes(1)).toEqual([1]);
    expect(sizes(4)).toEqual([2, 2]);
    expect(sizes(7)).toEqual([3, 2, 2]);
    expect(sizes(12)).toEqual([3, 3, 3, 3]);
    expect(sizes(18)).toEqual([3, 3, 3, 3, 3, 3]);
    expect(sizes(8, 2)).toEqual([2, 2, 2, 2]);
  });

  it('puts players beyond 18 in the spectator queue', () => {
    const sim = createSim();
    for (let i = 0; i < 20; i++) sim.addPlayer(`p${i}`, `P${i}`);
    expect(sim.state.spectators).toHaveLength(2);
  });

  it('assigns roles by index and swaps roles inside a team', () => {
    const sim = createSim();
    sim.addPlayer('a', 'A');
    sim.addPlayer('b', 'B');
    expect(sim.state.players['a']?.role).toBe('pilot');
    expect(sim.state.players['b']?.role).toBe('gunner');
    sim.applyMessage('b', { t: 'swap', role: 'pilot' });
    expect(sim.state.players['b']?.role).toBe('pilot');
    expect(sim.state.players['a']?.role).toBe('gunner');
  });

  it('keeps a bot team when a phone joins', () => {
    const sim = createSim();
    expect(sim.debug.addBotTeam()).toBe(0);
    sim.addPlayer('phone', 'Phone');
    expect(sim.state.teams.length).toBeGreaterThanOrEqual(1);
    expect(sim.lobbySnapshot().teams.flatMap((t) => t.members.map((m) => m.pid))).toContain('phone');
  });
});

describe('match flow', () => {
  it('runs lobby -> countdown -> battle -> results -> lobby on sim time', () => {
    const sim = createSim();
    sim.addPlayer('a', 'A');
    expect(sim.start()).toBe(true);
    expect(sim.state.phase).toBe('countdown');
    const run = (sec: number): void => {
      for (let i = 0; i < Math.round(sec / SIM.dt); i++) sim.step(SIM.dt);
    };
    run(MATCH.countdownSec + 0.05);
    expect(sim.state.phase).toBe('battle');
    run(MATCH.battleSec);
    expect(sim.state.phase).toBe('results');
    expect(sim.state.results?.winner).toBe(0);
    run(MATCH.resultsSec);
    expect(sim.state.phase).toBe('lobby');
  });

  it('moves the boat forward on gas and keeps it on water', () => {
    const sim = createSim();
    sim.addPlayer('a', 'A');
    sim.start();
    for (let i = 0; i < Math.round((MATCH.countdownSec + 0.1) / SIM.dt); i++) sim.step(SIM.dt);
    const boat = sim.state.boats[0];
    if (!boat) throw new Error('no boat');
    const start = { ...boat.pose };
    for (let i = 0; i < 120; i++) {
      sim.applyInput('a', { t: 'in', seq: i + 1, role: 'pilot', steer: 0, gas: true, brake: false });
      sim.step(SIM.dt);
    }
    expect(Math.hypot(boat.pose.x - start.x, boat.pose.z - start.z)).toBeGreaterThan(0.5);
    expect(sim.map.isWaterAt(boat.pose.x, boat.pose.z)).toBe(true);
  });
});

describe('layout', () => {
  it('splits 1080p into the spec grids without overlap', () => {
    expect(computeLayout(2, 1920, 1080).cells).toEqual([
      { x: 0, y: 0, w: 960, h: 1080 },
      { x: 960, y: 0, w: 960, h: 1080 },
    ]);
    const four = computeLayout(4, 1920, 1080);
    expect(four.cells.map((c) => [c.w, c.h])).toEqual([
      [960, 540],
      [960, 540],
      [960, 540],
      [960, 540],
    ]);
    expect(four.spare).toBeNull();
    expect(computeLayout(3, 1920, 1080).spare).toEqual({ x: 960, y: 540, w: 960, h: 540 });
    expect(computeLayout(5, 1920, 1080).cells).toHaveLength(5);
  });
});

describe('phone HUD feed', () => {
  it('reports team, role and phase for phones and skips virtual players', () => {
    const sim = createSim();
    sim.addPlayer('a', 'A');
    sim.addPlayer('kb', 'Keys', { virtual: true, team: 0, role: 'gunner' });
    const hud = buildHud(sim.state, 'a', false);
    expect(hud).toMatchObject({ t: 'hud', phase: 'lobby', team: 0, role: 'pilot', teamName: 'Rosso' });
    expect(buildHud(sim.state, 'kb', false)).toBeNull();
  });
});
