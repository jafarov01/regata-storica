/**
 * src/render/perf.ts
 * Budgets, measurement and the cut order from SPEC section 14: draw distance, shadows, building detail.
 * renderer.info resets on EVERY render() call by default, so with 4 viewports it would only show the
 * last one: set info.autoReset = false and reset once per frame (done in renderer.ts).
 */
import type { WebGLRenderer } from 'three';

export const BUDGET = {
  drawCallsPerViewport: 250,
  trianglesPerViewport: 300_000,
  drawCallsPerFrame: 1000,
  trianglesPerFrame: 1_200_000,
  targetFps: 60,
  downgradeBelowFps: 50,
  downgradeAfterSeconds: 3,
} as const;

export interface QualitySettings {
  readonly name: string;
  readonly cullDistance: number; // m, blocks/bridges beyond this are hidden per viewport
  readonly shadows: boolean; // static baked shadow map
  readonly dynamicShadows: boolean; // rebuild the map every frame (boats cast)
  readonly detail: boolean; // windows, shutters, chimneys, poles
  readonly pixelRatio: number;
}

/** Index 0 is full quality; each step is the next cut. */
export const QUALITY: readonly QualitySettings[] = [
  { name: 'full', cullDistance: 160, shadows: true, dynamicShadows: false, detail: true, pixelRatio: 1 },
  { name: 'near', cullDistance: 120, shadows: true, dynamicShadows: false, detail: true, pixelRatio: 1 },
  { name: 'no-shadows', cullDistance: 120, shadows: false, dynamicShadows: false, detail: true, pixelRatio: 1 },
  { name: 'plain', cullDistance: 100, shadows: false, dynamicShadows: false, detail: false, pixelRatio: 1 },
  { name: 'minimum', cullDistance: 90, shadows: false, dynamicShadows: false, detail: false, pixelRatio: 0.75 },
];

export class PerfMonitor {
  readonly el: HTMLDivElement;
  fps = 60;
  frameMs = 0;
  calls = 0;
  triangles = 0;
  private lowSince = -1;
  private lastDraw = 0;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:50;font:12px/1.4 ui-monospace,monospace;color:#9ff;background:rgba(0,0,0,.55);padding:6px 8px;border-radius:6px;pointer-events:none;white-space:pre;display:none';
    parent.appendChild(this.el);
  }

  toggle(): void {
    this.el.style.display = this.el.style.display === 'none' ? 'block' : 'none';
  }

  /** Call once per frame after the last viewport render. Returns true when a downgrade is advised. */
  sample(renderer: WebGLRenderer, dt: number, now: number, viewports: number, qualityName: string): boolean {
    const ms = dt * 1000;
    this.frameMs += (ms - this.frameMs) * 0.1;
    this.fps = 1000 / Math.max(0.1, this.frameMs);
    this.calls = renderer.info.render.calls;
    this.triangles = renderer.info.render.triangles;
    if (now - this.lastDraw > 0.25 && this.el.style.display !== 'none') {
      this.lastDraw = now;
      const mem = renderer.info.memory;
      this.el.textContent =
        `${this.fps.toFixed(0)} fps  ${this.frameMs.toFixed(1)} ms  q=${qualityName}\n` +
        `calls ${this.calls} (${Math.round(this.calls / Math.max(1, viewports))}/view)  tris ${(this.triangles / 1000).toFixed(0)}k\n` +
        `geom ${mem.geometries}  tex ${mem.textures}  programs ${renderer.info.programs?.length ?? 0}`;
    }
    if (this.fps < BUDGET.downgradeBelowFps) {
      if (this.lowSince < 0) this.lowSince = now;
      if (now - this.lowSince > BUDGET.downgradeAfterSeconds) {
        this.lowSince = -1;
        return true;
      }
    } else {
      this.lowSince = -1;
    }
    return false;
  }
}
