/**
 * STAND-IN for the protocol topic's deliverable: exactly the message types of
 * SPEC.md section 11, so src/scene/keyboard.ts and src/scene/bot.ts type-check.
 * The real shared/protocol.ts replaces this file; the names must stay.
 */
import type { Role } from './state.ts';

export type PilotIn = { t: 'in'; role: 'pilot'; steer: number; gas: boolean; brake: boolean };
export type GunnerIn = { t: 'in'; role: 'gunner'; dYaw: number; fire: boolean; recenter: boolean };
export type EngIn = { t: 'in'; role: 'engineer'; use: 0 | 1 | null; shake: number };
export type PlayerInput = PilotIn | GunnerIn | EngIn;
export type { Role };
