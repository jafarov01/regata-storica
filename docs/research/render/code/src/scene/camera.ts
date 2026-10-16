/**
 * src/scene/camera.ts
 * Third-person camera rig per team (SPEC section 4): 9 m behind, 4 m above the boat
 * along the world aim direction, looking level so the horizon runs through the centre.
 * Position is smoothed exponentially; aim is 1:1 (never smoothed). Kill-cam tracks the killer.
 */
import { MathUtils, PerspectiveCamera, Vector3 } from 'three';
import { angleDiff } from '@shared/math.ts';
import { isWall, type MapGrid } from '@shared/map.ts';

export const CAMERA = {
  back: 9, // m behind the boat along the aim
  up: 4, // m above the water
  hfovDeg: 85, // horizontal field of view kept constant across cell aspects
  minVfovDeg: 50,
  maxVfovDeg: 75,
  near: 0.5,
  far: 450, // whole 400 x 300 m map: the campanile must never clip
  posLambda: 10, // 1/s, exponential smoothing of the position (63 % in 0.1 s)
  killCamLambda: 4, // slower glide onto the killer
  minBack: 2.5, // never closer than this when a wall is in the way
  wallProbeStep: 0.5, // m, grid march resolution
} as const;

export function verticalFovDeg(aspect: number): number {
  const h = MathUtils.degToRad(CAMERA.hfovDeg);
  const v = 2 * Math.atan(Math.tan(h / 2) / Math.max(0.1, aspect));
  return MathUtils.clamp(MathUtils.radToDeg(v), CAMERA.minVfovDeg, CAMERA.maxVfovDeg);
}

/**
 * Screen angle of the bow-vs-camera arrow (radians, 0 = bow straight ahead on screen,
 * positive = clockwise on screen). The camera looks along `aim`; the bow points along `yaw`.
 */
export function bowArrowAngle(yaw: number, aim: number): number {
  return angleDiff(aim, yaw);
}

/**
 * March from the boat toward the wanted camera point; stop before the first wall cell.
 * Cheap grid test, no physics query. Returns the clamped point (same y as wanted).
 */
export function clampCameraToWater(map: MapGrid, bx: number, bz: number, cx: number, cz: number, minBack: number): { x: number; z: number } {
  const dx = cx - bx;
  const dz = cz - bz;
  const len = Math.hypot(dx, dz);
  if (len < 1e-6) return { x: cx, z: cz };
  const ux = dx / len;
  const uz = dz / len;
  let d = minBack;
  for (; d <= len; d += CAMERA.wallProbeStep) {
    if (isWall(map, bx + ux * d, bz + uz * d)) {
      d = Math.max(minBack, d - CAMERA.wallProbeStep * 2);
      return { x: bx + ux * d, z: bz + uz * d };
    }
  }
  return { x: cx, z: cz };
}

export interface RigTarget {
  readonly x: number;
  readonly z: number;
  /** Direction the camera sits behind and looks along (the gunner's world aim, or the killer's yaw). */
  readonly aim: number;
}

export type RigMode = 'follow' | 'killcam';

export class CameraRig {
  readonly camera: PerspectiveCamera;
  private readonly pos = new Vector3();
  private readonly want = new Vector3();
  private readonly look = new Vector3();
  private settled = false;
  private mode: RigMode = 'follow';

  constructor(private readonly map: MapGrid) {
    this.camera = new PerspectiveCamera(60, 16 / 9, CAMERA.near, CAMERA.far);
    this.camera.rotation.order = 'YXZ';
  }

  setAspect(aspect: number): void {
    if (Math.abs(this.camera.aspect - aspect) < 1e-6) return;
    this.camera.aspect = aspect;
    this.camera.fov = verticalFovDeg(aspect);
    this.camera.updateProjectionMatrix();
  }

  /** Forget the smoothed position: the next update snaps (respawn, kill-cam cut, round start). */
  snap(): void {
    this.settled = false;
  }

  /**
   * @param t      interpolated boat transform for this frame
   * @param dt     frame delta in seconds (for the exponential smoothing)
   * @param mode   'follow' looks level along t.aim; 'killcam' glides toward the killer and looks at it
   */
  update(t: RigTarget, dt: number, mode: RigMode): void {
    if (mode !== this.mode) {
      this.mode = mode;
      if (mode === 'follow') this.settled = false; // cut, never glide back through buildings
    }
    const fx = Math.cos(t.aim);
    const fz = Math.sin(t.aim);
    const wx = t.x - fx * CAMERA.back;
    const wz = t.z - fz * CAMERA.back;
    const c = clampCameraToWater(this.map, t.x, t.z, wx, wz, CAMERA.minBack);
    this.want.set(c.x, CAMERA.up, c.z);

    if (!this.settled) {
      this.pos.copy(this.want);
      this.settled = true;
    } else {
      const lambda = mode === 'killcam' ? CAMERA.killCamLambda : CAMERA.posLambda;
      const k = 1 - Math.exp(-lambda * dt);
      this.pos.lerp(this.want, k);
    }
    this.camera.position.copy(this.pos);

    if (mode === 'follow') {
      // Level look: target at the camera's own height, far ahead along the aim (never smoothed).
      this.look.set(this.pos.x + fx * 100, CAMERA.up, this.pos.z + fz * 100);
    } else {
      // Kill-cam: look at the killer boat itself (slightly down), so the room sees who did it.
      this.look.set(t.x, 1.0, t.z);
    }
    this.camera.lookAt(this.look);
  }
}
