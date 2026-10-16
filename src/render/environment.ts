/**
 * src/render/environment.ts
 * Golden-hour light (SPEC section 9): procedural Sky + PMREM at startup (zero download, Gate 1 safe),
 * then an HDRI (Poly Haven "Venice Sunset", CC0) swapped in when it has loaded.
 * One DirectionalLight is the sun; the HDRI/Sky is the ambient and the reflections.
 * Fog uses the official CAMERA distances; the campanile keeps a stronger silhouette.
 */
import {
  ACESFilmicToneMapping,
  BackSide,
  Color,
  DataUtils,
  DirectionalLight,
  EquirectangularReflectionMapping,
  Float32BufferAttribute,
  Fog,
  HemisphereLight,
  LinearSRGBColorSpace,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  PMREMGenerator,
  Scene,
  SphereGeometry,
  Vector3,
  type DataTexture,
  type Material,
  type Texture,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from 'three';
import { CAMERA } from '@shared/config.ts';
import { Sky } from 'three/addons/objects/Sky.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';

export const LIGHT = {
  sunElevationDeg: 17, // low golden-hour sun; long shadows across the canals
  sunAzimuthDeg: 215, // from the south-west
  sunIntensity: 2.3, // physically based units (lux-ish); ACES exposure below balances it
  exposure: 0.88,
  envIntensity: 0.55,
  fogColor: 0xe9c9a0, // warm haze, the colour of the sky dome at the horizon
  /** The painted sky dome: horizon, a band above it, the zenith, and the glow round the sun. */
  skyHorizon: 0xf3cf9c,
  skyBand: 0xe3a98c,
  skyZenith: 0x5f8fcf,
  sunGlow: 0xffd9a0,
  fogNear: CAMERA.fogNear,
  fogFar: CAMERA.fogFar,
  shadowMapSize: 2048,
  shadowExtent: 170, // half-size of the orthographic shadow box: covers the 240 x 192 m map and its edge
} as const;

export interface Environment {
  readonly sun: DirectionalLight;
  readonly sunDirection: Vector3; // unit vector pointing toward the sun
  /** Load the HDRI and swap it in. Never throws: on failure the procedural sky stays. */
  applyHdri(url: string): Promise<boolean>;
  dispose(): void;
}

export function sunDirection(elevationDeg: number, azimuthDeg: number, out: Vector3 = new Vector3()): Vector3 {
  // phi is the polar angle from +Y, theta the azimuth around Y
  return out.setFromSphericalCoords(1, MathUtils.degToRad(90 - elevationDeg), MathUtils.degToRad(azimuthDeg));
}

export function setupEnvironment(renderer: WebGLRenderer, scene: Scene, mapCentre: Vector3 = new Vector3()): Environment {
  // Colour pipeline (r186 defaults, stated explicitly): sRGB output, linear working space, ACES.
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = LIGHT.exposure;
  // renderer.outputColorSpace is SRGBColorSpace by default in r186; left as is.

  const dir = sunDirection(LIGHT.sunElevationDeg, LIGHT.sunAzimuthDeg);

  // 1) Procedural sky, available on the first frame.
  const sky = new Sky();
  sky.scale.setScalar(2000);
  const u = sky.material.uniforms;
  setUniform(u, 'turbidity', 6);
  setUniform(u, 'rayleigh', 2.2);
  setUniform(u, 'mieCoefficient', 0.008);
  setUniform(u, 'mieDirectionalG', 0.85);
  const sunPos = u['sunPosition']?.value;
  if (sunPos instanceof Vector3) sunPos.copy(dir);

  const pmrem = new PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const skyScene = new Scene();
  skyScene.add(sky);
  let envRT: WebGLRenderTarget | null = pmrem.fromScene(skyScene, 0.04);
  scene.environment = envRT.texture;
  scene.environmentIntensity = LIGHT.envIntensity;
  // The background is a painted dome, not the HDRI: a photo horizon shows its own trees and
  // roofs above our houses. The dome ignores the fog (the fog colour is its horizon colour).
  const dome = buildSkyDome(dir);
  scene.add(dome);
  skyScene.remove(sky);
  sky.geometry.dispose();
  sky.material.dispose();

  // 2) Lights: one sun with a shadow map shared across viewports; faint hemisphere fill.
  const sun = new DirectionalLight(0xffe0b8, LIGHT.sunIntensity);
  sun.position.copy(dir).multiplyScalar(300).add(mapCentre);
  sun.target.position.copy(mapCentre);
  scene.add(sun, sun.target); // the target must be in the scene for its matrixWorld to update
  sun.castShadow = true;
  sun.shadow.mapSize.set(LIGHT.shadowMapSize, LIGHT.shadowMapSize);
  const cam = sun.shadow.camera;
  cam.left = -LIGHT.shadowExtent;
  cam.right = LIGHT.shadowExtent;
  cam.top = LIGHT.shadowExtent;
  cam.bottom = -LIGHT.shadowExtent;
  cam.near = 1;
  cam.far = 620;
  cam.updateProjectionMatrix();
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.6; // metres; buildings are big, this kills acne on flat walls
  const hemi = new HemisphereLight(0xb9d3ff, 0x2b3a2e, 0.25);
  scene.add(hemi);

  // 3) Fog: linear, warm, matches the horizon.
  scene.fog = new Fog(LIGHT.fogColor, LIGHT.fogNear, LIGHT.fogFar);

  let hdrTexture: Texture | null = null;
  let disposed = false;

  return {
    sun,
    sunDirection: dir,
    async applyHdri(url: string): Promise<boolean> {
      try {
        const loader = new HDRLoader(); // RGBELoader is deprecated since r180; HDRLoader is the same parser
        const tex = await loader.loadAsync(url); // DataTexture, HalfFloatType, LinearSRGBColorSpace
        if (disposed) { tex.dispose(); return false; }
        tex.mapping = EquirectangularReflectionMapping;
        const rt = pmrem.fromEquirectangular(tex);
        scene.environment = rt.texture;
        envRT?.dispose();
        envRT = rt;
        hdrTexture?.dispose();
        hdrTexture = tex;
        return true;
      } catch (err: unknown) {
        console.warn('HDRI not applied, keeping the procedural sky', err);
        return false;
      }
    },
    dispose(): void {
      disposed = true;
      scene.environment = null;
      scene.background = null;
      scene.remove(dome);
      dome.geometry.dispose();
      (dome.material as MeshBasicMaterial).dispose();
      envRT?.dispose();
      hdrTexture?.dispose();
      pmrem.dispose();
      sun.dispose();
      hemi.dispose();
    },
  };
}

/**
 * A vertex-coloured dome: warm at the horizon, a rosy band above it, blue at the zenith, and a
 * glow round the sun. Drawn inside the far plane with no fog and no tone mapping surprises.
 */
export function buildSkyDome(sunDir: Vector3): Mesh {
  // Inside the far plane from anywhere on the map (the camera stays within about 130 m of the origin).
  const geo = new SphereGeometry(150, 48, 24);
  const pos = geo.getAttribute('position');
  const colours = new Float32Array(pos.count * 3);
  const horizon = new Color(LIGHT.skyHorizon);
  const band = new Color(LIGHT.skyBand);
  const zenith = new Color(LIGHT.skyZenith);
  const glow = new Color(LIGHT.sunGlow);
  const c = new Color();
  const v = new Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).normalize();
    const h = Math.max(0, v.y); // 0 at the horizon, 1 straight up
    // Horizon -> band in the first 12 degrees, band -> zenith above.
    if (h < 0.2) c.copy(horizon).lerp(band, Math.pow(h / 0.2, 0.8));
    else c.copy(band).lerp(zenith, Math.pow((h - 0.2) / 0.8, 0.6));
    const toSun = Math.max(0, v.dot(sunDir));
    c.lerp(glow, Math.pow(toSun, 14) * 0.9 + Math.pow(toSun, 3) * 0.18);
    // Below the horizon the water hides the dome; keep the horizon colour there.
    if (v.y < 0) c.copy(horizon);
    colours[i * 3] = c.r;
    colours[i * 3 + 1] = c.g;
    colours[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new Float32BufferAttribute(colours, 3));
  const mat = new MeshBasicMaterial({ vertexColors: true, side: BackSide, fog: false, depthWrite: false });
  const dome = new Mesh(geo, mat);
  dome.name = 'sky';
  dome.renderOrder = -1;
  dome.frustumCulled = false;
  return dome;
}

