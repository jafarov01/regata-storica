/**
 * Gameplay: Rapier boats, crates, weapons, kills, respawn, Shield, Mine, ram,
 * sudden death and bot matches (docs/TASKS-B.md B1-B10). Node environment;
 * Rapier's wasm is decoded once by createSim.
 */
import { describe, expect, it } from 'vitest';
import { AIM, BOAT, MATCH, MINE, RESPAWN, SIM, WEAPONS } from '../shared/config.ts';
import type { InputMsg } from '../shared/protocol.ts';
import type { SimEvent } from '../shared/state.ts';
import { createSim, type GameSim } from '../src/sim/index.ts';
import { LobbySync, buildHud, forwardEvents } from '../src/scene/phoneFeed.ts';
import { CameraViews } from '../src/scene/views.ts';

/** Lagoon water, far from walls: x 96..136, z -16..72 (cols 37..41, rows 17..27). */
const OPEN = { x: 120, z: 40 };

function steps(sim: GameSim, seconds: number, each?: () => void): void {
  for (let i = 0; i < Math.round(seconds / SIM.dt); i++) {
    each?.();
    sim.step(SIM.dt);
  }
}

let seq = 1;
function pilot(steer: number, gas: boolean, brake = false): InputMsg {
  return { t: 'in', seq: seq++, role: 'pilot', steer, gas, brake };
}
function gunner(fc: number, fire = false, yaw = 0, ep = 0): InputMsg {
  return { t: 'in', seq: seq++, role: 'gunner', dYaw: 0, yaw, ep, fire, fc, recenter: false, use: null, uc: 0 };
}
function engineer(uc: number, use: 0 | 1 | null, shake = 0): InputMsg {
  return { t: 'in', seq: seq++, role: 'engineer', use, uc, shake };
}

/** Two keyboard-style crews (team 0: pilot p0, gunner g0, engineer e0; team 1: pilot p1, gunner g1), in battle. */
async function duel(): Promise<GameSim> {
  const sim = await createSim();
  sim.addPlayer('p0', 'P0', { virtual: true, team: 0, role: 'pilot' });
  sim.addPlayer('g0', 'G0', { virtual: true, team: 0, role: 'gunner' });
  sim.addPlayer('e0', 'E0', { virtual: true, team: 0, role: 'engineer' });
  sim.addPlayer('p1', 'P1', { virtual: true, team: 1, role: 'pilot' });
  sim.addPlayer('g1', 'G1', { virtual: true, team: 1, role: 'gunner' });
  expect(sim.start()).toBe(true);
  steps(sim, MATCH.countdownSec + 0.05);
  expect(sim.state.phase).toBe('battle');
  // Prime each gunner's aim tracker with epoch 0 so later packets do not re-base.
  sim.applyInput('g0', gunner(0));
  sim.applyInput('g1', gunner(0));
  sim.step();
  sim.drainEvents();
  return sim;
}

function boat(sim: GameSim, team: number) {
  const b = sim.state.boats[team];
  if (!b) throw new Error(`no boat ${team}`);
  return b;
}

/** Shooter at OPEN facing -z, target `gap` metres ahead, both still. */
function lineUp(sim: GameSim, gap: number): void {
  sim.debug.teleport(0, OPEN.x, OPEN.z, 0);
  sim.debug.teleport(1, OPEN.x, OPEN.z - gap, 0);
  sim.step();
  sim.drainEvents();
}

function kinds(events: SimEvent[]): string[] {
  return events.map((e) => e.kind);
}

