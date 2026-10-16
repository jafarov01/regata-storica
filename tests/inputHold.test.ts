/**
 * Scene-side input hold (src/net/inputHold.ts): sequence filtering and the tap counters that
 * turn running totals (`fc`, `uc`) back into taps exactly once.
 */
import { describe, expect, it } from 'vitest';
import type { GunnerIn } from '@shared/protocol.ts';
import { AimTracker, InputHold, counterTapped } from '../src/net/inputHold.ts';
import { itemLabel } from '../src/phone/screens.ts';

let seq = 1;
const gun = (fc: number, uc = 0, use: 0 | 1 | null = null): GunnerIn => ({ t: 'in', seq: seq++, role: 'gunner', dYaw: 0, yaw: 0, ep: 0, fire: false, fc, recenter: false, use, uc });

describe('tap counters', () => {
  it('a fresh phone: 0 is nothing, 1 is its first tap, every rise is one tap', () => {
    const a = new AimTracker();
    expect(a.takeFireTap(gun(0))).toBe(false);
    expect(a.takeFireTap(gun(1))).toBe(true);
    expect(a.takeFireTap(gun(1))).toBe(false); // same packet held for several sim steps
    expect(a.takeFireTap(gun(3))).toBe(true); // a lost packet still gives a tap
    const b = new AimTracker();
    expect(b.takeFireTap(gun(1))).toBe(true);
  });

  it('a scene reload mid-match does not fire a phantom shot or power from a running counter', () => {
    const a = new AimTracker();
    expect(a.takeFireTap(gun(7))).toBe(false);
    expect(a.takeFireTap(gun(7))).toBe(false);
    expect(a.takeFireTap(gun(8))).toBe(true);
    const e = new AimTracker();
    expect(e.takeUse(4, 1)).toBeNull();
    expect(e.takeUse(5, 0)).toBe(0);
    expect(e.takeUse(5, 0)).toBeNull();
  });

  it('a phone that reloaded restarts at 0: new baseline, then taps count again', () => {
    expect(counterTapped(-1, 0)).toBe(false);
    expect(counterTapped(5, 0)).toBe(false);
    const a = new AimTracker();
    a.takeFireTap(gun(0));
    a.takeFireTap(gun(5));
    expect(a.takeFireTap(gun(0))).toBe(false);
    expect(a.takeFireTap(gun(1))).toBe(true);
  });

  it('a power tap needs a slot: use null never applies', () => {
    const e = new AimTracker();
    expect(e.takeUse(0, null)).toBeNull();
    expect(e.takeUse(1, null)).toBeNull();
    expect(e.takeUse(2, 1)).toBe(1);
  });
});

describe('input hold', () => {
  it('drops late packets, accepts a restarted phone, flags silence', () => {
    let now = 0;
    const hold = new InputHold(() => now);
    expect(hold.offer('p1', { ...gun(0), seq: 5000 })).toBe(true);
    expect(hold.offer('p1', { ...gun(0), seq: 4999 })).toBe(false);
    expect(hold.offer('p1', { ...gun(0), seq: 3 })).toBe(true); // jumped back by > seqResetGap: reload
    now = 2000;
    expect(hold.read('p1')?.dropped).toBe(true);
    expect(hold.droppedPids()).toEqual(['p1']);
  });
});

describe('phone cue labels', () => {
  it('weapon and power ids read like the pads, anything else in capitals', () => {
    expect(itemLabel('cannon')).toBe('CANNON');
    expect(itemLabel('shield')).toBe('SHIELD');
    expect(itemLabel('Mortar shells')).toBe('MORTAR SHELLS');
  });
});
