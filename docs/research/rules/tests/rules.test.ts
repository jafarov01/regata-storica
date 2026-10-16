import { describe, expect, it } from 'vitest';
import { CONFIG } from '../shared/config.ts';
import { makeRng } from '../shared/math.ts';
import type { PlayerState, Pose, TeamState } from '../shared/state.ts';
import {
  bailRate,
  compareTeams,
  countdownBeeps,
  creditKill,
  decideAfterOvertime,
  firingEndsProtection,
  isRevealed,
  killFeedText,
  overtimeBoatPlan,
  overtimeKill,
  pickRespawnDock,
  pushKillFeed,
  rankTeams,
  resolveHit,
  revealAfterFire,
  sinkTimeline,
  speedMultiplier,
  startCountdown,
  statusAt,
  stepWater,
  tickMatch,
  tiedForFirst,
} from '../src/sim/rules.ts';
import type { HitSource, HitTarget } from '../src/sim/rules.ts';
import { applyPickup, consumeShot, crateCategoryForIndex, crateRespawnDelay, emptyInventory, rollCrateContents, usePower } from '../src/sim/items.ts';

const pose: Pose = { x: 0, y: 0, angle: 0 };
const alive = (over: Partial<HitTarget> = {}): HitTarget => ({ team: 1, status: 'alive', shieldUntil: 0, protectedUntil: 0, boostUntil: 0, ...over });
const cannon = (team = 0): HitSource => ({ kind: 'cannon', team, playerId: 'g', pose });

describe('resolveHit matrix', () => {
  const now = 100;
  it('sinking or respawning boats cannot be hit again', () => {
    expect(resolveHit(alive({ status: 'sinking' }), cannon(), now)).toEqual({ result: 'ignored', reason: 'notAlive' });
    expect(resolveHit(alive({ status: 'respawning' }), cannon(), now).result).toBe('ignored');
  });
  it('own team never hurts you: shots, mines, rams', () => {
    expect(resolveHit(alive({ team: 0 }), cannon(0), now)).toEqual({ result: 'ignored', reason: 'ownTeam' });
    expect(resolveHit(alive({ team: 0 }), { kind: 'mine', team: 0, playerId: null, pose }, now).result).toBe('ignored');
  });
  it('the Water Cannon never kills, even without shield or protection', () => {
    expect(resolveHit(alive(), { kind: 'waterCannon', team: 0, playerId: 'g', pose }, now)).toEqual({ result: 'ignored', reason: 'notLethal' });
  });
  it('spawn protection ignores the hit and keeps the Shield', () => {
    const t = alive({ protectedUntil: now + 1, shieldUntil: now + 5 });
    expect(resolveHit(t, cannon(), now)).toEqual({ result: 'ignored', reason: 'protected' });
    expect(resolveHit(t, cannon(), now + 1)).toEqual({ result: 'shielded', byTeam: 0 });
  });
  it('a Shield absorbs exactly one lethal hit; expired shields do not', () => {
    expect(resolveHit(alive({ shieldUntil: now + 0.1 }), cannon(), now).result).toBe('shielded');
    expect(resolveHit(alive({ shieldUntil: now }), cannon(), now).result).toBe('sunk');
  });
  it('lethal hit credits the team and the player, remembers the weapon and the killer pose', () => {
    const r = resolveHit(alive(), { kind: 'torpedo', team: 3, playerId: 'gun3', pose: { x: 5, y: 6, angle: 1 } }, now);
    expect(r).toEqual({ result: 'sunk', killer: { team: 3, playerId: 'gun3', weapon: 'torpedo', pose: { x: 5, y: 6, angle: 1 } } });
  });
  it('a Mine credits the team that dropped it even if that team has died since (team index is stable)', () => {
    const r = resolveHit(alive(), { kind: 'mine', team: 2, playerId: 'eng2', pose }, now);
    expect(r.result === 'sunk' && r.killer.team === 2 && r.killer.weapon === 'mine').toBe(true);
  });
  it('rams: only boosted, only fast enough, never when both are boosted', () => {
    const ram = (over: Partial<Extract<HitSource, { kind: 'ram' }>> = {}): HitSource => ({ kind: 'ram', team: 0, playerId: 'pilot0', pose, attackerBoostUntil: now + 1, impactSpeed: 9, ...over });
    expect(resolveHit(alive(), ram(), now).result).toBe('sunk');
    expect(resolveHit(alive(), ram({ attackerBoostUntil: now }), now)).toEqual({ result: 'ignored', reason: 'attackerNotBoosted' });
    expect(resolveHit(alive({ boostUntil: now + 1 }), ram(), now)).toEqual({ result: 'ignored', reason: 'bothBoosted' });
    expect(resolveHit(alive(), ram({ impactSpeed: CONFIG.boat.ramMinImpactSpeed - 0.01 }), now)).toEqual({ result: 'ignored', reason: 'ramTooSlow' });
    expect(resolveHit(alive({ shieldUntil: now + 1 }), ram(), now).result).toBe('shielded');
  });
});