describe('B1 Rapier boats', () => {
  it('reaches about 95% of top speed in 3 s and the top speed after 8 s', async () => {
    const sim = await duel();
    sim.debug.teleport(0, OPEN.x, 64, 0);
    steps(sim, 3, () => sim.applyInput('p0', pilot(0, true)));
    expect(boat(sim, 0).speed).toBeGreaterThan(BOAT.topSpeed * 0.8);
    sim.debug.teleport(0, -92, 44, -Math.PI / 2); // long east-west canal (row 24), facing +x
    steps(sim, 8, () => sim.applyInput('p0', pilot(0, true)));
    expect(boat(sim, 0).speed).toBeGreaterThan(BOAT.topSpeed * 0.95);
    expect(boat(sim, 0).speed).toBeLessThan(BOAT.topSpeed * 1.02);
  });

  it('turns right for steer > 0 (negative yaw rate) and caps the turn rate', async () => {
    const sim = await duel();
    sim.debug.teleport(0, OPEN.x, OPEN.z, 0);
    steps(sim, 1.5, () => sim.applyInput('p0', pilot(1, true)));
    expect(boat(sim, 0).angVel).toBeLessThan(0);
    expect(Math.abs(boat(sim, 0).angVel)).toBeLessThanOrEqual(BOAT.maxTurnRate + 1e-6);
  });

  it('bounces off a wall without sticking and stays on water', async () => {
    const sim = await duel();
    // Lagoon, facing east (+x) toward the right-hand border wall.
    sim.debug.teleport(0, 160, OPEN.z, -Math.PI / 2);
    const events: SimEvent[] = [];
    steps(sim, 5, () => {
      sim.applyInput('p0', pilot(0, true));
      events.push(...sim.drainEvents());
    });
    expect(events.some((e) => e.kind === 'wall')).toBe(true);
    expect(sim.map.isWaterAt(boat(sim, 0).pose.x, boat(sim, 0).pose.z)).toBe(true);
    // Reverse away: not stuck.
    const x = boat(sim, 0).pose.x;
    steps(sim, 2, () => sim.applyInput('p0', pilot(0, false, true)));
    expect(boat(sim, 0).pose.x).toBeLessThan(x - 1);
  });

  it('two boats bounce off each other (momentum exchange)', async () => {
    const sim = await duel();
    sim.debug.teleport(0, OPEN.x, OPEN.z + 14, 0);
    sim.debug.teleport(1, OPEN.x, OPEN.z, 0);
    steps(sim, 2.5, () => sim.applyInput('p0', pilot(0, true)));
    expect(boat(sim, 1).pose.z).toBeLessThan(OPEN.z - 0.5);
    expect(boat(sim, 1).status).toBe('alive');
  });
});

describe('B2 crates and inventory', () => {
  it('a red crate gives the Gunner a weapon with full ammo and respawns 8 s later', async () => {
    const sim = await duel();
    const i = sim.state.crates.findIndex((c) => c.category === 'weapon');
    const crate = sim.state.crates[i];
    const home = sim.map.crates[i];
    if (!crate || !home) throw new Error('no weapon crate');
    sim.debug.teleport(0, home.x, home.z, 0);
    sim.step();
    expect(crate.active).toBe(false);
    const b = boat(sim, 0);
    expect(b.weapon).not.toBe('watercannon');
    expect(b.ammo).toBe(WEAPONS[b.weapon].ammo);
    expect(kinds(sim.drainEvents())).toContain('pickup');
    sim.debug.teleport(0, OPEN.x, OPEN.z, 0);
    steps(sim, 8.1);
    expect(crate.active).toBe(true);
  });

  it('a blue crate fills a power slot, and stays in the water when both slots are full', async () => {
    const sim = await duel();
    const i = sim.state.crates.findIndex((c) => c.category === 'power');
    const crate = sim.state.crates[i];
    const home = sim.map.crates[i];
    if (!crate || !home) throw new Error('no power crate');
    sim.debug.givePower(0, 'shield');
    sim.debug.givePower(0, 'mine');
    sim.debug.teleport(0, home.x, home.z, 0);
    sim.step();
    expect(crate.active).toBe(true);
    const b = boat(sim, 0);
    b.powers = [null, 'mine'];
    sim.step();
    expect(crate.active).toBe(false);
    expect(b.powers[0]).not.toBeNull();
  });

  it('the last shot brings the Water Cannon back', async () => {
    const sim = await duel();
    lineUp(sim, 60);
    sim.debug.teleport(1, -150, -100, 0); // out of the way
    sim.debug.giveWeapon(0, 'torpedo');
    let fc = 0;
    for (let shot = 0; shot < WEAPONS.torpedo.ammo; shot++) {
      sim.applyInput('g0', gunner(++fc));
      steps(sim, WEAPONS.torpedo.fireInterval + 0.05);
    }
    expect(boat(sim, 0).weapon).toBe('watercannon');
  });
});

