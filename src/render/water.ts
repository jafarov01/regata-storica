/**
 * src/render/water.ts
 * Water without planar reflections (SPEC section 9): one big MeshStandardMaterial plane,
 * two scrolling copies of one tileable normal map blended in the shader (onBeforeCompile),
 * sky reflection from scene.environment, dark green-teal base, linear fog, receives the sun shadow.
 * Do NOT use three/addons/objects/Water.js (mirror render target per camera) or Water2.js
 * (Reflector + Refractor): both re-render the scene per viewport.
 * Wake foam: one ribbon mesh per boat fed by a ring buffer of stern positions.
 */
import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Vector2,
  type Texture,
} from 'three';

export const WATER = {
  size: 1400, // m; reaches well past the fog on every side of the 400 x 300 map
  color: 0x0f3b38, // dark green-teal
  roughness: 0.22,
  tileA: 9, // m per normal-map tile, layer A
  tileB: 3.3, // m per tile, layer B
  flowA: new Vector2(0.018, 0.011), // tiles per second
  flowB: new Vector2(-0.025, 0.02),
  normalScale: 0.55,
} as const;

export interface WaterSurface {
  readonly mesh: Mesh;
  update(timeSeconds: number): void;
  dispose(): void;
}

export function createWater(normalMap: Texture, normalMapB: Texture): WaterSurface {
  const geometry = new PlaneGeometry(WATER.size, WATER.size, 1, 1);
  geometry.rotateX(-Math.PI / 2);
  const material = new MeshStandardMaterial({
    color: WATER.color,
    roughness: WATER.roughness,
    metalness: 0,
    normalMap,
    normalScale: new Vector2(WATER.normalScale, WATER.normalScale),
    envMapIntensity: 1.0,
  });
  const uTime = { value: 0 };
  const uScaleA = { value: WATER.size / WATER.tileA };
  const uScaleB = { value: WATER.size / WATER.tileB };
  const uFlowA = { value: WATER.flowA };
  const uFlowB = { value: WATER.flowB };
  material.onBeforeCompile = (shader) => {
    shader.uniforms['uNormalB'] = { value: normalMapB };
    shader.uniforms['uTime'] = uTime;
    shader.uniforms['uScaleA'] = uScaleA;
    shader.uniforms['uScaleB'] = uScaleB;
    shader.uniforms['uFlowA'] = uFlowA;
    shader.uniforms['uFlowB'] = uFlowB;
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <normalmap_pars_fragment>',
        `#include <normalmap_pars_fragment>
        uniform sampler2D uNormalB; uniform float uTime; uniform float uScaleA; uniform float uScaleB; uniform vec2 uFlowA; uniform vec2 uFlowB;`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        // Replaces the tangent-space branch of r186's normal_fragment_maps: reuses `tbn` from normal_fragment_begin.
        `vec3 nA = texture2D( normalMap, vNormalMapUv * uScaleA + uTime * uFlowA ).xyz * 2.0 - 1.0;
        vec3 nB = texture2D( uNormalB, vNormalMapUv * uScaleB + uTime * uFlowB ).xyz * 2.0 - 1.0;
        vec3 mapN = normalize( vec3( nA.xy + nB.xy, nA.z * nB.z ) );
        mapN.xy *= normalScale;
        normal = normalize( tbn * mapN );`,
      );
  };
  material.customProgramCacheKey = () => 'gondola-water-two-maps-v1';
  const mesh = new Mesh(geometry, material);
  mesh.receiveShadow = true;
  mesh.frustumCulled = false; // always in view; skip the sphere test
  mesh.name = 'water';
  return {
    mesh,
    update(timeSeconds: number): void {
      uTime.value = timeSeconds;
    },
    dispose(): void {
      geometry.dispose();
      material.dispose();
    },
  };
}

/**
 * Foam ribbon behind a boat. `push()` once every `sampleEvery` seconds with the stern position;
 * the ribbon fades with age and widens. One draw call, 2 * N vertices, no allocation per frame.
 */
