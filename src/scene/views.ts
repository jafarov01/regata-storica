/**
 * One camera per team, and the kill-cam (SPEC sections 2 and 5). Track B owns it.
 *
 * While a boat is sunk its viewport follows the boat that sank it for the whole
 * respawn delay. If the killer sinks too before the delay is over, the kill-cam
 * ends and the cell shows its own sinking boat for the rest of the countdown
 * (the render research's fallback): following a dead killer would cut to its
 * wreck and then to the dock it respawns at. The research froze the killer's
 * pose instead; `CameraView` has no pose field, so that needs the renderer to
 * hold the last pose itself.
 */
import type { CameraView } from '@shared/api.ts';
import { TIERS } from '@shared/config.ts';
import type { GameState } from '@shared/state.ts';

export class CameraViews {
  /** Teams whose kill-cam ended early this life (killer died). Cleared when the boat is back. */
  private readonly ended = new Set<number>();
  private readonly views: CameraView[] = [];

  /** Updates and returns the same array every call (no allocation per frame once sized). */
  update(state: GameState): readonly CameraView[] {
    const views = this.views;
    views.length = state.teams.length;
    for (let i = 0; i < state.teams.length; i++) {
      const view = (views[i] ??= { team: i, followTeam: i, killCam: false });
      view.team = i;
      view.followTeam = i;
      view.killCam = false;
      const boat = state.boats[i];
      if (!boat || (boat.status !== 'sinking' && boat.status !== 'respawning')) {
        this.ended.delete(i);
        continue;
      }
      const killer = boat.killerTeam;
      if (!TIERS.killCam || killer === null || killer === i || this.ended.has(i)) continue;
      const kb = state.boats[killer];
      if (!kb || kb.status !== 'alive') {
        this.ended.add(i);
        continue;
      }
      view.followTeam = killer;
      view.killCam = true;
    }
    return views;
  }
}