function setUniform(uniforms: Record<string, { value: unknown }>, name: string, value: number): void {
  const u = uniforms[name];
  if (u) u.value = value;
}

/**
 * Average colour of the HDRI's horizon row (v = 0.5), as a linear-space Color.
 * HDRLoader gives HalfFloatType data (Uint16Array) by default; FloatType is handled too.
 */
export function fogColorFromHdri(tex: DataTexture): Color {
  const img = tex.image;
  const w = img.width;
  const h = img.height;
  const data = img.data;
  const row = Math.floor(h * 0.5);
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  if (data instanceof Uint16Array || data instanceof Float32Array) {
    const half = data instanceof Uint16Array;
    for (let x = 0; x < w; x += 4) {
      const i = (row * w + x) * 4;
      const cr = data[i] ?? 0;
      const cg = data[i + 1] ?? 0;
      const cb = data[i + 2] ?? 0;
      r += half ? DataUtils.fromHalfFloat(cr) : cr;
      g += half ? DataUtils.fromHalfFloat(cg) : cg;
      b += half ? DataUtils.fromHalfFloat(cb) : cb;
      n++;
    }
  }
  if (n === 0) return new Color(LIGHT.fogColor);
  // Soft-clip the HDR average into display range (the fog is mixed in after tone mapping).
  const k = 1 / (1 + Math.max(r, g, b) / n);
  return new Color().setRGB((r / n) * k, (g / n) * k, (b / n) * k, LinearSRGBColorSpace);
}

/** Make a material keep part of its colour through the fog (campanile silhouette). */
export function weakenFog(material: Material, keep: number = 0.45): void {
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <fog_fragment>',
      `#ifdef USE_FOG
        float fogFactor = smoothstep( fogNear, fogFar, vFogDepth ) * ${(1 - keep).toFixed(3)};
        gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
      #endif`,
    );
  };
  material.customProgramCacheKey = () => `weakfog${keep}`;
}