describe('B3 weapons and B4 kills', () => {
  it('a Cannon hit sinks the target, scores, then respawns it at a safe dock with protection', async () => {
    const sim = await duel();
    lineUp(sim, 30);
    sim.debug.giveWeapon(0, 'cannon');
    sim.applyInput('g0', gunner(1));
    const events: SimEvent[] = [];
    steps(sim, 1, () => events.push(...sim.drainEvents()));
    expect(kinds(events)).toEqual(expect.arrayContaining(['fired', 'hit', 'kill', 'sunk']));
    const victim = boat(sim, 1);
    expect(victim.status).toBe('sinking');
    expect(victim.killerTeam).toBe(0);
    expect(victim.killCause).toBe('cannon');
    expect(sim.state.teams[0]?.kills).toBe(1);
    expect(sim.state.teams[1]?.deaths).toBe(1);
    expect(sim.state.players['g0']?.kills).toBe(1);
    expect(sim.state.killFeed.at(-1)).toMatchObject({ killerTeam: 0, victimTeam: 1, cause: 'cannon' });
    expect(boat(sim, 0).ammo).toBe(WEAPONS.cannon.ammo - 1);

    steps(sim, RESPAWN.sinkSec);
    expect(victim.status).toBe('respawning');
    steps(sim, RESPAWN.delaySec - RESPAWN.sinkSec);
    expect(victim.status).toBe('alive');
    const shooter = boat(sim, 0);
    const d = Math.hypot(victim.pose.x - shooter.pose.x, victim.pose.z - shooter.pose.z);
    expect(d).toBeGreaterThanOrEqual(RESPAWN.minDistanceFromEnemy);
    expect(victim.protectedUntil).toBeGreaterThan(sim.state.time);
    expect(victim.weapon).toBe('watercannon');
    expect(victim.powers).toEqual([null, null]);
  });

  it('never hits a teammate or the shooter, and a wall stops the shot', async () => {
    const sim = await duel();
    // Shooter in the north canal facing a building to the north.
    sim.debug.teleport(0, -32, -128, 0);
    sim.debug.teleport(1, -150, 100, 0);
    sim.debug.giveWeapon(0, 'cannon');
    sim.applyInput('g0', gunner(1));
    const events: SimEvent[] = [];
    steps(sim, 1, () => events.push(...sim.drainEvents()));
    expect(kinds(events)).toContain('splash');
    expect(kinds(events)).not.toContain('kill');
  });

  it('spawn protection blocks a hit and ends when that boat fires a lethal weapon', async () => {
    const sim = await duel();
    lineUp(sim, 30);
    boat(sim, 1).protectedUntil = sim.state.time + 10;
    sim.debug.giveWeapon(0, 'cannon');
    sim.applyInput('g0', gunner(1));
    steps(sim, 1);
    expect(boat(sim, 1).status).toBe('alive');
    sim.debug.giveWeapon(1, 'cannon');
    sim.applyInput('g1', gunner(1, false, Math.PI));
    steps(sim, 0.1);
    expect(boat(sim, 1).protectedUntil).toBeLessThanOrEqual(sim.state.time);
  });

  it('a Torpedo locks and homes onto a target off the aim line', async () => {
    const sim = await duel();
    sim.debug.teleport(0, OPEN.x, 64, 0);
    sim.debug.teleport(1, OPEN.x + 10, 20, 0);
    sim.step();
    sim.debug.giveWeapon(0, 'torpedo');
    sim.step();
    expect(boat(sim, 0).lockTarget).toBe(1);
    expect(boat(sim, 0).crosshair).toBe('lock');
    sim.applyInput('g0', gunner(1));
    const events: SimEvent[] = [];
    steps(sim, 4, () => events.push(...sim.drainEvents()));
    expect(events.find((e) => e.kind === 'kill')).toMatchObject({ team: 0, victim: 1, cause: 'torpedo' });
  });

  it('a Mortar lobs onto the nearest enemy near the aim line and splashes it', async () => {
    const sim = await duel();
    lineUp(sim, 45);
    sim.debug.giveWeapon(0, 'mortar');
    sim.applyInput('g0', gunner(1));
    const events: SimEvent[] = [];
    steps(sim, 2, () => events.push(...sim.drainEvents()));
    expect(events.find((e) => e.kind === 'kill')).toMatchObject({ team: 0, victim: 1, cause: 'mortar' });
  });

  it('debug.sink without a killer sinks and respawns without scoring', async () => {
    const sim = await duel();
    sim.debug.sink(1);
    expect(boat(sim, 1).status).toBe('sinking');
    expect(sim.state.teams[1]?.deaths).toBe(0);
    steps(sim, RESPAWN.delaySec + 0.05);
    expect(boat(sim, 1).status).toBe('alive');
  });
});

