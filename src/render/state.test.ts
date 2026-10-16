import { beforeAll, describe, expect, it } from 'vitest';
import { Group, MeshBasicMaterial, Object3D, BoxGeometry, Texture } from 'three';
import { CAMERA, RESPAWN } from '@shared/config.ts';
import { getMap } from '@shared/map.ts';
import { lerpAngle } from '@shared/math.ts';
import type { GameState } from '@shared/state.ts';
import { createSim } from '../sim/index.ts';
import { StateAdapter, interpolatedTime, researchYaw } from './state.ts';
import { CameraRig, clampCamera } from './camera.ts';
import { buildingBlocks, buildBridge } from './world.ts';
import { MeshStandardMaterial } from 'three';
import { InstancePool } from './objects.ts';
import { GondolaView, createGondolaAssets } from './gondola.ts';

let baseline: GameState;
beforeAll(async () => {
  const sim = await createSim();
  sim.debug.addBotTeam();
  baseline = structuredClone(sim.state);
});
function fixture() { return structuredClone(baseline); }

describe('Track C state adapter', () => {
  it.each([0, Math.PI / 2, Math.PI, -Math.PI / 2])('keeps hull and aim world directions at yaw %s', yaw => {
    const source = fixture(); const boat = source.boats[0]!;
    boat.pose.yaw = yaw; boat.aimYaw = yaw; boat.angVel = 1.25;
    const adapted = new StateAdapter().adapt(source).boats[0]!;
    expect(Math.cos(adapted.yaw)).toBeCloseTo(-Math.sin(yaw));
    expect(Math.sin(adapted.aim)).toBeCloseTo(-Math.cos(yaw));
    expect(adapted.turnRate).toBe(-1.25);
  });
  it('interpolates the shortest arc across ±pi for hull and independent aim', () => {
    const source = fixture(); const boat = source.boats[0]!;
    boat.prevPose.yaw = Math.PI - 0.1; boat.pose.yaw = -Math.PI + 0.1;
    boat.prevAimYaw = -Math.PI + 0.2; boat.aimYaw = Math.PI - 0.2;
    const b = new StateAdapter().adapt(source).boats[0]!;
    expect(Math.sin(lerpAngle(b.pyaw, b.yaw, 0.5))).toBeCloseTo(1);
    expect(Math.sin(lerpAngle(b.paim, b.aim, 0.5))).toBeCloseTo(1);
  });
  it('distinguishes a newly sunk boat from hidden respawning/out boats', () => {
    const source = fixture(); const boat = source.boats[0]!; const adapter = new StateAdapter();
    source.time = boat.sunkAt = 10; boat.status = 'sinking';
    expect(adapter.adapt(source).boats[0]).toMatchObject({ status: 'sinking', alive: false, sinkT: 0 });
    source.time += RESPAWN.sinkSec / 2;
    expect(adapter.adapt(source).boats[0]!.sinkT).toBeCloseTo(1);
    boat.status = 'respawning';
    expect(adapter.adapt(source).boats[0]).toMatchObject({ status: 'respawning', alive: false, sinkT: 0 });
    boat.status = 'out'; expect(adapter.adapt(source).boats[0]!.status).toBe('out');
  });
  it('expires bubbles and gates water jets by weapon, life and firing', () => {
    const source = fixture(); const boat = source.boats[0]!; const adapter = new StateAdapter();
    source.time = 5; boat.shieldUntil = 7; boat.protectedUntil = 4;
    boat.status = 'alive'; boat.weapon = 'watercannon'; boat.firing = true;
    expect(adapter.adapt(source).boats[0]).toMatchObject({ shieldT: 2, protectT: 0, jet: true });
    boat.weapon = 'cannon'; expect(adapter.adapt(source).boats[0]!.jet).toBe(false);
    boat.weapon = 'watercannon'; boat.status = 'sinking'; expect(adapter.adapt(source).boats[0]!.jet).toBe(false);
    boat.status = 'alive'; boat.firing = false; expect(adapter.adapt(source).boats[0]!.jet).toBe(false);
  });
  it('reuses output, resets derivatives on time rewind, and never writes to the input', () => {
    const source = fixture(); const snapshot = structuredClone(source); const adapter = new StateAdapter();
    const state = adapter.adapt(source), boat = state.boats[0];
    expect(adapter.adapt(source)).toBe(state); expect(state.boats[0]).toBe(boat); expect(source).toEqual(snapshot);
    source.time = 2; source.tick = 120; source.boats[0]!.speed = 10; adapter.adapt(source);
    source.time = 0; source.tick = 0; expect(adapter.adapt(source).boats[0]!.accel).toBe(0);
  });
  it('converts crate categories, mine arming and projectile height without inventing prevY', () => {
    const source = fixture(); source.time = 3;
    source.crates = [{ id: 1, x: 2, z: 3, category: 'power', active: true, yaw: 1, respawnAt: 0 }];
    source.mines = [{ id: 2, team: 0, x: 4, z: 5, armedAt: 4, expiresAt: 30 }];
    source.projectiles = [{ id: 3, kind: 'mortar', team: 0, x: 1, y: 12, z: 3, prevX: 0, prevZ: 2, vx: 1, vz: 2, yaw: 0, targetX: 9, targetZ: 9, progress: 0.5, lockTarget: null, spawnedAt: 2 }];
    const adapted = new StateAdapter().adapt(source);
    expect(adapted.crates[0]!.kind).toBe('power'); expect(adapted.mines[0]!.armed).toBe(false);
    expect(adapted.projectiles[0]).toMatchObject({ y: 12, px: 0, pz: 2 });
  });
  it('holds render time during pause', () => {
    const state = fixture(); state.time = 10; state.paused = true;
    expect(interpolatedTime(state, 0.1)).toBe(10); expect(interpolatedTime(state, 0.9)).toBe(10);
  });
});

