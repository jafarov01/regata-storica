/**
 * Who am I? Phones keep a random token in localStorage; the same token rejoins the same slot.
 * The scene keeps its room code + scene token in sessionStorage so a reload re-claims the room.
 * Storage access is wrapped: Safari private mode and some kiosk setups throw on localStorage.
 */

const PLAYER_TOKEN_KEY = 'gr.playerToken';
const PLAYER_NAME_KEY = 'gr.playerName';
const SCENE_SESSION_KEY = 'gr.scene';

/**
 * crypto.randomUUID() exists only in secure contexts (MDN); a LAN http:// test page has none.
 * getRandomValues works everywhere, so build a v4 UUID by hand as the fallback.
 */
export function newUuid(): string {
  const c = globalThis.crypto;
  if (typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function read(storage: Storage | undefined, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(storage: Storage | undefined, key: string, value: string | null): void {
  try {
    if (value === null) storage?.removeItem(key);
    else storage?.setItem(key, value);
  } catch {
    /* private mode or quota: the session simply will not survive a reload */
  }
}

function local(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function session(): Storage | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

/** Stable per phone/browser profile. Created once, then reused for every room. */
export function getPlayerToken(): string {
  const existing = read(local(), PLAYER_TOKEN_KEY);
  if (existing && existing.length >= 8 && existing.length <= 64) return existing;
  const token = newUuid();
  write(local(), PLAYER_TOKEN_KEY, token);
  return token;
}

const NICKNAMES = ['Bepi', 'Nane', 'Toni', 'Gigio', 'Momi', 'Checo', 'Lele', 'Zane', 'Piero', 'Nico', 'Bortolo', 'Meneghina', 'Marieta', 'Catina', 'Gigia', 'Nina'];

/** A random Venetian nickname on first visit; the player's last edit afterwards. */
export function getPlayerName(): string {
  const saved = read(local(), PLAYER_NAME_KEY);
  if (saved && saved.trim().length > 0) return saved;
  const name = NICKNAMES[Math.floor(Math.random() * NICKNAMES.length)] ?? 'Gondoliere';
  write(local(), PLAYER_NAME_KEY, name);
  return name;
}

export function setPlayerName(name: string): void {
  write(local(), PLAYER_NAME_KEY, name);
}

export interface SceneSession {
  code: string;
  sceneToken: string;
}

export function loadSceneSession(): SceneSession | null {
  const raw = read(session(), SCENE_SESSION_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { code?: unknown }).code === 'string' &&
      typeof (parsed as { sceneToken?: unknown }).sceneToken === 'string'
    ) {
      return parsed as SceneSession;
    }
  } catch {
    /* corrupt value: start fresh */
  }
  return null;
}

export function saveSceneSession(s: SceneSession | null): void {
  write(session(), SCENE_SESSION_KEY, s === null ? null : JSON.stringify(s));
}
