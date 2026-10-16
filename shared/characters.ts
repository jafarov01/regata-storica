/**
 * shared/characters.ts: the people players can be. One per player in a room (the gondolier is
 * the exception: anyone can be one, and bots always are).
 *
 * The 14 players of the Via Falchi retreat (15-18 October 2026), from the "Select your player"
 * cards of the event site; their cartoon portraits live in public/assets/players/<id>.jpg
 * (512 px, the 3D face) and <id>-256.jpg (the phone picker). `look` is what the 3D avatar is
 * built from (src/render/avatars.ts), read off each portrait; `face` is where the face sits in
 * the portrait, as fractions of its width, for the face decal on the avatar's head.
 */

export type HairStyle = 'short' | 'fade' | 'curly' | 'ponytail' | 'long-straight' | 'long-wavy' | 'long-curly';
export type Beard = 'none' | 'stubble' | 'goatee' | 'short' | 'full';
export type Glasses = 'none' | 'round' | 'rect';
export type TopStyle = 'tee' | 'polo' | 'shirt' | 'turtleneck' | 'tank' | 'sweater' | 'blazer' | 'jacket' | 'stripes';
export type Hat = 'none' | 'cap' | 'straw';

export interface CharacterLook {
  skin: string;
  hair: string;
  hairStyle: HairStyle;
  beard: Beard;
  glasses: Glasses;
  top: string;
  topStyle: TopStyle;
  /** The shirt or collar under a blazer, sweater or jacket. */
  inner: string;
  trousers: string;
  hat: Hat;
  hatColour: string;
  /** Standing height in metres. */
  height: number;
  /** Shoulder width, 1 = average. */
  build: number;
}

export interface CharacterDef {
  id: string;
  name: string;
  /** What the game calls the player once picked. */
  short: string;
  look: CharacterLook;
  /** Face centre and width in the portrait, 0..1. */
  face: { cx: number; cy: number; w: number };
}

const base: Omit<CharacterLook, 'skin' | 'hair' | 'hairStyle' | 'top' | 'topStyle'> = {
  beard: 'none',
  glasses: 'none',
  inner: '#f4f2ec',
  trousers: '#2e323b',
  hat: 'none',
  hatColour: '#2f62a8',
  height: 1.78,
  build: 1,
};

export const GONDOLIER_ID = 'gondolier';

