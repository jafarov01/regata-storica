// src/render/mapGeometry.ts - placeholder district from the parsed map: one instanced
// box per wall rectangle, a tower, bridge decks and pile clusters. The art track
// replaces the materials and adds facades; the positions and sizes come from here.
import { BoxGeometry, CylinderGeometry, Group, InstancedMesh, Mesh, MeshStandardMaterial, Object3D } from 'three';
import { MAP, PILE_RADIUS, type VeniceMap } from '@shared/map';

const FLOOR_HEIGHT = 3.2; // metres; SPEC: 3 to 5 floors
const PILES_PER_CLUSTER = 5;

export function buildDistrict(map: VeniceMap = MAP): Group {
  const group = new Group();
  const unitBox = new BoxGeometry(1, 1, 1);
  const plaster = new MeshStandardMaterial({ color: 0xd9b48f, roughness: 0.9 });
  const stone = new MeshStandardMaterial({ color: 0xcfc8b8, roughness: 0.8 });
  const wood = new MeshStandardMaterial({ color: 0x5a3a22, roughness: 0.9 });

  // walls: three.js rotation.y is never needed here, the rectangles are axis aligned
  const walls = new InstancedMesh(unitBox, plaster, map.walls.length);
  const dummy = new Object3D();
  map.walls.forEach((w, i) => {
    const floors = 3 + ((i * 7) % 3); // deterministic 3..5 floors per block
    const h = floors * FLOOR_HEIGHT;
    dummy.position.set(w.x, h / 2, w.z);
    dummy.scale.set(w.w, h, w.d);
    dummy.updateMatrix();
    walls.setMatrixAt(i, dummy.matrix);
  });
  walls.instanceMatrix.needsUpdate = true;
  group.add(walls);

  // campanile: one cell footprint, 60 m tall, visible from every viewport
  const tower = new Mesh(new BoxGeometry(map.cell, 60, map.cell), stone);
  tower.position.set(map.tower.x, 30, map.tower.z);
  group.add(tower);

  // bridges: the deck runs along z for 'ns', along x for 'ew'; clearance 4 m above the water
  for (const b of map.bridges) {
    const alongX = b.orientation === 'ew';
    const covered = b.kind === 'covered';
    const deck = new Mesh(
      new BoxGeometry(alongX ? b.length : b.width, covered ? 7 : 0.8, alongX ? b.width : b.length),
      stone,
    );
    deck.position.set(b.x, covered ? 4 + 3.5 : 4 + 0.4, b.z);
    group.add(deck);
  }

  // piles: a ring of posts per cluster
  const post = new CylinderGeometry(0.25, 0.25, 4, 6);
  const piles = new InstancedMesh(post, wood, map.piles.length * PILES_PER_CLUSTER);
  let k = 0;
  for (const p of map.piles) {
    for (let j = 0; j < PILES_PER_CLUSTER; j++) {
      const a = (j / PILES_PER_CLUSTER) * Math.PI * 2;
      dummy.position.set(p.x + Math.cos(a) * PILE_RADIUS * 0.7, 1, p.z + Math.sin(a) * PILE_RADIUS * 0.7);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      piles.setMatrixAt(k++, dummy.matrix);
    }
  }
  piles.instanceMatrix.needsUpdate = true;
  group.add(piles);
  return group;
}

/** three.js yaw for a mesh whose model forward is +x, from a sim heading (see shared/map.ts). */
export function yawFromHeading(heading: number): number {
  return -heading;
}
