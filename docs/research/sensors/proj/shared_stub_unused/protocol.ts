// Stub of the contract file from SPEC.md section 11 (only what the phone input code needs).
export type Role = 'pilot' | 'gunner' | 'engineer';
export type PilotIn = { t: 'in'; role: 'pilot'; steer: number; gas: boolean; brake: boolean };
export type GunnerIn = { t: 'in'; role: 'gunner'; dYaw: number; fire: boolean; recenter: boolean };
export type EngIn = { t: 'in'; role: 'engineer'; use: 0 | 1 | null; shake: number };
export type InputMsg = PilotIn | GunnerIn | EngIn;
