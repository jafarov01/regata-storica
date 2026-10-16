/**
 * src/render/textures.ts
 * Procedural textures built on a 2D canvas at startup so nothing has to download before Gate 1.
 * Colour textures get SRGBColorSpace; data textures (normal maps) keep the default NoColorSpace.
 */
import { CanvasTexture, RepeatWrapping, SRGBColorSpace, type Texture } from 'three';

function canvas2d(size: number, height: number = size): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas not available');
  return { canvas, ctx };
}

/** Tileable water normal map: a sum of directional sine waves, normals by finite differences. */
export function makeWaterNormalTexture(size: number = 256, anisotropy: number = 8): Texture {
  const { canvas, ctx } = canvas2d(size);
  const img = ctx.createImageData(size, size);
  const waves: readonly [number, number, number, number][] = [
    // [kx, kz] integer wave numbers keep it tileable; [amp, phase]
    [3, 2, 1.0, 0.3],
    [-2, 5, 0.6, 1.7],
    [7, -1, 0.35, 0.9],
    [4, 6, 0.25, 2.4],
    [-9, 3, 0.15, 0.1],
  ];
  const h = (u: number, v: number): number => {
    let s = 0;
    for (const [kx, kz, amp, ph] of waves) s += amp * Math.sin(2 * Math.PI * (kx * u + kz * v) + ph);
    return s;
  };
  const e = 1 / size;
  const strength = 0.08; // slope scale
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const dx = (h(u + e, v) - h(u - e, v)) / (2 * e) * strength;
      const dy = (h(u, v + e) - h(u, v - e)) / (2 * e) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      img.data[i] = Math.round((-dx / len * 0.5 + 0.5) * 255);
      img.data[i + 1] = Math.round((-dy / len * 0.5 + 0.5) * 255);
      img.data[i + 2] = Math.round((1 / len * 0.5 + 0.5) * 255);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.anisotropy = anisotropy;
  return tex;
}

/** Soft plaster/stone grain: value noise, tileable by wrapping the lattice. */
export function makeGrainTexture(size: number = 256, contrast: number = 0.18, anisotropy: number = 8): Texture {
  const { canvas, ctx } = canvas2d(size);
  const img = ctx.createImageData(size, size);
  const n = 16;
  const lattice = new Float32Array(n * n);
  let seed = 1234;
  const rnd = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < lattice.length; i++) lattice[i] = rnd();
  const at = (ix: number, iy: number): number => lattice[((iy + n) % n) * n + ((ix + n) % n)] ?? 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0;
      let amp = 1;
      let freq = 1;
      for (let o = 0; o < 3; o++) {
        const fx = (x / size) * n * freq;
        const fy = (y / size) * n * freq;
        const ix = Math.floor(fx);
        const iy = Math.floor(fy);
        const tx = fx - ix;
        const ty = fy - iy;
        const sx = tx * tx * (3 - 2 * tx);
        const sy = ty * ty * (3 - 2 * ty);
        const a = at(ix, iy) * (1 - sx) + at(ix + 1, iy) * sx;
        const b = at(ix, iy + 1) * (1 - sx) + at(ix + 1, iy + 1) * sx;
        v += (a * (1 - sy) + b * sy) * amp;
        amp *= 0.5;
        freq *= 2;
      }
      const g = Math.round(255 * (1 - contrast / 2 + (v / 1.75) * contrast));
      const i = (y * size + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = g;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.anisotropy = anisotropy;
  return tex;
}

/** Radial glow sprite (white, alpha falls off) for lanterns, muzzle flashes and particles. */
export function makeGlowTexture(size: number = 64): Texture {
  const { canvas, ctx } = canvas2d(size);
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

/** Horizontal stripes (gondolier shirts, mooring poles). */
export function makeStripeTexture(a: string, b: string, stripes: number = 8): Texture {
  const size = 64;
  const { canvas, ctx } = canvas2d(size);
  const h = size / stripes;
  for (let i = 0; i < stripes; i++) {
    ctx.fillStyle = i % 2 === 0 ? a : b;
    ctx.fillRect(0, i * h, size, h);
  }
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.wrapS = tex.wrapT = RepeatWrapping;
  return tex;
}
