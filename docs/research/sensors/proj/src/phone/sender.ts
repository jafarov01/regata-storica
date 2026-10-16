// src/phone/sender.ts
// The 30 Hz input loop. Samples the latest filtered state, builds one protocol packet,
// resets the edge-triggered fields, and pauses while the tab is hidden.

import type { EngineerIn, GunnerIn, InputPacket, PilotIn } from '@shared/protocol';
import type { Role } from '@shared/state';
import type { PadsView } from './pads';
import type { ControllerPipeline } from './sensors';

export interface InputSenderDeps {
  readonly role: Role;
  readonly pipeline: ControllerPipeline;
  readonly pads: PadsView;
  readonly send: (packet: InputPacket) => void;
  readonly hz?: number;
  /** Teams of 2: the Gunner also carries the two power buttons (GunnerIn.use). */
  readonly gunnerHasPowers?: boolean;
  /** Called on CALIBRATE taps so the screen can confirm and send { t: 'calibrated' }. */
  readonly onCalibrate?: (ok: boolean) => void;
}

/** What one tick consumed from the pads. Pure so it can be unit-tested. */
export interface TickEdges {
  readonly fireTapped: boolean;
  readonly recenter: boolean;
  readonly calibrate: boolean;
  readonly use: 0 | 1 | null;
}

export function collectEdges(taps: readonly string[]): TickEdges {
  let fireTapped = false;
  let recenter = false;
  let calibrate = false;
  let use: 0 | 1 | null = null;
  for (const t of taps) {
    if (t === 'fire') fireTapped = true;
    else if (t === 'recenter') recenter = true;
    else if (t === 'calibrate') calibrate = true;
    else if (t === 'power0' && use === null) use = 0;
    else if (t === 'power1' && use === null) use = 1;
  }
  return { fireTapped, recenter, calibrate, use };
}

export interface TickState {
  readonly seq: number;
  readonly steer: number;
  readonly dYawRad: number;
  readonly shake: number;
  readonly gasHeld: boolean;
  readonly brakeHeld: boolean;
  readonly fireHeld: boolean;
}

/**
 * Builds the packet for a role. A tap shorter than one tick still sends fire=true once
 * (the scene does the edge detection, so one `true` packet is one shot).
 */
export function buildInputPacket(role: Role, s: TickState, edges: TickEdges, gunnerHasPowers = false): InputPacket {
  switch (role) {
    case 'pilot': {
      const p: PilotIn = { t: 'in', seq: s.seq, role, steer: s.steer, gas: s.gasHeld, brake: s.brakeHeld };
      return p;
    }
    case 'gunner': {
      const p: GunnerIn = {
        t: 'in',
        seq: s.seq,
        role,
        dYaw: s.dYawRad,
        fire: s.fireHeld || edges.fireTapped,
        recenter: edges.recenter,
      };
      return gunnerHasPowers ? { ...p, use: edges.use } : p;
    }
    case 'engineer': {
      const p: EngineerIn = { t: 'in', seq: s.seq, role, use: edges.use, shake: s.shake };
      return p;
    }
  }
}

export function neutralPacket(role: Role, seq: number): InputPacket {
  return buildInputPacket(
    role,
    { seq, steer: 0, dYawRad: 0, shake: 0, gasHeld: false, brakeHeld: false, fireHeld: false },
    { fireTapped: false, recenter: false, calibrate: false, use: null },
  );
}

/**
 * Fixed-rate loop on setTimeout aligned to a schedule (no drift, no bursts after a hiccup).
 * Why not send on every sensor event: 60 Hz events through a tunnel double the packet
 * rate for no gameplay benefit, and the sim integrates dYaw anyway; the fixed loop also
 * keeps pads-only roles (engineer) at a steady rate.
 */
export function startInputSender(deps: InputSenderDeps): { stop(): void } {
  const hz = deps.hz ?? 30;
  const period = 1000 / hz;
  let stopped = false;
  let timer: number | null = null;
  let next = performance.now() + period;
  let seq = 0;

  const tick = (): void => {
    if (stopped || document.visibilityState !== 'visible') return;
    const edges = collectEdges(deps.pads.drainTaps());
    if (edges.calibrate) {
      const ok = deps.pipeline.calibrateSteer();
      deps.pipeline.recenterYaw();
      deps.onCalibrate?.(ok);
    }
    if (edges.recenter) deps.pipeline.recenterYaw();
    const snap = deps.pipeline.snapshot();
    seq += 1;
    const state: TickState = {
      seq,
      steer: snap.steer,
      dYawRad: deps.pipeline.drainYaw(),
      shake: snap.shake,
      gasHeld: deps.pads.isHeld('gas'),
      brakeHeld: deps.pads.isHeld('brake'),
      fireHeld: deps.pads.isHeld('fire'),
    };
    deps.send(buildInputPacket(deps.role, state, edges, deps.gunnerHasPowers ?? false));
    next += period;
    const now = performance.now();
    if (next < now - 5 * period) next = now + period; // fell far behind: resync instead of bursting
    timer = window.setTimeout(tick, Math.max(0, next - now));
  };

  const onVisibility = (): void => {
    if (document.visibilityState === 'visible') {
      if (stopped) return;
      deps.pipeline.resetFilters();
      next = performance.now() + period;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(tick, period);
    } else {
      // Sensors stop in the background and timers are throttled; make the boat coast now.
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      deps.pipeline.drainYaw();
      seq += 1;
      deps.send(neutralPacket(deps.role, seq));
    }
  };
  document.addEventListener('visibilitychange', onVisibility);
  timer = window.setTimeout(tick, period);

  return {
    stop(): void {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