describe('death timeline', () => {
  it('hit -> 2 s sinking -> respawn at 5 s -> 3 s protection; kill-cam 5 s', () => {
    const t = sinkTimeline(10);
    expect(t).toEqual({ hitAt: 10, sinkingUntil: 12, respawnAt: 15, killCamUntil: 15, protectedUntil: 18 });
    expect(statusAt(t, 10)).toBe('sinking');
    expect(statusAt(t, 11.99)).toBe('sinking');
    expect(statusAt(t, 12)).toBe('respawning');
    expect(statusAt(t, 14.99)).toBe('respawning');
    expect(statusAt(t, 15)).toBe('alive');
  });
  it('any firing ends protection, the Water Cannon per config', () => {
    expect(firingEndsProtection('cannon')).toBe(true);
    expect(firingEndsProtection('waterCannon')).toBe(CONFIG.weapons.waterCannon.endsSpawnProtection);
  });
});

describe('respawn dock', () => {
  const docks = Array.from({ length: 8 }, (_, i) => ({ id: i, x: i * 50, y: 0 })); // 0..350 m along x
  it('picks only docks at least 80 m from every enemy', () => {
    const rng = makeRng(1);
    for (let i = 0; i < 50; i++) {
      const d = pickRespawnDock(docks, [{ x: 100, y: 0 }], [], rng);
      expect(d).not.toBeNull();
      expect(Math.abs(d!.x - 100)).toBeGreaterThanOrEqual(80);
    }
  });
  it('falls back to the farthest dock when none is safe, skipping occupied docks', () => {
    const enemies = docks.map((d) => ({ x: d.x + 10, y: 0 })); // an enemy near every dock
    const d = pickRespawnDock(docks, enemies, [{ x: 350, y: 0 }], () => 0.5);
    expect(d).not.toBeNull();
    expect(d!.x).not.toBe(350);
    expect(pickRespawnDock([], [], [], () => 0)).toBeNull();
  });
  it('two boats respawning in the same step never share a dock', () => {
    const first = pickRespawnDock(docks, [], [], () => 0)!;
    const second = pickRespawnDock(docks, [], [first], () => 0)!;
    expect(second.id).not.toBe(first.id);
  });
});

describe('hull water', () => {
  it('full hull halves the speed', () => {
    expect(speedMultiplier(0)).toBe(1);
    expect(speedMultiplier(50)).toBeCloseTo(0.75);
    expect(speedMultiplier(100)).toBeCloseTo(0.5);
  });
  it('fills under the stream, bails with shake, auto-drains at half rate for 2-person teams, clamps 0..100', () => {
    expect(stepWater(0, 1, 0, 3, 1)).toBe(CONFIG.water.fillPerSecond);
    expect(stepWater(100, 1, 0, 3, 1)).toBe(100);
    expect(stepWater(50, 0, 1, 3, 1)).toBe(50 - CONFIG.water.bailPerSecondAtFullShake);
    expect(stepWater(50, 0, 0, 3, 1)).toBe(50 - CONFIG.water.naturalDrainPerSecond);
    expect(stepWater(50, 0, 0, 2, 1)).toBe(50 - CONFIG.water.autoDrainPerSecond);
    expect(bailRate(1, 2)).toBe(CONFIG.water.bailPerSecondAtFullShake / 2);
    expect(stepWater(1, 0, 1, 3, 1)).toBe(0);
  });
});

function team(index: number, kills: number, deaths: number, lastKillAt = 0): TeamState {
  return { index, name: `T${index}`, colour: '#fff', textColour: '#000', members: [`p${index}`], kills, deaths, lastKillAt };
}
function playerRec(id: string, kills: number, bestRamSpeed = 0, joinOrder = 0): PlayerState {
  return { id, name: id, joinOrder, pinned: false, connected: true, enabled: true, ready: true, calibrated: true, kind: 'phone', kills, deaths: 0, bestRamSpeed };
}

