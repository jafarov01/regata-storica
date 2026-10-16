/**
 * src/render/gondola.ts
 * Adapted research gondola: a lofted hull (asymmetric, bow and stern rising),
 * team-colour trim strip, the ferro (extruded comb), a bow lantern that GLOWS in the team
 * colour (emissive + additive sprite + a light pool on the water; no PointLight: 6 lights x
 * 4 viewports would be evaluated in every lit fragment, and the lamp itself would still be
 * invisible), a swivel cannon, a blob shadow and a wake trail. Crew is deferred to C8.
 * Model convention: bow along +X; world forward = (cos yaw, 0, sin yaw) => mesh.rotation.y = -yaw.
 */
import {
  AdditiveBlending,
  BoxGeometry,
  BufferGeometry,
  CircleGeometry,
  Color,
  CylinderGeometry,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Group,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Shape,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  type Texture,
} from 'three';
import { lerp, lerpAngle } from '@shared/math.ts';
import type { RenderBoat as BoatState } from './state.ts';
import { WakeTrail } from './water.ts';
import { CrewAvatars, type CrewMember } from './avatars.ts';


export const GONDOLA = {
  length: 6.0,
  beam: 1.4,
  depth: 0.5,
  asymmetry: 0.1, // the real hull is wider on the left; shifts the keel line
  bob: 0.05,
  maxRollDeg: 8,
  sinkSeconds: 2.0,
  teleportMetres: 20, // a jump bigger than this is a respawn: do not interpolate across it
} as const;

interface Station {
  x: number;
  width: number;
  depth: number;
  yTop: number;
  zc: number;
}

function station(s: number): Station {
  const bulge = Math.sin(Math.PI * s);
  return {
    x: (s - 0.5) * GONDOLA.length,
    width: GONDOLA.beam * Math.pow(bulge, 0.55),
    depth: GONDOLA.depth * Math.pow(bulge, 0.7) + 0.05,
    yTop: 0.42 + Math.pow(1 - bulge, 3) * 1.1, // bow and stern rise
    zc: GONDOLA.asymmetry * bulge,
  };
}

