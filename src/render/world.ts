/**
 * src/render/world.ts: Venice built from the map grid (SPEC section 9). Track C owns it.
 *
 * Every solid cell belongs to a house of one or two cells, and each house has its own number
 * of floors, plaster, tint, roof, chimneys, balcony, lantern and laundry, so a canal reads as
 * a row of narrow palazzi rather than one long block. Houses on the water get Istrian stone at
 * the waterline with an algae band, gothic windows on every floor and a water door; some stand
 * behind a stone quay (fondamenta) with mooring poles and a lamp post. Deeper cells are lower
 * so the roofs show behind the facades. One block carries a church dome, the T cell the
 * campanile. Everything static is merged into one mesh per material (a dozen draw calls per
 * viewport); the lanterns' glow is one Points cloud.
 *
 * UVs are in world metres, so a texture tiles at the same size on every house and runs
 * continuously across neighbours.
 */
import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Group,
  Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Points,
  PointsMaterial,
  Shape,
  SphereGeometry,
  Vector3,
  type Texture,
} from 'three';
import type { ParsedMap } from '@shared/map.ts';
import type { AssetKey } from './assets.ts';
import { weakenFog } from './environment.ts';
import { buildHullGeometry } from './gondola.ts';

// ---------------------------------------------------------------- dimensions

const HOUSE = {
  inset: 0.12, // gap between neighbouring houses, so different heights read as separate walls
  groundFloor: 3.7,
  floor: 3.2,
  keelDepth: -0.6, // walls continue below the water line
  stoneBand: 1.35, // Istrian stone course up to this height
  roofOverhang: 0.45,
  quayDepth: 2.4,
  quayTop: 0.5,
} as const;

/** Deterministic noise from integers: the same map always builds the same Venice. */
function hash(...n: number[]): number {
  let h = 2166136261 >>> 0;
  for (const v of n) {
    h = Math.imul(h ^ ((v + 0x9e3779b9) | 0), 16777619);
    h ^= h >>> 13;
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

// ---------------------------------------------------------------- geometry buckets

type V3 = readonly [number, number, number];
type UV = readonly [number, number];

/** One merged mesh per material. Quads are given with their outward normal; the winding follows. */
class Bucket {
  private readonly pos: number[] = [];
  private readonly nrm: number[] = [];
  private readonly uv: number[] = [];
  private readonly col: number[] = [];
  private readonly idx: number[] = [];

  constructor(
    readonly name: string,
    readonly material: Material,
    readonly cast: boolean,
  ) {}

  private vertex(p: V3, n: V3, t: UV, tint: Color): number {
    this.pos.push(p[0], p[1], p[2]);
    this.nrm.push(n[0], n[1], n[2]);
    this.uv.push(t[0], t[1]);
    this.col.push(tint.r, tint.g, tint.b);
    return this.pos.length / 3 - 1;
  }

  quad(a: V3, b: V3, c: V3, d: V3, uvs: readonly [UV, UV, UV, UV], normal: V3, tint: Color): void {
    // Flip to counter-clockwise around the normal if the caller listed the corners the other way.
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const cx = ab[1]! * ac[2]! - ab[2]! * ac[1]!;
    const cy = ab[2]! * ac[0]! - ab[0]! * ac[2]!;
    const cz = ab[0]! * ac[1]! - ab[1]! * ac[0]!;
    const flip = cx * normal[0] + cy * normal[1] + cz * normal[2] < 0;
    const i0 = this.vertex(a, normal, uvs[0], tint);
    const i1 = this.vertex(flip ? d : b, normal, flip ? uvs[3] : uvs[1], tint);
    const i2 = this.vertex(c, normal, uvs[2], tint);
    const i3 = this.vertex(flip ? b : d, normal, flip ? uvs[1] : uvs[3], tint);
    this.idx.push(i0, i1, i2, i0, i2, i3);
  }

  tri(a: V3, b: V3, c: V3, uvs: readonly [UV, UV, UV], normal: V3, tint: Color): void {
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const cx = ab[1]! * ac[2]! - ab[2]! * ac[1]!;
    const cy = ab[2]! * ac[0]! - ab[0]! * ac[2]!;
    const cz = ab[0]! * ac[1]! - ab[1]! * ac[0]!;
    const flip = cx * normal[0] + cy * normal[1] + cz * normal[2] < 0;
    const i0 = this.vertex(a, normal, uvs[0], tint);
    const i1 = this.vertex(flip ? c : b, normal, flip ? uvs[2] : uvs[1], tint);
    const i2 = this.vertex(flip ? b : c, normal, flip ? uvs[1] : uvs[2], tint);
    this.idx.push(i0, i1, i2);
  }

  /** Appends a ready-made geometry (cylinders, cones, spheres), transformed. */
  geometry(geo: BufferGeometry, matrix: Matrix4, tint: Color): void {
    const g = geo.index ? geo.toNonIndexed() : geo;
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    const t = g.getAttribute('uv');
    const v = new Vector3();
    const nv = new Vector3();
    const base = this.pos.length / 3;
    for (let i = 0; i < p.count; i++) {
      v.set(p.getX(i), p.getY(i), p.getZ(i)).applyMatrix4(matrix);
      nv.set(n.getX(i), n.getY(i), n.getZ(i)).transformDirection(matrix);
      this.pos.push(v.x, v.y, v.z);
      this.nrm.push(nv.x, nv.y, nv.z);
      this.uv.push(t ? t.getX(i) : 0, t ? t.getY(i) : 0);
      this.col.push(tint.r, tint.g, tint.b);
    }
    for (let i = 0; i < p.count; i++) this.idx.push(base + i);
    if (g !== geo) g.dispose();
  }

  mesh(): Mesh | null {
    if (this.idx.length === 0) return null;
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('normal', new Float32BufferAttribute(this.nrm, 3));
    geo.setAttribute('uv', new Float32BufferAttribute(this.uv, 2));
    geo.setAttribute('color', new Float32BufferAttribute(this.col, 3));
    geo.setIndex(this.idx);
    geo.computeBoundingSphere();
    const mesh = new Mesh(geo, this.material);
    mesh.name = this.name;
    mesh.castShadow = this.cast;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    return mesh;
  }
}

interface Faces {
  px?: boolean;
  nx?: boolean;
  pz?: boolean;
  nz?: boolean;
  py?: boolean;
  ny?: boolean;
}
const SIDES: Faces = { px: true, nx: true, pz: true, nz: true };
const SIDES_TOP: Faces = { ...SIDES, py: true };

/** An axis-aligned box with world-metre UVs (`tile` metres per texture repeat). */
function box(b: Bucket, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, tile: number, tint: Color, faces: Faces = SIDES_TOP): void {
  const u = (v: number): number => v / tile;
  if (faces.px) b.quad([x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0], [[u(z0), u(y0)], [u(z1), u(y0)], [u(z1), u(y1)], [u(z0), u(y1)]], [1, 0, 0], tint);
  if (faces.nx) b.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [[u(z0), u(y0)], [u(z1), u(y0)], [u(z1), u(y1)], [u(z0), u(y1)]], [-1, 0, 0], tint);
  if (faces.pz) b.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [[u(x0), u(y0)], [u(x1), u(y0)], [u(x1), u(y1)], [u(x0), u(y1)]], [0, 0, 1], tint);
  if (faces.nz) b.quad([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [[u(x0), u(y0)], [u(x1), u(y0)], [u(x1), u(y1)], [u(x0), u(y1)]], [0, 0, -1], tint);
  if (faces.py) b.quad([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], [[u(x0), u(z0)], [u(x1), u(z0)], [u(x1), u(z1)], [u(x0), u(z1)]], [0, 1, 0], tint);
  if (faces.ny) b.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [[u(x0), u(z0)], [u(x1), u(z0)], [u(x1), u(z1)], [u(x0), u(z1)]], [0, -1, 0], tint);
}

