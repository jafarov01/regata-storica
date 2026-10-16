# Hosting: tunnel first, Render as the backup

Phones need HTTPS for motion sensors. Two ways to get it; both serve the same app and relay.

## 1. Tunnel from the scene PC (default for the demo)

```bash
npm run dev        # terminal 1: Vite :5173 + relay :3000
npm run tunnel     # terminal 2: prints https://<random>.trycloudflare.com
```

Open `https://<random>.trycloudflare.com/scene` on the scene PC so the QR carries the https address. The URL changes on every tunnel restart. For the demo itself, a production build is faster and does not reload on file changes:

```bash
npm run preview          # build + relay serving dist/ on :3000
npm run tunnel:prod      # tunnel to :3000
```

Install once: `brew install cloudflared` (macOS) or see Cloudflare's downloads page.

## 2. Render (backup if the venue blocks the tunnel)

The repo has a `render.yaml` blueprint: one Node web service that runs `npm ci && npm run build`, then `npm start` (the relay serves `dist/` and Socket.IO on Render's `PORT`), with `/api/health` as the health check.

1. render.com, New, Blueprint, pick the GitHub repo `jafarov01/regata-storica`, branch `main`. Accept the defaults.
2. Wait for the first deploy (about 2 to 3 minutes), then open `https://<service>.onrender.com/scene`.
3. Phones scan the QR as usual; the QR uses the page's own origin, so no extra setting is needed.

Notes:
- The free plan sleeps after 15 minutes without traffic; open the URL a minute before the demo. WebSockets work on all plans.
- Rooms live in memory: a redeploy closes every room. Do not push to `main` during the demo.
- Check it is up: `curl https://<service>.onrender.com/api/health` returns `{"ok":true,...}`. `GET /api/rooms/<CODE>` says whether a room exists (the phone join form uses it).

## When the scene runs on localhost but phones use another address

Set `VITE_PUBLIC_ORIGIN` before `npm run dev`, for example `VITE_PUBLIC_ORIGIN=https://abc.trycloudflare.com npm run dev`; the QR then encodes that origin instead of `localhost`.