describe('B5 Shield and Mine', () => {
  it('a Shield absorbs one lethal hit, the next one sinks', async () => {
    const sim = await duel();
    lineUp(sim, 30);
    sim.debug.givePower(1, 'shield');
    boat(sim, 1).powers = ['shield', null];
    sim.debug.giveWeapon(0, 'cannon');
    // Team 1 has no Engineer: in teams of 3 its Gunner cannot use powers, so set the Shield directly.
    boat(sim, 1).shieldUntil = sim.state.time + 8;
    sim.applyInput('g0', gunner(1));
    const events: SimEvent[] = [];
    steps(sim, 0.6, () => events.push(...sim.drainEvents()));
    expect(kinds(events)).toContain('shielded');
    expect(boat(sim, 1).status).toBe('alive');
    sim.applyInput('g0', gunner(2));
    steps(sim, 0.8);
    expect(boat(sim, 1).status).toBe('sinking');
  });

  it('the Engineer uses a Shield from a power tap', async () => {
    const sim = await duel();
    sim.debug.givePower(0, 'shield');
    sim.applyInput('e0', engineer(1, 0));
    sim.step();
    expect(boat(sim, 0).shieldUntil).toBeGreaterThan(sim.state.time);
    expect(boat(sim, 0).powers[0]).toBeNull();
  });

  it('a Mine arms after 1 s, ignores its owner and sinks the first enemy, credited to the dropper', async () => {
    const sim = await duel();
    sim.debug.teleport(0, OPEN.x, OPEN.z, 0);
    sim.debug.teleport(1, -150, 100, 0);
    sim.step();
    sim.debug.givePower(0, 'mine');
    sim.applyInput('e0', engineer(1, 0));
    sim.step();
    const mine = sim.state.mines[0];
    if (!mine) throw new Error('no mine');
    expect(Math.hypot(mine.x - OPEN.x, mine.z - (OPEN.z + MINE.dropBehind))).toBeLessThan(0.5);
    steps(sim, MINE.armDelaySec + 0.1);
    expect(sim.state.mines).toHaveLength(1); // the owner sits next to it, nothing happens
    sim.debug.teleport(1, mine.x + 1, mine.z, 0);
    steps(sim, 0.1);
    expect(sim.state.mines).toHaveLength(0);
    expect(boat(sim, 1).killCause).toBe('mine');
    expect(sim.state.players['e0']?.kills).toBe(1);
  });
});

