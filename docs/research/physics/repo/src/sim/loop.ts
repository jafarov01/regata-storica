// src/sim/loop.ts — fixed 60 Hz stepping with an accumulator, frame clamp and interpolation snapshots.
import { PHYSICS } from '@shared/config';
import { lerpAngle } from './coords';

export interface Transform2 {
  x: number;
  y: number;
  angle: number;
}

export function makeTransform(x = 0, y = 0, angle = 0): Transform2 {
  return { x, y, angle };
}

export function copyTransform(from: Transform2, to: Transform2): void {
  to.x = from.x;
  to.y = from.y;
  to.angle = from.angle;
}

/** out = prev*(1-alpha) + curr*alpha, angle along the shortest arc. The renderer calls this. */
export function lerpTransform(prev: Transform2, curr: Transform2, alpha: number, out: Transform2): Transform2 {
  out.x = prev.x + (curr.x - prev.x) * alpha;
  out.y = prev.y + (curr.y - prev.y) * alpha;
  out.angle = lerpAngle(prev.angle, curr.angle, alpha);
  return out;
}

/**
 * Accumulator loop ("Fix your timestep"). Wall time feeds `advance`; the sim only ever
 * sees `dt`. A frame longer than `maxFrameTime` is clamped, so after a stall the sim
 * runs at most maxFrameTime/dt (= 15) steps and the sim clock falls behind wall time
 * instead of spiralling. All game timers must use `simTime`, never Date.now().
 */
export class FixedStepper {
  private accumulator = 0;
  /** Seconds of simulated time (dt * steps). */
  simTime = 0;
  /** Number of fixed steps run so far. */
  stepCount = 0;
  /** Blend factor for the renderer after the last `advance`: 0 = previous step, 1 = current step. */
  alpha = 0;
  /** Set when the last frame had to be clamped (debug HUD). */
  clamped = false;

  constructor(
    readonly dt: number = PHYSICS.dt,
    readonly maxFrameTime: number = PHYSICS.maxFrameTime,
  ) {}

  /**
   * @param frameSeconds wall-clock seconds since the previous frame
   * @param step runs exactly one fixed step; it must snapshot prev <- curr first
   * @returns the number of steps run this frame
   */
  advance(frameSeconds: number, step: (dt: number) => void): number {
    let ft = frameSeconds;
    if (!(ft >= 0)) ft = 0; // NaN or negative (clock went backwards)
    this.clamped = ft > this.maxFrameTime;
    if (this.clamped) ft = this.maxFrameTime;
    this.accumulator += ft;
    let n = 0;
    while (this.accumulator >= this.dt) {
      step(this.dt);
      this.accumulator -= this.dt;
      this.simTime += this.dt;
      this.stepCount += 1;
      n += 1;
    }
    this.alpha = this.accumulator / this.dt;
    return n;
  }

  reset(): void {
    this.accumulator = 0;
    this.simTime = 0;
    this.stepCount = 0;
    this.alpha = 0;
    this.clamped = false;
  }
}