export const CHARACTERS: readonly CharacterDef[] = [
  {
    id: 'ennio-guzman',
    name: 'Ennio Guzman',
    short: 'Ennio',
    look: { ...base, skin: '#e9c3a0', hair: '#3a281e', hairStyle: 'short', beard: 'goatee', top: '#f1efe8', topStyle: 'turtleneck', trousers: '#2b2f38' },
    face: { cx: 0.51, cy: 0.52, w: 0.38 },
  },
  {
    id: 'justin-simon',
    name: 'Justin Simon',
    short: 'Justin',
    look: { ...base, skin: '#d9aa86', hair: '#2d1f18', hairStyle: 'curly', beard: 'short', top: '#1f2a44', topStyle: 'blazer', inner: '#f6f5f1', trousers: '#2a3142' },
    face: { cx: 0.49, cy: 0.46, w: 0.36 },
  },
  {
    id: 'makhlug-jafarov',
    name: 'Makhlug Jafarov',
    short: 'Makhlug',
    look: { ...base, skin: '#e2b794', hair: '#2b1e17', hairStyle: 'short', beard: 'stubble', top: '#1e2a46', topStyle: 'sweater', inner: '#f4f4f0' },
    face: { cx: 0.5, cy: 0.48, w: 0.39 },
  },
  {
    id: 'natalia-jurado-santiago',
    name: 'Natalia Jurado Santiago',
    short: 'Natalia',
    look: { ...base, skin: '#efc8a9', hair: '#4a2c1c', hairStyle: 'long-wavy', top: '#1c1c21', topStyle: 'blazer', inner: '#26262c', trousers: '#1c1c21', height: 1.66, build: 0.86 },
    face: { cx: 0.49, cy: 0.34, w: 0.31 },
  },
  {
    id: 'quentin-tristan',
    name: 'Quentin Tristan',
    short: 'Quentin',
    look: { ...base, skin: '#ecc5a5', hair: '#33251d', hairStyle: 'fade', top: '#1b1d22', topStyle: 'polo', inner: '#1b1d22', trousers: '#3b4150' },
    face: { cx: 0.6, cy: 0.42, w: 0.35 },
  },
  {
    id: 'jinlong-yu',
    name: 'Jinlong Yu',
    short: 'Jinlong',
    look: { ...base, skin: '#e8c39b', hair: '#141211', hairStyle: 'short', glasses: 'round', top: '#243553', topStyle: 'jacket', inner: '#2f5d8a', height: 1.75 },
    face: { cx: 0.51, cy: 0.5, w: 0.43 },
  },
  {
    id: 'remo-marconzini',
    name: 'Remo Marconzini',
    short: 'Remo',
    look: { ...base, skin: '#f0cfb2', hair: '#8b5b3a', hairStyle: 'short', glasses: 'rect', top: '#1b1b1f', topStyle: 'sweater', inner: '#f4f4f0', trousers: '#3a3d45', height: 1.84 },
    face: { cx: 0.5, cy: 0.38, w: 0.37 },
  },
  {
    id: 'oriana-angelucci',
    name: 'Oriana Angelucci',
    short: 'Oriana',
    look: { ...base, skin: '#e2b28a', hair: '#2a1a13', hairStyle: 'long-curly', top: '#f3f0e8', topStyle: 'tank', trousers: '#c8b597', height: 1.64, build: 0.84 },
    face: { cx: 0.52, cy: 0.36, w: 0.35 },
  },
  {
    id: 'jashan-chittesh',
    name: 'Jashan Chittesh',
    short: 'Jashan',
    look: { ...base, skin: '#f0c8a6', hair: '#8f8a84', hairStyle: 'short', beard: 'stubble', glasses: 'rect', top: '#e4e4df', topStyle: 'tee', trousers: '#3a3d45', hat: 'cap', hatColour: '#2f62a8' },
    face: { cx: 0.53, cy: 0.56, w: 0.44 },
  },
  {
    id: 'silvia-facco',
    name: 'Silvia Facco',
    short: 'Silvia',
    look: { ...base, skin: '#f1ccaf', hair: '#3a2318', hairStyle: 'long-straight', top: '#f6f4ef', topStyle: 'shirt', trousers: '#2c3346', height: 1.67, build: 0.85 },
    face: { cx: 0.5, cy: 0.32, w: 0.29 },
  },
  {
    id: 'juan-carlos-rosito',
    name: 'Juan Carlos Rosito',
    short: 'Juan Carlos',
    look: { ...base, skin: '#c99770', hair: '#291c15', hairStyle: 'ponytail', beard: 'short', top: '#b8bbbf', topStyle: 'tee', trousers: '#2b2f38', build: 1.06 },
    face: { cx: 0.52, cy: 0.45, w: 0.41 },
  },
  {
    id: 'simon-moreau',
    name: 'Simon Moreau',
    short: 'Simon',
    look: { ...base, skin: '#dbad89', hair: '#1f1713', hairStyle: 'curly', beard: 'full', glasses: 'round', top: '#eee8da', topStyle: 'tee', trousers: '#3a3d45', build: 1.08 },
    face: { cx: 0.52, cy: 0.48, w: 0.41 },
  },
  {
    id: 'eugenio-andreose',
    name: 'Eugenio Andreose',
    short: 'Eugenio',
    look: { ...base, skin: '#efc7a7', hair: '#382820', hairStyle: 'short', glasses: 'rect', top: '#f4f4f0', topStyle: 'polo', inner: '#f4f4f0', trousers: '#2c3346' },
    face: { cx: 0.51, cy: 0.43, w: 0.38 },
  },
  {
    id: 'giovanni-andreose',
    name: 'Giovanni Andreose',
    short: 'Giovanni',
    look: { ...base, skin: '#e6be9c', hair: '#3a271b', hairStyle: 'short', beard: 'short', top: '#1f2533', topStyle: 'tee', trousers: '#3a3d45' },
    face: { cx: 0.49, cy: 0.46, w: 0.41 },
  },
];

/** The classic crew member: striped shirt and a straw hat (the team colour goes on the ribbon). */
export const GONDOLIER: CharacterDef = {
  id: GONDOLIER_ID,
  name: 'Gondolier',
  short: 'Gondolier',
  look: { ...base, skin: '#e3b48f', hair: '#3b2a20', hairStyle: 'short', top: '#1f2a44', topStyle: 'stripes', trousers: '#1f2533', hat: 'straw', hatColour: '#e6d28a' },
  face: { cx: 0.5, cy: 0.5, w: 0.4 },
};

const BY_ID = new Map<string, CharacterDef>([...CHARACTERS, GONDOLIER].map((c) => [c.id, c]));

export function characterById(id: string | null | undefined): CharacterDef | null {
  return id ? (BY_ID.get(id) ?? null) : null;
}

export function isCharacterId(id: unknown): id is string {
  return typeof id === 'string' && BY_ID.has(id);
}

/** Portrait URLs (same origin, under public/). The gondolier has none. */
export function portraitUrl(id: string, size: 256 | 512 = 512): string | null {
  if (!BY_ID.has(id) || id === GONDOLIER_ID) return null;
  return size === 256 ? `/assets/players/${id}-256.jpg` : `/assets/players/${id}.jpg`;
}