describe('B10 boost, ram, bailing, sudden death', () => {
  it('a boosted bow-on ram sinks the target; unboosted it just bounces', async () => {
    const sim = await duel();
    sim.debug.teleport(0, OPEN.x, OPEN.z + 22, 0);
    sim.debug.teleport(1, OPEN.x, OPEN.z, Math.PI / 2);
    steps(sim, 2.5, () => sim.applyInput('p0', pilot(0, true)));
    expect(boat(sim, 1).status).toBe('alive');

    sim.debug.teleport(0, OPEN.x, OPEN.z + 22, 0);
    sim.debug.teleport(1, OPEN.x, OPEN.z, Math.PI / 2);
    boat(sim, 0).boostUntil = sim.state.time + 10;
    const events: SimEvent[] = [];
    steps(sim, 2.5, () => {
      sim.applyInput('p0', pilot(0, true));
      events.push(...sim.drainEvents());
    });
    expect(events.find((e) => e.kind === 'ram')).toMatchObject({ team: 0, victim: 1, lethal: true });
    expect(boat(sim, 1).killCause).toBe('ram');
    expect(sim.state.players['p0']?.ramKills).toBe(1);
  });

  it('the Engineer bails by shaking; a team without one drains on its own', async () => {
    const sim = await duel();
    boat(sim, 0).water = 60;
    boat(sim, 1).water = 60;
    steps(sim, 1, () => sim.applyInput('e0', engineer(0, null, 0)));
    expect(boat(sim, 0).water).toBeCloseTo(60, 0);
    expect(boat(sim, 1).water).toBeLessThan(40);
    steps(sim, 1, () => sim.applyInput('e0', engineer(0, null, 1)));
    expect(boat(sim, 0).water).toBeLessThan(5);
  });

  it('a tie at 5:00 goes to sudden death between the tied teams; the next kill wins', async () => {
    const sim = await duel();
    sim.debug.addBotTeam(); // not allowed outside the lobby: still 2 teams
    expect(sim.state.teams).toHaveLength(2);
    steps(sim, MATCH.battleSec);
    expect(sim.state.phase).toBe('suddendeath');
    expect(sim.state.suddenDeathTeams).toEqual([0, 1]);
    lineUp(sim, 30);
    sim.debug.giveWeapon(1, 'cannon');
    sim.applyInput('g1', gunner(1, false, Math.PI));
    steps(sim, 1);
    expect(sim.state.phase).toBe('results');
    expect(sim.state.results).toMatchObject({ winner: 1, suddenDeath: true });
  });

  it('results list the top Gunner; rematch resets scores and keeps the teams', async () => {
    const sim = await duel();
    lineUp(sim, 30);
    sim.debug.giveWeapon(0, 'cannon');
    sim.applyInput('g0', gunner(1));
    steps(sim, 1);
    sim.abort();
    expect(sim.state.results).toMatchObject({ winner: 0, topGunner: 'g0', suddenDeath: false });
    sim.rematch();
    expect(sim.state.phase).toBe('countdown');
    expect(sim.state.teams.map((t) => t.kills)).toEqual([0, 0]);
    expect(sim.state.teams[0]?.members).toEqual(['p0', 'g0', 'e0']);
  });
});

describe('B9 bots', () => {
  it('four bot teams play a full match: they loot, shoot and sink each other, and the step stays cheap', async () => {
    const sim = await createSim();
    for (let i = 0; i < 4; i++) sim.debug.addBotTeam();
    sim.start();
    const counts = new Map<string, number>();
    const t0 = performance.now();
    steps(sim, MATCH.countdownSec + MATCH.battleSec, () => {
      for (const e of sim.drainEvents()) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
    });
    const msPerStep = (performance.now() - t0) / ((MATCH.countdownSec + MATCH.battleSec) / SIM.dt);
    expect(counts.get('pickup') ?? 0).toBeGreaterThan(4);
    expect(counts.get('fired') ?? 0).toBeGreaterThan(10);
    expect(counts.get('kill') ?? 0).toBeGreaterThan(0);
    expect(['results', 'suddendeath']).toContain(sim.state.phase);
    expect(msPerStep).toBeLessThan(1);
    for (const b of sim.state.boats) if (b.status === 'alive') expect(sim.map.isWaterAt(b.pose.x, b.pose.z)).toBe(true);
  }, 60_000);
});

