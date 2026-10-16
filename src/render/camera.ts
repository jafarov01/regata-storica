/** Research camera rig, using the repository's camera constants and ParsedMap. */
import { PerspectiveCamera, Vector3 } from 'three';
import { CAMERA } from '@shared/config.ts';
import type { ParsedMap } from '@shared/map.ts';
import { smoothingAlpha } from '@shared/math.ts';

export function clampCamera(map: ParsedMap, bx: number, bz: number, cx: number, cz: number): { x: number; z: number } {
  const distance = Math.hypot(cx - bx, cz - bz);
  if (distance < 0.001) return { x: cx, z: cz };
  const dx = (cx - bx) / distance, dz = (cz - bz) / distance;
  for (let d = 0.25; d <= distance; d += 0.25) {
    if (!map.isWaterAt(bx + dx * d, bz + dz * d)) {
      const safe = Math.max(0, d - 0.5);
      return { x: bx + dx * safe, z: bz + dz * safe };
    }
  }
  return { x: cx, z: cz };
}

export class CameraRig {
  readonly camera = new PerspectiveCamera(CAMERA.fovDeg, 16 / 9, CAMERA.near, CAMERA.far);
  private readonly position = new Vector3();
  private settled = false;
  private target = -1;
  private killcam = false;
  private lastX = 0;
  private lastZ = 0;
  constructor(private readonly map: ParsedMap) {}
  update(x: number, z: number, aim: number, team: number, killcam: boolean, dt: number, aspect: number, snap = false): void {
    const fx = Math.cos(aim), fz = Math.sin(aim);
    const wanted = clampCamera(this.map, x, z, x - fx * CAMERA.back, z - fz * CAMERA.back);
    const teleport = team === this.target && Math.hypot(x - this.lastX, z - this.lastZ) > 20;
    if (snap || !this.settled || teleport || (!killcam && (this.killcam || team !== this.target))) {
      this.position.set(wanted.x, CAMERA.up, wanted.z);
      this.settled = true;
    } else {
      const k = smoothingAlpha(dt, killcam ? 0.25 : CAMERA.positionTau);
      this.position.x += (wanted.x - this.position.x) * k;
      this.position.z += (wanted.z - this.position.z) * k;
      // Smoothing across a turn must not place the camera inside a building.
      const safe = clampCamera(this.map, x, z, this.position.x, this.position.z);
      this.position.set(safe.x, CAMERA.up, safe.z);
    }
    this.target = team; this.killcam = killcam; this.lastX = x; this.lastZ = z;
    this.camera.position.copy(this.position);
    if (killcam) this.camera.lookAt(x, 1, z);
    else this.camera.lookAt(this.position.x + fx * 50, CAMERA.up, this.position.z + fz * 50);
    if (this.camera.aspect !== aspect) { this.camera.aspect = aspect; this.camera.updateProjectionMatrix(); }
  }
}
