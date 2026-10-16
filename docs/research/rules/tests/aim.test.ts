import { describe, expect, it } from 'vitest';
import { CONFIG } from '../shared/config.ts';
import { DEG } from '../shared/math.ts';
import { aimAssist, crosshairFor, enemyUnderCrosshair, integrateAim, keyboardDYaw, mortarTarget, rayCircleDistance, torpedoLock } from '../src/sim/aim.ts';
import type { AimCandidate } from '../src/sim/aim.ts';

const enemy = (team: number, x: number, y: number, hidden = false): AimCandidate => ({ team, x, y, hidden });

describe('aim assist', () => {
  it('bends by at most 4 degrees toward the enemy nearest the aim line', () => {
    const far = enemy(1, 40, Math.tan(6 * DEG) * 40); // 6 deg off, 40 m
    const r = aimAssist(0, 0, 0, [far]);
    expect(r.team).toBe(1);
    expect(r.yaw).toBeCloseTo(4 * DEG, 6);
    const close = enemy(2, 30, Math.tan(2 * DEG) * 30); // 2 deg off: exact
    expect(aimAssist(0, 0, 0, [far, close])).toMatchObject({ team: 2 });
    expect(aimAssist(0, 0, 0, [far, close]).yaw).toBeCloseTo(2 * DEG, 6);
  });
  it('ignores enemies outside the cone, out of range, hidden in smoke or behind a wall', () => {
    expect(aimAssist(0, 0, 0, [enemy(1, 40, Math.tan(9 * DEG) * 40)]).team).toBeNull();
    expect(aimAssist(0, 0, 0, [enemy(1, CONFIG.aim.assistRange + 1, 0)]).team).toBeNull();
    expect(aimAssist(0, 0, 0, [enemy(1, 40, 0, true)]).team).toBeNull();
    expect(aimAssist(0, 0, 0, [enemy(1, 40, 0)], CONFIG, () => false).team).toBeNull();
    expect(aimAssist(0, 0, 0, []).yaw).toBe(0);
  });
});

describe('under the crosshair', () => {
  it('is a ray-vs-hull-circle test with hysteresis and line of sight', () => {
    expect(rayCircleDistance(0, 0, 1, 0, 50, 0, 3.5)).toBeCloseTo(46.5);
    expect(rayCircleDistance(0, 0, 1, 0, -50, 0, 3.5)).toBeNull();
    expect(rayCircleDistance(0, 0, 1, 0, 0, 0, 3.5)).toBe(0);
    const edge = enemy(1, 50, 4.0); // 4 m off the line: outside 3.5, inside the sticky 4.6
    expect(enemyUnderCrosshair(0, 0, 0, [edge], false)).toBeNull();
    expect(enemyUnderCrosshair(0, 0, 0, [edge], true)).toBe(1);
    expect(enemyUnderCrosshair(0, 0, 0, [enemy(1, 50, 0)], false, CONFIG, () => false)).toBeNull();
    expect(enemyUnderCrosshair(0, 0, 0, [enemy(1, CONFIG.aim.onTargetRange + 10, 0)], false)).toBeNull();
    expect(enemyUnderCrosshair(0, 0, 0, [enemy(2, 60, 0), enemy(1, 30, 0)], false)).toBe(1); // nearest wins
  });
  it('gyro gain drops to 0.6 while on target, applied by the sim not the phone', () => {
    expect(integrateAim(0, 0.1, false)).toBeCloseTo(0.1);
    expect(integrateAim(0, 0.1, true)).toBeCloseTo(0.06);
    expect(integrateAim(Math.PI - 0.01, 0.05, false)).toBeCloseTo(-Math.PI + 0.04);
  });
});

describe('torpedo lock and mortar', () => {
  it('locks the nearest enemy inside 40 degrees of the AIM, not the bow', () => {
    const aim = 90 * DEG; // gunner looks to the side
    const ahead = enemy(1, 60, 0); // along the bow: outside the aim cone
    const side = enemy(2, 0, 50);
    expect(torpedoLock(0, 0, aim, [ahead, side])).toBe(2);
    expect(torpedoLock(0, 0, 0, [ahead, side])).toBe(1);
    expect(torpedoLock(0, 0, 0, [enemy(1, 60, Math.tan(21 * DEG) * 60)])).toBeNull();
    expect(torpedoLock(0, 0, 0, [enemy(1, CONFIG.weapons.torpedo.lockRange + 1, 0)])).toBeNull();
    expect(torpedoLock(0, 0, 0, [enemy(1, 60, 0, true)])).toBeNull();
    expect(torpedoLock(0, 0, 0, [enemy(1, 60, 0)], CONFIG, () => false)).toBeNull();
    expect(torpedoLock(0, 0, 0, [enemy(1, 60, 0), enemy(2, 20, Math.tan(15 * DEG) * 20)])).toBe(2); // nearest by distance
  });
  it('mortar lands on the nearest enemy within 10 degrees and 60 m (walls ignored), else 40 m ahead', () => {
    expect(mortarTarget(0, 0, 0, [enemy(1, 50, Math.tan(9 * DEG) * 50)])).toMatchObject({ team: 1 });
    expect(mortarTarget(0, 0, 0, [enemy(1, 50, Math.tan(11 * DEG) * 50)])).toEqual({ x: 40, y: 0, team: null });
    expect(mortarTarget(0, 0, 0, [enemy(1, 61, 0)]).team).toBeNull();
    const r = mortarTarget(10, 10, 90 * DEG, []);
    expect(r.x).toBeCloseTo(10);
    expect(r.y).toBeCloseTo(50);
  });
  it('crosshair priority: hit flash > lock > diamond > neutral', () => {
    expect(crosshairFor({ now: 1, hitFlashUntil: 1.2, weapon: 'torpedo', lockTeam: 1, onTarget: true })).toBe('hit');
    expect(crosshairFor({ now: 1, hitFlashUntil: 0, weapon: 'torpedo', lockTeam: 1, onTarget: false })).toBe('lock');
    expect(crosshairFor({ now: 1, hitFlashUntil: 0, weapon: 'cannon', lockTeam: 1, onTarget: true })).toBe('target');
    expect(crosshairFor({ now: 1, hitFlashUntil: 0, weapon: null, lockTeam: null, onTarget: false })).toBe('neutral');
  });
  it('keyboard Left/Right produce a dYaw like a phone', () => {
    expect(keyboardDYaw(true, false, 0.5)).toBeCloseTo(60 * DEG);
    expect(keyboardDYaw(false, true, 0.5)).toBeCloseTo(-60 * DEG);
    expect(keyboardDYaw(true, true, 0.5)).toBe(0);
  });
});