describe('scoring and results', () => {
  it('ranks by kills, then fewer deaths, then earliest last kill, then index', () => {
    const teams = [team(0, 3, 5, 200), team(1, 3, 2, 250), team(2, 5, 9, 100), team(3, 3, 2, 240)];
    expect(rankTeams(teams)).toEqual([2, 3, 1, 0]);
    expect(compareTeams(team(0, 1, 0, 0), team(1, 1, 0, 50))).toBeGreaterThan(0); // never scored sorts after
  });
  it('detects a tie for first only when kills and deaths are both equal', () => {
    expect(tiedForFirst([team(0, 4, 1), team(1, 4, 1), team(2, 4, 2)])).toEqual([0, 1]);
    expect(tiedForFirst([team(0, 4, 1), team(1, 4, 2)])).toEqual([0]);
    expect(tiedForFirst([])).toEqual([]);
  });
  it('credits kills to team and player, deaths to the victim team and its crew, tracks the best ram', () => {
    const teams = [team(0, 0, 0), team(1, 0, 0)];
    const players = { p0: playerRec('p0', 0), p1: playerRec('p1', 0) };
    const r = creditKill(teams, players, { killerTeam: 0, killerPlayer: 'p0', victimTeam: 1, weapon: 'ram', at: 42, impactSpeed: 11 });
    expect(r.teams[0]).toMatchObject({ kills: 1, lastKillAt: 42 });
    expect(r.teams[1]).toMatchObject({ deaths: 1 });
    expect(r.players['p0']).toMatchObject({ kills: 1, bestRamSpeed: 11 });
    expect(r.players['p1']).toMatchObject({ deaths: 1 });
    expect(teams[0]?.kills).toBe(0); // inputs untouched
  });
  it('results extras: top Gunner is the player with most kills, best ram the fastest', () => {
    const players = { a: playerRec('a', 2, 0, 1), b: playerRec('b', 4, 9.5, 2), c: playerRec('c', 4, 12, 3) };
    const r = decideAfterOvertime([team(0, 4, 1, 100), team(1, 4, 1, 90)], players);
    expect(r.winner).toBe(1); // reached the score first
    expect(r.decidedBy).toBe('firstToScore');
    expect(r.topGunner).toEqual({ playerId: 'b', name: 'b', kills: 4 });
    expect(r.bestRam).toEqual({ playerId: 'c', name: 'c', speed: 12 });
    const draw = decideAfterOvertime([team(0, 0, 0), team(1, 0, 0)], players);
    expect(draw).toMatchObject({ draw: true, winner: null, decidedBy: 'draw' });
  });
  it('kill feed strings and the 5-entry cap', () => {
    expect(killFeedText('Azzurro', 'Verde', 'torpedo')).toBe('Azzurro sank Verde with a Torpedo');
    expect(killFeedText('Rosso', 'Oro', 'ram')).toBe('Rosso rammed Oro');
    expect(killFeedText('Oro', 'Viola', 'mine')).toBe('Oro sank Viola with a Mine');
    expect(killFeedText(null, 'Verde', 'none')).toBe('Verde sank');
    let feed = pushKillFeed([], { at: 0, killerTeam: 0, victimTeam: 1, weapon: 'cannon', text: 'a' });
    for (let i = 1; i < 7; i++) feed = pushKillFeed(feed, { at: i, killerTeam: 0, victimTeam: 1, weapon: 'cannon', text: `t${i}` });
    expect(feed.length).toBe(5);
    expect(feed[0]?.text).toBe('t2');
  });
  it('minimap: 2 s after firing, always in the lagoon, never while sunk', () => {
    expect(revealAfterFire(0, 10, 'cannon')).toBe(12);
    expect(revealAfterFire(0, 10, 'waterCannon')).toBe(0);
    expect(isRevealed({ status: 'alive', revealedUntil: 12 }, 11.9, false, false)).toBe(true);
    expect(isRevealed({ status: 'alive', revealedUntil: 12 }, 12, false, false)).toBe(false);
    expect(isRevealed({ status: 'alive', revealedUntil: 0 }, 12, true, false)).toBe(true);
    expect(isRevealed({ status: 'sinking', revealedUntil: 99 }, 12, true, false)).toBe(false);
  });
});