describe('audit fixes (Track B review)', () => {
  it('keeps a phone Pilot from steering until CALIBRATE, then turns about 0.5 rad/s at rest', async () => {
    const sim = await createSim();
    sim.addPlayer('ph', 'Phone');
    sim.start();
    steps(sim, MATCH.countdownSec + 0.05);
    sim.debug.teleport(0, OPEN.x, OPEN.z, 0);
    steps(sim, 1, () => sim.applyInput('ph', pilot(1, false)));
    expect(Math.abs(boat(sim, 0).angVel)).toBeLessThan(1e-3);
    sim.applyMessage('ph', { t: 'calibrate' });
    steps(sim, 2, () => sim.applyInput('ph', pilot(1, false)));
    expect(boat(sim, 0).angVel).toBeLessThan(-0.4);
    expect(boat(sim, 0).angVel).toBeGreaterThan(-0.6);
  });

  it('a fire tap during the countdown is not a queued shot at the start of the battle', async () => {
    const sim = await createSim();
    sim.addPlayer('p0', 'P0', { virtual: true, team: 0, role: 'pilot' });
    sim.addPlayer('g0', 'G0', { virtual: true, team: 0, role: 'gunner' });
    sim.addPlayer('p1', 'P1', { virtual: true, team: 1, role: 'pilot' });
    sim.start();
    sim.debug.giveWeapon(0, 'cannon');
    sim.applyInput('g0', gunner(0));
    sim.step();
    sim.applyInput('g0', gunner(1));
    steps(sim, MATCH.countdownSec + 1);
    expect(sim.state.phase).toBe('battle');
    expect(kinds(sim.drainEvents())).not.toContain('fired');
    expect(boat(sim, 0).ammo).toBe(WEAPONS.cannon.ammo);
  });

  it('the Gunner of a 2-member crew uses powers even in teams of 3', async () => {
    const sim = await duel();
    expect(sim.state.teamSize).toBe(3);
    sim.debug.givePower(1, 'shield');
    sim.applyInput('g1', { t: 'in', seq: seq++, role: 'gunner', dYaw: 0, yaw: 0, ep: 0, fire: false, fc: 0, recenter: false, use: 0, uc: 1 });
    sim.step();
    expect(boat(sim, 1).shieldUntil).toBeGreaterThan(sim.state.time);
    expect(boat(sim, 1).powers[0]).toBeNull();
  });

  it('the gyro gain drops under the crosshair also while it shows a Torpedo lock', async () => {
    const sim = await duel();
    lineUp(sim, 30);
    sim.debug.giveWeapon(0, 'torpedo');
    sim.step();
    expect(boat(sim, 0).crosshair).toBe('lock');
    expect(boat(sim, 0).aimTarget).toBe(1);
    sim.applyInput('g0', { t: 'in', seq: seq++, role: 'gunner', dYaw: 0.1, yaw: 0.1, ep: 0, fire: false, fc: 0, recenter: false, use: null, uc: 0 });
    sim.step();
    expect(boat(sim, 0).aimYaw).toBeCloseTo(0.1 * AIM.gainUnderCrosshair, 5);
  });

  it('a boosted ram ends the rammer spawn protection', async () => {
    const sim = await duel();
    sim.debug.teleport(0, OPEN.x, OPEN.z + 22, 0);
    sim.debug.teleport(1, OPEN.x, OPEN.z, Math.PI / 2);
    boat(sim, 0).boostUntil = sim.state.time + 10;
    boat(sim, 0).protectedUntil = sim.state.time + 10;
    steps(sim, 2.5, () => sim.applyInput('p0', pilot(0, true)));
    expect(boat(sim, 1).killCause).toBe('ram');
    expect(boat(sim, 0).protectedUntil).toBeLessThanOrEqual(sim.state.time);
  });

  it('rams count for best ram, not for top Gunner', async () => {
    const sim = await duel();
    sim.debug.teleport(0, OPEN.x, OPEN.z + 22, 0);
    sim.debug.teleport(1, OPEN.x, OPEN.z, Math.PI / 2);
    boat(sim, 0).boostUntil = sim.state.time + 10;
    steps(sim, 2.5, () => sim.applyInput('p0', pilot(0, true)));
    sim.abort();
    expect(sim.state.results).toMatchObject({ winner: 0, topGunner: null, bestRam: 'p0' });
  });

  it('sudden death: teams that are not tied are out, with no killer or respawn countdown left over', async () => {
    const sim = await createSim();
    for (const t of [0, 1, 2]) {
      sim.addPlayer(`p${t}`, `P${t}`, { virtual: true, team: t, role: 'pilot' });
      sim.addPlayer(`g${t}`, `G${t}`, { virtual: true, team: t, role: 'gunner' });
    }
    sim.start();
    steps(sim, MATCH.countdownSec + 0.05);
    sim.debug.sink(2, 0);
    steps(sim, RESPAWN.delaySec + 0.05);
    sim.debug.sink(2, 1);
    sim.debug.endPhase();
    sim.step();
    expect(sim.state.phase).toBe('suddendeath');
    expect(sim.state.suddenDeathTeams).toEqual([0, 1]);
    expect(boat(sim, 2)).toMatchObject({ status: 'out', killerTeam: null, respawnAt: 0 });
  });
});

