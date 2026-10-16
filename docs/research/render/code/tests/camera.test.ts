import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { bowArrowAngle, CameraRig, clampCameraToWater, verticalFovDeg } from '../src/scene/camera.ts';
import { parseMap, SAMPLE_MAP } from '../shared/map.ts';

describe('camera rig', () => {
  const map = parseMap(SAMPLE_MAP);
  it('vertical fov follows the cell aspect and clamps', () => {
    expect(verticalFovDeg(16 / 9)).toBeCloseTo(54.5, 0); // 2x2 at 16:9
    expect(verticalFovDeg(640 / 540)).toBe(75); // 3x2 cells, clamped
    expect(verticalFovDeg(960 / 1080)).toBe(75); // side-by-side halves, clamped
  });
  it('sits 9 m behind and 4 m up along the aim and looks level', () => {
    const rig = new CameraRig(map);
    const yaw = 0.7;
    rig.update({ x: 0, z: 0, aim: yaw }, 1 / 60, 'follow'); // first update snaps
    expect(rig.camera.position.x).toBeCloseTo(-Math.cos(yaw) * 9, 5);
    expect(rig.camera.position.z).toBeCloseTo(-Math.sin(yaw) * 9, 5);
    expect(rig.camera.position.y).toBe(4);
    const dir = rig.camera.getWorldDirection(new Vector3());
    expect(dir.y).toBeCloseTo(0, 6);
    expect(Math.atan2(dir.z, dir.x)).toBeCloseTo(yaw, 6);
  });
  it('smooths position but the look direction stays 1:1 with the aim', () => {
    const rig = new CameraRig(map);
    rig.update({ x: 0, z: 0, aim: 0 }, 1 / 60, 'follow');
    rig.update({ x: 10, z: 0, aim: 1.2 }, 1 / 60, 'follow');
    const dir = rig.camera.getWorldDirection(new Vector3());
    expect(Math.atan2(dir.z, dir.x)).toBeCloseTo(1.2, 6);
    expect(rig.camera.position.x).toBeGreaterThan(-9); // moved toward the new wanted position
    expect(rig.camera.position.x).toBeLessThan(10 - Math.cos(1.2) * 9); // but not all the way
  });
  it('bow arrow is the signed angle from the aim to the bow', () => {
    expect(bowArrowAngle(0.5, 0.5)).toBe(0);
    expect(bowArrowAngle(0.5, 0)).toBeCloseTo(0.5);
    expect(bowArrowAngle(0, 3)).toBeCloseTo(-3);
  });
  it('pulls the camera out of a building', () => {
    // row 3 of SAMPLE_MAP is open water; row 2 at column 0..2 is building.
    // Boat in the canal at (x of col 3, z of row 3), camera wanted deep inside the block to the -x side.
    const bx = (3 + 0.5 - map.cols / 2) * map.cell;
    const bz = (3 + 0.5 - map.rows / 2) * map.cell;
    const wantX = bx - 9;
    const wantZ = bz - 9; // diagonal into the block at rows 1-2
    const c = clampCameraToWater(map, bx, bz, wantX, wantZ, 2.5);
    expect(Math.hypot(c.x - bx, c.z - bz)).toBeLessThan(Math.hypot(9, 9));
    expect(Math.hypot(c.x - bx, c.z - bz)).toBeGreaterThanOrEqual(2.5);
  });
});
