import {
  BoxGeometry, ConeGeometry, CylinderGeometry, DoubleSide, ExtrudeGeometry, Group, InstancedMesh,
  Matrix4, Mesh, MeshStandardMaterial, Object3D, PlaneGeometry, Shape,
  type BufferGeometry, type Material, type Texture,
} from 'three';
import type { ParsedMap } from '@shared/map.ts';
import type { AssetKey } from './assets.ts';
import { weakenFog } from './environment.ts';

export interface BuildingBlock { x: number; z: number; w: number; d: number; col: number; row: number; cols: number; rows: number }

/** Split official rectangles for detail, excluding T even when it was merged with B. */
export function buildingBlocks(map: ParsedMap): BuildingBlock[] {
  const blocks: BuildingBlock[] = [];
  const add = (col: number, row: number, cols: number, rows: number) => {
    const p = map.toWorld(col, row);
    blocks.push({ col, row, cols, rows, x: p.x + (cols - 1) * map.cell / 2, z: p.z + (rows - 1) * map.cell / 2, w: cols * map.cell, d: rows * map.cell });
  };
  for (const wall of map.walls) {
    for (let r = wall.row; r < wall.row + wall.rows; r += 6) for (let c = wall.col; c < wall.col + wall.cols; c += 6) {
      const cols = Math.min(6, wall.col + wall.cols - c), rows = Math.min(6, wall.row + wall.rows - r);
      const t = map.tower;
      if (t && t.col >= c && t.col < c + cols && t.row >= r && t.row < r + rows) {
        for (let rr = r; rr < r + rows; rr++) for (let cc = c; cc < c + cols; cc++) if (map.cellAt(cc, rr) === 'B') add(cc, rr, 1, 1);
      } else add(c, r, cols, rows);
    }
  }
  return blocks;
}

/** Surface UVs in metres, so scaling an instance does not stretch its masonry. */
function surfaceMaterial(map: Texture, metres: number, band = false): MeshStandardMaterial {
  const material = new MeshStandardMaterial({ map, roughness: 0.88 });
  material.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vSurfacePos; varying vec3 vSurfaceNormal;');
    shader.vertexShader = shader.vertexShader.replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
      mat4 surfaceMatrix = modelMatrix;
      #ifdef USE_INSTANCING
        surfaceMatrix = modelMatrix * instanceMatrix;
      #endif
      vSurfacePos = (surfaceMatrix * vec4(transformed, 1.0)).xyz;
      vSurfaceNormal = normalize(mat3(surfaceMatrix) * normal);`);
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vSurfacePos; varying vec3 vSurfaceNormal;');
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `
      #ifdef USE_MAP
        vec3 n = abs(vSurfaceNormal);
        vec2 uv = n.y > 0.5 ? vSurfacePos.xz : (n.x > n.z ? vSurfacePos.zy : vSurfacePos.xy);
        uv /= ${metres.toFixed(4)};
        ${band ? 'uv.y = clamp(vSurfacePos.y / 0.6, 0.0, 1.0);' : ''}
        diffuseColor *= texture2D(map, uv);
      #endif`);
  };
  material.customProgramCacheKey = () => `surface-${metres}-${band}`;
  return material;
}

