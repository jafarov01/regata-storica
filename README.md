# Gondola Royale

A browser party deathmatch for 4 to 18 people in one room. Teams crew armed gondolas in a 3D Venice shown on one big screen; their phones are the controllers. One hit sinks a boat, a sunk boat is back in 5 seconds, and after 5 minutes the team with the most kills wins.

- `SPEC.md`: the full game spec and hackathon plan (source of truth).
- `HANDOFF.md`: current state of the repo, fixed decisions, where the research and ready-made code live, what to do next. **Start here.**
- `docs/TASKS-A.md`, `docs/TASKS-B.md`, `docs/TASKS-C.md`: one task list per track.
- `docs/CHALLENGES.md`: the hard parts and their solutions, with pointers into `docs/research/`.
- `docs/ASSETS.md`: sounds to download and image prompts for ChatGPT / Gemini, with the filenames the code expects.

## Quick start

```bash
npm install
npm run dev
```

Open http://localhost:5173 on the PC, pick SCENE. Phones need HTTPS for motion sensors: run `npm run tunnel` (needs `brew install cloudflared`) and scan the QR the scene shows. See `docs/CHALLENGES.md` for the HTTPS options.

## Scripts

| Script | Does |
|---|---|
| `npm run dev` | Vite dev server (5173) + relay (3000, proxied under `/socket.io`) |
| `npm run check` | typecheck, tests, production build |
| `npm test` | Vitest |
| `npm run build` / `npm start` | Build to `dist/` and serve it from the relay on 3000 |
| `npm run tunnel` | Cloudflare quick tunnel to the dev server (HTTPS URL for phones) |

## Folder ownership (hard borders)

| Folder | Owner | Content |
|---|---|---|
| `shared/` | everyone, read-only for agents | contract files: config, state, protocol, api, map, math |
| `server/` | Track A | Socket.IO relay, serves `dist/` in production |
| `src/net/` | Track A | socket client for phones and the scene, token, reconnect |
| `src/phone/` | Track A | lobby, Pilot / Gunner / Engineer screens, sensors |
| `src/landing/` | Track A | SCENE / PLAYER choice |
| `src/sim/` | Track B | Rapier physics, rules, items, kills, respawn, score |
| `src/scene/` | Track B | game loop, camera rigs, viewports, HUD, keyboard harness |
| `src/render/` | Track C | world, water, boats, crew, VFX, audio |
| `public/assets/` | Track C | models, textures, sounds |
| `tests/` | the folder's owner | Vitest, node environment |

Rules: one branch per track, merge to `main` small and often (every 45 to 60 minutes), pull `main` before each new task, every merge comes with a two-line "how to test". Every feature has a keyboard or debug toggle so it can be tested without phones.

## Routes

`/` landing, `/scene` the projector PC, `/play?room=CODE` a phone. One Vite app; each route is a dynamic import so phones never download Three.js or Rapier.
