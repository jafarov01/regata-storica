import { ClampToEdgeWrapping, NoColorSpace, RepeatWrapping, SRGBColorSpace, TextureLoader, type Texture } from 'three';
import { makeGlowTexture, makeGrainTexture, makeStripeTexture, makeWaterNormalTexture } from './textures.ts';

export const TEXTURE_FILES = {
  ochre: 'plaster-ochre.jpg', terracotta: 'plaster-terracotta.jpg', rose: 'plaster-rose.jpg', cream: 'plaster-cream.jpg',
  stone: 'stone-istrian.jpg', algae: 'algae-band.jpg', wood: 'wood-dark.jpg', crate: 'wood-crate.jpg',
  poles: 'pole-stripes.jpg', window: 'window-gothic.png', laundry: 'laundry.png',
  roof: 'roof-tiles.jpg', lantern: 'lantern-glow.png', foam: 'foam.jpg',
  normalA: 'water-normal-1.jpg', normalB: 'water-normal-2.jpg',
} as const;
export const TEXTURE_COUNT = Object.keys(TEXTURE_FILES).length;
export type AssetKey = keyof typeof TEXTURE_FILES;

/** Stable texture objects: successful loads replace pixels, failures keep procedural pixels. */
export function loadAssets(anisotropy: number, onLoad: () => void) {
  const textures = {} as Record<AssetKey, Texture>;
  const loader = new TextureLoader();
  let disposed = false;
  for (const key of Object.keys(TEXTURE_FILES) as AssetKey[]) {
    const normal = key === 'normalA' || key === 'normalB';
    const cutout = key === 'window' || key === 'laundry' || key === 'lantern';
    const texture = normal ? makeWaterNormalTexture(256, anisotropy) : key === 'lantern' ? makeGlowTexture(64) : cutout ? makeGrainTexture(32, 0, anisotropy) : key === 'poles' ? makeStripeTexture('#f3f0e6', '#2b5fb8') : makeGrainTexture(128, 0.18, anisotropy);
    texture.colorSpace = normal ? NoColorSpace : SRGBColorSpace;
    texture.wrapS = cutout || key === 'crate' ? ClampToEdgeWrapping : RepeatWrapping;
    texture.wrapT = cutout || key === 'crate' || key === 'algae' || key === 'poles' ? ClampToEdgeWrapping : RepeatWrapping;
    texture.anisotropy = anisotropy;
    texture.name = key;
    textures[key] = texture;
    loader.load(`/assets/textures/${TEXTURE_FILES[key]}`, loaded => {
      if (!disposed) {
        // texStorage2D is immutable: release the small fallback before uploading
        // a full-size image into this same texture object.
        texture.dispose();
        texture.image = loaded.image;
        texture.needsUpdate = true;
        texture.userData.loaded = true;
        onLoad();
      }
      loaded.dispose();
    }, undefined, () => { if (!disposed) console.warn(`Texture ${TEXTURE_FILES[key]} unavailable; using procedural fallback.`); });
  }
  const glow = makeGlowTexture(64);
  return { textures, glow, dispose() { disposed = true; Object.values(textures).forEach(t => t.dispose()); glow.dispose(); } };
}
