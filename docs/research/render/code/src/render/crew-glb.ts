/**
 * src/render/crew-glb.ts (UPGRADE PATH, not used in the hackathon build)
 * Mixamo -> FBX -> Blender -> GLB with several clips ('Idle', 'Row', 'Sit', 'Bail', 'Fall', 'Cheer').
 * One GLB is loaded once; every crew member is a SkeletonUtils.clone with its own AnimationMixer.
 * Cost per instance: one skinned draw call per viewport plus a bone-texture upload per frame.
 */
import { AnimationMixer, Mesh, type AnimationAction, type AnimationClip, type Group, type Object3D } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

export interface CrewRig {
  readonly scene: Group;
  readonly clips: readonly AnimationClip[];
}

export async function loadCrewRig(url: string): Promise<CrewRig> {
  const gltf = await new GLTFLoader().loadAsync(url);
  gltf.scene.traverse((o: Object3D) => {
    if (o instanceof Mesh) {
      o.castShadow = false;
      o.frustumCulled = false; // skinned bounds are not updated; never cull a crew member
    }
  });
  return { scene: gltf.scene, clips: gltf.animations };
}

export class CrewInstance {
  readonly root: Object3D;
  private readonly mixer: AnimationMixer;
  private readonly actions = new Map<string, AnimationAction>();
  private current: AnimationAction | null = null;

  constructor(rig: CrewRig, scale: number = 0.01) {
    this.root = cloneSkinned(rig.scene); // plain Object3D.clone() would share the skeleton: all clones would move together
    this.root.scale.setScalar(scale); // Mixamo FBX is in centimetres
    this.mixer = new AnimationMixer(this.root);
    for (const clip of rig.clips) this.actions.set(clip.name, this.mixer.clipAction(clip));
  }

  play(name: string, fade: number = 0.2, timeScale: number = 1): void {
    const next = this.actions.get(name);
    if (!next) return;
    next.setEffectiveTimeScale(timeScale);
    if (next === this.current) return;
    next.reset().setEffectiveWeight(1).fadeIn(fade).play();
    this.current?.fadeOut(fade);
    this.current = next;
  }

  update(dt: number): void {
    this.mixer.update(dt);
  }

  dispose(): void {
    this.mixer.stopAllAction();
  }
}
