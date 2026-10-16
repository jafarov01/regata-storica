/**
 * Baseline behaviour every track builds on: roster balancing, match flow, the
 * kinematic placeholder boat, split-screen layout and the phone HUD feed.
 * When Track B swaps internals of src/sim, these must keep passing.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_WEAPON, MATCH, SIM, TIERS } from '../shared/config.ts';
import { createSim } from '../src/sim/index.ts';
import { computeLayout } from '../src/scene/layout.ts';
import { buildHud } from '../src/scene/phoneFeed.ts';

async function sizes(n: number, teamSize: 2 | 3 = 3): Promise<number[]> {
  const sim = await createSim();
  sim.setTeamSize(teamSize);
  for (let i = 0; i < n; i++) sim.addPlayer(`p${i}`, `P${i}`);
  return sim.state.teams.map((t) => t.members.length);
}

describe('roster', () => {
  it.skipIf(!TIERS.engineer)('balances teams in join order (7 in threes = 3+2+2, never 3+3+1)', async () => {
    expect(await sizes(1)).toEqual([1]);
    expect(await sizes(4)).toEqual([2, 2]);
    expect(await sizes(7)).toEqual([3, 2, 2]);
    expect(await sizes(12)).toEqual([3, 3, 3, 3]);
    expect(await sizes(18)).toEqual([3, 3, 3, 3, 3, 3]);
    expect(await sizes(8, 2)).toEqual([2, 2, 2, 2]);
  });

  it('puts players beyond 6 crews of the team size in the spectator queue', async () => {
    const sim = await createSim();
    const seats = MATCH.maxTeams * sim.state.teamSize;
    for (let i = 0; i < seats + 2; i++) sim.addPlayer(`p${i}`, `P${i}`);
    expect(sim.state.spectators).toHaveLength(2);
  });

  it('assigns roles by index and swaps roles inside a team', async () => {
    const sim = await createSim();
    sim.addPlayer('a', 'A');
    sim.addPlayer('b', 'B');
    expect(sim.state.players['a']?.role).toBe('pilot');
    expect(sim.state.players['b']?.role).toBe('gunner');
    sim.applyMessage('b', { t: 'swap', role: 'pilot' });
    expect(sim.state.players['b']?.role).toBe('pilot');
    expect(sim.state.players['a']?.role).toBe('gunner');
  });

  it('keeps a bot team when a phone joins', async () => {
    const sim = await createSim();
    expect(sim.debug.addBotTeam()).toBe(0);
    sim.addPlayer('phone', 'Phone');
    expect(sim.state.teams.length).toBeGreaterThanOrEqual(1);
    expect(sim.lobbySnapshot().teams.flatMap((t) => t.members.map((m) => m.pid))).toContain('phone');
  });
});

describe('match flow', () => {
  it('runs lobby -> countdown -> battle -> results -> lobby on sim time', async () => {
    const sim = await createSim();
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

  it('moves the boat forward on gas and keeps it on water', async () => {
    const sim = await createSim();
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
  it('splits 1080p into the spec grids without overlap', async () => {
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
  it('reports team, role and phase for phones and skips virtual players', async () => {
    const sim = await createSim();
    sim.addPlayer('a', 'A');
    sim.addPlayer('kb', 'Keys', { virtual: true, team: 0, role: 'gunner' });
    const hud = buildHud(sim.state, 'a', false);
    expect(hud).toMatchObject({ t: 'hud', phase: 'lobby', team: 0, role: 'pilot', teamName: 'Rosso' });
    expect(buildHud(sim.state, 'kb', false)).toBeNull();
  });
});

// The Water Cannon is no longer the default weapon (simplified game): back when DEFAULT_WEAPON is.
describe.skipIf(DEFAULT_WEAPON !== 'watercannon')('water cannon', () => {
  it('streams while FIRE is held: fired cues, push and hull water on an enemy in the cone, never a kill', async () => {
    const sim = await createSim();
    sim.addPlayer('a', 'A', { virtual: true, team: 0, role: 'pilot' });
    sim.addPlayer('b', 'B', { virtual: true, team: 0, role: 'gunner' });
    sim.addPlayer('c', 'C', { virtual: true, team: 1, role: 'pilot' });
    sim.start();
    for (let i = 0; i < Math.round((MATCH.countdownSec + 0.1) / SIM.dt); i++) sim.step(SIM.dt);
    const boat = sim.state.boats[0];
    const enemy = sim.state.boats[1];
    if (!boat || !enemy) throw new Error('no boats');
    // Open lagoon water: shooter facing -z, enemy 8 m ahead.
    sim.debug.teleport(0, 120, 40, 0);
    sim.debug.teleport(1, 120, 32, 0);
    sim.drainEvents();
    for (let i = 0; i < 30; i++) {
      sim.applyInput('b', { t: 'in', seq: i + 1, role: 'gunner', dYaw: 0, yaw: 0, ep: 0, fire: true, fc: 0, recenter: false, use: null, uc: 0 });
      sim.step(SIM.dt);
    }
    const events = sim.drainEvents();
    expect(events.filter((e) => e.kind === 'fired').length).toBeGreaterThanOrEqual(2);
    expect(boat.firing).toBe(true);
    expect(enemy.water).toBeGreaterThan(10);
    expect(enemy.pose.z).toBeLessThan(32);
    expect(enemy.status).toBe('alive');
    expect(events.some((e) => e.kind === 'kill')).toBe(false);
  });
});