/** Lifted arch construction from research; official length and width are now honoured. */
export function buildBridge(length: number, width: number, covered: boolean, stone: MeshStandardMaterial, roof: MeshStandardMaterial): Group {
  const group = new Group();
  group.name = covered ? 'bridge_covered' : 'bridge';
  const half = length / 2;
  // Open-bottom arch: no underwater slab seals the canal, clearance at centre 3.4m.
  const shape = new Shape();
  shape.moveTo(-half, -0.5);
  shape.lineTo(-half, 3.8);
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    shape.lineTo(-half + length * t, 3.8 + Math.sin(t * Math.PI) * 0.6);
  }
  shape.lineTo(half, -0.5);
  const opening = Math.max(1, half - 0.45);
  shape.lineTo(opening, -0.5);
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    shape.lineTo(opening - 2 * opening * t, -0.5 + Math.sin(t * Math.PI) * 3.9);
  }
  shape.lineTo(-half, -0.5);
  shape.closePath();
  const geometry = new ExtrudeGeometry(shape, { depth: width, bevelEnabled: false, curveSegments: 6 });
  geometry.translate(0, 0, -width / 2);
  const arch = new Mesh(geometry, stone); arch.castShadow = arch.receiveShadow = true; group.add(arch);
  for (const side of [-1, 1]) {
    const rail = new Mesh(new BoxGeometry(length, 0.75, 0.18), stone);
    rail.position.set(0, 4.6, side * (width / 2 - 0.12)); rail.castShadow = true; group.add(rail);
  }
  if (covered) {
    for (const side of [-1, 1]) {
      const slab = new Mesh(new BoxGeometry(length + 1, 0.3, width * 0.58), roof);
      slab.position.set(0, 8.3, side * width * 0.23); slab.rotation.x = -side * 0.4;
      slab.castShadow = true; group.add(slab);
      for (let x = -half + 0.6; x <= half - 0.5; x += 3) {
        const column = new Mesh(new CylinderGeometry(0.16, 0.22, 3.2, 6), stone);
        column.position.set(x, 6, side * (width / 2 - 0.3)); column.castShadow = true; group.add(column);
      }
    }
  }
  return group;
}