describe('match state machine (sim time)', () => {
  const noPlayers = {};
  it('lobby -> countdown(10) -> battle(300) with horn -> results(20) -> lobby', () => {
    let clock = startCountdown(5);
    expect(clock).toEqual({ phase: 'countdown', phaseEndsAt: 15 });
    expect(tickMatch(clock, 14.99, [], noPlayers).transition.kind).toBe('none');
    let r = tickMatch(clock, 15, [], noPlayers);
    expect(r.clock).toEqual({ phase: 'battle', phaseEndsAt: 315 });
    expect(r.events.some((e) => e.kind === 'horn')).toBe(true);
    clock = r.clock;
    r = tickMatch(clock, 315, [team(0, 2, 1), team(1, 1, 1)], noPlayers);
    expect(r.clock).toEqual({ phase: 'results', phaseEndsAt: 335 });
    expect(r.transition).toMatchObject({ kind: 'results', results: { winner: 0, decidedBy: 'kills' } });
    r = tickMatch(r.clock, 335, [], noPlayers);
    expect(r.clock.phase).toBe('lobby');
  });
  it('a tie on kills and deaths goes to a 30 s sudden death for the tied teams only; next kill wins', () => {
    const clock = { phase: 'battle' as const, phaseEndsAt: 300 };
    const teams = [team(0, 3, 1, 100), team(1, 3, 1, 120), team(2, 1, 4)];
    const r = tickMatch(clock, 300, teams, noPlayers);
    expect(r.clock).toEqual({ phase: 'overtime', phaseEndsAt: 330 });
    expect(r.transition).toEqual({ kind: 'overtime', teams: [0, 1] });
    expect(overtimeBoatPlan([{ team: 0, status: 'alive' }, { team: 1, status: 'respawning' }, { team: 2, status: 'alive' }], [0, 1])).toEqual({ out: [2], respawnNow: [1] });
    const k = overtimeKill(310, 1, teams, noPlayers);
    expect(k.clock).toEqual({ phase: 'results', phaseEndsAt: 330 });
    expect(k.results).toMatchObject({ winner: 1, decidedBy: 'overtime', ranking: [1, 0, 2] });
    const still = tickMatch(r.clock, 330, teams, noPlayers);
    expect(still.transition).toMatchObject({ kind: 'results', results: { winner: 0, decidedBy: 'firstToScore' } });
  });
  it('beeps at 3, 2, 1 exactly once each even with uneven steps', () => {
    const all: number[] = [];
    let prev = 10;
    for (let t = 9.98; t >= -0.01; t -= 0.017) {
      for (const e of countdownBeeps(prev, Math.max(0, t))) if (e.kind === 'beep') all.push(e.secondsLeft);
      prev = Math.max(0, t);
    }
    expect(all).toEqual([3, 2, 1]);
  });
});

describe('inventory and crates', () => {
  it('same weapon tops up, different replaces, last shot brings the Water Cannon back', () => {
    let inv = emptyInventory();
    let r = applyPickup(inv, 'cannon');
    expect(r).toMatchObject({ consumed: true, effect: 'newWeapon' });
    inv = r.inv;
    inv = { ...inv, weapon: { kind: 'cannon', ammo: 1 } };
    r = applyPickup(inv, 'cannon');
    expect(r.inv.weapon).toEqual({ kind: 'cannon', ammo: 5 });
    expect(r.effect).toBe('topUp');
    r = applyPickup(r.inv, 'torpedo');
    expect(r.inv.weapon).toEqual({ kind: 'torpedo', ammo: 2 });
    expect(r.effect).toBe('replace');
    let s = consumeShot(r.inv);
    expect(s).toMatchObject({ fired: 'torpedo', emptied: false });
    s = consumeShot(s.inv);
    expect(s).toMatchObject({ fired: 'torpedo', emptied: true });
    expect(s.inv.weapon).toBeNull();
    expect(consumeShot(s.inv).fired).toBe('waterCannon');
  });
  it('two power slots; a third blue crate stays in the water; disabled tiers are not picked up', () => {
    let r = applyPickup(emptyInventory(), 'shield');
    r = applyPickup(r.inv, 'mine');
    expect(r.inv.powers).toEqual(['shield', 'mine']);
    const full = applyPickup(r.inv, 'boost');
    expect(full).toMatchObject({ consumed: false, effect: 'powersFull' });
    expect(applyPickup(emptyInventory(), 'wave', CONFIG, { mvp: true, should: true, stretch: false })).toMatchObject({ consumed: false, effect: 'disabled' });
    const u = usePower(r.inv, 0);
    expect(u.power).toBe('shield');
    expect(u.inv.powers).toEqual([null, 'mine']);
  });
  it('crate rolls respect category, weights and tier flags', () => {
    const rng = makeRng(7);
    const counts: Record<string, number> = {};
    for (let i = 0; i < 2000; i++) {
      const k = rollCrateContents('weapon', rng, CONFIG, { mvp: true, should: false, stretch: false });
      counts[k] = (counts[k] ?? 0) + 1;
    }
    expect(counts['mortar']).toBeUndefined();
    expect(counts['cannon']! / 2000).toBeCloseTo(50 / 80, 1);
    expect(rollCrateContents('power', () => 0.999, CONFIG, { mvp: true, should: true, stretch: true })).toBe('wave');
    expect([0, 1, 2, 3, 4].map((i) => crateCategoryForIndex(i))).toEqual(['weapon', 'weapon', 'weapon', 'power', 'power']);
  });
  it('crates respawn in 8 s, 4 s in the final minute when the stretch tier is on', () => {
    expect(crateRespawnDelay(100, 'battle', 300)).toBe(8);
    expect(crateRespawnDelay(250, 'battle', 300, CONFIG, { mvp: true, should: true, stretch: true })).toBe(4);
    expect(crateRespawnDelay(250, 'battle', 300, CONFIG, { mvp: true, should: true, stretch: false })).toBe(8);
  });
});
