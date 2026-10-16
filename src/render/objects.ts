import {
  BoxGeometry, Color, ConeGeometry, CylinderGeometry, Group, InstancedMesh, MeshBasicMaterial, MeshStandardMaterial,
  Object3D, SphereGeometry, type BufferGeometry, type Material, type Texture,
} from 'three';
import { lerp } from '@shared/math.ts';
import type { RenderState } from './state.ts';
import { WakeTrail } from './water.ts';

/** Growing instance storage. Replaces only the GPU instance buffer when expanded. */
export class InstancePool {
  mesh: InstancedMesh;
  private count = 0;
  constructor(private readonly group: Group, readonly geometry: BufferGeometry, readonly material: Material, capacity = 16) {
    this.mesh = this.create(capacity); group.add(this.mesh);
  }
  private create(capacity: number): InstancedMesh {
    const mesh = new InstancedMesh(this.geometry, this.material, capacity);
    mesh.frustumCulled = false; mesh.count = 0; return mesh;
  }
  begin(required: number): void {
    if (required > this.mesh.instanceMatrix.count) {
      const next = this.create(2 ** Math.ceil(Math.log2(required)));
      this.group.remove(this.mesh); this.mesh.dispose(); this.mesh = next; this.group.add(next);
    }
    this.count = 0;
  }
  add(object: Object3D, colour?: number): void {
    object.updateMatrix(); this.mesh.setMatrixAt(this.count, object.matrix);
    if (colour !== undefined) this.mesh.setColorAt(this.count, objectColour.setHex(colour));
    this.count++;
  }
  end(): void {
    this.mesh.count = this.count; this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
  dispose(): void { this.group.remove(this.mesh); this.mesh.dispose(); this.geometry.dispose(); this.material.dispose(); }
}
const objectColour = new Color();

export function createObjects(crateTexture: Texture) {
  const group = new Group(); group.name = 'combat-objects';
  const dummy = new Object3D();
  const crates = new InstancePool(group, new BoxGeometry(1.3, 1, 1.3), new MeshStandardMaterial({ map: crateTexture, roughness: 0.9 }));
  const lanterns = new InstancePool(group, new BoxGeometry(0.32, 0.42, 0.32), new MeshBasicMaterial({ toneMapped: false }));
  const cannon = new InstancePool(group, new SphereGeometry(0.22, 10, 8), new MeshStandardMaterial({ color: 0x29292d, metalness: 0.7, roughness: 0.4 }));
  const mortar = new InstancePool(group, new SphereGeometry(0.3, 8, 6), new MeshStandardMaterial({ color: 0xf7bc49, emissive: 0xe68e19, emissiveIntensity: 0.8 }));
  const torpedo = new InstancePool(group, new CylinderGeometry(0.18, 0.24, 1.6, 8).rotateZ(-Math.PI / 2), new MeshStandardMaterial({ color: 0x697e76, metalness: 0.65, roughness: 0.4 }));
  const mines = new InstancePool(group, new SphereGeometry(0.45, 10, 8), new MeshStandardMaterial({ color: 0x333939, metalness: 0.4 }));
  const spikes = new InstancePool(group, new ConeGeometry(0.14, 0.4, 5), new MeshStandardMaterial({ color: 0x545858, metalness: 0.5 }));
  const jets = new InstancePool(group, new ConeGeometry(0.6, 9, 10, 1, true).rotateZ(Math.PI / 2).translate(4.5, 0, 0), new MeshBasicMaterial({ color: 0xaedfff, transparent: true, opacity: 0.4, depthWrite: false }));
  const pools = [crates, lanterns, cannon, mortar, torpedo, mines, spikes, jets];
  const trails = new Map<number, WakeTrail>();
  const seen = new Set<number>();
  return {
    group,
    update(state: RenderState, alpha: number, time: number): void {
      crates.begin(state.crates.length); lanterns.begin(state.crates.length);
      for (const c of state.crates) {
        if (!c.active) continue;
        dummy.scale.set(1, 1, 1); dummy.rotation.set(0, c.yaw, Math.sin(time + c.id) * 0.035);
        const y = 0.45 + Math.sin(time * 1.1 + c.id) * 0.08;
        dummy.position.set(c.x, y, c.z); crates.add(dummy);
        dummy.position.y = y + 0.85; lanterns.add(dummy, c.kind === 'weapon' ? 0xff3424 : 0x268dff);
      }
      cannon.begin(state.projectiles.length); mortar.begin(state.projectiles.length); torpedo.begin(state.projectiles.length);
      seen.clear();
      for (const p of state.projectiles) {
        dummy.scale.set(1, 1, 1); dummy.rotation.set(0, -p.yaw, 0);
        dummy.position.set(lerp(p.px, p.x, alpha), p.y, lerp(p.pz, p.z, alpha));
        (p.kind === 'cannon' ? cannon : p.kind === 'mortar' ? mortar : torpedo).add(dummy);
        if (p.kind === 'torpedo') {
          seen.add(p.id);
          let trail = trails.get(p.id);
          if (!trail) { trail = new WakeTrail(null, 18, 1.2, 0.06); trails.set(p.id, trail); group.add(trail.mesh); }
          trail.update(time, dummy.position.x - Math.cos(p.yaw) * 0.8, dummy.position.z - Math.sin(p.yaw) * 0.8, p.yaw, p.speed);
        }
      }
      for (const [id, trail] of trails) if (!seen.has(id)) { group.remove(trail.mesh); trail.dispose(); trails.delete(id); }
      mines.begin(state.mines.length); spikes.begin(state.mines.length * 6);
      for (const mine of state.mines) {
        dummy.position.set(mine.x, 0.15, mine.z); dummy.rotation.set(0, 0, 0); dummy.scale.setScalar(mine.armed ? 1 : 0.75); mines.add(dummy);
        for (let i = 0; i < 6; i++) {
          const a = i * Math.PI / 3;
          dummy.position.set(mine.x + Math.cos(a) * 0.48, 0.15, mine.z + Math.sin(a) * 0.48);
          dummy.rotation.set(0, -a, -Math.PI / 2); spikes.add(dummy);
        }
      }
      jets.begin(state.boats.length);
      for (const boat of state.boats) {
        if (!boat.jet) continue;
        dummy.scale.set(1, 1, 1); dummy.rotation.set(0, -boat.aim, 0);
        dummy.position.set(lerp(boat.px, boat.x, alpha), 0.8, lerp(boat.pz, boat.z, alpha)); jets.add(dummy);
      }
      for (const pool of pools) pool.end();
    },
    dispose(): void { for (const pool of pools) pool.dispose(); for (const trail of trails.values()) trail.dispose(); trails.clear(); },
  };
}