export function buildWorld(map: ParsedMap, textures: Record<AssetKey, Texture>) {
  const group = new Group(); group.name = 'venice';
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  const dummy = new Object3D();
  const batches = new Map<string, { geometry: BufferGeometry; material: MeshStandardMaterial; matrices: Matrix4[]; cast: boolean }>();
  const box = new BoxGeometry(1, 1, 1), plane = new PlaneGeometry(1, 1);
  const pole = new CylinderGeometry(0.24, 0.3, 4, 8);
  const plaster = ['ochre', 'terracotta', 'rose', 'cream'].map(key => surfaceMaterial(textures[key as AssetKey], 4));
  const stone = surfaceMaterial(textures.stone, 3);
  const algae = surfaceMaterial(textures.algae, 4, true);
  const roof = new MeshStandardMaterial({ color: 0x9f5136, roughness: 0.95 });
  const wood = surfaceMaterial(textures.wood, 3);
  const poles = new MeshStandardMaterial({ map: textures.poles, roughness: 0.85 });
  const window = new MeshStandardMaterial({ map: textures.window, alphaTest: 0.5, roughness: 0.8, side: DoubleSide });
  const laundry = new MeshStandardMaterial({ map: textures.laundry, alphaTest: 0.5, side: DoubleSide, roughness: 1 });
  for (const material of [...plaster, stone, algae, roof, wood, poles, window, laundry]) materials.add(material);

  function instance(key: string, geometry: BufferGeometry, material: MeshStandardMaterial, x: number, y: number, z: number, sx: number, sy: number, sz: number, yaw = 0, cast = true) {
    let batch = batches.get(key);
    if (!batch) { batch = { geometry, material, matrices: [], cast }; batches.set(key, batch); geometries.add(geometry); }
    dummy.position.set(x, y, z); dummy.rotation.set(0, yaw, 0); dummy.scale.set(sx, sy, sz); dummy.updateMatrix();
    batch.matrices.push(dummy.matrix.clone());
  }
  const blocks = buildingBlocks(map);
  for (const block of blocks) {
    const floors = 3 + ((block.col * 7 + block.row * 13) % 3), height = floors * 3.4;
    const variant = (block.col + block.row) % 4;
    instance('plaster' + variant, box, plaster[variant]!, block.x, 1.5 + height / 2, block.z, block.w, height, block.d);
    instance('algae', box, algae, block.x, 0.3, block.z, block.w + 0.03, 0.6, block.d + 0.03);
    instance('stone', box, stone, block.x, 1.05, block.z, block.w + 0.08, 0.9, block.d + 0.08);
    instance('cornice', box, stone, block.x, height + 1.55, block.z, block.w + 0.3, 0.28, block.d + 0.3);
    instance('roof', box, roof, block.x, height + 1.85, block.z, block.w + 0.5, 0.35, block.d + 0.5);
    for (let r = block.row; r < block.row + block.rows; r++) for (let c = block.col; c < block.col + block.cols; c++) {
      const p = map.toWorld(c, r);
      for (const [dc, dr, yaw] of [[0, -1, Math.PI], [0, 1, 0], [-1, 0, -Math.PI / 2], [1, 0, Math.PI / 2]]) {
        if (!map.isWater(c + dc!, r + dr!)) continue;
        const x = p.x + dc! * (map.cell / 2 + 0.09), z = p.z + dr! * (map.cell / 2 + 0.09);
        for (let f = 0; f < floors; f++) for (const offset of [-1.9, 1.9]) {
          instance('windows', plane, window, x + (dr ? offset : 0), 3.4 + f * 3.4, z + (dc ? offset : 0), 2.6 * 607 / 1024, 2.6, 1, yaw!, false);
        }
        if ((c * 7 + r * 3 + dc! + dr!) % 13 === 0) {
          instance('laundry', plane, laundry, x + dc! * 0.08, 6.3, z + dr! * 0.08, 4.4, 4.4 * 452 / 2048, 1, yaw!, false);
        }
        if ((c + r + dc! + dr!) % 3 === 0) instance('poles', pole, poles, x + dc! * 0.6, 1.4, z + dr! * 0.6, 1, 1, 1);
      }
    }
  }
  for (const bridge of map.bridges) {
    const object = buildBridge(bridge.span * map.cell, bridge.width * map.cell, bridge.covered, stone, roof);
    object.position.set(bridge.x, 0, bridge.z);
    object.rotation.y = bridge.deck === 'ns' ? Math.PI / 2 : 0;
    group.add(object);
  }
  for (const dock of map.docks) {
    // Deck behind spawn, leaving the navigation cell and respawn point free.
    const dx = -Math.sin(dock.yaw), dz = -Math.cos(dock.yaw);
    instance('docks', box, wood, dock.x - dx * 3.5, 0.45, dock.z - dz * 3.5, 4, 0.45, 1.8, dock.yaw);
  }
  for (const pile of map.piles) for (let i = 0; i < 3; i++) {
    const a = i * Math.PI * 2 / 3;
    instance('piles', pole, wood, pile.x + Math.cos(a) * pile.radius * 0.45, 1.2, pile.z + Math.sin(a) * pile.radius * 0.45, 1.2, 0.9, 1.2);
  }
  if (map.tower) {
    const t = map.tower;
    const towerMat = new MeshStandardMaterial({ color: 0xb66646, roughness: 0.9 }); weakenFog(towerMat); materials.add(towerMat);
    instance('tower', box, towerMat, t.x, 28, t.z, 6.3, 56, 6.3);
    instance('tower-base', box, stone, t.x, 1.2, t.z, 7.8, 2.4, 7.8);
    instance('tower-belfry', box, stone, t.x, 58, t.z, 7, 4, 7);
    const spire = new ConeGeometry(5.2, 8, 4);
    instance('tower-spire', spire, roof, t.x, 64, t.z, 1, 1, 1, Math.PI / 4);
  }
  for (const [name, batch] of batches) {
    const mesh = new InstancedMesh(batch.geometry, batch.material, batch.matrices.length);
    mesh.name = name; mesh.castShadow = batch.cast; mesh.receiveShadow = true;
    batch.matrices.forEach((matrix, i) => mesh.setMatrixAt(i, matrix));
    mesh.computeBoundingSphere(); group.add(mesh);
  }
  group.traverse(object => {
    if (object instanceof Mesh) { geometries.add(object.geometry); for (const m of Array.isArray(object.material) ? object.material : [object.material]) materials.add(m); }
  });
  return { group, dispose() { geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); } };
}
