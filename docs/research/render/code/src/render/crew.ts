/**
 * src/render/crew.ts
 * Code-built stylised crew (the hackathon choice): capsule bodies, striped shirts, straw hats
 * with a team-colour ribbon. Procedural animation: row (faster on GAS), aim-turn, bail,
 * flinch, tumble overboard, celebrate. Shared geometries and materials; ~700 triangles per boat.
 */
import { BoxGeometry, CapsuleGeometry, CylinderGeometry, Group, Mesh, MeshStandardMaterial, SphereGeometry, Vector3, type Texture } from 'three';

export interface CrewTextures {
  readonly shirt: Texture; // horizontal stripes
}

export interface CrewFrame {
  readonly time: number;
  readonly dt: number;
  readonly gas: boolean;
  readonly speed: number;
  readonly aimRel: number; // cannon yaw relative to the hull (radians, three rotation.y)
  readonly bailing: boolean;
  readonly sinking: boolean;
  readonly sinkT: number;
  readonly celebrate: boolean;
}

interface CrewGeo {
  body: CapsuleGeometry;
  head: SphereGeometry;
  brim: CylinderGeometry;
  crown: CylinderGeometry;
  ribbon: CylinderGeometry;
  arm: CapsuleGeometry;
  oar: CylinderGeometry;
  bucket: CylinderGeometry;
  seat: BoxGeometry;
}

let geo: CrewGeo | null = null;
const mats = new Map<string, MeshStandardMaterial>();

function geometry(): CrewGeo {
  if (geo) return geo;
  geo = {
    body: new CapsuleGeometry(0.2, 0.5, 3, 10),
    head: new SphereGeometry(0.16, 12, 10),
    brim: new CylinderGeometry(0.34, 0.34, 0.035, 14),
    crown: new CylinderGeometry(0.17, 0.2, 0.17, 14),
    ribbon: new CylinderGeometry(0.205, 0.205, 0.05, 14),
    arm: new CapsuleGeometry(0.055, 0.42, 2, 6).translate(0, -0.26, 0),
    oar: new CylinderGeometry(0.025, 0.035, 4.2, 6).translate(0, -1.6, 0),
    bucket: new CylinderGeometry(0.16, 0.12, 0.26, 10),
    seat: new BoxGeometry(0.7, 0.08, 0.7),
  };
  return geo;
}

function material(key: string, make: () => MeshStandardMaterial): MeshStandardMaterial {
  let m = mats.get(key);
  if (!m) {
    m = make();
    mats.set(key, m);
  }
  return m;
}

class Figure {
  readonly root = new Group();
  readonly armL: Mesh;
  readonly armR: Mesh;
  readonly body: Mesh;
  readonly hat = new Group();
  readonly vel = new Vector3();
  readonly spin = new Vector3();
  readonly home = new Vector3();
  overboard = false;

  constructor(tex: CrewTextures, teamColour: number, seated: boolean) {
    const g = geometry();
    const shirt = material('shirt', () => new MeshStandardMaterial({ map: tex.shirt, roughness: 0.9 }));
    const skin = material('skin', () => new MeshStandardMaterial({ color: 0xe3b48f, roughness: 0.8 }));
    const straw = material('straw', () => new MeshStandardMaterial({ color: 0xe6d28a, roughness: 0.95 }));
    const ribbon = material(`ribbon${teamColour}`, () => new MeshStandardMaterial({ color: teamColour, roughness: 0.6 }));
    this.body = new Mesh(g.body, shirt);
    this.body.position.y = seated ? 0.45 : 0.75;
    const head = new Mesh(g.head, skin);
    head.position.y = 0.52;
    const brim = new Mesh(g.brim, straw);
    brim.position.y = 0.6;
    const crown = new Mesh(g.crown, straw);
    crown.position.y = 0.68;
    const rib = new Mesh(g.ribbon, ribbon);
    rib.position.y = 0.62;
    this.hat.add(brim, crown, rib);
    this.armL = new Mesh(g.arm, shirt);
    this.armL.position.set(0, 0.3, -0.26);
    this.armR = new Mesh(g.arm, shirt);
    this.armR.position.set(0, 0.3, 0.26);
    this.body.add(head, this.hat, this.armL, this.armR);
    this.root.add(this.body);
    for (const m of [this.body, head, brim, crown, rib, this.armL, this.armR]) m.castShadow = false;
  }
}

export class CrewSet {
  readonly root = new Group();
  private readonly pilot: Figure;
  private readonly gunner: Figure;
  private readonly engineer: Figure;
  private readonly oar: Mesh;
  private readonly bucket: Mesh;
  private readonly figures: readonly Figure[];