/** A hipped roof over the rectangle (x0..x1, z0..z1) at height y0, ridge along the longer side. */
function hipRoof(b: Bucket, x0: number, z0: number, x1: number, z1: number, y0: number, h: number, tile: number, tint: Color): void {
  const w = x1 - x0;
  const d = z1 - z0;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const y1 = y0 + h;
  const u = (v: number): number => v / tile;
  if (w >= d) {
    const r = (w - d) / 2;
    const s = Math.hypot(d / 2, h) / tile; // slope length in tiles
    const R1: V3 = [cx - r, y1, cz];
    const R2: V3 = [cx + r, y1, cz];
    const nz = Math.hypot(d / 2, h);
    b.quad([x0, y0, z1], [x1, y0, z1], R2, R1, [[u(x0), 0], [u(x1), 0], [u(cx + r), s], [u(cx - r), s]], [0, (d / 2) / nz, h / nz], tint);
    b.quad([x1, y0, z0], [x0, y0, z0], R1, R2, [[u(x1), 0], [u(x0), 0], [u(cx - r), s], [u(cx + r), s]], [0, (d / 2) / nz, -h / nz], tint);
    b.tri([x1, y0, z0], [x1, y0, z1], R2, [[u(z0), 0], [u(z1), 0], [u(cz), s]], [h / nz, (d / 2) / nz, 0], tint);
    b.tri([x0, y0, z1], [x0, y0, z0], R1, [[u(z1), 0], [u(z0), 0], [u(cz), s]], [-h / nz, (d / 2) / nz, 0], tint);
  } else {
    const r = (d - w) / 2;
    const s = Math.hypot(w / 2, h) / tile;
    const R1: V3 = [cx, y1, cz - r];
    const R2: V3 = [cx, y1, cz + r];
    const nx = Math.hypot(w / 2, h);
    b.quad([x1, y0, z0], [x1, y0, z1], R2, R1, [[u(z0), 0], [u(z1), 0], [u(cz + r), s], [u(cz - r), s]], [h / nx, (w / 2) / nx, 0], tint);
    b.quad([x0, y0, z1], [x0, y0, z0], R1, R2, [[u(z1), 0], [u(z0), 0], [u(cz - r), s], [u(cz + r), s]], [-h / nx, (w / 2) / nx, 0], tint);
    b.tri([x0, y0, z1], [x1, y0, z1], R2, [[u(x0), 0], [u(x1), 0], [u(cx), s]], [0, (w / 2) / nx, h / nx], tint);
    b.tri([x1, y0, z0], [x0, y0, z0], R1, [[u(x1), 0], [u(x0), 0], [u(cx), s]], [0, (w / 2) / nx, -h / nx], tint);
  }
}

