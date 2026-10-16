// src/phone/wake.ts
// Screen wake lock, fullscreen / orientation lock attempts, the rotate-your-phone
// detector and haptics (vibration on Android, red flash on iOS).

// ---------------------------------------------------------------- wake lock

export class WakeLockKeeper {
  private sentinel: WakeLockSentinel | null = null;
  private wanted = false;

  constructor(private readonly onState?: (held: boolean) => void) {
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('pageshow', this.onVisibility);
  }

  /** navigator.wakeLock exists on Chrome 84+ and Safari 16.4+ (full on iOS 18.4+). */
  static supported(): boolean {
    return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
  }

  /** Resolves true when the lock is held. Safe to call outside a gesture. */
  async request(): Promise<boolean> {
    this.wanted = true;
    if (!WakeLockKeeper.supported()) return false;
    if (this.sentinel !== null && !this.sentinel.released) return true;
    try {
      const s = await navigator.wakeLock.request('screen');
      this.sentinel = s;
      s.addEventListener('release', () => {
        if (this.sentinel === s) this.sentinel = null;
        this.onState?.(false);
      });
      this.onState?.(true);
      return true;
    } catch {
      // Low battery, hidden document, or the request was refused.
      this.onState?.(false);
      return false;
    }
  }

  async release(): Promise<void> {
    this.wanted = false;
    const s = this.sentinel;
    this.sentinel = null;
    if (s !== null && !s.released) await s.release();
  }

  dispose(): void {
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('pageshow', this.onVisibility);
    void this.release();
  }

  /** The browser drops the lock whenever the page is hidden (screen lock, app switch, bfcache); re-request on return. */
  private readonly onVisibility = (): void => {
    if (this.wanted && document.visibilityState === 'visible') void this.request();
  };
}

// ---------------------------------------------------------------- fullscreen + orientation lock

/** lib.dom (TS 5.9) declares unlock() but not lock(); Safari does not implement lock(). */
interface OrientationLockApi {
  lock?: (orientation: 'landscape' | 'portrait' | 'natural' | 'any') => Promise<void>;
}

/**
 * Android Chrome: fullscreen hides the URL bar and allows screen.orientation.lock().
 * iPhone Safari: element fullscreen is not implemented and lock() does not exist, so
 * this resolves false and the rotate-your-phone overlay does the job. Call inside the tap.
 */
export async function requestFullscreenLandscape(): Promise<boolean> {
  const el = document.documentElement;
  if (typeof el.requestFullscreen !== 'function') return false;
  try {
    await el.requestFullscreen({ navigationUI: 'hide' });
  } catch {
    return false;
  }
  const so = screen.orientation as ScreenOrientation & OrientationLockApi;
  if (typeof so.lock === 'function') {
    try {
      await so.lock('landscape');
    } catch {
      // Not allowed (desktop, or not in fullscreen): fine, the overlay covers it.
    }
  }
  return true;
}

// ---------------------------------------------------------------- orientation detection

export interface OrientationInfo {
  readonly landscape: boolean;
  /** 'landscape-primary' etc. when the browser says, else null (iOS before 16.4). */
  readonly type: OrientationType | null;
}

export function readOrientation(): OrientationInfo {
  const type = typeof screen !== 'undefined' && screen.orientation ? screen.orientation.type : null;
  if (type !== null) return { landscape: type.startsWith('landscape'), type };
  // matchMedia works everywhere; it flips briefly when the keyboard shrinks the viewport.
  return { landscape: matchMedia('(orientation: landscape)').matches, type: null };
}

/** Calls back on every orientation change and once immediately. Returns the unsubscribe. */
export function watchOrientation(cb: (info: OrientationInfo) => void): () => void {
  const fire = (): void => cb(readOrientation());
  const mql = matchMedia('(orientation: landscape)');
  mql.addEventListener('change', fire);
  const so = typeof screen !== 'undefined' ? screen.orientation : undefined;
  so?.addEventListener('change', fire);
  window.addEventListener('resize', fire);
  fire();
  return () => {
    mql.removeEventListener('change', fire);
    so?.removeEventListener('change', fire);
    window.removeEventListener('resize', fire);
  };
}

// ---------------------------------------------------------------- haptics

export type HapticKind = 'fire' | 'hit';

const PATTERNS: Record<HapticKind, number | number[]> = { fire: 25, hit: [60, 40, 90] };
/** Flash class per cue: a hit is a strong red, a shot only a short soft red so it does not read as damage. */
const FLASH_CLASS: Record<HapticKind, string> = { fire: 'flash-red-soft', hit: 'flash-red' };
const FLASH_MS: Record<HapticKind, number> = { fire: 120, hit: 260 };

/**
 * Android: navigator.vibrate (needs a prior user gesture, which Enable controls gave us).
 * iOS: no Vibration API, so flash the given element red instead (the spec's fallback).
 * `flashEl` should be a full-screen overlay above every other layer (pointer-events: none):
 * an inset shadow on the page root is hidden by the pads and the sunk screen.
 */
export function haptic(kind: HapticKind, flashEl: HTMLElement | null): void {
  let vibrated = false;
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    try {
      vibrated = navigator.vibrate(PATTERNS[kind]);
    } catch {
      vibrated = false;
    }
  }
  if (!vibrated && flashEl !== null) flash(flashEl, FLASH_CLASS[kind], FLASH_MS[kind]);
}

const flashTimers = new WeakMap<HTMLElement, number>();

/** Restarts the animation on every call, so two hits in a row flash twice instead of once. */
export function flash(el: HTMLElement, cls: string, ms: number): void {
  const pending = flashTimers.get(el);
  if (pending !== undefined) window.clearTimeout(pending);
  el.classList.remove('flash-red', 'flash-red-soft', 'flash-gold');
  void el.offsetWidth; // force a style flush so the re-added class restarts the animation
  el.classList.add(cls);
  flashTimers.set(
    el,
    window.setTimeout(() => {
      el.classList.remove(cls);
      flashTimers.delete(el);
    }, ms),
  );
}
