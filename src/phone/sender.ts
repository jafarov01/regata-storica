// src/phone/sender.ts
// The 30 Hz input loop. Samples the latest filtered state, builds one protocol sample,
// and pauses while the tab is hidden. The net client (src/net/client.ts sendInput) adds `seq`.
//
// Lost-packet rule (shared/protocol.ts): nothing that matters is sent as a one-packet edge.
// Gunner aim goes out as an absolute `yaw` plus an epoch `ep` bumped on every recenter or
// calibrate; fire taps and power taps go out as running counters (`fc`, `uc`).

import type { InputSample } from '@shared/protocol';
import type { Role } from '@shared/state';
import type { PadsView } from './pads';
import type { ControllerPipeline } from './sensors';

export interface InputSenderDeps {
  readonly role: Role;
  readonly pipeline: ControllerPipeline;
  readonly pads: PadsView;
  readonly send: (sample: InputSample) => void;
  readonly hz?: number;
  /** Teams of 2: the Gunner also carries the two power buttons (GunnerIn.use / uc). */
  readonly gunnerHasPowers?: boolean;
  /** Called on CALIBRATE taps so the screen can confirm and send { t: 'calibrate' }. */
  readonly onCalibrate?: (ok: boolean) => void;
  /**
   * True while the controls must not act (the rotate-your-phone overlay for Pilot and Gunner):
   * every tick then sends a coasting sample and throws away taps and turned yaw, so a phone held
   * in portrait neither steers at full lock nor swings the aim when it comes back.
   */
  readonly suspended?: () => boolean;
}

/** What one tick consumed from the pads. Pure so it can be unit-tested. */
export interface TickEdges {
  readonly fireTaps: number;
  readonly recenter: boolean;
  readonly calibrate: boolean;
  /** Power taps in order (a tap on each slot in one tick counts both). */
  readonly uses: readonly (0 | 1)[];
}

export function collectEdges(taps: readonly string[]): TickEdges {
  let fireTaps = 0;
  let recenter = false;
  let calibrate = false;
  const uses: (0 | 1)[] = [];
  for (const t of taps) {
    if (t === 'fire') fireTaps += 1;
    else if (t === 'recenter') recenter = true;
    else if (t === 'calibrate') calibrate = true;
    else if (t === 'power0') uses.push(0);
    else if (t === 'power1') uses.push(1);
  }
  return { fireTaps, recenter, calibrate, uses };
}

/** Running totals kept by the sender between ticks. */
export interface SenderTotals {
  /** Radians since the last recenter/calibrate (absolute aim the scene re-bases on `ep`). */
  yaw: number;
  ep: number;
  fc: number;
  uc: number;
  lastUse: 0 | 1 | null;
}

export function newTotals(): SenderTotals {
  return { yaw: 0, ep: 0, fc: 0, uc: 0, lastUse: null };
}

export interface TickState {
  readonly steer: number;
  readonly dYawRad: number;
  readonly shake: number;
  readonly gasHeld: boolean;
  readonly brakeHeld: boolean;
  readonly fireHeld: boolean;
}

/** Folds this tick's edges into the totals (mutates `totals`). Recenter/calibrate restart the yaw. */
export function applyEdges(totals: SenderTotals, edges: TickEdges, dYawRad: number): void {
  if (edges.recenter || edges.calibrate) {
    totals.yaw = 0;
    totals.ep += 1;
  } else {
    totals.yaw += dYawRad;
  }
  totals.fc += edges.fireTaps;
  for (const u of edges.uses) {
    totals.uc += 1;
    totals.lastUse = u;
  }
}

/** Builds the sample for a role from the current state and the (already updated) totals. */
export function buildInputSample(role: Role, s: TickState, totals: SenderTotals, edges: TickEdges, gunnerHasPowers = false): InputSample {
  switch (role) {
    case 'pilot':
      return { t: 'in', role, steer: s.steer, gas: s.gasHeld, brake: s.brakeHeld };
    case 'gunner':
      return {
        t: 'in',
        role,
        dYaw: edges.recenter || edges.calibrate ? 0 : s.dYawRad,
        yaw: totals.yaw,
        ep: totals.ep,
        fire: s.fireHeld,
        fc: totals.fc,
        recenter: edges.recenter || edges.calibrate,
        use: gunnerHasPowers ? totals.lastUse : null,
        uc: gunnerHasPowers ? totals.uc : 0,
      };
    case 'engineer':
      return { t: 'in', role, use: totals.lastUse, uc: totals.uc, shake: s.shake };
  }
}

/** A coasting sample: no gas, no fire, no shake; the totals are kept so nothing is replayed. */
export function neutralSample(role: Role, totals: SenderTotals, gunnerHasPowers = false): InputSample {
  return buildInputSample(
    role,
    { steer: 0, dYawRad: 0, shake: 0, gasHeld: false, brakeHeld: false, fireHeld: false },
    totals,
    { fireTaps: 0, recenter: false, calibrate: false, uses: [] },
    gunnerHasPowers,
  );
}

/**
 * Fixed-rate loop on setTimeout aligned to a schedule (no drift, no bursts after a hiccup).
 * Why not send on every sensor event: 60 Hz events through a tunnel double the packet
 * rate for no gameplay benefit; the fixed loop also keeps pads-only roles at a steady rate.
 */
export function startInputSender(deps: InputSenderDeps): { stop(): void } {
  const hz = deps.hz ?? 30;
  const period = 1000 / hz;
  const powers = deps.gunnerHasPowers ?? false;
  const totals = newTotals();
  let stopped = false;
  let timer: number | null = null;
  let next = performance.now() + period;

  const tick = (): void => {
    if (stopped || document.visibilityState !== 'visible') return;
    if (deps.suspended?.()) {
      deps.pads.drainTaps();
      deps.pipeline.drainYaw();
      deps.send(neutralSample(deps.role, totals, powers));
      schedule();
      return;
    }
    const edges = collectEdges(deps.pads.drainTaps());
    if (edges.calibrate) {
      const ok = deps.pipeline.calibrateSteer();
      deps.pipeline.recenterYaw();
      deps.onCalibrate?.(ok);
    }
    if (edges.recenter) deps.pipeline.recenterYaw();
    const snap = deps.pipeline.snapshot();
    const dYawRad = deps.pipeline.drainYaw();
    applyEdges(totals, edges, dYawRad);
    const state: TickState = {
      steer: snap.steer,
      dYawRad,
      shake: snap.shake,
      gasHeld: deps.pads.isHeld('gas'),
      brakeHeld: deps.pads.isHeld('brake'),
      fireHeld: deps.pads.isHeld('fire'),
    };
    deps.send(buildInputSample(deps.role, state, totals, edges, powers));
    schedule();
  };

  function schedule(): void {
    next += period;
    const now = performance.now();
    if (next < now - 5 * period) next = now + period; // fell far behind: resync instead of bursting
    timer = window.setTimeout(tick, Math.max(0, next - now));
  }

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
      deps.send(neutralSample(deps.role, totals, powers));
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
