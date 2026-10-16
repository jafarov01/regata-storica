// src/phone/pads.ts
// Multi-touch pads with pointer events. The root element owns every listener; zones are
// child elements with a data-zone attribute (gas, brake, fire, recenter, calibrate,
// power0, power1). A pointer belongs to the zone it went down on until it is released,
// so a thumb sliding across the middle does not flip GAS into BRAKE.
//
// Pair with pads.css (touch-action: none, user-select: none, -webkit-touch-callout: none,
// 100dvh, safe-area padding, overscroll-behavior: none).

export type PadZone = 'gas' | 'brake' | 'fire' | 'recenter' | 'calibrate' | 'power0' | 'power1';

const ZONES: ReadonlySet<string> = new Set<PadZone>(['gas', 'brake', 'fire', 'recenter', 'calibrate', 'power0', 'power1']);

function isPadZone(v: string | undefined): v is PadZone {
  return v !== undefined && ZONES.has(v);
}

export interface PadsView {
  isHeld(zone: PadZone): boolean;
  /** Pointerdown edges since the last call, in order. */
  drainTaps(): PadZone[];
}

const preventDefault = (e: Event): void => {
  e.preventDefault();
};

export class Pads implements PadsView {
  private readonly pointers = new Map<number, PadZone>();
  private readonly held = new Map<PadZone, number>();
  private taps: PadZone[] = [];
  private readonly onChange: ((zone: PadZone, down: boolean) => void) | undefined;

  constructor(
    private readonly root: HTMLElement,
    onChange?: (zone: PadZone, down: boolean) => void,
  ) {
    this.onChange = onChange;
    root.addEventListener('pointerdown', this.onPointerDown);
    root.addEventListener('pointerup', this.onPointerEnd);
    root.addEventListener('pointercancel', this.onPointerEnd);
    // Mouse on the desktop: capture so a release outside the pad still counts.
    root.addEventListener('lostpointercapture', this.onPointerEnd);
    // iOS Safari: stop double-tap zoom, the long-press callout and the synthetic click.
    // touch-action: none alone does not stop double-tap zoom on positioned elements (WebKit bug 218015).
    root.addEventListener('touchstart', preventDefault, { passive: false });
    root.addEventListener('touchmove', preventDefault, { passive: false });
    root.addEventListener('touchend', preventDefault, { passive: false });
    // iOS pinch: gesture events are WebKit-only and not in lib.dom, so the string overload is used.
    root.addEventListener('gesturestart', preventDefault);
    root.addEventListener('contextmenu', preventDefault);
    window.addEventListener('blur', this.releaseAll);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  isHeld(zone: PadZone): boolean {
    return (this.held.get(zone) ?? 0) > 0;
  }

  drainTaps(): PadZone[] {
    const out = this.taps;
    this.taps = [];
    return out;
  }

  dispose(): void {
    this.releaseAll();
    this.root.removeEventListener('pointerdown', this.onPointerDown);
    this.root.removeEventListener('pointerup', this.onPointerEnd);
    this.root.removeEventListener('pointercancel', this.onPointerEnd);
    this.root.removeEventListener('lostpointercapture', this.onPointerEnd);
    this.root.removeEventListener('touchstart', preventDefault);
    this.root.removeEventListener('touchmove', preventDefault);
    this.root.removeEventListener('touchend', preventDefault);
    this.root.removeEventListener('gesturestart', preventDefault);
    this.root.removeEventListener('contextmenu', preventDefault);
    window.removeEventListener('blur', this.releaseAll);
    document.removeEventListener('visibilitychange', this.onVisibility);
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const target = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-zone]') : null;
    const zone = target?.dataset['zone'];
    if (!isPadZone(zone)) return;
    e.preventDefault();
    if (e.pointerType === 'mouse') {
      try {
        this.root.setPointerCapture(e.pointerId);
      } catch {
        // Not capturable (already released); the up event still reaches the root.
      }
    }
    this.pointers.set(e.pointerId, zone);
    this.held.set(zone, (this.held.get(zone) ?? 0) + 1);
    this.taps.push(zone);
    if (this.held.get(zone) === 1) this.onChange?.(zone, true);
  };

  private readonly onPointerEnd = (e: PointerEvent): void => {
    this.release(e.pointerId);
  };

  private readonly onVisibility = (): void => {
    if (document.visibilityState !== 'visible') this.releaseAll();
  };

  private readonly releaseAll = (): void => {
    for (const id of [...this.pointers.keys()]) this.release(id);
  };

  private release(pointerId: number): void {
    const zone = this.pointers.get(pointerId);
    if (zone === undefined) return;
    this.pointers.delete(pointerId);
    const n = (this.held.get(zone) ?? 1) - 1;
    this.held.set(zone, Math.max(0, n));
    if (n <= 0) this.onChange?.(zone, false);
  }
}

/**
 * Builds the zone layout for a role. Returns the root; the caller adds it to the page.
 * `gunnerHasPowers`: teams of 2, the Gunner also gets the two power buttons (spec section 2).
 */
export function buildPadLayout(role: 'pilot' | 'gunner' | 'engineer', gunnerHasPowers = false): HTMLElement {
  const root = document.createElement('div');
  root.className = `pads pads-${role}`;
  const zone = (name: PadZone, label: string, extraClass = ''): HTMLElement => {
    const el = document.createElement('div');
    el.className = `zone zone-${name} ${extraClass}`.trim();
    el.dataset['zone'] = name;
    el.textContent = label;
    return el;
  };
  switch (role) {
    case 'pilot':
      root.append(zone('brake', 'BRAKE'), zone('gas', 'GAS'));
      root.append(zone('calibrate', 'CALIBRATE', 'small'));
      break;
    case 'gunner':
      root.append(zone('recenter', 'RECENTER'), zone('fire', 'FIRE'));
      root.append(zone('calibrate', 'CALIBRATE', 'small'));
      if (gunnerHasPowers) root.append(zone('power0', 'P1', 'small power-a'), zone('power1', 'P2', 'small power-b'));
      break;
    case 'engineer':
      root.append(zone('power0', 'POWER 1'), zone('power1', 'POWER 2'));
      break;
  }
  return root;
}
