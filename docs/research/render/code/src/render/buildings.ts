/**
 * src/render/buildings.ts
 * Venice from the ASCII grid (SPEC section 7 and 9). Adjacent 'B' cells are merged into
 * rectangles (greedy), each rectangle becomes ONE mesh: four stacked boxes (algae band,
 * Istrian stone band, plaster, cornice) merged with BufferGeometryUtils.mergeGeometries and
 * coloured by a vertex-colour attribute so a single material (one draw call) serves every block.
 * Windows, shutters, chimneys and mooring poles are InstancedMesh per map quadrant.
 * Bridges are arched extrusions over '=' runs; the run nearest the centre gets the covered roof.
 * 'T' is the campanile. Everything static casts into the one baked shadow map.
 */
import {
  BoxGeometry,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Shape,
  Vector3,
  type Texture,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { cellAt, cellToWorld, type CellChar, type MapGrid } from '@shared/map.ts';
import { weakenFog } from './environment.ts';

export const BUILDING = {
  floorHeight: 3.3,
  minFloors: 3,
  maxFloors: 5,
  algaeBand: 0.6,
  stoneBand: 0.9,
  cornice: 0.35,
  corniceOverhang: 0.25,
  grainTileMetres: 4,
  plaster: [0xd9a461, 0xc7714f, 0xdca08f, 0xe8dcc3, 0xcf9a5a, 0xb86a4c] as const, // ochre, terracotta, rose, cream
  roof: 0x8a4b36,
  stone: 0xe9e4d8,
  algae: 0x2f4a36,
  windowGlass: 0x1b2530,
  shutters: [0x3f6b48, 0x2e5a3b, 0x5a4a35, 0x6a7c5a] as const,
  bridgeWidth: 5,
  bridgeRise: 3.6,
  archClearance: 3.1,
  poleHeight: 3.2,
} as const;

export interface BlockRect {
  readonly c: number;
  readonly r: number;
  readonly w: number; // cells along X
  readonly d: number; // cells along Z
}

/** Greedy rectangle decomposition of all 'B' cells. Deterministic, O(cells). */
export function mergeBlocks(map: MapGrid): BlockRect[] {
  const used = new Uint8Array(map.cols * map.rows);
  const isB = (c: number, r: number): boolean => cellAt(map, c, r) === 'B' && used[r * map.cols + c] === 0;
  const out: BlockRect[] = [];
  for (let r = 0; r < map.rows; r++) {
    for (let c = 0; c < map.cols; c++) {
      if (!isB(c, r)) continue;
      let w = 1;
      while (c + w < map.cols && isB(c + w, r) && w < 6) w++;
      let d = 1;
      outer: while (r + d < map.rows && d < 6) {
        for (let k = 0; k < w; k++) if (!isB(c + k, r + d)) break outer;
        d++;
      }
      for (let rr = r; rr < r + d; rr++) for (let cc = c; cc < c + w; cc++) used[rr * map.cols + cc] = 1;
      out.push({ c, r, w, d });
    }
  }
  return out;
}

function hash(a: number, b: number, salt: number = 0): number {
  let h = (a * 374761393 + b * 668265263 + salt * 2246822519) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** BoxGeometry face order is px, nx, py, ny, pz, nz, four vertices each (three r186 BoxGeometry.js). */
function scaleBoxUvs(geo: BoxGeometry, w: number, h: number, d: number, tile: number): void {
  const uv = geo.getAttribute('uv');
  const faceDims: readonly [number, number][] = [
    [d, h],
    [d, h],
    [w, d],
    [w, d],
    [w, h],
    [w, h],
  ];
  for (let i = 0; i < uv.count; i++) {
    const dims = faceDims[Math.floor(i / 4)] ?? [1, 1];
    uv.setXY(i, (uv.getX(i) * dims[0]) / tile, (uv.getY(i) * dims[1]) / tile);
  }
}

function colourBox(geo: BoxGeometry, side: Color, top: Color): void {
  const n = geo.getAttribute('position').count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const c = Math.floor(i / 4) === 2 ? top : side; // face 2 = +Y
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new Float32BufferAttribute(arr, 3));
}

function box(w: number, h: number, d: number, x: number, y: number, z: number, side: Color, top: Color): BoxGeometry {
  const g = new BoxGeometry(w, h, d);
  scaleBoxUvs(g, w, h, d, BUILDING.grainTileMetres);
  colourBox(g, side, top);
  g.translate(x, y + h / 2, z);
  return g;
}

export interface Cullable {
  readonly object: Object3D;
  readonly cx: number;
  readonly cz: number;
  readonly radius: number;
}

export interface World {
  readonly group: Group;
  /** Per-viewport distance culling candidates (building blocks, bridges). */
  readonly cullables: readonly Cullable[];
  /** Hidden by the "building detail" quality cut (windows, shutters, chimneys, poles). */
  readonly detail: readonly Object3D[];
  readonly blockCount: number;
  dispose(): void;
}

export interface WorldTextures {
  readonly grain: Texture;
  readonly stripesBlue: Texture;
  readonly stripesRed: Texture;
}

const tmpColor = new Color();
const tmpColor2 = new Color();
const dummy = new Object3D();

function floorsFor(b: BlockRect): number {
  return BUILDING.minFloors + (hash(b.c, b.r, 1) % (BUILDING.maxFloors - BUILDING.minFloors + 1));
}

function blockHeight(b: BlockRect): number {
  return BUILDING.algaeBand + BUILDING.stoneBand + floorsFor(b) * BUILDING.floorHeight;
}

export function buildWorld(map: MapGrid, tex: WorldTextures): World {
  const group = new Group();
  group.name = 'world';
  const cullables: Cullable[] = [];
  const detail: Object3D[] = [];
  const disposables: { dispose(): void }[] = [];

  const plasterMat = new MeshStandardMaterial({ map: tex.grain, vertexColors: true, roughness: 0.92, metalness: 0 });
  const stoneMat = new MeshStandardMaterial({ map: tex.grain, color: BUILDING.stone, roughness: 0.8 });
  const glassMat = new MeshStandardMaterial({ color: BUILDING.windowGlass, roughness: 0.15, metalness: 0.1 });
  const shutterMat = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.85 }); // tinted per instance
  const roofMat = new MeshStandardMaterial({ color: BUILDING.roof, roughness: 0.95 });
  const poleBlue = new MeshStandardMaterial({ map: tex.stripesBlue, roughness: 0.7 });
  const poleRed = new MeshStandardMaterial({ map: tex.stripesRed, roughness: 0.7 });
  disposables.push(plasterMat, stoneMat, glassMat, shutterMat, roofMat, poleBlue, poleRed);

  // ---- blocks -------------------------------------------------------------
  const blocks = mergeBlocks(map);
  const roof = new Color(BUILDING.roof);
  const stone = new Color(BUILDING.stone);
  const algae = new Color(BUILDING.algae);
  for (const b of blocks) {
    const w = b.w * map.cell;
    const d = b.d * map.cell;
    const h = blockHeight(b);
    const p0 = cellToWorld(map, b.c, b.r);
    const p1 = cellToWorld(map, b.c + b.w - 1, b.r + b.d - 1);
    const cx = (p0.x + p1.x) / 2;
    const cz = (p0.z + p1.z) / 2;
    const plaster = tmpColor.setHex(BUILDING.plaster[hash(b.c, b.r, 2) % BUILDING.plaster.length] ?? 0xd9a461).clone();
    const parts: BufferGeometry[] = [
      box(w, BUILDING.algaeBand, d, cx, 0, cz, algae, algae),
      box(w, BUILDING.stoneBand, d, cx, BUILDING.algaeBand, cz, stone, stone),
      box(w, h - BUILDING.algaeBand - BUILDING.stoneBand, d, cx, BUILDING.algaeBand + BUILDING.stoneBand, cz, plaster, roof),
      box(w + BUILDING.corniceOverhang * 2, BUILDING.cornice, d + BUILDING.corniceOverhang * 2, cx, h, cz, stone, roof),
    ];
    const merged = mergeGeometries(parts, false);
    for (const p of parts) p.dispose();
    const mesh = new Mesh(merged, plasterMat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = `block_${b.c}_${b.r}`;
    group.add(mesh);
    disposables.push(merged);
    cullables.push({ object: mesh, cx, cz, radius: Math.hypot(w, d, h) / 2 });
  }

  // ---- windows, shutters, chimneys, poles: per quadrant --------------------
  type Quad = { frames: Matrix4[]; glass: Matrix4[]; shutters: Matrix4[]; shutterCols: number[]; chimneys: Matrix4[]; polesBlue: Matrix4[]; polesRed: Matrix4[] };
  const quads: Quad[] = [0, 1, 2, 3].map(() => ({ frames: [], glass: [], shutters: [], shutterCols: [], chimneys: [], polesBlue: [], polesRed: [] }));
  const quadOf = (x: number, z: number): Quad => quads[(x < 0 ? 0 : 1) + (z < 0 ? 0 : 2)] ?? quads[0]!;

  const placeWindow = (x: number, y: number, z: number, yaw: number, seed: number): void => {
    const q = quadOf(x, z);
    dummy.position.set(x, y, z);
    dummy.rotation.set(0, yaw, 0);
    dummy.updateMatrix();
    q.frames.push(dummy.matrix.clone());
    q.glass.push(dummy.matrix.clone());
    const open = 0.25 + (hash(seed, 7) % 100) / 400; // shutter opening angle
    for (const side of [-1, 1] as const) {
      dummy.position.set(x, y, z);
      dummy.rotation.set(0, yaw, 0);
      dummy.translateX(side * 0.88);
      dummy.translateZ(0.1);
      dummy.rotateY(-side * open);
      dummy.updateMatrix();
      q.shutters.push(dummy.matrix.clone());
      q.shutterCols.push(BUILDING.shutters[hash(seed, 3) % BUILDING.shutters.length] ?? 0x3f6b48);
    }
  };

  const exterior = (c: number, r: number): boolean => {
    const ch: CellChar | undefined = cellAt(map, c, r);
    return ch !== undefined && ch !== 'B' && ch !== 'T';
  };

  for (const b of blocks) {
    const floors = floorsFor(b);
    const base = BUILDING.algaeBand + BUILDING.stoneBand;
    const h = blockHeight(b);
    // walls: for each cell on the rectangle edge whose outside neighbour is water, 2 windows per floor
    for (let k = 0; k < b.w; k++) {
      const c = b.c + k;
      for (const [r, dz, yaw] of [
        [b.r - 1, -map.cell / 2, Math.PI],
        [b.r + b.d, map.cell / 2, 0],
      ] as const) {
        if (!exterior(c, r)) continue;
        const centre = cellToWorld(map, c, r === b.r - 1 ? b.r : b.r + b.d - 1);
        for (let f = 0; f < floors; f++) {
          const y = base + f * BUILDING.floorHeight + 1.9;
          for (const off of [-2, 2]) placeWindow(centre.x + off, y, centre.z + dz, yaw, hash(c, r, f * 2 + off));
        }
      }
    }
    for (let k = 0; k < b.d; k++) {
      const r = b.r + k;
      for (const [c, dx, yaw] of [
        [b.c - 1, -map.cell / 2, -Math.PI / 2],
        [b.c + b.w, map.cell / 2, Math.PI / 2],
      ] as const) {
        if (!exterior(c, r)) continue;
        const centre = cellToWorld(map, c === b.c - 1 ? b.c : b.c + b.w - 1, r);
        for (let f = 0; f < floors; f++) {
          const y = base + f * BUILDING.floorHeight + 1.9;
          for (const off of [-2, 2]) placeWindow(centre.x + dx, y, centre.z + off, yaw, hash(c, r, f * 2 + off));
        }
      }
    }
    // chimneys: 1..3 per block on the roof
    const n = 1 + (hash(b.c, b.r, 9) % 3);
    const p0 = cellToWorld(map, b.c, b.r);
    for (let i = 0; i < n; i++) {
      const x = p0.x - map.cell / 2 + 1.5 + (hash(b.c, b.r, 20 + i) % Math.max(1, Math.round(b.w * map.cell - 3)));
      const z = p0.z - map.cell / 2 + 1.5 + (hash(b.c, b.r, 40 + i) % Math.max(1, Math.round(b.d * map.cell - 3)));
      dummy.position.set(x, h + BUILDING.cornice, z);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      quadOf(x, z).chimneys.push(dummy.matrix.clone());
    }
  }

  // mooring poles: water cells touching a building, 60 % of segments, jittered along the wall
  for (let r = 0; r < map.rows; r++) {
    for (let c = 0; c < map.cols; c++) {
      const ch = cellAt(map, c, r);
      if (ch !== '~' && ch !== 'S' && ch !== 'L') continue;
      const centre = cellToWorld(map, c, r);
      const sides: readonly [number, number, number, number][] = [
        [c, r - 1, 0, -1],
        [c, r + 1, 0, 1],
        [c - 1, r, -1, 0],
        [c + 1, r, 1, 0],
      ];
      for (const [nc, nr, nx, nz] of sides) {
        if (cellAt(map, nc, nr) !== 'B') continue;
        if (hash(c * 4 + nc, r * 4 + nr, 5) % 100 >= 60) continue;
        const along = ((hash(c, r, nc + nr) % 100) / 100 - 0.5) * (map.cell - 2);
        const x = centre.x + nx * (map.cell / 2 - 0.7) + nz * along;
        const z = centre.z + nz * (map.cell / 2 - 0.7) + nx * along;
        dummy.position.set(x, BUILDING.poleHeight / 2 - 0.6, z);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        const q = quadOf(x, z);
        (hash(c, r, 77) % 2 === 0 ? q.polesBlue : q.polesRed).push(dummy.matrix.clone());
      }
    }
  }

  const frameGeo = new BoxGeometry(1.25, 2.1, 0.12);
  const glassGeo = new BoxGeometry(0.95, 1.8, 0.06);
  glassGeo.translate(0, 0, 0.04);
  const shutterGeo = new BoxGeometry(0.42, 1.9, 0.05);
  shutterGeo.translate(0.21, 0, 0);
  const chimneyGeo = mergeGeometries([new CylinderGeometry(0.22, 0.28, 1.7, 8).translate(0, 0.85, 0), new ConeGeometry(0.5, 0.6, 8).rotateX(Math.PI).translate(0, 2.0, 0)], false);
  const poleGeo = new CylinderGeometry(0.11, 0.14, BUILDING.poleHeight, 8);
  disposables.push(frameGeo, glassGeo, shutterGeo, chimneyGeo, poleGeo);

  const instanced = (geo: BufferGeometry, mat: MeshStandardMaterial, mats: readonly Matrix4[], colours?: readonly number[]): InstancedMesh | null => {
    if (mats.length === 0) return null;
    const im = new InstancedMesh(geo, mat, mats.length);
    for (let i = 0; i < mats.length; i++) {
      const m = mats[i];
      if (m) im.setMatrixAt(i, m);
      if (colours) im.setColorAt(i, tmpColor2.setHex(colours[i] ?? 0xffffff));
    }
    im.computeBoundingSphere(); // static: compute once so per-viewport frustum culling works
    im.castShadow = false; // windows need no shadow of their own; keeps the baked pass small
    im.receiveShadow = true;
    group.add(im);
    detail.push(im);
    return im;
  };
  let windowCount = 0;
  for (const q of quads) {
    instanced(frameGeo, stoneMat, q.frames);
    instanced(glassGeo, glassMat, q.glass);
    instanced(shutterGeo, shutterMat, q.shutters, q.shutterCols);
    instanced(chimneyGeo, roofMat, q.chimneys);
    const pb = instanced(poleGeo, poleBlue, q.polesBlue);
    const pr = instanced(poleGeo, poleRed, q.polesRed);
    if (pb) pb.castShadow = true;
    if (pr) pr.castShadow = true;
    windowCount += q.frames.length;
  }
  group.userData['windowCount'] = windowCount;

  // ---- bridges -----------------------------------------------------------
  const bridgeRuns = findBridgeRuns(map);
  const centreRun = bridgeRuns.reduce<(BridgeRun & { dist: number }) | null>((best, run) => {
    const p = cellToWorld(map, run.c + (run.alongX ? (run.len - 1) / 2 : 0), run.r + (run.alongX ? 0 : (run.len - 1) / 2));
    const dist = Math.hypot(p.x, p.z);
    return best === null || dist < best.dist ? { ...run, dist } : best;
  }, null);
  for (const run of bridgeRuns) {
    const covered = centreRun !== null && run.c === centreRun.c && run.r === centreRun.r;
    const mesh = buildBridge(run.len * map.cell, covered, stoneMat, roofMat);
    const p = cellToWorld(map, run.c + (run.alongX ? (run.len - 1) / 2 : 0), run.r + (run.alongX ? 0 : (run.len - 1) / 2));
    mesh.position.set(p.x, 0, p.z);
    mesh.rotation.y = run.alongX ? 0 : Math.PI / 2;
    group.add(mesh);
    cullables.push({ object: mesh, cx: p.x, cz: p.z, radius: run.len * map.cell });
  }

  // ---- campanile -----------------------------------------------------------
  for (let r = 0; r < map.rows; r++) {
    for (let c = 0; c < map.cols; c++) {
      if (cellAt(map, c, r) !== 'T') continue;
      const p = cellToWorld(map, c, r);
      const brick = new Color(0x9a5a46);
      const parts = [
        box(7, 48, 7, 0, 0, 0, brick, brick),
        box(8.4, 9, 8.4, 0, 48, 0, stone, stone),
        (() => {
          const g = new ConeGeometry(5.5, 13, 4);
          g.rotateY(Math.PI / 4);
          g.translate(0, 57 + 6.5, 0);
          const n = g.getAttribute('position').count;
          const col = new Float32Array(n * 3);
          const green = new Color(0x3e7f5a);
          for (let i = 0; i < n; i++) {
            col[i * 3] = green.r;
            col[i * 3 + 1] = green.g;
            col[i * 3 + 2] = green.b;
          }
          g.setAttribute('color', new Float32BufferAttribute(col, 3));
          return g;
        })(),
      ];
      const merged = mergeGeometries(parts, false);
      for (const g of parts) g.dispose();
      const mat = new MeshStandardMaterial({ map: tex.grain, vertexColors: true, roughness: 0.9 });
      weakenFog(mat, 0.45); // keep a silhouette beyond the fog: it is the orientation landmark
      const mesh = new Mesh(merged, mat);
      mesh.position.set(p.x, 0, p.z);
      mesh.castShadow = true;
      mesh.name = 'campanile';
      group.add(mesh); // never distance-culled
      disposables.push(merged, mat);
    }
  }

  return {
    group,
    cullables,
    detail,
    blockCount: blocks.length,
    dispose(): void {
      for (const d of disposables) d.dispose();
      group.traverse((o) => {
        if (o instanceof InstancedMesh) o.dispose();
      });
    },
  };
}

