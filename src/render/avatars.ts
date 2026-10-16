/**
 * src/render/avatars.ts: the crew aboard each gondola, built from the people players pick
 * (shared/characters.ts). Self-contained so any renderer can carry it: add `CrewAvatars.root`
 * to a boat group whose frame has the bow toward -Z, +X to starboard and y = 0 at the deck,
 * then call `update()` every frame.
 *
 * Where they stand (the user's layout): the Pilot stands at the stern rowing on the starboard
 * side, the Gunner sits at the bow behind a swivel cannon and turns with it, the Engineer
 * sits amidships with the bailing bucket.
 *
 * How they look: proportions, skin, hair style and colour, beard, glasses, hat, top, sleeves
 * and trousers from each person's `look`, and their cartoon portrait as a face decal on the
 * front of the head (a soft-edged crop on a sphere patch). Every avatar is merged into six
 * meshes with vertex colours (legs, torso, head, face, two arms) sharing one material, so
 * 18 people in 4 viewports stay cheap.
 *
 * How they move: each body hangs on a damped spring around its feet (standing) or seat
 * (sitting). The boat's turn pushes them outward (lateral acceleration = speed * yaw rate),
 * speeding up tips them back and braking forward, and a small wave bob runs underneath; the
 * head follows the body on a second, quicker spring. On top: rowing (faster on GAS), aiming,
 * bailing, flailing while the boat sinks, and cheering for the winners.
 */
import {
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  CapsuleGeometry,
  Color,
  CylinderGeometry,
  Euler,
  Float32BufferAttribute,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  SphereGeometry,
  SRGBColorSpace,
  TorusGeometry,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GONDOLIER, characterById, portraitUrl, type CharacterDef, type CharacterLook } from '@shared/characters.ts';
import type { Role } from '@shared/state.ts';

// ---------------------------------------------------------------- tuning

/** Seats in the boat frame (bow at -Z). The placeholder hull is 6 m long. */
export const SEATS = {
  pilot: new Vector3(0.15, 0, 2.35),
  engineer: new Vector3(0, 0, 0.55),
  /** The cannon post; the Gunner sits behind it and both turn with the aim. */
  gunnerPost: new Vector3(0, 0, -1.85),
} as const;

const SWAY = {
  /** Body spring: natural frequency (Hz) and damping ratio. Low damping = a visible wobble. */
  freqHz: 1.5,
  damping: 0.32,
  /** Head spring, quicker. */
  headFreqHz: 3.2,
  headDamping: 0.45,
  /** Lean per m/s^2: sideways in a turn, back/forward when speeding up/braking. */
  rollPerAccel: 0.03,
  pitchPerAccel: 0.05,
  maxLean: 0.32,
  /** Seated people lean less than the standing Pilot. */
  seatedScale: 0.55,
  /** Wave bob: radians at rest and at top speed. */
  bobRest: 0.015,
  bobFast: 0.04,
} as const;

// ---------------------------------------------------------------- geometry helpers

const tmpColor = new Color();
const m4 = new Matrix4();
const q = new Quaternion();
const e = new Euler();

/** Gives a geometry a flat vertex colour and moves it into place. */
function part(geo: BufferGeometry, hex: string, pos: [number, number, number] = [0, 0, 0], rot: [number, number, number] = [0, 0, 0], scale: [number, number, number] = [1, 1, 1]): BufferGeometry {
  const g = geo;
  m4.compose(new Vector3(...pos), q.setFromEuler(e.set(...rot)), new Vector3(...scale));
  g.applyMatrix4(m4);
  tmpColor.set(hex).convertSRGBToLinear();
  const n = g.getAttribute('position').count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    c[i * 3] = tmpColor.r;
    c[i * 3 + 1] = tmpColor.g;
    c[i * 3 + 2] = tmpColor.b;
  }
  g.setAttribute('color', new Float32BufferAttribute(c, 3));
  return g;
}

function merge(parts: BufferGeometry[]): BufferGeometry {
  const out = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return out ?? new BufferGeometry();
}

function mix(a: string, b: string, t: number): string {
  return `#${new Color(a).lerp(new Color(b), t).getHexString()}`;
}