  constructor(tex: CrewTextures, teamColour: number) {
    const g = geometry();
    const wood = material('wood', () => new MeshStandardMaterial({ color: 0x6b4a2b, roughness: 0.8 }));
    this.pilot = new Figure(tex, teamColour, false);
    this.pilot.home.set(-2.25, 0.42, 0.15);
    this.oar = new Mesh(g.oar, wood);
    this.oar.position.set(0.1, 0.55, 0.35);
    this.pilot.body.add(this.oar);
    this.gunner = new Figure(tex, teamColour, true);
    this.gunner.home.set(-0.45, 0.35, 0);
    this.engineer = new Figure(tex, teamColour, true);
    this.engineer.home.set(1.35, 0.35, 0);
    this.bucket = new Mesh(g.bucket, wood);
    this.bucket.position.set(0, -0.5, 0);
    this.engineer.armR.add(this.bucket);
    for (const f of [this.gunner, this.engineer]) {
      const seat = new Mesh(g.seat, wood);
      seat.position.y = 0.2;
      f.root.add(seat);
    }
    this.figures = [this.pilot, this.gunner, this.engineer];
    for (const f of this.figures) {
      f.root.position.copy(f.home);
      this.root.add(f.root);
    }
  }

  reset(): void {
    for (const f of this.figures) {
      f.overboard = false;
      f.root.position.copy(f.home);
      f.root.rotation.set(0, 0, 0);
      f.root.visible = true;
      f.body.rotation.set(0, 0, 0);
    }
  }

  update(f: CrewFrame): void {
    if (f.sinking) {
      this.tumble(f);
      return;
    }
    const t = f.time;
    // Pilot: rowing cycle; faster with GAS, slower at rest
    const hz = f.gas ? 1.4 : Math.abs(f.speed) > 0.5 ? 0.9 : 0.5;
    const w = t * hz * Math.PI * 2;
    this.oar.rotation.z = 0.35 + Math.sin(w) * 0.3;
    this.oar.rotation.x = Math.cos(w) * 0.25;
    this.pilot.body.rotation.z = Math.sin(w) * 0.14 + 0.08;
    this.pilot.armR.rotation.z = -1.1 + Math.sin(w) * 0.4;
    this.pilot.armL.rotation.z = -0.9 + Math.sin(w + 0.6) * 0.4;
    // Gunner: turns with the cannon, hands on the grips
    this.gunner.root.rotation.y = f.aimRel;
    this.gunner.armL.rotation.z = -1.3;
    this.gunner.armR.rotation.z = -1.3;
    this.gunner.body.rotation.x = Math.sin(t * 1.3) * 0.02;
    // Engineer: bails with the bucket, or sways idle
    if (f.bailing) {
      const b = t * 2.4 * Math.PI * 2;
      this.engineer.armR.rotation.z = -0.6 + Math.sin(b) * 1.1;
      this.engineer.body.rotation.x = Math.sin(b) * 0.2;
      this.bucket.rotation.x = Math.max(0, Math.sin(b)) * 1.2;
    } else {
      this.engineer.armR.rotation.z = -0.4 + Math.sin(t * 1.7) * 0.08;
      this.engineer.body.rotation.x = Math.sin(t * 1.1) * 0.04;
      this.bucket.rotation.x = 0;
    }
    if (f.celebrate) {
      const c = t * 3 * Math.PI * 2;
      for (const fig of this.figures) {
        fig.armL.rotation.z = Math.PI - 0.3 + Math.sin(c) * 0.3;
        fig.armR.rotation.z = Math.PI - 0.3 + Math.cos(c) * 0.3;
        fig.root.position.y = fig.home.y + Math.max(0, Math.sin(c)) * 0.25;
      }
    }
  }

  private tumble(f: CrewFrame): void {
    for (let i = 0; i < this.figures.length; i++) {
      const fig = this.figures[i];
      if (!fig) continue;
      if (!fig.overboard) {
        fig.overboard = true;
        const ang = i * 2.1 + f.time;
        fig.vel.set(Math.cos(ang) * 2.5, 3.2 + i * 0.4, Math.sin(ang) * 2.5);
        fig.spin.set(2 + i, 1, 3 - i);
      }
      fig.root.position.addScaledVector(fig.vel, f.dt);
      fig.vel.y -= 9.81 * f.dt;
      fig.root.rotation.x += fig.spin.x * f.dt;
      fig.root.rotation.z += fig.spin.z * f.dt;
      if (fig.root.position.y < -1.2) fig.root.visible = false; // under water; the splash VFX covers the entry
    }
  }

  dispose(): void {
    // geometries and materials are shared module-wide; nothing per boat to free
  }
}
