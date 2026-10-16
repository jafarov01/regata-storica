import { describe, expect, it } from 'vitest';
import { InstancedMesh, Matrix4, Mesh, Texture, Vector3 } from 'three';
import type { RenderState } from './state.ts';
import { createObjects } from './objects.ts';

function frame(): RenderState { return { time: 0, boats: [], crates: [], projectiles: [], mines: [] }; }
function instances(group: import('three').Group) { return group.children.filter(o => o instanceof InstancedMesh) as InstancedMesh[]; }

describe('Track C combat object synchronization', () => {
  it('removes collected crates, restores them and colours lanterns by category', () => {
    const texture = new Texture(), objects = createObjects(texture), state = frame();
    state.crates.push({ id: 1, x: 1, z: 2, yaw: 0, active: true, kind: 'power' });
    objects.update(state, 1, 0);
    const [crate, lantern] = instances(objects.group);
    expect(crate!.count).toBe(1); expect(lantern!.count).toBe(1);
    expect(lantern!.instanceColor!.getZ(0)).toBeGreaterThan(lantern!.instanceColor!.getX(0));
    state.crates[0]!.active = false; objects.update(state, 1, 0); expect(crate!.count).toBe(0);
    state.crates[0]!.active = true; objects.update(state, 1, 0); expect(crate!.count).toBe(1);
    objects.dispose(); texture.dispose();
  });
  it('draws the actual mortar height and cleans up torpedo wakes', () => {
    const texture = new Texture(), objects = createObjects(texture), state = frame();
    state.projectiles.push({ id: 1, kind: 'mortar', x: 10, px: 8, z: 12, pz: 10, y: 7, yaw: 0, speed: 12 });
    objects.update(state, 0.5, 1);
    const mortar = instances(objects.group)[3]!;
    const matrix = new Matrix4(); mortar.getMatrixAt(0, matrix);
    const position = new Vector3().setFromMatrixPosition(matrix);
    expect(position.toArray()).toEqual([9, 7, 11]);
    state.projectiles[0]!.kind = 'torpedo'; objects.update(state, 1, 2);
    expect(objects.group.children.filter(o => o instanceof Mesh && !(o instanceof InstancedMesh))).toHaveLength(1);
    state.projectiles.length = 0; objects.update(state, 1, 3);
    expect(objects.group.children.filter(o => o instanceof Mesh && !(o instanceof InstancedMesh))).toHaveLength(0);
    objects.dispose(); texture.dispose();
  });
  it('clears stream instances and keeps mines visibly distinct', () => {
    const texture = new Texture(), objects = createObjects(texture), state = frame();
    state.mines.push({ id: 1, x: 0, z: 0, armed: true });
    objects.update(state, 1, 1);
    const pools = instances(objects.group);
    expect(pools[5]!.count).toBe(1); expect(pools[6]!.count).toBe(6); expect(pools[7]!.count).toBe(0);
    state.mines.length = 0; objects.update(state, 1, 1);
    expect(pools[5]!.count).toBe(0); expect(pools[6]!.count).toBe(0);
    objects.dispose(); texture.dispose();
  });
});