/** A vertical quad on a wall facing `dir` (unit axis), centred at (x, y, z), `w` wide and `h` tall; UV 0..1. */
function facadeQuad(b: Bucket, x: number, y: number, z: number, w: number, h: number, dir: V3, tint: Color): void {
  const hx = dir[2] !== 0 ? w / 2 : 0;
  const hz = dir[0] !== 0 ? w / 2 : 0;
  // Along the facade, left to right as seen from the water.
  const sx = dir[2] > 0 ? 1 : dir[2] < 0 ? -1 : 0;
  const sz = dir[0] > 0 ? -1 : dir[0] < 0 ? 1 : 0;
  const a: V3 = [x - hx * sx, y - h / 2, z - hz * sz];
  const c: V3 = [x + hx * sx, y - h / 2, z + hz * sz];
  b.quad(a, c, [c[0], y + h / 2, c[2]], [a[0], y + h / 2, a[2]], [[0, 0], [1, 0], [1, 1], [0, 1]], dir, tint);
}

// ---------------------------------------------------------------- bridges

/** Clearance under the bridges: the camera rides at CAMERA.up (4 m) and must pass beneath the deck. */
const BRIDGE = { clearance: 5.1, deck: 5.6, rail: 0.95 } as const;

/** Arched stone bridge over a canal; `length` spans the water, `width` is the deck width. */
export function buildBridge(length: number, width: number, covered: boolean, stone: MeshStandardMaterial, roof: MeshStandardMaterial): Group {
  const group = new Group();
  group.name = covered ? 'bridge_covered' : 'bridge';
  const half = length / 2;
  // Open-bottom arch: no underwater slab seals the canal; the vault clears the camera.
  const shape = new Shape();
  shape.moveTo(-half, -0.5);
  shape.lineTo(-half, BRIDGE.deck);
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    shape.lineTo(-half + length * t, BRIDGE.deck + Math.sin(t * Math.PI) * 0.6);
  }
  shape.lineTo(half, -0.5);
  const opening = Math.max(1, half - 0.45);
  shape.lineTo(opening, -0.5);
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    shape.lineTo(opening - 2 * opening * t, -0.5 + Math.sin(t * Math.PI) * (BRIDGE.clearance + 0.5));
  }
  shape.lineTo(-half, -0.5);
  shape.closePath();
  const geometry = new ExtrudeGeometry(shape, { depth: width, bevelEnabled: false, curveSegments: 6 });
  geometry.translate(0, 0, -width / 2);
  const arch = new Mesh(geometry, stone);
  arch.castShadow = arch.receiveShadow = true;
  group.add(arch);
  // Balustrades: a coping rail on short posts, following the deck's camber.
  const post = new CylinderGeometry(0.09, 0.11, 0.8, 6);
  for (const side of [-1, 1]) {
    const rail = new Mesh(new CylinderGeometry(0.1, 0.1, length, 8).rotateZ(Math.PI / 2), stone);
    rail.position.set(0, BRIDGE.deck + 0.3 + BRIDGE.rail, side * (width / 2 - 0.12));
    rail.castShadow = true;
    group.add(rail);
    for (let x = -half + 0.5; x <= half - 0.4; x += 1.1) {
      const p = new Mesh(post, stone);
      p.position.set(x, BRIDGE.deck + Math.sin(((x + half) / length) * Math.PI) * 0.6 + 0.4, side * (width / 2 - 0.12));
      group.add(p);
    }
  }
  if (covered) {
    for (const side of [-1, 1]) {
      const slab = new Mesh(boxGeometry(length + 1, 0.3, width * 0.58), roof);
      slab.position.set(0, BRIDGE.deck + 4.6, side * width * 0.23);
      slab.rotation.x = -side * 0.4;
      slab.castShadow = true;
      group.add(slab);
      for (let x = -half + 0.6; x <= half - 0.5; x += 3) {
        const column = new Mesh(new CylinderGeometry(0.16, 0.22, 3.2, 6), stone);
        column.position.set(x, BRIDGE.deck + 2.2, side * (width / 2 - 0.3));
        column.castShadow = true;
        group.add(column);
      }
    }
  }
  return group;
}

function boxGeometry(w: number, h: number, d: number): BufferGeometry {
  const b = new Bucket('tmp', new MeshBasicMaterial(), false);
  box(b, -w / 2, -h / 2, -d / 2, w / 2, h / 2, d / 2, 3, new Color(1, 1, 1), { ...SIDES_TOP, ny: true });
  const m = b.mesh();
  return m ? m.geometry : new BufferGeometry();
}

// ---------------------------------------------------------------- houses

export interface House {
  c0: number;
  r0: number;
  cols: number;
  rows: number;
  /** Cells from the water: 1 on a canal, 2 and more behind. */
  depth: number;
  /** Which sides face water, in grid directions. */
  water: { n: boolean; s: boolean; w: boolean; e: boolean };
  church: boolean;
}

/** BFS distance to the nearest water cell, over solid cells. */
function waterDistance(map: ParsedMap): Uint8Array {
  const W = map.width;
  const H = map.height;
  const dist = new Uint8Array(W * H).fill(255);
  const queue: number[] = [];
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) if (map.isWater(c, r)) { dist[r * W + c] = 0; queue.push(r * W + c); }
  for (let qi = 0; qi < queue.length; qi++) {
    const i = queue[qi]!;
    const c = i % W;
    const r = (i - c) / W;
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nc = c + dc;
      const nr = r + dr;
      if (nc < 0 || nr < 0 || nc >= W || nr >= H) continue;
      const j = nr * W + nc;
      if (dist[j]! > dist[i]! + 1) { dist[j] = dist[i]! + 1; queue.push(j); }
    }
  }
  return dist;
}