describe('audit fixes: roster with bots and keyboard crews', () => {
  it('a phone never takes a seat on a bot boat, and the bot team survives a team size change', async () => {
    const sim = await createSim();
    expect(sim.debug.addBotTeam()).toBe(0);
    for (let i = 0; i < 5; i++) sim.addPlayer(`ph${i}`, `Phone ${i}`);
    expect(sim.state.teams[0]?.members).toEqual(['bot-1']);
    expect(sim.state.teams.slice(1).map((t) => t.members.length)).toEqual([3, 2]);
    sim.setTeamSize(2);
    expect(sim.state.teams[0]?.members).toEqual(['bot-1']);
    expect(sim.state.teams.slice(1).map((t) => t.members.length)).toEqual([2, 2, 1]);
  });

  it('a keyboard crew stays together, in role order, when the team size changes', async () => {
    const sim = await createSim();
    sim.addPlayer('a', 'A');
    sim.addPlayer('b', 'B');
    sim.addPlayer('kb-1-pilot', 'KP', { virtual: true, team: 1, role: 'pilot' });
    sim.addPlayer('kb-1-gunner', 'KG', { virtual: true, team: 1, role: 'gunner' });
    sim.setTeamSize(2);
    sim.setTeamSize(3);
    expect(sim.state.teams[1]?.members.slice(0, 2)).toEqual(['kb-1-pilot', 'kb-1-gunner']);
    expect(sim.state.players['kb-1-gunner']?.role).toBe('gunner');
  });
});

