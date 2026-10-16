/**
 * Scene-side input hold: the last packet per player, staleness, sequence filtering, and the
 * gunner aim re-basing that makes `yaw` + `ep` robust to dropped packets.
 *
 * The sim calls `offer()` from the socket handler and `read()` once per fixed step.
 */
import { NET, type GunnerIn, type InputMsg } from '@shared/protocol.ts';

export interface HeldInput {
  input: InputMsg;
  /** ms since the packet arrived */
  ageMs: number;
  /** true when no packet for NET.inputStaleMs: the HUD shows "phone dropped", the sim coasts. */
  dropped: boolean;
}

interface Slot {
  input: InputMsg;
  at: number;
  seq: number;
}

export class InputHold {
  private readonly slots = new Map<string, Slot>();

  constructor(private readonly now: () => number = () => performance.now()) {}

  /** Returns false for stale/out-of-order packets (seq not above the last applied one). */
  offer(pid: string, input: InputMsg): boolean {
    const slot = this.slots.get(pid);
    if (slot) {
      const reset = input.seq < slot.seq - NET.seqResetGap; // phone reloaded: its counter restarted
      if (!reset && input.seq <= slot.seq) return false;
      slot.input = input;
      slot.at = this.now();
      slot.seq = input.seq;
      return true;
    }
    this.slots.set(pid, { input, at: this.now(), seq: input.seq });
    return true;
  }

  read(pid: string): HeldInput | null {
    const slot = this.slots.get(pid);
    if (!slot) return null;
    const ageMs = this.now() - slot.at;
    return { input: slot.input, ageMs, dropped: ageMs > NET.inputStaleMs };
  }

  forget(pid: string): void {
    this.slots.delete(pid);
  }

  /** Every player whose phone is silent (for the HUD "phone dropped" badge). */
  droppedPids(): string[] {
    const t = this.now();
    const out: string[] = [];
    for (const [pid, s] of this.slots) if (t - s.at > NET.inputStaleMs) out.push(pid);
    return out;
  }
}

/**
 * World-space aim from gunner packets.
 *   aim = base + yaw, where base is set when the epoch changes (calibrate/recenter) or on respawn
 *   so that the aim lands behind the bow at that instant. The accumulated `yaw` is absolute, so a
 *   lost packet costs nothing; `dYaw` is only used as a turn-rate hint for aim assist.
 */
export class AimTracker {
  private base = 0;
  /** Bow-relative mode: offset such that rel + yaw is the aim's angle from the bow. */
  private rel = 0;
  private ep = -1;
  /** -1 until the first packet: a counter is only a tap relative to one we have already seen. */
  private lastFc = -1;
  private lastUc = -1;
  private lastSeq = -1;

  /**
   * Returns world aim in radians. `bowHeading` is the boat's current heading (world yaw).
   * `gain` < 1 slows the aim while an enemy is under the crosshair (AIM.gainUnderCrosshair):
   * each new packet's dYaw is scaled by re-basing, so the absolute `yaw` stays authoritative.
   * Safe to call every sim step with the same held packet: each packet is counted once.
   */
  apply(pkt: GunnerIn, bowHeading: number, gain = 1): number {
    if (pkt.ep !== this.ep) {
      this.ep = pkt.ep;
      this.base = bowHeading - pkt.yaw;
    } else if (pkt.seq !== this.lastSeq && gain < 1) {
      this.base -= (1 - gain) * pkt.dYaw;
    }
    this.lastSeq = pkt.seq;
    return this.base + pkt.yaw;
  }

  /**
   * Bow-relative aim (AIM.followBow): the offset of the aim from the bow, in radians, from the
   * same packets. Zero at every recenter/calibrate (new epoch) and after resetBehindBow; the
   * under-crosshair gain shaves each new packet's dYaw as in apply(). The caller adds the bow.
   */
  applyRelative(pkt: GunnerIn, gain = 1): number {
    if (pkt.ep !== this.ep) {
      this.ep = pkt.ep;
      this.rel = -pkt.yaw;
    } else if (pkt.seq !== this.lastSeq && gain < 1) {
      this.rel -= (1 - gain) * pkt.dYaw;
    }
    this.lastSeq = pkt.seq;
    return this.rel + pkt.yaw;
  }

  /** Call on respawn (the spec resets the view behind the bow). */
  resetBehindBow(pkt: GunnerIn | null, bowHeading: number): void {
    this.base = bowHeading - (pkt?.yaw ?? 0);
    this.rel = -(pkt?.yaw ?? 0);
    if (pkt) this.ep = pkt.ep;
  }

  /** True once per fire tap even if the packet carrying `fire: true` was lost. */
  takeFireTap(pkt: GunnerIn): boolean {
    const last = this.lastFc;
    this.lastFc = pkt.fc;
    return counterTapped(last, pkt.fc);
  }

  /** Engineer power use, applied exactly once per tap. */
  takeUse(uc: number, use: 0 | 1 | null): 0 | 1 | null {
    const last = this.lastUc;
    this.lastUc = uc;
    return use !== null && counterTapped(last, uc) ? use : null;
  }
}

/**
 * Did a running tap counter (`fc`, `uc`) move since `last`? `last` is -1 before the first packet.
 *
 * First packet: a fresh phone starts at 0, so 1 is its first tap. A larger value means the
 * counter was already running before this tracker existed (scene reload mid-match, a phone
 * that changed role): it becomes the baseline instead of firing a phantom shot or power.
 * A counter that went down is a phone that reloaded and restarted at 0: new baseline, no tap.
 * Only a reload with exactly one earlier tap can still leak one tap; priming the tracker with
 * the phone's first packet (as the sim tests do for Gunners) closes that too.
 */
export function counterTapped(last: number, now: number): boolean {
  if (last < 0) return now === 1;
  return now > last;
}
