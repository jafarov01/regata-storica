# Gondola Royale

A browser party deathmatch for 4 to 18 people in one room. Teams crew armed gondolas in a 3D Venice shown on one big screen; their phones are the controllers. One hit sinks a boat, a sunk boat is back in 5 seconds, and after 5 minutes the team with the most kills wins.

- `SPEC.md`: the full game spec and hackathon plan (source of truth).
- `HANDOFF.md`: current state of the repo, how to run it, what to do next. **Start here.**
- `ARCHITECTURE.md`: how the parts fit, the conventions (coordinates, time, lost packets), module status, settled decisions.
- `docs/TASKS.md`: who does what. Three modules (phones & network, gameplay & HUD, graphics & assets), order of work, gates. Task lists: `docs/TASKS-A.md`, `docs/TASKS-B.md`, `docs/TASKS-C.md`.
- `docs/CHALLENGES.md`: the hard parts and their solutions, with pointers into `docs/research/`.
- `docs/ASSETS.md`: every asset with its file name and a ready-to-paste prompt (images for ChatGPT / Gemini, sound effects for AI audio tools, or where to download).

## Quick start

```bash
npm install
npm run dev
```

Open http://localhost:5173/scene on the PC. Without phones: **K** adds a keyboard crew, **Enter** starts, **WASD** drives, **arrows** aim. To try the phone UI on a desktop, open `/play?room=CODE&sim=1`. Real phones need HTTPS for motion sensors: run `npm run tunnel` (needs `brew install cloudflared`), open the scene on the tunnel URL and scan its QR. See `docs/CHALLENGES.md` for the HTTPS options.

## Scripts

| Script | Does |
|---|---|
| `npm run dev` | Vite dev server (5173) + relay (`RELAY_PORT`, default 3000, proxied under `/socket.io`) |
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
| `src/scene/` | Track B | game loop, layout, HUD, phone HUD feed, keyboard harness |
| `src/render/` | Track C | world, water, boats, crew, VFX, audio, camera rigs |
| `public/assets/` | Track C | models, textures, sounds |
| `tests/` | the folder's owner | Vitest, node environment |

Rules: one branch per track, merge to `main` small and often (every 45 to 60 minutes), pull `main` before each new task, every merge comes with a two-line "how to test". Every feature has a keyboard or debug toggle so it can be tested without phones.

## Routes

`/` landing, `/scene` the projector PC, `/play?room=CODE` a phone. One Vite app; each route is a dynamic import so phones never download Three.js or Rapier.
