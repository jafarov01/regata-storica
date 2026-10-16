/**
 * src/render/environment.ts
 * Golden-hour light (SPEC section 9): procedural Sky + PMREM at startup (zero download, Gate 1 safe),
 * then an HDRI (Poly Haven "Venice Sunset", CC0) swapped in when it has loaded.
 * One DirectionalLight is the sun; the HDRI/Sky is the ambient and the reflections.
 * Fog is linear and tuned to hide beyond about 120 m; the campanile gets a weaker fog.
 */
import {
  ACESFilmicToneMapping,
  Color,
  DataUtils,
  DirectionalLight,
  EquirectangularReflectionMapping,
  Fog,
  HemisphereLight,
  LinearSRGBColorSpace,
  MathUtils,
  PMREMGenerator,
  Scene,
  Vector3,
  type DataTexture,
  type Material,
  type Texture,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';

export const LIGHT = {
  sunElevationDeg: 14, // low golden-hour sun; long shadows across the canals
  sunAzimuthDeg: 215, // from the south-west
  sunIntensity: 2.6, // physically based units (lux-ish); ACES exposure below balances it
  exposure: 0.95,
  envIntensity: 0.7,
  fogColor: 0xe7c9a3, // warm haze, close to the HDRI horizon; refined by fogColorFromHdri()
  fogNear: 40,
  fogFar: 140, // "hide beyond about 120 m": smoothstep(40, 140, 120) = 0.90
  shadowMapSize: 2048,
  shadowExtent: 260, // half-size of the orthographic shadow box: covers the 500 m map diagonal
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
  scene.background = envRT.texture; // CubeUV PMREM as background is supported by WebGLBackground
  scene.backgroundIntensity = 1.0;
  skyScene.remove(sky);
  sky.geometry.dispose();
  sky.material.dispose();

  // 2) Lights: one sun with a single static shadow map; a faint hemisphere fill as a floor.
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

  return {
    sun,
    sunDirection: dir,
    async applyHdri(url: string): Promise<boolean> {
      try {
        const loader = new HDRLoader(); // RGBELoader is deprecated since r180; HDRLoader is the same parser
        const tex = await loader.loadAsync(url); // DataTexture, HalfFloatType, LinearSRGBColorSpace
        tex.mapping = EquirectangularReflectionMapping;
        const rt = pmrem.fromEquirectangular(tex);
        if (scene.fog instanceof Fog) scene.fog.color.copy(fogColorFromHdri(tex));
        scene.environment = rt.texture;
        scene.background = rt.texture;
        scene.backgroundBlurriness = 0; // sharp sky; raise toward 0.1 for a dreamier look
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
      envRT?.dispose();
      hdrTexture?.dispose();
      pmrem.dispose();
      sun.dispose();
      hemi.dispose();
    },
  };
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