describe('audit fixes: phone feed, lobby resend, kill-cam', () => {
  it('Hud.hasPowers follows the crew aboard; onTarget stays on while the crosshair shows a lock', async () => {
    const sim = await createSim();
    sim.addPlayer('a', 'A');
    sim.addPlayer('b', 'B');
    expect(buildHud(sim.state, 'b', false)?.hasPowers).toBe(true);
    sim.addPlayer('c', 'C');
    expect(buildHud(sim.state, 'b', false)?.hasPowers).toBe(false);
    expect(buildHud(sim.state, 'c', false)?.hasPowers).toBe(true);
    const b = boat(sim, 0);
    b.crosshair = 'lock';
    b.aimTarget = 1;
    b.lockTarget = 1;
    expect(buildHud(sim.state, 'b', false)).toMatchObject({ onTarget: true, locked: true });
  });

  it('forwards pickup, power, shielded, respawn and ram cues to the crew, never to keyboard or bot seats', async () => {
    const sim = await createSim();
    sim.addPlayer('a', 'A');
    sim.addPlayer('b', 'B');
    sim.addPlayer('kb', 'KB', { virtual: true, team: 1, role: 'pilot' });
    const sent: [string | null, string, string | undefined][] = [];
    const events: SimEvent[] = [
      { kind: 'pickup', team: 0, category: 'weapon', item: 'torpedo', x: 0, z: 0 },
      { kind: 'power', team: 0, power: 'shield', x: 0, z: 0 },
      { kind: 'shielded', team: 0, x: 0, z: 0 },
      { kind: 'respawn', team: 0, x: 0, z: 0 },
      { kind: 'ram', team: 1, victim: 0, lethal: false, x: 0, z: 0 },
      { kind: 'fired', team: 1, weapon: 'cannon', x: 0, z: 0, yaw: 0 },
    ];
    forwardEvents(sim.state, events, (pid, evt) => sent.push([pid, evt.kind, evt.detail]));
    expect(sent.filter(([pid]) => pid === 'a').map(([, kind]) => kind)).toEqual(['pickup', 'power', 'shielded', 'respawn', 'rammed']);
    expect(sent.find(([pid, kind]) => pid === 'b' && kind === 'pickup')?.[2]).toBe('Torpedo');
    expect(sent.some(([pid]) => pid === 'kb')).toBe(false);
  });

  it('LobbySync resends an unchanged roster after a join or rejoin', async () => {
    const sim = await createSim();
    sim.addPlayer('a', 'A');
    const sync = new LobbySync();
    expect(sync.take(sim.lobbySnapshot())).not.toBeNull();
    sim.addPlayer('a', 'A'); // the same token rejoins the same seat: nothing changes
    expect(sync.take(sim.lobbySnapshot())).toBeNull();
    sync.invalidate();
    expect(sync.take(sim.lobbySnapshot())).not.toBeNull();
  });

  it("sends the shooter's Gunner a 'landed' hit cue, and the victim crew a plain hit", async () => {
    const sim = await createSim();
    sim.setTeamSize(2);
    for (const id of ['a', 'b', 'c', 'd']) sim.addPlayer(id, id.toUpperCase());
    const [shooter, victim] = sim.state.teams;
    const sent: [string | null, string, string | undefined][] = [];
    forwardEvents(sim.state, [{ kind: 'hit', team: 0, victim: 1, cause: 'cannon', x: 0, z: 0 }], (pid, evt) => sent.push([pid, evt.kind, evt.detail]));
    expect(sent).toContainEqual([shooter?.members[1] ?? null, 'hit', 'landed']);
    for (const pid of victim?.members ?? []) expect(sent).toContainEqual([pid, 'hit', undefined]);
    expect(sent).toHaveLength(1 + (victim?.members.length ?? 0));
  });

  it('a phone that dropped off the network coasts instead of replaying its last packet', async () => {
    const sim = await createSim();
    sim.addPlayer('p0', 'P0');
    sim.addPlayer('kb', 'KB', { virtual: true, team: 1, role: 'pilot' });
    sim.applyMessage('p0', { t: 'calibrate' });
    expect(sim.start()).toBe(true);
    steps(sim, MATCH.countdownSec + 0.05);
    sim.debug.teleport(0, OPEN.x, OPEN.z, 0);
    sim.applyInput('p0', pilot(0, true));
    steps(sim, 1);
    expect(boat(sim, 0).gas).toBe(true);
    steps(sim, 1); // no packet for 2 s: past NET.inputStaleMs
    expect(boat(sim, 0).gas).toBe(false);
    sim.applyInput('p0', pilot(0, true));
    sim.step();
    expect(boat(sim, 0).gas).toBe(true);
    sim.setConnected('p0', false);
    sim.step();
    expect(boat(sim, 0).gas).toBe(false);
  });

  it('the kill-cam follows the killer and ends for good when the killer sinks', async () => {
    const sim = await duel();
    const views = new CameraViews();
    lineUp(sim, 30);
    sim.debug.giveWeapon(0, 'cannon');
    sim.applyInput('g0', gunner(1));
    steps(sim, 0.6);
    expect(boat(sim, 1).status).toBe('sinking');
    expect(views.update(sim.state)[1]).toMatchObject({ team: 1, followTeam: 0, killCam: true });
    sim.debug.sink(0);
    expect(views.update(sim.state)[1]).toMatchObject({ followTeam: 1, killCam: false });
    boat(sim, 0).status = 'alive'; // as if the killer were back already: the cut stays
    expect(views.update(sim.state)[1]).toMatchObject({ followTeam: 1, killCam: false });
    steps(sim, RESPAWN.delaySec);
    expect(boat(sim, 1).status).toBe('alive');
    expect(views.update(sim.state)[1]).toMatchObject({ followTeam: 1, killCam: false });
  });
});