export interface BridgeRun {
  readonly c: number;
  readonly r: number;
  readonly len: number;
  readonly alongX: boolean;
}

/** Runs of '=' cells. A run spans X when buildings sit at its two X ends, otherwise Z. */
export function findBridgeRuns(map: MapGrid): BridgeRun[] {
  const seen = new Uint8Array(map.cols * map.rows);
  const runs: BridgeRun[] = [];
  for (let r = 0; r < map.rows; r++) {
    for (let c = 0; c < map.cols; c++) {
      if (cellAt(map, c, r) !== '=' || seen[r * map.cols + c]) continue;
      let lenX = 1;
      while (cellAt(map, c + lenX, r) === '=') lenX++;
      let lenZ = 1;
      while (cellAt(map, c, r + lenZ) === '=') lenZ++;
      const xEnds = cellAt(map, c - 1, r) === 'B' && cellAt(map, c + lenX, r) === 'B';
      const zEnds = cellAt(map, c, r - 1) === 'B' && cellAt(map, c, r + lenZ) === 'B';
      const alongX = xEnds || !zEnds;
      const len = alongX ? lenX : lenZ;
      for (let k = 0; k < len; k++) seen[(alongX ? r : r + k) * map.cols + (alongX ? c + k : c)] = 1;
      runs.push({ c, r, len, alongX });
    }
  }
  return runs;
}

