/**
 * src/render/audio.ts
 * Scene-PC audio only (phones stay silent). Non-positional THREE.Audio for everything:
 * there is ONE AudioListener but four cameras, so PositionalAudio has no meaningful listener;
 * instead the gain is scaled by the distance to the nearest team boat. The AudioContext starts
 * suspended under Chrome's autoplay policy and is resumed from the host's Start click / Space.
 * Buffers load lazily after Gate 1; a missing file just means silence for that sound.
 */
import { Audio, AudioListener, AudioLoader } from 'three';
import type { GameEvent, RenderState } from '@shared/state.ts';

export type SoundId =
  | 'cannon'
  | 'torpedo'
  | 'mortar'
  | 'splash'
  | 'explosion'
  | 'pickup'
  | 'shield'
  | 'respawn'
  | 'horn'
  | 'scrape'
  | 'win'
  | 'lapping'
  | 'bells'
  | 'gulls'
  | 'lobby';

export const SOUND_FILES: Readonly<Record<SoundId, string>> = {
  cannon: '/assets/sounds/cannon.ogg',
  torpedo: '/assets/sounds/torpedo.ogg',
  mortar: '/assets/sounds/mortar.ogg',
  splash: '/assets/sounds/splash.ogg',
  explosion: '/assets/sounds/explosion.ogg',
  pickup: '/assets/sounds/pickup.ogg',
  shield: '/assets/sounds/shield.ogg',
  respawn: '/assets/sounds/respawn.ogg',
  horn: '/assets/sounds/horn.ogg',
  scrape: '/assets/sounds/scrape.ogg',
  win: '/assets/sounds/win.ogg',
  lapping: '/assets/sounds/lapping-loop.ogg',
  bells: '/assets/sounds/bells.ogg',
  gulls: '/assets/sounds/gulls.ogg',
  lobby: '/assets/sounds/lobby-loop.ogg',
};

const LOOPS: readonly SoundId[] = ['lapping', 'lobby'];

export class GameAudio {
  private listener: AudioListener | null = null;
  private readonly buffers = new Map<SoundId, AudioBuffer>();
  private readonly loops = new Map<SoundId, Audio>();
  private loading: Promise<void> | null = null;
  private lastScrape = -1;

  /** Create the context lazily, inside a user gesture, so it is never born suspended. */
  private ensure(): AudioListener {
    if (!this.listener) this.listener = new AudioListener();
    return this.listener;
  }

  /** Call from the Start click or the Space keydown handler (both count as user activation). */
  unlock(): void {
    const ctx = this.ensure().context; // the DOM AudioContext behind three's AudioListener
    if (ctx.state === 'suspended') void ctx.resume();
  }

  preload(ids: readonly SoundId[] = Object.keys(SOUND_FILES) as SoundId[]): Promise<void> {
    if (this.loading) return this.loading;
    const loader = new AudioLoader();
    this.loading = Promise.all(
      ids.map(async (id) => {
        try {
          const buf = await loader.loadAsync(SOUND_FILES[id]);
          this.buffers.set(id, buf);
        } catch {
          // Missing or undecodable file: that sound stays silent. Never block the game on audio.
        }
      }),
    ).then(() => undefined);
    return this.loading;
  }

  play(id: SoundId, volume: number = 1, rate: number = 1): void {
    const buf = this.buffers.get(id);
    if (!buf || !this.listener) return;
    const a = new Audio(this.listener);
    a.setBuffer(buf);
    a.setVolume(volume);
    a.setPlaybackRate(rate);
    a.play();
  }

  loop(id: SoundId, on: boolean, volume: number = 0.4): void {
    const existing = this.loops.get(id);
    if (!on) {
      existing?.stop();
      this.loops.delete(id);
      return;
    }
    if (existing || !LOOPS.includes(id)) return;
    const buf = this.buffers.get(id);
    if (!buf || !this.listener) return;
    const a = new Audio(this.listener);
    a.setBuffer(buf);
    a.setLoop(true);
    a.setVolume(volume);
    a.play();
    this.loops.set(id, a);
  }

  /** Gain by distance to the nearest living boat (the room watches all of them). */
  private gainAt(state: RenderState, x: number, z: number): number {
    let best = Infinity;
    for (const b of state.boats) best = Math.min(best, Math.hypot(b.x - x, b.z - z));
    return best === Infinity ? 1 : Math.max(0.25, 1 - best / 160);
  }

  onEvents(events: readonly GameEvent[], state: RenderState, time: number): void {
    for (const e of events) {
      switch (e.kind) {
        case 'fired':
          if (e.weapon === 'cannon') this.play('cannon', this.gainAt(state, e.x, e.z), 0.95 + Math.random() * 0.1);
          else if (e.weapon === 'torpedo') this.play('torpedo', this.gainAt(state, e.x, e.z));
          else if (e.weapon === 'mortar') this.play('mortar', this.gainAt(state, e.x, e.z));
          break;
        case 'hit':
        case 'sunk':
          this.play('explosion', 1);
          break;
        case 'splash':
          this.play('splash', this.gainAt(state, e.x, e.z) * 0.8);
          break;
        case 'respawn':
          this.play('respawn', 0.8);
          break;
        case 'shielded':
          this.play('shield', 1);
          break;
        case 'pickup':
          this.play('pickup', 0.9);
          break;
        case 'scrape':
          if (time - this.lastScrape > 0.25) {
            this.lastScrape = time;
            this.play('scrape', this.gainAt(state, e.x, e.z) * 0.6);
          }
          break;
        case 'horn':
          this.play('horn', 1);
          break;
        case 'win':
          this.play('win', 1);
          break;
        default:
          break;
      }
    }
    this.loop('lobby', state.phase === 'lobby' || state.phase === 'results', 0.35);
    this.loop('lapping', state.phase === 'battle' || state.phase === 'countdown', 0.3);
  }

  dispose(): void {
    for (const a of this.loops.values()) a.stop();
    this.loops.clear();
  }
}
