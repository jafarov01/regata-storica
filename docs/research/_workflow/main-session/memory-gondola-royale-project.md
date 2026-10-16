---
name: gondola-royale-project
description: "Gondola Royale (repo regata-storica) is a 6-hour, 3-person hackathon browser party game; spec lives in SPEC.md, hard-part solutions in docs/CHALLENGES.md"
metadata:
  node_type: memory
  type: project
  originSessionId: 69884729-7585-4b5d-ad26-4af5e194adaa
  modified: 2026-10-16T11:23:51.785Z
---

Gondola Royale is a browser party deathmatch (phones as controllers, one PC renders a 3D Venice split screen) built for a 3-person, ~6-hour hackathon. The repo at `~/Documents/regata-storica` was scaffolded from the spec "Gondola Royale Game Spec & Hackathon Plan.docx" (Downloads, dated 2026-10-16, author "Mex") on 2026-10-16. The spec itself is committed as SPEC.md; the folder ownership is Track A (server/, src/net/, src/phone/, src/landing/), Track B (src/sim/, src/scene/), Track C (src/render/, public/assets/), with shared/ read-only contract files.

**Why:** Makhlug asked for the full repo base with the difficult parts (iOS sensors, gyro aim, 4-viewport frame rate, relay/reconnect, Rapier 2D boats, the ASCII map) solved up front, so the three hackathon tracks can start in parallel.

**How to apply:** Treat SPEC.md as the source of truth and shared/ as the contract; keep docs/CHALLENGES.md in step when a solution changes. Pinned TypeScript 5.9 (not 7) on purpose for toolchain stability.