/** Groups solid cells into houses of one or two cells; one 2 x 2 block becomes the church. */
export function partition(map: ParsedMap, dist: Uint8Array = waterDistance(map)): House[] {
  const W = map.width;
  const H = map.height;
  const solid = (c: number, r: number): boolean => map.cellAt(c, r) === 'B';
  const owner = new Int32Array(W * H).fill(-1);
  const houses: House[] = [];
  const make = (c0: number, r0: number, cols: number, rows: number, church = false): void => {
    let depth = 255;
    const water = { n: false, s: false, w: false, e: false };
    for (let r = r0; r < r0 + rows; r++) for (let c = c0; c < c0 + cols; c++) {
      owner[r * W + c] = houses.length;
      depth = Math.min(depth, dist[r * W + c]!);
      if (map.isWater(c, r - 1)) water.n = true;
      if (map.isWater(c, r + 1)) water.s = true;
      if (map.isWater(c - 1, r)) water.w = true;
      if (map.isWater(c + 1, r)) water.e = true;
    }
    houses.push({ c0, r0, cols, rows, depth, water, church });
  };
  // The church: the most sheltered 2 x 2 block, if there is one at least two cells from the water.
  let best: { c: number; r: number; d: number } | null = null;
  for (let r = 1; r < H - 2; r++) for (let c = 1; c < W - 2; c++) {
    if (!solid(c, r) || !solid(c + 1, r) || !solid(c, r + 1) || !solid(c + 1, r + 1)) continue;
    const d = Math.min(dist[r * W + c]!, dist[r * W + c + 1]!, dist[(r + 1) * W + c]!, dist[(r + 1) * W + c + 1]!);
    if (d >= 2 && (!best || d > best.d)) best = { c, r, d };
  }
  if (best) make(best.c, best.r, 2, 2, true);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    if (!solid(c, r) || (owner[r * W + c] ?? -1) >= 0) continue;
    const h = hash(c, r, 1);
    if (h < 0.42 && solid(c + 1, r) && (owner[r * W + c + 1] ?? -1) < 0) make(c, r, 2, 1);
    else if (h < 0.62 && solid(c, r + 1) && (owner[(r + 1) * W + c] ?? -1) < 0) make(c, r, 1, 2);
    else make(c, r, 1, 1);
  }
  return houses;
}

// ---------------------------------------------------------------- the world