/** Lofted hull: `stations` cross-sections, each a half-ellipse from port gunwale to starboard gunwale, plus a deck strip. */
export function buildHullGeometry(stations: number = 26, profile: number = 9): BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  const rowLen = profile + 1;
  for (let i = 0; i <= stations; i++) {
    const st = station(i / stations);
    for (let j = 0; j <= profile; j++) {
      const th = (Math.PI * j) / profile;
      pos.push(st.x, st.yTop - (st.yTop + st.depth) * Math.sin(th), st.zc - (st.width / 2) * Math.cos(th));
    }
  }
  for (let i = 0; i < stations; i++) {
    for (let j = 0; j < profile; j++) {
      const a = i * rowLen + j;
      const b = a + rowLen;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  // deck: two vertices per station just under the gunwale
  const deckStart = pos.length / 3;
  for (let i = 0; i <= stations; i++) {
    const st = station(i / stations);
    const y = st.yTop - 0.12;
    pos.push(st.x, y, st.zc - st.width / 2 + 0.04, st.x, y, st.zc + st.width / 2 - 0.04);
  }
  for (let i = 0; i < stations; i++) {
    const a = deckStart + i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Thin ribbon along both gunwales for the team-colour trim. */
export function buildTrimGeometry(stations: number = 26): BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  for (const side of [-1, 1]) {
    const start = pos.length / 3;
    for (let i = 0; i <= stations; i++) {
      const st = station(i / stations);
      const z = st.zc + (side * st.width) / 2;
      pos.push(st.x, st.yTop + 0.02, z + side * 0.02, st.x, st.yTop - 0.1, z + side * 0.04);
    }
    for (let i = 0; i < stations; i++) {
      const a = start + i * 2;
      if (side > 0) idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      else idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** The ferro: a flat comb in the X-Y plane, 6 teeth pointing forward, extruded 5 cm. */
export function buildFerroGeometry(): BufferGeometry {
  const s = new Shape();
  const pts: readonly [number, number][] = [
    [0, 0], [0.24, 0], [0.24, 0.12], [0.44, 0.12], [0.44, 0.26], [0.24, 0.26], [0.24, 0.4], [0.44, 0.4], [0.44, 0.54], [0.24, 0.54],
    [0.24, 0.68], [0.44, 0.68], [0.44, 0.82], [0.24, 0.82], [0.24, 0.96], [0.44, 0.96], [0.44, 1.1], [0.24, 1.1], [0.3, 1.3], [0.5, 1.42], [0.12, 1.5], [0, 1.25],
  ];
  const first = pts[0] ?? [0, 0];
  s.moveTo(first[0], first[1]);
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i] ?? [0, 0];
    s.lineTo(p[0], p[1]);
  }
  s.closePath();
  const g = new ExtrudeGeometry(s, { depth: 0.05, bevelEnabled: false });
  g.translate(0, 0, -0.025);
  return g;
}

export interface GondolaAssets {
  readonly hull: BufferGeometry;
  readonly trim: BufferGeometry;
  readonly ferro: BufferGeometry;
  readonly lanternPole: BufferGeometry;
  readonly lanternHead: BufferGeometry;
  readonly cannonBase: BufferGeometry;
  readonly cannonBarrel: BufferGeometry;
  readonly bubble: BufferGeometry;
  readonly blob: BufferGeometry;
  readonly pool: BufferGeometry;
  readonly hullMat: MeshStandardMaterial;
  readonly ferroMat: MeshStandardMaterial;
  readonly cannonMat: MeshStandardMaterial;
  readonly blobMat: MeshBasicMaterial;
  readonly glow: Texture;
  dispose(): void;
}

export function createGondolaAssets(glow: Texture): GondolaAssets {
  const hull = buildHullGeometry();
  const trim = buildTrimGeometry();
  const ferro = buildFerroGeometry();
  const lanternPole = new CylinderGeometry(0.03, 0.03, 1.3, 6);
  const lanternHead = new BoxGeometry(0.26, 0.34, 0.26);
  const cannonBase = new CylinderGeometry(0.22, 0.3, 0.3, 10);
  const cannonBarrel = new CylinderGeometry(0.09, 0.13, 1.1, 10).rotateZ(-Math.PI / 2).translate(0.5, 0, 0);
  const bubble = new SphereGeometry(4.2, 24, 16);
  const blob = new PlaneGeometry(7.5, 2.6).rotateX(-Math.PI / 2);
  const pool = new CircleGeometry(2.4, 20).rotateX(-Math.PI / 2);
  const hullMat = new MeshStandardMaterial({ color: 0x0a0a0c, roughness: 0.35, metalness: 0.05 });
  const ferroMat = new MeshStandardMaterial({ color: 0xcfd3d8, roughness: 0.3, metalness: 0.9 });
  const cannonMat = new MeshStandardMaterial({ color: 0x2b2b2e, roughness: 0.45, metalness: 0.8 });
  const blobMat = new MeshBasicMaterial({ color: 0x000000, map: glow, transparent: true, opacity: 0.38, depthWrite: false });
  return {
    hull, trim, ferro, lanternPole, lanternHead, cannonBase, cannonBarrel, bubble, blob, pool, hullMat, ferroMat, cannonMat, blobMat, glow,
    dispose(): void {
      for (const g of [hull, trim, ferro, lanternPole, lanternHead, cannonBase, cannonBarrel, bubble, blob, pool]) g.dispose();
      for (const m of [hullMat, ferroMat, cannonMat, blobMat]) m.dispose();
    },
  };
}

interface TeamMaterials {
  trim: MeshStandardMaterial;
  lantern: MeshStandardMaterial;
  glow: SpriteMaterial;
  pool: MeshBasicMaterial;
  bubble: MeshBasicMaterial;
}



function teamMaterials(colour: number, glowTex: Texture): TeamMaterials {
  const c = new Color(colour);
  const m: TeamMaterials = {
    trim: new MeshStandardMaterial({ color: c, roughness: 0.5 }),
    lantern: new MeshStandardMaterial({ color: 0x111111, emissive: c, emissiveIntensity: 3.0, roughness: 0.4 }),
    glow: new SpriteMaterial({ map: glowTex, color: c, blending: AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.85, fog: false, toneMapped: false }),
    pool: new MeshBasicMaterial({ color: c, map: glowTex, blending: AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.22, toneMapped: false }),
    bubble: new MeshBasicMaterial({ color: c, transparent: true, opacity: 0.16, blending: AdditiveBlending, depthWrite: false }),
  };
  return m;
}

export class GondolaView {
  readonly root = new Group();
  /** Interpolated transform of this frame, reused by the camera rig and the HUD. */
  ix = 0;
  iz = 0;
  iyaw = 0;
  iaim = 0;
  private readonly boat = new Group();
  private readonly cannon = new Group();
  private readonly bubble: Mesh;
  private readonly protect: Mesh;
  private readonly glow: Sprite;
  private readonly blob: Mesh;
  private readonly pool: Mesh;
  private readonly wake: WakeTrail;
  private readonly crew: CrewAvatars;
  private readonly teamMats: TeamMaterials;
  private readonly phase = Math.random() * Math.PI * 2;
  private roll = 0;
  private pitch = 0;
  private lastAlive = true;

  constructor(assets: GondolaAssets, teamColour: number, foam: Texture | null) {
    const tm = teamMaterials(teamColour, assets.glow);
    this.teamMats = tm;
    const hull = new Mesh(assets.hull, assets.hullMat);
    hull.castShadow = true; // shadow map refreshed once per frame, shared by all viewports
    const trim = new Mesh(assets.trim, tm.trim);
    const ferro = new Mesh(assets.ferro, assets.ferroMat);
    ferro.position.set(GONDOLA.length / 2 - 0.15, 1.1, 0);
    const pole = new Mesh(assets.lanternPole, assets.ferroMat);
    pole.position.set(2.0, 1.2, 0);
    const head = new Mesh(assets.lanternHead, tm.lantern);
    head.position.set(2.0, 2.0, 0);
    this.glow = new Sprite(tm.glow);
    this.glow.position.copy(head.position);
    this.glow.scale.setScalar(2.4);
    this.cannon.position.set(0.2, 0.45, 0);
    this.cannon.add(new Mesh(assets.cannonBase, assets.cannonMat));
    const barrel = new Mesh(assets.cannonBarrel, assets.cannonMat);
    barrel.position.y = 0.3;
    this.cannon.add(barrel);
    this.boat.add(hull, trim, ferro, pole, head, this.glow, this.cannon);

    this.bubble = new Mesh(assets.bubble, tm.bubble);
    this.bubble.visible = false;
    this.protect = new Mesh(assets.bubble, new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.12, blending: AdditiveBlending, depthWrite: false }));
    this.protect.visible = false;
    this.blob = new Mesh(assets.blob, assets.blobMat);
    this.blob.position.y = 0.02;
    this.pool = new Mesh(assets.pool, tm.pool);
    this.pool.position.y = 0.04;
    this.wake = new WakeTrail(foam);
    this.crew = new CrewAvatars(`#${teamColour.toString(16).padStart(6, '0')}`);
    this.crew.root.position.y = 0.32;
    // CrewAvatars uses bow -Z; the procedural gondola bow points along +X.
    this.crew.root.rotation.y = -Math.PI / 2;
    this.boat.add(this.crew.root);
    this.root.add(this.boat, this.bubble, this.protect, this.blob, this.pool, this.wake.mesh);
  }

  setCrew(members: readonly CrewMember[]): void {
    this.crew.setCrew(members);
  }

  /** Call once per frame. `alpha` is the fixed-timestep interpolation factor from the sim loop. */
  update(b: BoatState, alpha: number, time: number, dt: number): void {
    const jump = Math.hypot(b.x - b.px, b.z - b.pz) > GONDOLA.teleportMetres;
    const a = jump ? 1 : alpha;
    this.ix = lerp(b.px, b.x, a);
    this.iz = lerp(b.pz, b.z, a);
    this.iyaw = lerpAngle(b.pyaw, b.yaw, a);
    this.iaim = lerpAngle(b.paim, b.aim, a);
    if (jump || (b.alive && !this.lastAlive)) {
      this.wake.reset();

    }
    this.lastAlive = b.alive;

    // visual-only motion: bob, roll into turns, pitch with acceleration, sit lower with water aboard
    const bob = Math.sin(time * 1.3 + this.phase) * GONDOLA.bob - 0.2 * (b.water / 100);
    const rollTarget = MathUtils.clamp(-b.turnRate * b.speed * 0.045, -1, 1) * MathUtils.degToRad(GONDOLA.maxRollDeg);
    const pitchTarget = MathUtils.clamp(-b.accel * 0.02, -0.09, 0.09);
    const k = 1 - Math.exp(-6 * dt);
    this.roll += (rollTarget - this.roll) * k;
    this.pitch += (pitchTarget - this.pitch) * k;

    let y = bob;
    let roll = this.roll;
    let pitch = this.pitch;
    this.root.visible = b.status === 'alive' || b.status === 'sinking';
    const sinking = b.status === 'sinking';
    if (sinking) {
      const t = Math.min(b.sinkT, GONDOLA.sinkSeconds + 0.3);
      pitch += t * 0.55; // bow up
      roll += t * 0.7;
      y -= t * t * 1.1;
    }
    this.boat.visible = b.alive || (sinking && b.sinkT < GONDOLA.sinkSeconds);
    this.boat.position.set(this.ix, y, this.iz);
    this.boat.rotation.set(roll, -this.iyaw, pitch, 'YZX'); // yaw about world Y, pitch about the beam, roll about the keel
    this.cannon.rotation.y = -(this.iaim - this.iyaw); // gunner aim relative to the hull
    this.glow.material.opacity = b.alive ? 0.85 : 0;
    this.crew.update({
      dt,
      time,
      speed: b.speed,
      angVel: -b.turnRate,
      gas: b.gas,
      aimRel: -(this.iaim - this.iyaw),
      water: b.water,
      sinking,
      celebrate: b.celebrate,
    });

    this.blob.visible = b.alive;
    this.blob.position.set(this.ix, 0.02, this.iz);
    this.blob.rotation.y = -this.iyaw;
    this.pool.visible = b.alive;
    this.pool.position.set(this.ix + Math.cos(this.iyaw) * 2.0, 0.04, this.iz + Math.sin(this.iyaw) * 2.0);

    this.bubble.visible = b.alive && b.shieldT > 0;
    if (this.bubble.visible) {
      this.bubble.position.set(this.ix, 0.3, this.iz);
      this.bubble.scale.setScalar(1 + 0.03 * Math.sin(time * 9));
    }
    this.protect.visible = b.alive && b.protectT > 0;
    if (this.protect.visible) {
      this.protect.position.set(this.ix, 0.3, this.iz);
      const m = this.protect.material;
      if (!Array.isArray(m)) m.opacity = 0.06 + 0.06 * Math.sin(time * 14);
    }

    const sternX = this.ix - Math.cos(this.iyaw) * 2.8;
    const sternZ = this.iz - Math.sin(this.iyaw) * 2.8;
    this.wake.mesh.visible = b.alive;
    if (b.alive) this.wake.update(time, sternX, sternZ, this.iyaw, b.speed);


  }

  dispose(): void {
    this.crew.dispose();
    this.wake.dispose();
    for (const material of Object.values(this.teamMats)) material.dispose();
    const pm = this.protect.material;
    if (!Array.isArray(pm)) pm.dispose();
  }
}
