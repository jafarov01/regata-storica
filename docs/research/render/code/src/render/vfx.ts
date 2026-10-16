/**
 * src/render/vfx.ts
 * GPU-animated particles: one THREE.Points per blending mode, a ring buffer of particles
 * whose motion (p0 + v*t + g*t^2/2, with drag) is evaluated in the vertex shader from a
 * birth time, so emitting is a typed-array write and updating is one uniform.
 * Sprites would be one draw call each; Points are one draw call per system per viewport.
 * gl_PointSize depends on the viewport height: call setViewport() before each viewport render.
 */
import { AdditiveBlending, BufferAttribute, BufferGeometry, DynamicDrawUsage, Group, NormalBlending, Points, ShaderMaterial, Vector3, type Texture } from 'three';
import type { GameEvent, RenderState } from '@shared/state.ts';

const VERT = /* glsl */ `
attribute vec3 aVel; attribute float aBirth; attribute float aLife; attribute float aSize; attribute vec3 aColor;
uniform float uTime; uniform vec3 uGravity; uniform float uDrag; uniform float uScale; uniform float uMaxSize;
varying float vAge; varying vec3 vColor;
void main() {
  float t = uTime - aBirth;
  float age = aLife > 0.0 ? t / aLife : 2.0;
  vAge = age; vColor = aColor;
  if (t < 0.0 || age > 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  float k = uDrag > 1e-4 ? (1.0 - exp(-uDrag * t)) / uDrag : t;
  vec3 p = position + aVel * k + 0.5 * uGravity * t * t;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float grow = 1.0 + 1.5 * age;
  gl_PointSize = min(uMaxSize, aSize * grow * uScale / max(0.1, -mv.z));
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */ `
uniform sampler2D map; varying float vAge; varying vec3 vColor;
void main() {
  vec4 tex = texture2D(map, gl_PointCoord);
  float fade = 1.0 - smoothstep(0.55, 1.0, vAge);
  gl_FragColor = vec4(vColor, tex.a * fade);
}`;

export interface Particle {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number; // s
  size: number; // metres at 1 m distance, before perspective
  r: number;
  g: number;
  b: number;
}

export class ParticleSystem {
  readonly points: Points;
  private readonly cap: number;
  private cursor = 0;
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly birth: Float32Array;
  private readonly life: Float32Array;
  private readonly size: Float32Array;
  private readonly color: Float32Array;
  private dirty = false;
  private readonly uTime = { value: 0 };
  private readonly uScale = { value: 300 };

  constructor(map: Texture, cap: number, gravity: number, drag: number, additive: boolean) {
    this.cap = cap;
    this.pos = new Float32Array(cap * 3);
    this.vel = new Float32Array(cap * 3);
    this.birth = new Float32Array(cap).fill(-1e9);
    this.life = new Float32Array(cap);
    this.size = new Float32Array(cap);
    this.color = new Float32Array(cap * 3);
    const g = new BufferGeometry();
    const attr = (arr: Float32Array, n: number): BufferAttribute => {
      const a = new BufferAttribute(arr, n);
      a.setUsage(DynamicDrawUsage);
      return a;
    };
    g.setAttribute('position', attr(this.pos, 3));
    g.setAttribute('aVel', attr(this.vel, 3));
    g.setAttribute('aBirth', attr(this.birth, 1));
    g.setAttribute('aLife', attr(this.life, 1));
    g.setAttribute('aSize', attr(this.size, 1));
    g.setAttribute('aColor', attr(this.color, 3));
    const mat = new ShaderMaterial({
      uniforms: {
        uTime: this.uTime,
        uGravity: { value: new Vector3(0, gravity, 0) },
        uDrag: { value: drag },
        uScale: this.uScale,
        uMaxSize: { value: 256 }, // ALIASED_POINT_SIZE_RANGE is GPU dependent; big effects use meshes
        map: { value: map },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: additive ? AdditiveBlending : NormalBlending,
    });
    this.points = new Points(g, mat);
    this.points.frustumCulled = false;
  }

  emit(p: Particle, time: number): void {
    const i = this.cursor;
    this.cursor = (i + 1) % this.cap;
    this.pos[i * 3] = p.x;
    this.pos[i * 3 + 1] = p.y;
    this.pos[i * 3 + 2] = p.z;
    this.vel[i * 3] = p.vx;
    this.vel[i * 3 + 1] = p.vy;
    this.vel[i * 3 + 2] = p.vz;
    this.birth[i] = time;
    this.life[i] = p.life;
    this.size[i] = p.size;
    this.color[i * 3] = p.r;
    this.color[i * 3 + 1] = p.g;
    this.color[i * 3 + 2] = p.b;
    this.dirty = true;
  }

  update(time: number): void {
    this.uTime.value = time;
    if (!this.dirty) return;
    this.dirty = false;
    const g = this.points.geometry;
    for (const name of ['position', 'aVel', 'aBirth', 'aLife', 'aSize', 'aColor']) {
      const a = g.getAttribute(name);
      if ('needsUpdate' in a) a.needsUpdate = true;
    }
  }

  /** Point size in pixels is proportional to viewportHeight / (2 tan(vfov / 2)). */
  setViewport(heightPx: number, vfovDeg: number): void {
    this.uScale.value = heightPx / (2 * Math.tan((vfovDeg * Math.PI) / 360));
  }

  dispose(): void {
    this.points.geometry.dispose();
    const m = this.points.material;
    if (!Array.isArray(m)) m.dispose();
  }
}

const scratch: Particle = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 1, size: 1, r: 1, g: 1, b: 1 };

/** Facade: three systems (spray, glow, fireworks) and the event-to-effect mapping. */
export class Vfx {
  readonly group = new Group();
  private readonly spray: ParticleSystem;
  private readonly glow: ParticleSystem;
  private readonly fire: ParticleSystem;
  private rnd = 12345;

  constructor(glowTex: Texture) {
    this.spray = new ParticleSystem(glowTex, 4096, -9.81, 0.9, false);
    this.glow = new ParticleSystem(glowTex, 1024, 0, 2.5, true);
    this.fire = new ParticleSystem(glowTex, 2048, -3.0, 0.9, true);
    this.group.add(this.spray.points, this.glow.points, this.fire.points);
  }

  private random(): number {
    this.rnd = (this.rnd * 1664525 + 1013904223) >>> 0;
    return this.rnd / 4294967296;
  }

  private burst(sys: ParticleSystem, time: number, n: number, x: number, y: number, z: number, speed: number, up: number, life: number, size: number, r: number, g: number, b: number): void {
    for (let i = 0; i < n; i++) {
      const a = this.random() * Math.PI * 2;
      const s = speed * (0.4 + this.random() * 0.6);
      scratch.x = x;
      scratch.y = y;
      scratch.z = z;
      scratch.vx = Math.cos(a) * s;
      scratch.vz = Math.sin(a) * s;
      scratch.vy = up * (0.5 + this.random());
      scratch.life = life * (0.7 + this.random() * 0.6);
      scratch.size = size * (0.6 + this.random() * 0.8);
      scratch.r = r;
      scratch.g = g;
      scratch.b = b;
      sys.emit(scratch, time);
    }
  }

  muzzleFlash(time: number, x: number, z: number, yaw: number): void {
    const fx = Math.cos(yaw);
    const fz = Math.sin(yaw);
    this.burst(this.glow, time, 6, x + fx * 1.4, 0.8, z + fz * 1.4, 0.5, 0.3, 0.12, 2.2, 1.0, 0.75, 0.3);
    this.burst(this.spray, time, 10, x + fx * 1.6, 0.8, z + fz * 1.6, 1.5, 1.0, 0.8, 0.9, 0.6, 0.6, 0.6); // smoke-ish
  }

  splash(time: number, x: number, z: number, strength: number): void {
    this.burst(this.spray, time, Math.round(30 * strength), x, 0.1, z, 2.5 * strength, 5 * strength, 0.9, 1.2, 0.9, 0.97, 1.0);
  }

  /** Lethal hit: water column (tall, slow spray) plus a bright flash. */
  explosion(time: number, x: number, z: number): void {
    this.burst(this.spray, time, 90, x, 0.2, z, 3.5, 11, 1.4, 1.8, 0.92, 0.98, 1.0);
    this.burst(this.glow, time, 12, x, 1.5, z, 2, 2, 0.25, 4, 1.0, 0.6, 0.2);
  }

  sparks(time: number, x: number, z: number): void {
    this.burst(this.glow, time, 8, x, 0.4, z, 3, 2, 0.35, 0.5, 1.0, 0.8, 0.3);
  }

  pickup(time: number, x: number, z: number, r: number, g: number, b: number): void {
    this.burst(this.glow, time, 14, x, 0.8, z, 1.2, 2.5, 0.7, 1.0, r, g, b);
  }

  firework(time: number, x: number, y: number, z: number, r: number, g: number, b: number): void {
    this.burst(this.fire, time, 120, x, y, z, 9, 0, 1.6, 1.1, r, g, b);
  }

  onEvents(events: readonly GameEvent[], state: RenderState, time: number): void {
    for (const e of events) {
      switch (e.kind) {
        case 'fired':
          if (e.weapon !== 'water') this.muzzleFlash(time, e.x, e.z, e.yaw);
          break;
        case 'hit':
          this.explosion(time, e.x, e.z);
          break;
        case 'splash':
          this.splash(time, e.x, e.z, 1);
          break;
        case 'sunk':
          this.explosion(time, e.x, e.z);
          break;
        case 'respawn':
          this.splash(time, e.x, e.z, 1.4);
          break;
        case 'scrape':
          this.sparks(time, e.x, e.z);
          break;
        case 'pickup':
          this.pickup(time, e.x, e.z, 1, 0.9, 0.4);
          break;
        case 'win': {
          const team = state.teams.find((t) => t.id === e.team);
          const c = team ? team.colour : 0xffffff;
          this.firework(time, 0, 30, 0, ((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255);
          break;
        }
        default:
          break;
      }
    }
  }

  update(time: number): void {
    this.spray.update(time);
    this.glow.update(time);
    this.fire.update(time);
  }

  setViewport(heightPx: number, vfovDeg: number): void {
    this.spray.setViewport(heightPx, vfovDeg);
    this.glow.setViewport(heightPx, vfovDeg);
    this.fire.setViewport(heightPx, vfovDeg);
  }

  dispose(): void {
    this.spray.dispose();
    this.glow.dispose();
    this.fire.dispose();
  }
}