/** Deterministic pseudo-random for curls, from a string. */
function seeded(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- shared materials and faces

let bodyMat: MeshStandardMaterial | null = null;
function bodyMaterial(): MeshStandardMaterial {
  bodyMat ??= new MeshStandardMaterial({ vertexColors: true, roughness: 0.78, metalness: 0 });
  return bodyMat;
}

const faces = new Map<string, MeshStandardMaterial | 'loading' | 'none'>();
const faceWaiters = new Map<string, Array<(m: MeshStandardMaterial) => void>>();

/** The face decal material for a person: their portrait cropped to the face, edges feathered. */
function faceMaterial(c: CharacterDef, ready: (m: MeshStandardMaterial) => void): void {
  const known = faces.get(c.id);
  if (known instanceof MeshStandardMaterial) {
    ready(known);
    return;
  }
  if (known === 'none') return;
  const waiters = faceWaiters.get(c.id) ?? [];
  waiters.push(ready);
  faceWaiters.set(c.id, waiters);
  if (known === 'loading') return;
  const url = portraitUrl(c.id, 512);
  if (!url || typeof document === 'undefined') {
    faces.set(c.id, 'none');
    return;
  }
  faces.set(c.id, 'loading');
  const img = new Image();
  img.onload = () => {
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const g = canvas.getContext('2d');
    if (!g) return;
    // A square around the face, a little larger than the face itself (hairline to chin).
    const side = c.face.w * img.width * 1.18;
    g.drawImage(img, c.face.cx * img.width - side / 2, c.face.cy * img.height - side / 2, side, side, 0, 0, size, size);
    // Feather to transparent outside a tall oval (faces are taller than wide), so the decal
    // blends into the 3D head and the portrait's background never shows at the cheeks.
    g.globalCompositeOperation = 'destination-in';
    g.save();
    g.translate(size / 2, size / 2);
    g.scale(0.78, 1);
    const grad = g.createRadialGradient(0, 0, size * 0.28, 0, 0, size * 0.47);
    grad.addColorStop(0, 'rgba(0,0,0,1)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(-size, -size / 2, size * 2, size);
    g.restore();
    const tex = new CanvasTexture(canvas);
    tex.colorSpace = SRGBColorSpace;
    const mat = new MeshStandardMaterial({ map: tex, transparent: true, depthWrite: false, roughness: 0.85, polygonOffset: true, polygonOffsetFactor: -2 });
    faces.set(c.id, mat);
    for (const w of faceWaiters.get(c.id) ?? []) w(mat);
    faceWaiters.delete(c.id);
  };
  img.onerror = () => faces.set(c.id, 'none');
  img.src = url;
}

/** The front patch of the head the face decal sits on (faces -Z; texture not mirrored). */
function facePatch(r: number): BufferGeometry {
  const width = 1.95;
  return new SphereGeometry(r * 1.025, 16, 12, (3 * Math.PI) / 2 - width / 2, width, 0.55, 1.75);
}

// ---------------------------------------------------------------- one person

interface Figure {
  root: Group;
  /** Spring-driven lean, pivoting at the feet or the seat. */
  lean: Group;
  torso: Group;
  head: Group;
  armL: Group;
  armR: Group;
  face: Mesh | null;
  seated: boolean;
  /** Body spring state: roll (z) and pitch (x), with velocities. */
  roll: number;
  pitch: number;
  vRoll: number;
  vPitch: number;
  hRoll: number;
  hPitch: number;
  vhRoll: number;
  vhPitch: number;
  phase: number;
}

interface Dims {
  H: number;
  hip: number;
  shoulder: number;
  headY: number;
  r: number;
  sw: number;
}

function dims(look: CharacterLook): Dims {
  const H = look.height;
  return { H, hip: 0.53 * H, shoulder: 0.81 * H, headY: 0.925 * H, r: 0.064 * H, sw: 0.115 * H * look.build };
}

function buildHair(look: CharacterLook, d: Dims, id: string): BufferGeometry[] {
  const { r } = d;
  const hair = look.hair;
  const out: BufferGeometry[] = [];
  // The head is stretched (0.92, 1.08, 1): the hair shells follow, a little proud of the skull.
  const stretch: [number, number, number] = [0.95, 1.12, 1.03];
  // Hair leaves the face open: a crown down to the hairline all round, then the sides and back
  // further down, skipping a wedge at the front where the face decal is.
  const open = 1.9;
  const cap = (s: number, low = 0.56): BufferGeometry =>
    merge([
      part(new SphereGeometry(r * s, 18, 5, 0, Math.PI * 2, 0, Math.PI * 0.2), hair, [0, 0.008, 0.006], [0, 0, 0], stretch),
      part(new SphereGeometry(r * s, 16, 8, (3 * Math.PI) / 2 + open / 2, Math.PI * 2 - open, Math.PI * 0.2 - 0.01, Math.PI * (low - 0.2)), hair, [0, 0.008, 0.006], [0, 0, 0], stretch),
    ]);
  // Back of the head, below the crown.
  const back = (s: number, down: number): BufferGeometry => part(new SphereGeometry(r * s, 16, 8, 0, Math.PI, Math.PI * 0.45, Math.PI * down), hair, [0, 0, 0.004], [0, 0, 0], stretch);
  switch (look.hairStyle) {
    case 'fade':
      out.push(cap(1.06, 0.42), back(1.03, 0.22));
      break;
    case 'short':
      out.push(cap(1.08), back(1.05, 0.3));
      break;
    case 'curly': {
      out.push(cap(1.1), back(1.07, 0.32));
      const rnd = seeded(id);
      for (let i = 0; i < 16; i++) {
        const th = rnd() * Math.PI * 0.5;
        const ph = rnd() * Math.PI * 2;
        // Not over the face: the decal shows the hairline there.
        if (Math.sin(ph) < -0.55 && th > 0.4) continue;
        const rr = r * 1.08;
        out.push(part(new SphereGeometry(r * (0.24 + rnd() * 0.1), 7, 5), hair, [-rr * Math.cos(ph) * Math.sin(th), rr * Math.cos(th), rr * Math.sin(ph) * Math.sin(th)]));
      }
      break;
    }
    case 'ponytail':
      out.push(cap(1.05), back(1.04, 0.3));
      out.push(part(new CapsuleGeometry(r * 0.22, r * 1.6, 3, 8), hair, [0, -r * 0.5, r * 1.15], [0.35, 0, 0]));
      out.push(part(new TorusGeometry(r * 0.24, r * 0.06, 5, 10), mix(hair, '#000000', 0.4), [0, r * 0.25, r * 1.02], [Math.PI / 2 + 0.35, 0, 0]));
      break;
    case 'long-straight':
    case 'long-wavy':
    case 'long-curly': {
      out.push(cap(1.09), back(1.07, 0.38));
      const curly = look.hairStyle === 'long-curly';
      const wide = look.hairStyle === 'long-straight' ? 1 : 1.18;
      // The fall of hair down the back, to the shoulder blades.
      out.push(part(new CapsuleGeometry(r * 0.75 * wide, r * 3, 4, 12), hair, [0, -r * 1.9, r * 0.55], [0.08, 0, 0], [1.25, 1, 0.55]));
      // Locks framing the face, down to the collarbones.
      for (const side of [-1, 1]) {
        out.push(part(new CapsuleGeometry(r * 0.32 * wide, r * 2.3, 3, 8), hair, [side * r * 0.92, -r * 1.25, r * 0.05], [0, 0, side * 0.08]));
      }
      if (curly) {
        const rnd = seeded(id);
        for (let i = 0; i < 18; i++) {
          const y = -r * (0.4 + rnd() * 3.2);
          const x = (rnd() - 0.5) * r * 2.4;
          out.push(part(new SphereGeometry(r * (0.32 + rnd() * 0.14), 7, 5), hair, [x, y, r * (0.75 + rnd() * 0.25)]));
        }
      }
      break;
    }
  }
  return out;
}

function buildHead(look: CharacterLook, d: Dims, id: string, teamColour: string): BufferGeometry {
  const { r } = d;
  const parts: BufferGeometry[] = [];
  parts.push(part(new SphereGeometry(r, 20, 14), look.skin, [0, 0, 0], [0, 0, 0], [0.92, 1.08, 1]));
  // Ears.
  for (const side of [-1, 1]) parts.push(part(new SphereGeometry(r * 0.22, 8, 6), mix(look.skin, '#b0705a', 0.15), [side * r * 0.9, -r * 0.05, r * 0.05], [0, 0, 0], [0.5, 1, 0.8]));
  // Beard: a shell on the jaw, visible from the sides (the decal draws it from the front).
  if (look.beard !== 'none') {
    const colour = look.beard === 'stubble' ? mix(look.hair, look.skin, 0.55) : look.hair;
    const wide = look.beard === 'goatee' ? 1.1 : look.beard === 'stubble' ? 2.4 : 2.7;
    const low = look.beard === 'full' ? 0.4 : 0.34;
    const s = look.beard === 'full' ? 1.07 : 1.03;
    parts.push(part(new SphereGeometry(r * s, 16, 8, (3 * Math.PI) / 2 - wide / 2, wide, Math.PI * 0.58, Math.PI * low), colour, [0, 0, 0], [0, 0, 0], [0.92, 1.08, 1]));
  }
  // Glasses: the temples along the sides (the frame itself is in the portrait).
  if (look.glasses !== 'none') {
    for (const side of [-1, 1]) parts.push(part(new BoxGeometry(r * 0.06, r * 0.07, r * 1.15), '#151515', [side * r * 0.93, r * 0.12, r * 0.05]));
  }
  parts.push(...buildHair(look, d, id));
  if (look.hat === 'cap') {
    // The crown stops above the eyes; the peak sticks out over the face.
    parts.push(part(new SphereGeometry(r * 1.13, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.36), look.hatColour, [0, r * 0.05, 0], [0, 0, 0], [0.95, 1.1, 1.03]));
    parts.push(part(new CylinderGeometry(r * 0.95, r * 0.95, r * 0.08, 16, 1, false, Math.PI, Math.PI), mix(look.hatColour, '#000000', 0.15), [0, r * 0.12, -r * 0.55], [0.15, 0, 0], [1, 1, 1.1]));
  } else if (look.hat === 'straw') {
    parts.push(part(new CylinderGeometry(r * 2.3, r * 2.3, r * 0.1, 20), look.hatColour, [0, r * 0.62, 0]));
    parts.push(part(new CylinderGeometry(r * 1.02, r * 1.1, r * 0.8, 16), look.hatColour, [0, r * 1.0, 0]));
    parts.push(part(new CylinderGeometry(r * 1.11, r * 1.11, r * 0.24, 16), teamColour, [0, r * 0.76, 0]));
  }
  return merge(parts);
}

function sleeveLength(look: CharacterLook): 'long' | 'short' | 'none' {
  if (look.topStyle === 'tank') return 'none';
  if (look.topStyle === 'tee' || look.topStyle === 'polo') return 'short';
  return 'long';
}

function buildArm(look: CharacterLook, d: Dims, teamColour: string): BufferGeometry {
  const sleeve = sleeveLength(look);
  const H = d.H;
  const upper = 0.17 * H;
  const lower = 0.15 * H;
  const ra = 0.026 * H * look.build;
  const top = look.topStyle === 'stripes' ? '#f3eee2' : look.top;
  const parts: BufferGeometry[] = [];
  parts.push(part(new CapsuleGeometry(ra, upper - ra, 3, 8), sleeve === 'none' ? look.skin : top, [0, -upper / 2, 0]));
  parts.push(part(new CapsuleGeometry(ra * 0.9, lower - ra, 3, 8), sleeve === 'long' ? top : look.skin, [0, -upper - lower / 2 + ra * 0.3, 0]));
  parts.push(part(new SphereGeometry(ra * 1.05, 8, 6), look.skin, [0, -upper - lower - ra * 0.2, 0], [0, 0, 0], [0.8, 1.2, 0.6]));
  // A band in the team colour on the upper arm, so the crew reads as one team.
  parts.push(part(new CylinderGeometry(ra * 1.12, ra * 1.12, upper * 0.22, 10), teamColour, [0, -upper * 0.42, 0]));
  return merge(parts);
}

function buildTorso(look: CharacterLook, d: Dims): BufferGeometry {
  const { H, sw } = d;
  const len = d.shoulder - d.hip;
  const parts: BufferGeometry[] = [];
  const depth = 0.62;
  const chest = (colour: string, s = 1): BufferGeometry => part(new CapsuleGeometry(sw * 0.9 * s, len * 0.62, 4, 14), colour, [0, len * 0.48, 0], [0, 0, 0], [1.05, 1, depth]);
  switch (look.topStyle) {
    case 'stripes': {
      const bands = 7;
      for (let i = 0; i < bands; i++) {
        const h = (len * 0.95) / bands;
        parts.push(part(new CylinderGeometry(sw * 0.98, sw * 0.98, h, 16), i % 2 ? '#f3eee2' : look.top, [0, h * (i + 0.5) + len * 0.03, 0], [0, 0, 0], [1, 1, depth * 1.05]));
      }
      parts.push(part(new SphereGeometry(sw * 0.98, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), look.top, [0, len * 0.98, 0], [0, 0, 0], [1, 0.35, depth * 1.05]));
      break;
    }
    case 'blazer':
    case 'jacket': {
      parts.push(chest(look.inner, 0.97));
      // The jacket: the same shape a size larger, open at the front where the shirt shows.
      parts.push(part(new CapsuleGeometry(sw * 0.93, len * 0.62, 4, 16, 1), look.top, [0, len * 0.48, 0.004], [0, 0, 0], [1.08, 1, depth * 1.04]));
      parts.push(part(new BoxGeometry(sw * 0.42, len * 0.62, 0.01), look.inner, [0, len * 0.6, -sw * depth * 0.98]));
      parts.push(part(new TorusGeometry(sw * 0.36, sw * 0.08, 5, 12, Math.PI), look.top, [0, len * 0.96, -0.01], [Math.PI / 2 + 0.3, 0, 0]));
      break;
    }
    default:
      parts.push(chest(look.top));
  }
  // Collars and necklines.
  const neckR = 0.03 * H;
  if (look.topStyle === 'turtleneck') parts.push(part(new CylinderGeometry(neckR * 1.4, neckR * 1.5, 0.055 * H, 12), look.top, [0, len + 0.02 * H, 0]));
  if (look.topStyle === 'sweater' || look.topStyle === 'polo' || look.topStyle === 'shirt') parts.push(part(new TorusGeometry(neckR * 1.4, neckR * 0.35, 6, 14), look.topStyle === 'sweater' ? look.inner : mix(look.top, '#000000', 0.08), [0, len * 0.99, -0.005], [Math.PI / 2 + 0.25, 0, 0]));
  if (look.topStyle === 'tank') for (const side of [-1, 1]) parts.push(part(new BoxGeometry(sw * 0.16, len * 0.3, sw * 0.9), look.top, [side * sw * 0.5, len * 0.9, 0]));
  // Neck.
  parts.push(part(new CylinderGeometry(neckR, neckR * 1.1, 0.08 * H, 10), look.skin, [0, len + 0.03 * H, 0]));
  // Hips and belt line in the trousers.
  parts.push(part(new CapsuleGeometry(sw * 0.8, 0.04 * H, 4, 16), look.trousers, [0, -0.01 * H, 0], [0, 0, 0], [1, 1, depth * 0.95]));
  return merge(parts);
}

function buildLegs(look: CharacterLook, d: Dims, seated: boolean): BufferGeometry {
  const { H } = d;
  const rl = 0.038 * H * Math.max(0.9, look.build);
  const thigh = 0.245 * H;
  const shin = 0.235 * H;
  const shoe = '#2a221c';
  const parts: BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    const x = side * d.sw * 0.42;
    if (!seated) {
      parts.push(part(new CapsuleGeometry(rl, thigh + shin - rl, 3, 8), look.trousers, [x, d.hip - (thigh + shin) / 2, 0]));
      parts.push(part(new BoxGeometry(rl * 2, rl * 1.1, rl * 3.6), shoe, [x, rl * 0.55, -rl * 0.7]));
    } else {
      // Thighs forward along -Z from the seat, shins down to the deck.
      const seatY = d.hip;
      parts.push(part(new CapsuleGeometry(rl, thigh - rl, 3, 8), look.trousers, [x, seatY, -thigh / 2], [Math.PI / 2, 0, 0]));
      parts.push(part(new CapsuleGeometry(rl * 0.92, seatY - rl, 3, 8), look.trousers, [x, seatY / 2, -thigh]));
      parts.push(part(new BoxGeometry(rl * 2, rl * 1.1, rl * 3.6), shoe, [x, rl * 0.55, -thigh - rl * 0.7]));
    }
  }
  return merge(parts);
}

function buildFigure(c: CharacterDef, teamColour: string, seated: boolean): Figure {
  const look = c.look;
  const d = dims(look);
  // Seated: the hips at seat height (0.45 m) instead of standing hip height.
  const dd: Dims = seated ? { ...d, hip: 0.45 } : d;
  const mat = bodyMaterial();
  const root = new Group();
  const lean = new Group();
  root.add(lean);
  lean.add(new Mesh(buildLegs(look, dd, seated), mat));
  const torso = new Group();
  torso.position.y = dd.hip;
  lean.add(torso);
  torso.add(new Mesh(buildTorso(look, d), mat));
  const head = new Group();
  head.position.y = d.headY - d.hip;
  torso.add(head);
  head.add(new Mesh(buildHead(look, d, c.id, teamColour), mat));
  const armL = new Group();
  const armR = new Group();
  armL.position.set(-d.sw * 1.02, d.shoulder - d.hip - 0.02 * d.H, 0);
  armR.position.set(d.sw * 1.02, d.shoulder - d.hip - 0.02 * d.H, 0);
  armL.add(new Mesh(buildArm(look, d, teamColour), mat));
  armR.add(new Mesh(buildArm(look, d, teamColour), mat));
  torso.add(armL, armR);
  const fig: Figure = { root, lean, torso, head, armL, armR, face: null, seated, roll: 0, pitch: 0, vRoll: 0, vPitch: 0, hRoll: 0, hPitch: 0, vhRoll: 0, vhPitch: 0, phase: seeded(c.id)() * 10 };
  faceMaterial(c, (m) => {
    const face = new Mesh(facePatch(d.r), m);
    face.scale.set(0.92, 1.08, 1);
    face.renderOrder = 2;
    head.add(face);
    fig.face = face;
  });
  return fig;
}

// ---------------------------------------------------------------- props

function buildOar(): BufferGeometry {
  return merge([
    part(new CylinderGeometry(0.022, 0.03, 4.2, 6), '#6b4a2b', [0, -1.4, 0]),
    part(new BoxGeometry(0.03, 0.75, 0.16), '#5a3c22', [0, -3.4, 0]),
  ]);
}

function buildCannon(): BufferGeometry {
  return merge([
    part(new CylinderGeometry(0.05, 0.07, 0.75, 8), '#4a3a2c', [0, 0.37, 0]),
    // Muzzle (the narrow top of the cylinder) forward along -Z, a touch of elevation.
    part(new CylinderGeometry(0.07, 0.1, 0.9, 12), '#2a2a2e', [0, 0.82, -0.18], [-Math.PI / 2 + 0.08, 0, 0]),
    part(new SphereGeometry(0.11, 10, 8), '#2a2a2e', [0, 0.84, 0.25]),
  ]);
}

function buildBucket(): BufferGeometry {
  return merge([part(new CylinderGeometry(0.13, 0.1, 0.22, 12, 1, true), '#7a5a3a'), part(new CylinderGeometry(0.1, 0.1, 0.02, 12), '#5a3c22', [0, -0.11, 0])]);
}

let propGeo: { oar: BufferGeometry; cannon: BufferGeometry; bucket: BufferGeometry; stool: BufferGeometry } | null = null;
function props(): NonNullable<typeof propGeo> {
  propGeo ??= {
    oar: buildOar(),
    cannon: buildCannon(),
    bucket: buildBucket(),
    stool: merge([part(new BoxGeometry(0.5, 0.06, 0.4), '#6b4a2b', [0, 0.42, 0]), part(new BoxGeometry(0.42, 0.4, 0.06), '#5a3c22', [0, 0.2, 0])]),
  };
  return propGeo;
}

// ---------------------------------------------------------------- the crew of one boat

export interface CrewMember {
  role: Role;
  /** Person id from shared/characters.ts; null or unknown = a gondolier. */
  character: string | null;
}

export interface CrewFrame {
  /** Seconds since the last frame (clamped by the caller). */
  dt: number;
  /** Seconds, any monotonic clock. */
  time: number;
  /** Signed forward speed, m/s. */
  speed: number;
  /** Yaw rate, rad/s, positive = turning left. */
  angVel: number;
  gas: boolean;
  /** Cannon yaw relative to the hull, radians (positive = to the left). */
  aimRel: number;
  /** Water aboard 0..100: the Engineer bails while there is some. */
  water: number;
  sinking: boolean;
  celebrate: boolean;
}

function spring(x: number, v: number, target: number, freqHz: number, zeta: number, dt: number): [number, number] {
  const w = 2 * Math.PI * freqHz;
  // Semi-implicit Euler in small steps: stable at 60 fps and through frame hitches.
  const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
  const h = dt / steps;
  for (let i = 0; i < steps; i++) {
    v += (w * w * (target - x) - 2 * zeta * w * v) * h;
    x += v * h;
  }
  return [x, v];
}

export class CrewAvatars {
  readonly root = new Group();
  private key = '';
  private figures = new Map<Role, Figure>();
  private readonly turret = new Group();
  private readonly oar: Mesh;
  private readonly bucket: Mesh;
  private prevSpeed = 0;
  private accel = 0;

  constructor(private readonly teamColour: string) {
    const p = props();
    const mat = bodyMaterial();
    this.turret.position.copy(SEATS.gunnerPost);
    this.turret.add(new Mesh(p.cannon, mat));
    const stool = new Mesh(p.stool, mat);
    stool.position.z = 0.62;
    this.turret.add(stool);
    this.root.add(this.turret);
    const engStool = new Mesh(p.stool, mat);
    engStool.position.copy(SEATS.engineer);
    this.root.add(engStool);
    this.oar = new Mesh(p.oar, mat);
    this.bucket = new Mesh(p.bucket, mat);
  }

  /** Rebuilds the people aboard when the crew or their picks change; cheap to call every frame. */
  setCrew(members: readonly CrewMember[]): void {
    const key = members.map((m) => `${m.role}:${m.character ?? ''}`).join('|');
    if (key === this.key) return;
    this.key = key;
    for (const f of this.figures.values()) {
      f.root.removeFromParent();
      f.root.traverse((o) => {
        if (o instanceof Mesh && o.geometry !== props().oar && o.geometry !== props().bucket) o.geometry.dispose();
      });
    }
    this.figures.clear();
    for (const m of members) {
      const c = characterById(m.character) ?? GONDOLIER;
      const seated = m.role !== 'pilot';
      const fig = buildFigure(c, this.teamColour, seated);
      if (m.role === 'pilot') {
        fig.root.position.copy(SEATS.pilot);
        // The oar at the right hand, down into the water behind on the starboard side.
        fig.torso.add(this.oar);
        const d = dims(c.look);
        this.oar.position.set(d.sw * 1.35, d.shoulder - d.hip - 0.28 * d.H * 0.6, -0.28);
        this.root.add(fig.root);
      } else if (m.role === 'gunner') {
        fig.root.position.set(0, 0, 0.62);
        this.turret.add(fig.root);
      } else {
        fig.root.position.copy(SEATS.engineer);
        fig.armR.add(this.bucket);
        this.bucket.position.set(0, -0.32 * c.look.height, -0.05);
        this.root.add(fig.root);
      }
      this.figures.set(m.role, fig);
    }
  }

  update(f: CrewFrame): void {
    const dt = Math.min(0.1, Math.max(0, f.dt));
    if (dt === 0) return;
    // Forward acceleration, smoothed: the sim's speed moves in 60 Hz steps.
    const raw = (f.speed - this.prevSpeed) / dt;
    this.prevSpeed = f.speed;
    this.accel += (raw - this.accel) * Math.min(1, dt / 0.12);
    // In a left turn (angVel > 0) the crew is thrown to starboard (+X): roll negative.
    const lateral = f.speed * f.angVel;
    const fast = Math.min(1, Math.abs(f.speed) / 10);
    const bobAmp = SWAY.bobRest + (SWAY.bobFast - SWAY.bobRest) * fast;
    this.turret.rotation.y = f.aimRel;

    for (const [role, fig] of this.figures) {
      const k = fig.seated ? SWAY.seatedScale : 1;
      const t = f.time + fig.phase;
      const bobRoll = Math.sin(t * 1.7) * bobAmp + Math.sin(t * 2.9) * bobAmp * 0.4;
      const bobPitch = Math.sin(t * 1.3 + 1) * bobAmp * 0.6;
      const clamp = (v: number): number => Math.max(-SWAY.maxLean, Math.min(SWAY.maxLean, v));
      const targetRoll = clamp(-lateral * SWAY.rollPerAccel * k) + bobRoll;
      const targetPitch = clamp(this.accel * SWAY.pitchPerAccel * k) + bobPitch;
      [fig.roll, fig.vRoll] = spring(fig.roll, fig.vRoll, targetRoll, SWAY.freqHz, SWAY.damping, dt);
      [fig.pitch, fig.vPitch] = spring(fig.pitch, fig.vPitch, targetPitch, SWAY.freqHz, SWAY.damping, dt);
      // The head lags the body a little and settles quicker.
      [fig.hRoll, fig.vhRoll] = spring(fig.hRoll, fig.vhRoll, -fig.roll * 0.6, SWAY.headFreqHz, SWAY.headDamping, dt);
      [fig.hPitch, fig.vhPitch] = spring(fig.hPitch, fig.vhPitch, -fig.pitch * 0.5, SWAY.headFreqHz, SWAY.headDamping, dt);
      fig.lean.rotation.set(fig.pitch, 0, fig.roll);
      fig.head.rotation.set(fig.hPitch, 0, fig.hRoll);

      if (f.sinking) {
        // Arms up, waving, as the boat goes down.
        const w = f.time * 9;
        fig.armL.rotation.set(0, 0, -2.6 + Math.sin(w) * 0.4);
        fig.armR.rotation.set(0, 0, 2.6 + Math.cos(w) * 0.4);
        fig.torso.rotation.set(Math.sin(w * 0.5) * 0.15, 0, 0);
        continue;
      }
      if (f.celebrate) {
        const w = f.time * 6 + fig.phase;
        fig.armL.rotation.set(0, 0, -2.7 + Math.sin(w) * 0.25);
        fig.armR.rotation.set(0, 0, 2.7 + Math.cos(w) * 0.25);
        fig.root.position.y = Math.max(0, Math.sin(w)) * (fig.seated ? 0.08 : 0.18);
        fig.torso.rotation.set(0, 0, 0);
        continue;
      }
      fig.root.position.y = 0;
      if (role === 'pilot') this.row(fig, f, t);
      else if (role === 'gunner') {
        // Both hands on the cannon's grips in front (+x swings an arm forward).
        fig.armL.rotation.set(1.2, 0, 0.18);
        fig.armR.rotation.set(1.2, 0, -0.18);
        fig.torso.rotation.set(-0.12 + Math.sin(t * 1.1) * 0.02, 0, 0);
      } else this.bail(fig, f, t);
    }
  }

  /** Pilot: the gondolier's stroke, faster on GAS, a slow paddle when coasting. */
  private row(fig: Figure, f: CrewFrame, t: number): void {
    const hz = f.gas ? 1.1 : Math.abs(f.speed) > 0.5 ? 0.6 : 0.3;
    const s = Math.sin(t * hz * Math.PI * 2);
    // Torso pitch: negative leans forward. Arms: positive x reaches forward. The oar's blade
    // end (-Y) points down, back (+Z) and out to starboard (+X), and sweeps with the stroke.
    fig.torso.rotation.set(-0.16 - s * 0.14, -0.25, 0);
    fig.armR.rotation.set(0.75 + s * 0.4, 0, -0.2);
    fig.armL.rotation.set(0.95 + s * 0.4, 0, 0.5);
    this.oar.rotation.set(-0.45 + s * 0.3, 0, 0.38);
  }

  /** Engineer: scoops and throws over the side while there is water aboard, else sits. */
  private bail(fig: Figure, f: CrewFrame, t: number): void {
    if (f.water > 0.5) {
      const b = Math.sin(t * 2.4 * Math.PI * 2);
      fig.torso.rotation.set(-0.25 - b * 0.2, 0, -0.1);
      fig.armR.rotation.set(0.5 + b * 0.9, 0, -0.35);
      fig.armL.rotation.set(0.35, 0, 0.15);
      this.bucket.rotation.x = Math.max(0, b) * 1.4;
    } else {
      fig.torso.rotation.set(Math.sin(t * 0.9) * 0.03, 0, 0);
      fig.armR.rotation.set(0.3, 0, -0.08);
      fig.armL.rotation.set(0.3, 0, 0.08);
      this.bucket.rotation.x = 0;
    }
  }

  dispose(): void {
    this.setCrew([]);
  }
}