/** Arched stone bridge spanning `length` metres along local X, deck centred on the origin. */
export function buildBridge(length: number, covered: boolean, stoneMat: MeshStandardMaterial, roofMat: MeshStandardMaterial): Group {
  const g = new Group();
  const L = length;
  const half = L / 2;
  const rise = BUILDING.bridgeRise;
  const shape = new Shape();
  shape.moveTo(-half, -0.4);
  shape.lineTo(half, -0.4);
  shape.lineTo(half, rise - 1.0);
  // gentle hump on the deck
  for (let i = 1; i < 16; i++) {
    const t = i / 16;
    const x = half - t * L;
    shape.lineTo(x, rise - 1.0 + Math.sin(t * Math.PI) * 1.0);
  }
  shape.lineTo(-half, rise - 1.0);
  shape.closePath();
  const hole = new Shape();
  const span = Math.max(4, L - 1.6);
  const arcH = BUILDING.archClearance;
  hole.moveTo(-span / 2, -0.4);
  for (let i = 0; i <= 20; i++) {
    const t = i / 20;
    hole.lineTo(-span / 2 + t * span, -0.4 + Math.sin(t * Math.PI) * (arcH + 0.4));
  }
  hole.closePath();
  shape.holes.push(hole);
  const geo = new ExtrudeGeometry(shape, { depth: BUILDING.bridgeWidth, bevelEnabled: false, curveSegments: 4 });
  geo.translate(0, 0, -BUILDING.bridgeWidth / 2);
  const deck = new Mesh(geo, stoneMat);
  deck.castShadow = true;
  deck.receiveShadow = true;
  g.add(deck);
  for (const side of [-1, 1]) {
    const rail = new Mesh(new BoxGeometry(L, 1.0, 0.15), stoneMat);
    rail.position.set(0, rise + 0.3, side * (BUILDING.bridgeWidth / 2 - 0.1));
    rail.castShadow = true;
    g.add(rail);
  }
  if (covered) {
    const roofY = rise + 4.2;
    for (const side of [-1, 1]) {
      const slab = new Mesh(new BoxGeometry(L + 1, 0.3, 4.2), roofMat);
      slab.position.set(0, roofY + 1.2, side * 1.6);
      slab.rotation.x = side * -0.55;
      slab.castShadow = true;
      g.add(slab);
    }
    const cols = Math.max(2, Math.round(L / 2.5));
    const colGeo = new CylinderGeometry(0.22, 0.26, 4.4, 8);
    for (let i = 0; i < cols; i++) {
      for (const side of [-1, 1]) {
        const col = new Mesh(colGeo, stoneMat);
        col.position.set(-half + 1 + (i * (L - 2)) / Math.max(1, cols - 1), rise + 2.2, side * (BUILDING.bridgeWidth / 2 - 0.4));
        col.castShadow = true;
        g.add(col);
      }
    }
  }
  g.name = covered ? 'bridge_covered' : 'bridge';
  return g;
}

/** Per-viewport distance culling: call before each renderer.render(). */
export function cullByDistance(cullables: readonly Cullable[], camera: Vector3, maxDistance: number): void {
  for (const c of cullables) {
    const d = Math.hypot(c.cx - camera.x, c.cz - camera.z) - c.radius;
    c.object.visible = d < maxDistance;
  }
}
