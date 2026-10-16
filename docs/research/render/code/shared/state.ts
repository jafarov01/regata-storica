/**
 * RENDER-FACING SLICE OF GameState (to be merged into the real shared/state.ts).
 * The simulation writes it, the renderer and HUD only read it. Every boat carries
 * its previous-step transform (px, pz, pyaw, paim) so the renderer can interpolate
 * with the alpha from the fixed-timestep accumulator (Gaffer, "Fix Your Timestep").
 */
export type Phase = 'lobby' | 'countdown' | 'battle' | 'results';
export type Role = 'pilot' | 'gunner' | 'engineer';
export type WeaponId = 'water' | 'cannon' | 'torpedo' | 'mortar';
export type PowerId = 'shield' | 'mine' | 'boost' | 'smoke' | 'wave';

export interface CrewMember {
  readonly name: string;
  readonly role: Role;
}

export interface TeamState {
  readonly id: number; // 0..5, index into TEAM_COLOURS
  readonly name: string; // Rosso, Azzurro, ...
  readonly colour: number; // 0xrrggbb
  readonly crew: readonly CrewMember[];
  readonly boatId: number;
  readonly kills: number;
  readonly deaths: number;
}

export interface BoatState {
  readonly id: number;
  readonly team: number;
  // current step (metres, radians; forward = (cos yaw, 0, sin yaw) in 3D (x, y, z))
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
  readonly aim: number; // world aim angle of the gunner (stabilised, not boat-relative)
  // previous step, for interpolation
  readonly px: number;
  readonly pz: number;
  readonly pyaw: number;
  readonly paim: number;
  // motion cues for visual-only animation
  readonly speed: number; // m/s along the heading, negative in reverse
  readonly turnRate: number; // rad/s, positive = turning toward +yaw
  readonly accel: number; // m/s^2 along the heading
  readonly gas: boolean;
  readonly bailing: boolean;
  // status
  readonly alive: boolean;
  readonly sinkT: number; // seconds since the lethal hit; 0 while alive
  readonly respawnIn: number; // seconds, 0 while alive
  readonly killerBoatId: number | null;
  readonly water: number; // 0..100
  readonly shieldT: number; // seconds left, 0 = none
  readonly boostT: number;
  readonly protectT: number; // spawn protection seconds left
  readonly smokeT: number;
  readonly revealed: boolean; // visible on the shared minimap (fired < 2 s ago or in the lagoon)
  readonly weapon: WeaponId;
  readonly ammo: number;
  readonly powers: readonly [PowerId | null, PowerId | null];
  readonly enemyOnAim: boolean; // crosshair: red diamond
  readonly lockReady: boolean; // crosshair: torpedo lock ring
}

export interface CrateState {
  readonly id: number;
  readonly x: number;
  readonly z: number;
  readonly kind: 'weapon' | 'power';
  readonly active: boolean; // false while respawning (8 s)
}

export interface ProjectileState {
  readonly id: number;
  readonly kind: 'cannon' | 'torpedo' | 'mortar';
  readonly team: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly px: number;
  readonly py: number;
  readonly pz: number;
  readonly yaw: number;
}

export interface MineState {
  readonly id: number;
  readonly team: number;
  readonly x: number;
  readonly z: number;
  readonly armed: boolean;
}

export interface WaterJetState {
  readonly boatId: number; // the gunner is holding the water cannon
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
}

export interface RenderState {
  readonly phase: Phase;
  readonly time: number; // seconds since round start
  readonly timeLeft: number; // seconds, battle only
  readonly teams: readonly TeamState[];
  readonly boats: readonly BoatState[];
  readonly crates: readonly CrateState[];
  readonly projectiles: readonly ProjectileState[];
  readonly mines: readonly MineState[];
  readonly jets: readonly WaterJetState[];
  readonly killFeed: readonly string[]; // newest first, already formatted by the sim
}

export type GameEvent =
  | { readonly kind: 'fired'; readonly boatId: number; readonly weapon: WeaponId; readonly x: number; readonly z: number; readonly yaw: number }
  | { readonly kind: 'hit'; readonly x: number; readonly z: number; readonly weapon: WeaponId }
  | { readonly kind: 'splash'; readonly x: number; readonly z: number } // projectile missed
  | { readonly kind: 'sunk'; readonly boatId: number; readonly byTeam: number; readonly x: number; readonly z: number }
  | { readonly kind: 'respawn'; readonly boatId: number; readonly x: number; readonly z: number }
  | { readonly kind: 'shielded'; readonly boatId: number }
  | { readonly kind: 'pickup'; readonly boatId: number; readonly x: number; readonly z: number }
  | { readonly kind: 'scrape'; readonly x: number; readonly z: number }
  | { readonly kind: 'kill'; readonly team: number; readonly victimTeam: number; readonly weapon: WeaponId | 'ram' | 'mine' }
  | { readonly kind: 'horn' }
  | { readonly kind: 'win'; readonly team: number };