describe('Track C map and camera integration', () => {
  it('covers every B cell exactly once and never builds a facade over the tower', () => {
    const map = getMap(), seen = new Set<string>();
    for (const b of buildingBlocks(map)) for (let r = b.row; r < b.row + b.rows; r++) for (let c = b.col; c < b.col + b.cols; c++) {
      expect(map.cellAt(c, r)).toBe('B'); expect(seen.has(`${c},${r}`)).toBe(false); seen.add(`${c},${r}`);
    }
    expect(seen.size).toBe(map.rows.join('').split('').filter(c => c === 'B').length);
  });
  it('builds bridge geometry to official cell-derived dimensions', () => {
    const material = new MeshStandardMaterial();
    for (const bridge of getMap().bridges) {
      const group = buildBridge(bridge.span * getMap().cell, bridge.width * getMap().cell, bridge.covered, material, material);
      const arch = group.children[0] as import('three').Mesh;
      arch.geometry.computeBoundingBox();
      const box = arch.geometry.boundingBox!;
      expect(box.max.x - box.min.x).toBeCloseTo(bridge.span * getMap().cell);
      expect(box.max.z - box.min.z).toBeCloseTo(bridge.width * getMap().cell);
      expect(group.name).toBe(bridge.covered ? 'bridge_covered' : 'bridge');
      group.traverse(o => { if ('geometry' in o) (o as import('three').Mesh).geometry.dispose(); });
    }
    material.dispose();
  });
  it('keeps a level camera, official FOV, and snaps after teleport', () => {
    const rig = new CameraRig(getMap());
    // Lagoon water of the compact map (column 22 and 26, row 11).
    rig.update(68, 12, researchYaw(0), 0, false, 0.016, 16 / 9);
    expect(rig.camera.fov).toBe(CAMERA.fovDeg); expect(rig.camera.position.y).toBe(CAMERA.up);
    expect(rig.camera.position.z).toBeCloseTo(12 + CAMERA.back);
    expect(Math.abs(rig.camera.rotation.x)).toBeLessThan(1e-7);
    rig.update(100, 12, researchYaw(0), 0, false, 0.016, 1);
    expect(rig.camera.position.x).toBeCloseTo(100);
    expect(rig.camera.position.z).toBeCloseTo(12 + CAMERA.back);
    expect(rig.camera.aspect).toBe(1);
  });
  it('stops camera motion before a map wall', () => {
    const map = getMap();
    // From the lagoon toward the east border wall (x >= 104).
    const safe = clampCamera(map, 92, 12, 114, 12);
    expect(map.isWaterAt(safe.x, safe.z)).toBe(true);
    expect(safe.x).toBeLessThan(104);
  });
});

it('grows dynamic pools beyond research capacities and clears stale instances', () => {
  const pool = new InstancePool(new Group(), new BoxGeometry(), new MeshBasicMaterial(), 2);
  const dummy = new Object3D();
  pool.begin(150); for (let i = 0; i < 150; i++) { dummy.position.x = i; pool.add(dummy); } pool.end();
  expect(pool.mesh.count).toBe(150); expect(pool.mesh.instanceMatrix.count).toBeGreaterThanOrEqual(150);
  pool.begin(1); pool.add(dummy); pool.end(); expect(pool.mesh.count).toBe(1); pool.dispose();
});

it('hides every part of respawning/out boats and freezes motion while paused', () => {
  const glow = new Texture(), assets = createGondolaAssets(glow);
  const view = new GondolaView(assets, 0xff0000, null);
  const source = fixture(); const adapter = new StateAdapter();
  source.boats[0]!.status = 'alive';
  view.update(adapter.adapt(source).boats[0]!, 1, 10, 0.016);
  const boat = view.root.children[0]!;
  const pose = boat.position.clone(), rotation = boat.rotation.clone();
  view.update(adapter.adapt(source).boats[0]!, 1, 10, 0);
  expect(boat.position.equals(pose)).toBe(true); expect(boat.rotation.equals(rotation)).toBe(true);
  for (const status of ['respawning', 'out'] as const) {
    source.boats[0]!.status = status;
    view.update(adapter.adapt(source).boats[0]!, 1, 10, 0);
    expect(view.root.visible).toBe(false);
  }
  source.boats[0]!.status = 'alive';
  view.update(adapter.adapt(source).boats[0]!, 1, 10, 0);
  expect(view.root.visible).toBe(true);
  view.dispose(); assets.dispose(); glow.dispose();
});