export function buildWorld(map: ParsedMap, textures: Record<AssetKey, Texture>, glow: Texture) {
  const group = new Group();
  group.name = 'venice';
  const disposables: { dispose(): void }[] = [];
  const std = (opts: ConstructorParameters<typeof MeshStandardMaterial>[0]): MeshStandardMaterial => {
    const m = new MeshStandardMaterial({ vertexColors: true, ...opts });
    disposables.push(m);
    return m;
  };
  const plasterMats = (['ochre', 'terracotta', 'rose', 'cream'] as const).map((k) => std({ map: textures[k], roughness: 0.92 }));
  const stoneMat = std({ map: textures.stone, roughness: 0.82 });
  const algaeMat = std({ map: textures.algae, roughness: 0.95 });
  const roofMat = std({ map: textures.roof, roughness: 0.9 });
  const woodMat = std({ map: textures.wood, roughness: 0.85 });
  const poleMat = std({ map: textures.poles, roughness: 0.8 });
  const windowMat = std({ map: textures.window, alphaTest: 0.5, roughness: 0.7 });
  const laundryMat = std({ map: textures.laundry, alphaTest: 0.5, side: DoubleSide, roughness: 1 });
  const ironMat = std({ color: 0x1c1c1f, roughness: 0.55, metalness: 0.45 });
  const leadMat = std({ color: 0x8a9a95, roughness: 0.5, metalness: 0.25 });
  const copperMat = std({ color: 0x4f8f78, roughness: 0.5, metalness: 0.35 });
  const goldMat = std({ color: 0xf2c14e, roughness: 0.3, metalness: 0.8 });
  const lampMat = new MeshBasicMaterial({ color: 0xffd48a, vertexColors: true, toneMapped: false });
  disposables.push(lampMat);
  // The campanile keeps its silhouette through the haze.
  const towerBrick = std({ map: textures.terracotta, roughness: 0.9 });
  const towerStone = std({ map: textures.stone, roughness: 0.82 });
  weakenFog(towerBrick, 0.45);
  weakenFog(towerStone, 0.45);

  const B = {
    plaster: plasterMats.map((m, i) => new Bucket(`plaster${i}`, m, true)),
    stone: new Bucket('stone', stoneMat, true),
    algae: new Bucket('algae', algaeMat, false),
    roof: new Bucket('roofs', roofMat, true),
    wood: new Bucket('wood', woodMat, true),
    poles: new Bucket('poles', poleMat, true),
    window: new Bucket('windows', windowMat, false),
    laundry: new Bucket('laundry', laundryMat, false),
    iron: new Bucket('iron', ironMat, false),
    lamp: new Bucket('lamps', lampMat, false),
    lead: new Bucket('lead', leadMat, true),
    copper: new Bucket('copper', copperMat, true),
    gold: new Bucket('gold', goldMat, false),
    towerBrick: new Bucket('campanile', towerBrick, true),
    towerStone: new Bucket('campanile-stone', towerStone, true),
  };
  const glowPoints: number[] = [];
  const white = new Color(1, 1, 1);
  const stoneTint = new Color(0.9, 0.89, 0.84);
  const tmpM = new Matrix4();
  const place = (b: Bucket, geo: BufferGeometry, x: number, y: number, z: number, tint: Color, sy = 1, yaw = 0, sx = 1, sz = sx): void => {
    tmpM.makeRotationY(yaw);
    tmpM.scale(new Vector3(sx, sy, sz));
    tmpM.setPosition(x, y, z);
    b.geometry(geo, tmpM, tint);
  };
  const lamp = (x: number, y: number, z: number): void => {
    box(B.lamp, x - 0.13, y - 0.17, z - 0.13, x + 0.13, y + 0.17, z + 0.13, 1, white, { ...SIDES_TOP, ny: true });
    glowPoints.push(x, y, z);
  };
  const pole = new CylinderGeometry(0.15, 0.19, 3.6, 8);
  const bollard = new CylinderGeometry(0.14, 0.16, 0.9, 7);
  const lampPost = new CylinderGeometry(0.06, 0.08, 3.1, 6);
  const chimneyStem = new CylinderGeometry(0.24, 0.26, 1.8, 8);
  const chimneyFunnel = new CylinderGeometry(0.6, 0.26, 0.9, 8);
  const chimneyCap = new CylinderGeometry(0.66, 0.66, 0.14, 8);
  const mooredHull = buildHullGeometry(16, 7);
  const geos = [pole, bollard, lampPost, chimneyStem, chimneyFunnel, chimneyCap, mooredHull];
  const hullTint = new Color(0.08, 0.08, 0.09);

  const dist = waterDistance(map);
  const houses = partition(map, dist);
  const cell = map.cell;
  const chimneyTint = new Color(0.93, 0.86, 0.76);

  for (const house of houses) {
    const { c0, r0, cols, rows } = house;
    const p0 = map.toWorld(c0, r0);
    const p1 = map.toWorld(c0 + cols - 1, r0 + rows - 1);
    const seed = c0 * 131 + r0 * 7;
    const onWater = house.depth === 1;
    let x0 = p0.x - cell / 2 + HOUSE.inset;
    let x1 = p1.x + cell / 2 - HOUSE.inset;
    let z0 = p0.z - cell / 2 + HOUSE.inset;
    let z1 = p1.z + cell / 2 - HOUSE.inset;

    if (house.church) {
      buildChurch(x0, z0, x1, z1);
      continue;
    }

    // Floors: canal-side houses 2 to 4, houses behind them lower so their roofs show.
    const floors = onWater ? 2 + Math.floor(hash(seed, 2) * 3) : 2 + (hash(seed, 2) < 0.35 ? 1 : 0);
    const H = HOUSE.groundFloor + (floors - 1) * HOUSE.floor;
    const variant = Math.floor(hash(seed, 3) * 4);
    const tint = new Color(0.82 + hash(seed, 4) * 0.18, 0.8 + hash(seed, 5) * 0.18, 0.78 + hash(seed, 6) * 0.18);
    const roofTint = new Color(0.85 + hash(seed, 7) * 0.3, 0.85 + hash(seed, 8) * 0.22, 0.85 + hash(seed, 9) * 0.2);

    // A quay (fondamenta) in front of some canal houses: the house steps back behind a stone walk.
    const waterSides: ('n' | 's' | 'w' | 'e')[] = (['n', 's', 'w', 'e'] as const).filter((k) => house.water[k]);
    const quaySide = onWater && hash(seed, 10) < 0.32 ? waterSides[Math.floor(hash(seed, 11) * waterSides.length)] ?? null : null;
    const outer = { x0, x1, z0, z1 };
    if (quaySide === 'n') z0 += HOUSE.quayDepth;
    if (quaySide === 's') z1 -= HOUSE.quayDepth;
    if (quaySide === 'w') x0 += HOUSE.quayDepth;
    if (quaySide === 'e') x1 -= HOUSE.quayDepth;

    // Walls, the stone course, the algae at the waterline, the cornice and the roof.
    const plaster = B.plaster[variant]!;
    box(plaster, x0, HOUSE.keelDepth, z0, x1, H, z1, 4.2, tint, SIDES);
    if (onWater) {
      box(B.stone, x0 - 0.06, 0.42, z0 - 0.06, x1 + 0.06, HOUSE.stoneBand, z1 + 0.06, 2.6, stoneTint, SIDES);
      box(B.algae, x0 - 0.03, HOUSE.keelDepth, z0 - 0.03, x1 + 0.03, 0.45, z1 + 0.03, 1.05, white, SIDES);
    }
    const ov = HOUSE.roofOverhang;
    box(B.stone, x0 - ov, H - 0.08, z0 - ov, x1 + ov, H + 0.24, z1 + ov, 2.6, stoneTint, SIDES_TOP);
    const roofH = 1.3 + 0.16 * Math.min(x1 - x0, z1 - z0);
    hipRoof(B.roof, x0 - ov, z0 - ov, x1 + ov, z1 + ov, H + 0.24, roofH, 2.4, roofTint);

    // Chimneys along the ridge: the Venetian funnel.
    const chimneys = onWater ? 1 + (hash(seed, 12) < 0.45 ? 1 : 0) : hash(seed, 12) < 0.5 ? 1 : 0;
    for (let i = 0; i < chimneys; i++) {
      const t = chimneys === 1 ? 0.3 + hash(seed, 13) * 0.4 : i === 0 ? 0.22 : 0.78;
      const along = x1 - x0 >= z1 - z0;
      const cx = along ? x0 + (x1 - x0) * t : (x0 + x1) / 2 + (hash(seed, 14) - 0.5) * 1.2;
      const cz = along ? (z0 + z1) / 2 + (hash(seed, 14) - 0.5) * 1.2 : z0 + (z1 - z0) * t;
      const base = H + 0.24 + roofH * 0.5;
      place(B.plaster[3]!, chimneyStem, cx, base + 0.9, cz, chimneyTint);
      place(B.plaster[3]!, chimneyFunnel, cx, base + 1.8 + 0.45, cz, chimneyTint);
      place(B.stone, chimneyCap, cx, base + 2.25 + 0.07, cz, stoneTint);
    }

    // Facades on the water: windows per floor, a water door, a balcony, a lantern, laundry, poles.
    for (const side of waterSides) {
      const dir: V3 = side === 'n' ? [0, 0, -1] : side === 's' ? [0, 0, 1] : side === 'w' ? [-1, 0, 0] : [1, 0, 0];
      const alongX = side === 'n' || side === 's';
      const a0 = alongX ? x0 : z0;
      const a1 = alongX ? x1 : z1;
      const wallAt = side === 'n' ? z0 : side === 's' ? z1 : side === 'w' ? x0 : x1;
      const L = a1 - a0;
      const n = Math.max(1, Math.round(L / 3.1));
      const step = L / n;
      const at = (along: number, out: number, y: number): [number, number, number] => (alongX ? [along, y, wallAt + dir[2] * out] : [wallAt + dir[0] * out, y, along]);
      const doorSlot = Math.floor(n / 2);
      for (let i = 0; i < n; i++) {
        const along = a0 + step * (i + 0.5);
        for (let f = 1; f < floors; f++) {
          const y = HOUSE.groundFloor + (f - 1) * HOUSE.floor + 1.3;
          const [wx, wy, wz] = at(along, 0.07, y);
          facadeQuad(B.window, wx, wy, wz, 1.35, 2.3, dir, white);
        }
        if (i === doorSlot) {
          // The water door: a tall gothic arch down to the stone step.
          const [dx, dy, dz] = at(along, 0.07, 1.95);
          facadeQuad(B.window, dx, dy, dz, 1.9, 3.1, dir, white);
          const [sx, , sz] = at(along, 0.3, 0);
          box(B.stone, sx - (alongX ? 1.2 : 0.3), 0.2, sz - (alongX ? 0.3 : 1.2), sx + (alongX ? 1.2 : 0.3), 0.5, sz + (alongX ? 0.3 : 1.2), 2.6, stoneTint);
        } else {
          const [wx, wy, wz] = at(along, 0.07, 2.55);
          facadeQuad(B.window, wx, wy, wz, 1.0, 1.4, dir, white);
        }
      }
      // Balcony under one upstairs window.
      if (floors > 1 && hash(seed, 20, side.charCodeAt(0)) < 0.5) {
        const slot = Math.floor(hash(seed, 21, side.charCodeAt(0)) * n);
        const along = a0 + step * (slot + 0.5);
        const y = HOUSE.groundFloor + 0.05;
        const [bx, , bz] = at(along, 0.45, y);
        const hw = alongX ? 1.15 : 0.42;
        const hd = alongX ? 0.42 : 1.15;
        box(B.stone, bx - hw, y, bz - hd, bx + hw, y + 0.2, bz + hd, 2.6, stoneTint, { ...SIDES_TOP, ny: true });
        for (const k of [-1, 0, 1]) {
          const [px, , pz] = at(along + k * 1.0, 0.82, y);
          box(B.iron, px - 0.04, y + 0.2, pz - 0.04, px + 0.04, y + 1.05, pz + 0.04, 1, white);
        }
        const [rx, , rz] = at(along, 0.82, y);
        box(B.iron, rx - (alongX ? 1.1 : 0.04), y + 1.0, rz - (alongX ? 0.04 : 1.1), rx + (alongX ? 1.1 : 0.04), y + 1.08, rz + (alongX ? 0.04 : 1.1), 1, white);
      }
      // A wall lantern beside the door.
      if (quaySide !== side && hash(seed, 22, side.charCodeAt(0)) < 0.6) {
        const along = a0 + step * (doorSlot + 0.5) + 1.45;
        if (along < a1 - 0.3) {
          const [bx, by, bz] = at(along, 0.3, 3.4);
          box(B.iron, bx - (alongX ? 0.03 : 0.3), by - 0.03, bz - (alongX ? 0.3 : 0.03), bx + (alongX ? 0.03 : 0.3), by + 0.03, bz + (alongX ? 0.3 : 0.03), 1, white);
          const [lx, ly, lz] = at(along, 0.55, 3.25);
          lamp(lx, ly, lz);
        }
      }
      // Laundry across the facade.
      if (L > 7 && hash(seed, 23, side.charCodeAt(0)) < 0.16) {
        const [lx, ly, lz] = at((a0 + a1) / 2, 0.4, HOUSE.groundFloor + HOUSE.floor + 0.3);
        facadeQuad(B.laundry, lx, ly, lz, Math.min(L - 1, 6), (Math.min(L - 1, 6) * 452) / 2048, dir, white);
      }
      // Mooring poles in the water, and the quay in front of the house.
      const edge = side === 'n' ? outer.z0 : side === 's' ? outer.z1 : side === 'w' ? outer.x0 : outer.x1;
      const poleStep = quaySide === side ? 3.2 : 4.1;
      for (let along = a0 + 1.0; along < a1 - 0.6; along += poleStep) {
        const [px, , pz] = alongX ? [along, 0, edge + dir[2] * 0.5] : [edge + dir[0] * 0.5, 0, along];
        const lean = (hash(seed, 24, Math.round(along)) - 0.5) * 0.08;
        tmpM.makeRotationZ(lean);
        tmpM.setPosition(px, 1.15, pz);
        B.poles.geometry(pole, tmpM, white);
      }
      if (quaySide === side) {
        const qx0 = side === 'e' ? x1 : outer.x0;
        const qx1 = side === 'w' ? x0 : outer.x1;
        const qz0 = side === 's' ? z1 : outer.z0;
        const qz1 = side === 'n' ? z0 : outer.z1;
        box(B.stone, qx0, HOUSE.keelDepth, qz0, qx1, HOUSE.quayTop, qz1, 2.6, stoneTint, SIDES_TOP);
        box(B.algae, qx0 - 0.03, HOUSE.keelDepth, qz0 - 0.03, qx1 + 0.03, 0.42, qz1 + 0.03, 1.05, white, SIDES);
        for (const k of [0.3, 0.7]) {
          const [bx, , bz] = alongX ? [outer.x0 + (outer.x1 - outer.x0) * k, 0, edge - dir[2] * 0.5] : [edge - dir[0] * 0.5, 0, outer.z0 + (outer.z1 - outer.z0) * k];
          place(B.stone, bollard, bx, HOUSE.quayTop + 0.4, bz, stoneTint);
        }
        const [lx, , lz] = alongX ? [(outer.x0 + outer.x1) / 2 + 1.6, 0, edge - dir[2] * 1.0] : [edge - dir[0] * 1.0, 0, (outer.z0 + outer.z1) / 2 + 1.6];
        place(B.iron, lampPost, lx, HOUSE.quayTop + 1.55, lz, white);
        lamp(lx, HOUSE.quayTop + 3.3, lz);
        // A gondola moored along the quay, bow along the water, tight to the stones.
        if (hash(seed, 25) < 0.55) {
          const [mx, , mz] = alongX ? [(outer.x0 + outer.x1) / 2 - 1.2, 0, edge + dir[2] * 1.05] : [edge + dir[0] * 1.05, 0, (outer.z0 + outer.z1) / 2 - 1.2];
          // The hull model has its bow along +X; turn it to lie along the quay.
          place(B.lead, mooredHull, mx, 0.02, mz, hullTint, 1, alongX ? 0 : Math.PI / 2);
        }
      }
    }
  }

  // Bridges, docks, pile clusters, the campanile.
  const bridgeTint = new Color(0.9, 0.88, 0.82);
  for (const bridge of map.bridges) {
    // A one-cell bridge is ambiguous in the map: it crosses the canal from bank to bank, so the
    // deck runs along whichever axis has land on both sides.
    let deck = bridge.deck;
    const first = bridge.cells[0];
    if (bridge.cells.length === 1 && first) {
      const landEW = !map.isWater(first.col - 1, first.row) && !map.isWater(first.col + 1, first.row);
      const landNS = !map.isWater(first.col, first.row - 1) && !map.isWater(first.col, first.row + 1);
      deck = landEW && !landNS ? 'ew' : landNS && !landEW ? 'ns' : bridge.deck;
    }
    const object = buildBridge(bridge.span * cell, bridge.width * cell, bridge.covered, stoneMat, roofMat);
    object.position.set(bridge.x, 0, bridge.z);
    object.rotation.y = deck === 'ns' ? Math.PI / 2 : 0;
    object.updateMatrixWorld(true);
    // Folded into the stone and roof meshes: a bridge is thirty parts, and there are a dozen bridges.
    object.traverse((o) => {
      if (!(o instanceof Mesh)) return;
      const bucket = o.material === roofMat ? B.roof : B.stone;
      bucket.geometry(o.geometry as BufferGeometry, o.matrixWorld, bridgeTint);
      (o.geometry as BufferGeometry).dispose();
    });
  }
  for (const dock of map.docks) {
    const dx = -Math.sin(dock.yaw);
    const dz = -Math.cos(dock.yaw);
    const cx = dock.x - dx * 3.5;
    const cz = dock.z - dz * 3.5;
    const hw = (Math.abs(dx) * 4 + Math.abs(dz) * 1.8) / 2;
    const hd = (Math.abs(dz) * 4 + Math.abs(dx) * 1.8) / 2;
    box(B.wood, cx - hw, 0.15, cz - hd, cx + hw, 0.62, cz + hd, 1.6, white, { ...SIDES_TOP, ny: true });
    for (const k of [-1, 1]) place(B.wood, bollard, cx + (Math.abs(dz) ? 0 : k * 1.6), 0.95, cz + (Math.abs(dx) ? 0 : k * 1.6), new Color(0.55, 0.42, 0.3));
  }
  for (const pile of map.piles) {
    for (let i = 0; i < 3; i++) {
      const a = (i * Math.PI * 2) / 3;
      tmpM.makeRotationZ((hash(pile.x, pile.z, i) - 0.5) * 0.12);
      tmpM.setPosition(pile.x + Math.cos(a) * pile.radius * 0.5, 1.0, pile.z + Math.sin(a) * pile.radius * 0.5);
      B.wood.geometry(pole, tmpM, new Color(0.5, 0.38, 0.26));
    }
  }
  if (map.tower) buildCampanile(map.tower.x, map.tower.z);

  function buildCampanile(x: number, z: number): void {
    const brick = new Color(0.96, 0.78, 0.68);
    box(B.towerStone, x - 4.1, HOUSE.keelDepth, z - 4.1, x + 4.1, 2.6, z + 4.1, 2.6, stoneTint, SIDES_TOP);
    box(B.towerBrick, x - 3.1, 2.6, z - 3.1, x + 3.1, 54, z + 3.1, 4.2, brick, SIDES);
    // Pilaster strips up every face.
    for (const k of [-2.1, -0.7, 0.7, 2.1]) {
      box(B.towerStone, x + k - 0.22, 2.6, z - 3.3, x + k + 0.22, 53, z - 3.1, 2.6, stoneTint, { nz: true, px: true, nx: true });
      box(B.towerStone, x + k - 0.22, 2.6, z + 3.1, x + k + 0.22, 53, z + 3.3, 2.6, stoneTint, { pz: true, px: true, nx: true });
      box(B.towerStone, x - 3.3, 2.6, z + k - 0.22, x - 3.1, 53, z + k + 0.22, 2.6, stoneTint, { nx: true, pz: true, nz: true });
      box(B.towerStone, x + 3.1, 2.6, z + k - 0.22, x + 3.3, 53, z + k + 0.22, 2.6, stoneTint, { px: true, pz: true, nz: true });
    }
    // Belfry with two arched openings per face, an attic, the spire and the golden angel.
    box(B.towerStone, x - 3.6, 54, z - 3.6, x + 3.6, 59.5, z + 3.6, 2.6, stoneTint, SIDES_TOP);
    for (const dir of [[0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]] as const) {
      for (const k of [-1.3, 1.3]) {
        const wx = x + (dir[0] ? dir[0] * 3.67 : k);
        const wz = z + (dir[2] ? dir[2] * 3.67 : k);
        facadeQuad(B.window, wx, 56.9, wz, 1.8, 3.9, dir, white);
      }
    }
    box(B.towerBrick, x - 2.9, 59.5, z - 2.9, x + 2.9, 62, z + 2.9, 4.2, brick, SIDES);
    const spire = new ConeGeometry(4.2, 8, 4);
    tmpM.makeRotationY(Math.PI / 4);
    tmpM.setPosition(x, 66, z);
    B.copper.geometry(spire, tmpM, white);
    spire.dispose();
    const ball = new SphereGeometry(0.7, 10, 8);
    tmpM.identity();
    tmpM.setPosition(x, 70.4, z);
    B.gold.geometry(ball, tmpM, white);
    ball.dispose();
  }

  function buildChurch(x0: number, z0: number, x1: number, z1: number): void {
    const H = 14;
    box(B.stone, x0, HOUSE.keelDepth, z0, x1, H, z1, 2.6, stoneTint, SIDES);
    box(B.stone, x0 - 0.5, H - 0.1, z0 - 0.5, x1 + 0.5, H + 0.5, z1 + 0.5, 2.6, stoneTint, SIDES_TOP);
    // Pilasters and tall windows round the walls.
    for (const [x, z, dir] of [[(x0 + x1) / 2, z0, [0, 0, -1]], [(x0 + x1) / 2, z1, [0, 0, 1]], [x0, (z0 + z1) / 2, [-1, 0, 0]], [x1, (z0 + z1) / 2, [1, 0, 0]]] as const) {
      for (const k of [-4.5, 0, 4.5]) {
        const wx = dir[0] ? x + dir[0] * 0.07 : x + k;
        const wz = dir[2] ? z + dir[2] * 0.07 : z + k;
        facadeQuad(B.window, wx, 8.5, wz, 2.0, 5.2, dir, white);
      }
    }
    const cx = (x0 + x1) / 2;
    const cz = (z0 + z1) / 2;
    const r = Math.min(x1 - x0, z1 - z0) * 0.34;
    const drum = new CylinderGeometry(r, r, 3.6, 24);
    tmpM.identity();
    tmpM.setPosition(cx, H + 0.5 + 1.8, cz);
    B.stone.geometry(drum, tmpM, stoneTint);
    drum.dispose();
    const dome = new SphereGeometry(r * 1.08, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2);
    tmpM.setPosition(cx, H + 4.1, cz);
    B.lead.geometry(dome, tmpM, white);
    dome.dispose();
    const lantern = new CylinderGeometry(r * 0.18, r * 0.2, 2.4, 10);
    tmpM.setPosition(cx, H + 4.1 + r * 1.08 + 1.0, cz);
    B.stone.geometry(lantern, tmpM, stoneTint);
    lantern.dispose();
    const cap = new ConeGeometry(r * 0.24, 1.6, 10);
    tmpM.setPosition(cx, H + 4.1 + r * 1.08 + 2.9, cz);
    B.lead.geometry(cap, tmpM, white);
    cap.dispose();
    const ball = new SphereGeometry(0.45, 10, 8);
    tmpM.setPosition(cx, H + 4.1 + r * 1.08 + 3.9, cz);
    B.gold.geometry(ball, tmpM, white);
    ball.dispose();
  }

  for (const bucket of [...B.plaster, B.stone, B.algae, B.roof, B.wood, B.poles, B.window, B.laundry, B.iron, B.lamp, B.lead, B.copper, B.gold, B.towerBrick, B.towerStone]) {
    const mesh = bucket.mesh();
    if (mesh) {
      group.add(mesh);
      disposables.push(mesh.geometry);
    }
  }
  // Lantern glow: one additive point cloud, sized in metres.
  if (glowPoints.length) {
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(glowPoints, 3));
    const mat = new PointsMaterial({ map: glow, color: 0xffb765, size: 2.6, sizeAttenuation: true, transparent: true, opacity: 0.85, blending: AdditiveBlending, depthWrite: false });
    const points = new Points(geo, mat);
    points.name = 'lantern-glow';
    group.add(points);
    disposables.push(geo, mat);
  }
  for (const g of geos) disposables.push(g);

  return {
    group,
    dispose(): void {
      for (const d of disposables) d.dispose();
    },
  };
}
