# Who does what: three modules for three people

The base is done (see `HANDOFF.md`): the game runs end to end with placeholder physics and placeholder 3D. Each teammate now takes **one module**, works only in that module's folders, and merges to `main` every 45 to 60 minutes.

| Module | Owner | Folders (only edit these) | Task list | In one line |
|---|---|---|---|---|
| **1. Phones & network** | Teammate A | `src/phone/`, `src/net/`, `src/landing/`, `server/` | [`TASKS-A.md`](TASKS-A.md) | Everything the players hold: controller screens, sensors on real phones, join, reconnect, hosting |
| **2. Gameplay & big-screen HUD** | Teammate B | `src/sim/`, `src/scene/` | [`TASKS-B.md`](TASKS-B.md) | The rules of the game: physics, weapons, crates, kills, respawn, score, and the HUD that shows them |
| **3. Graphics, audio & assets** | Teammate C | `src/render/`, `public/assets/` | [`TASKS-C.md`](TASKS-C.md) | How it looks and sounds: Venice, water, gondolas, effects, sounds, generated images |

`shared/` (the contracts) is read-only. If you need a contract change, say it out loud, one person makes it, and `npm run check` must pass.

## The three modules never block each other

- **Module 1** talks to the game only through `shared/protocol.ts`: it sends `InputMsg` and draws the `Hud` / `Lobby` it receives. It can be tested alone with the keyboard-free desktop phone (`/play?room=CODE&sim=1`).
- **Module 2** implements `Sim` from `shared/api.ts`. It can be tested alone with the keyboard harness on `/scene` (K keyboard crew, O bot team, Enter start).
- **Module 3** implements `Renderer` from `shared/api.ts` and only reads `GameState` / `SimEvent`. It can be tested alone with bot teams (press O a few times, then Enter) and `gr.sim.debug` in the console.

## Order of work (about 6 hours)

| When | Everyone | Module 1 | Module 2 | Module 3 |
|---|---|---|---|---|
| 0:00 to 0:20 | **Gate 1 together**: tunnel, one iPhone and one Android steer a boat (HANDOFF.md section 2) | | | |
| 0:20 to 2:30 | merge every hour | A1 to A5 | B1 to B5 | C1 to C5 |
| **~2:30 Gate 2** | 4 teams by QR, loot, shoot, sink, respawn, finish a 5:00 match; measure FPS with 4 viewports | | | |
| 2:30 to 4:30 | merge every hour | A6 to A10 | B6 to B10 | C6 to C10 |
| **~4:30 Gate 3** | feature freeze: real Venice and gondolas in the loop; cut what is not in | | | |
| 4:30 to 6:00 | bug fixes, tuning (`PLAYTEST_TUNING` in `shared/config.ts`), rehearse the demo | | | |

Cut order if late (first to go at the top): Smoke and Wave, final-minute frenzy, Mortar, kill-cam, animated crew, Engineer. Never cut: QR join, steering, aiming, the kill and respawn loop, the scoreboard, the results screen.

## Rules for every task

1. Pull `main`, branch `a/<task>`, `b/<task>` or `c/<task>`.
2. One task per agent chat; paste the prompt starter from `HANDOFF.md` section 6 with the task ID.
3. Done means: the "Done when" holds, `npm run check` passes, and the merge message has a two-line "how to test".
4. Every feature gets a keyboard key or a `gr.sim.debug` call so others can test it without phones.
