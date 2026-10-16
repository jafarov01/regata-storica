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
  private ep = -1;
  private lastFc = 0;
  private lastUc = -1;

  /** Returns world aim in radians. `bowHeading` is the boat's current heading. */
  apply(pkt: GunnerIn, bowHeading: number): number {
    if (pkt.ep !== this.ep) {
      this.ep = pkt.ep;
      this.base = bowHeading - pkt.yaw;
    }
    return this.base + pkt.yaw;
  }

  /** Call on respawn (the spec resets the view behind the bow). */
  resetBehindBow(pkt: GunnerIn | null, bowHeading: number): void {
    this.base = bowHeading - (pkt?.yaw ?? 0);
    if (pkt) this.ep = pkt.ep;
  }

  /** True once per fire tap even if the packet carrying `fire: true` was lost. */
  takeFireTap(pkt: GunnerIn): boolean {
    if (pkt.fc === this.lastFc) return false;
    this.lastFc = pkt.fc;
    return true;
  }

  /** Engineer power use, applied exactly once per tap. */
  takeUse(uc: number, use: 0 | 1 | null): 0 | 1 | null {
    if (uc === this.lastUc || use === null) return null;
    this.lastUc = uc;
    return use;
  }
}
