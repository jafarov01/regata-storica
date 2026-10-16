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

## 3. A VPS (fastest: use this when the venue's upload is slow)

The tunnel serves every file from the scene PC, so the venue's **upload** speed caps loading: at 157 KB/s (measured at Via Falchi) the 4 MB big-screen bundle took over a minute and phones queued behind it. On a VPS the files come from the server's own connection: the big screen loaded in 2 s, phones in 0.2 s.

**Taken down after the event (2026-10-16 evening).** It ran on the Hostinger VPS `vps-fyce` next to Coolify: one Docker container (`Dockerfile`, the relay serving the built game on port 3000) behind Coolify's Traefik, which added HTTPS (Let's Encrypt) and gzip, on the name `gondola.179-198-200-73.sslip.io` (`sslip.io` resolves to the VPS IP, no DNS record needed). To bring it back, from a machine with the `vps-fyce` SSH alias:

```bash
ssh vps-fyce 'git clone https://github.com/jafarov01/regata-storica.git /opt/gondola-royale && cd /opt/gondola-royale && docker build -t gondola-royale .'
```

then put this at `/opt/gondola-royale-run.sh` on the VPS (`chmod +x`) and run it; rerun it after every `git pull && docker build`:

```sh
#!/bin/sh
set -e
# No HTTP/3: Traefik advertises QUIC and browsers that switched to it lost every bundle with
# ERR_QUIC_PROTOCOL_ERROR. Dropping UDP 443 makes them fall back to HTTP/2 (all apps on the host).
iptables -C DOCKER-USER -p udp --dport 443 -j DROP 2>/dev/null || iptables -I DOCKER-USER 1 -p udp --dport 443 -j DROP
HOST='gondola.179-198-200-73.sslip.io'
docker rm -f gondola-royale >/dev/null 2>&1 || true
docker run -d --name gondola-royale --restart unless-stopped --network coolify \
  -l traefik.enable=true -l traefik.docker.network=coolify \
  -l "traefik.http.routers.gondola-http.rule=Host(\`$HOST\`)" -l traefik.http.routers.gondola-http.entrypoints=http \
  -l traefik.http.routers.gondola-http.middlewares=gondola-https -l traefik.http.routers.gondola-http.service=gondola \
  -l traefik.http.middlewares.gondola-https.redirectscheme.scheme=https \
  -l "traefik.http.routers.gondola.rule=Host(\`$HOST\`)" -l traefik.http.routers.gondola.entrypoints=https \
  -l traefik.http.routers.gondola.tls.certresolver=letsencrypt -l traefik.http.routers.gondola.middlewares=gondola-gzip,gondola-noh3 \
  -l traefik.http.routers.gondola.service=gondola -l traefik.http.middlewares.gondola-gzip.compress=true \
  -l "traefik.http.middlewares.gondola-noh3.headers.customResponseHeaders.Alt-Svc=" \
  -l traefik.http.services.gondola.loadbalancer.server.port=3000 \
  gondola-royale
```

Rooms live in memory: a redeploy closes open rooms, so redeploy between matches. To take it down again: `docker rm -f gondola-royale; docker rmi gondola-royale; rm -rf /opt/gondola-royale /opt/gondola-royale-run.sh; iptables -D DOCKER-USER -p udp --dport 443 -j DROP`.

## When the scene runs on localhost but phones use another address

Set `VITE_PUBLIC_ORIGIN` before `npm run dev`, for example `VITE_PUBLIC_ORIGIN=https://abc.trycloudflare.com npm run dev`; the QR then encodes that origin instead of `localhost`.