export class WakeTrail {
  readonly mesh: Mesh;
  private readonly n: number;
  private readonly xs: Float32Array;
  private readonly zs: Float32Array;
  private readonly ts: Float32Array;
  private readonly positions: Float32Array;
  private readonly alphas: Float32Array;
  private head = 0;
  private count = 0;
  private lastSample = -1;

  constructor(foam: Texture | null, segments: number = 28, private readonly life: number = 2.2, private readonly sampleEvery: number = 0.08) {
    this.n = segments;
    this.xs = new Float32Array(segments);
    this.zs = new Float32Array(segments);
    this.ts = new Float32Array(segments);
    this.positions = new Float32Array(segments * 2 * 3);
    this.alphas = new Float32Array(segments * 2);
    const geo = new BufferGeometry();
    const pos = new BufferAttribute(this.positions, 3);
    pos.setUsage(DynamicDrawUsage);
    geo.setAttribute('position', pos);
    const alpha = new BufferAttribute(this.alphas, 1);
    alpha.setUsage(DynamicDrawUsage);
    geo.setAttribute('aAlpha', alpha);
    const index: number[] = [];
    for (let i = 0; i < segments - 1; i++) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    geo.setIndex(index);
    const mat = new MeshBasicMaterial({ color: 0xdff3ee, map: foam, transparent: true, opacity: 0.8, depthWrite: false, side: DoubleSide });
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aAlpha; varying float vAlpha;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvAlpha = aAlpha;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vAlpha;')
        .replace('#include <dithering_fragment>', '#include <dithering_fragment>\ngl_FragColor.a *= vAlpha;');
    };
    mat.customProgramCacheKey = () => 'gondola-wake-v1';
    this.mesh = new Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1; // after the water
    this.mesh.position.y = 0.03;
  }

  reset(): void {
    this.count = 0;
    this.head = 0;
    this.lastSample = -1;
    this.positions.fill(0);
    this.alphas.fill(0);
    this.markDirty();
  }

  /** Call every frame with the stern position (metres) and the boat speed (m/s). */
  update(time: number, sternX: number, sternZ: number, yaw: number, speed: number): void {
    if (time - this.lastSample >= this.sampleEvery && Math.abs(speed) > 0.5) {
      this.xs[this.head] = sternX;
      this.zs[this.head] = sternZ;
      this.ts[this.head] = time;
      this.head = (this.head + 1) % this.n;
      this.count = Math.min(this.count + 1, this.n);
      this.lastSample = time;
    }
    const px = -Math.sin(yaw); // perpendicular to the heading, in the water plane
    const pz = Math.cos(yaw);
    for (let i = 0; i < this.n; i++) {
      const k = (this.head - 1 - i + this.n * 2) % this.n; // newest first
      const valid = i < this.count;
      const age = valid ? time - (this.ts[k] ?? 0) : this.life;
      const a = Math.max(0, 1 - age / this.life);
      const half = 0.35 + 1.2 * (1 - a); // widens as it fades
      const x = valid ? (this.xs[k] ?? 0) : sternX;
      const z = valid ? (this.zs[k] ?? 0) : sternZ;
      const o = i * 6;
      this.positions[o] = x + px * half;
      this.positions[o + 1] = 0;
      this.positions[o + 2] = z + pz * half;
      this.positions[o + 3] = x - px * half;
      this.positions[o + 4] = 0;
      this.positions[o + 5] = z - pz * half;
      this.alphas[i * 2] = a * a;
      this.alphas[i * 2 + 1] = a * a;
    }
    this.markDirty();
  }

  private markDirty(): void {
    const g = this.mesh.geometry;
    const p = g.getAttribute('position');
    const a = g.getAttribute('aAlpha');
    if ('needsUpdate' in p) p.needsUpdate = true;
    if ('needsUpdate' in a) a.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    const m = this.mesh.material;
    if (!Array.isArray(m)) m.dispose();
  }
}
