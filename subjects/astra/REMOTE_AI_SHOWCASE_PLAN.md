# Remote AI Showcase Plan

## Recommendation

Build a spectator-only ASTRA URL and expose it privately through **Tailscale Serve**.

The project is a client-side Vite/Three.js application with no backend, WebSocket, database, or server-owned simulation state. Its current production bundle is about 618 KB. The best remote experience is therefore to send the site to the phone and let the phone render the AI race. This is more reliable than screen video, has almost no ongoing upload cost, and keeps the showcase responsive on mobile data.

The intended URL would look like:

```text
https://<pc-name>.<tailnet>.ts.net/?showcase=1
```

Tailscale Serve makes a local port available over a private HTTPS address to devices in the same tailnet. It does not require router port forwarding and does not expose the page to the public internet. The phone must have Tailscale connected, and the PC must remain awake and online. See the official [Tailscale local-server guide](https://tailscale.com/docs/use-cases/application-testing/share-local-dev-server-with-team) and [Serve command reference](https://tailscale.com/docs/reference/tailscale-cli/serve).

## What should be added to ASTRA

The existing **WATCH AI RACE** action already starts autopilot, opens the race engineer, and selects the engineer camera. A small showcase mode can reuse that path:

- `?showcase=1` automatically starts an AI race after the page loads.
- Player driving input is ignored for the whole session, so the remote view cannot accidentally become a player session.
- The interface hides the driving help and manual-control prompts while preserving camera, telemetry, pause, and race-engineer views.
- A finished race displays results briefly, then starts the next AI race automatically.
- Mobile showcase mode defaults to performance quality, a capped device-pixel ratio, muted audio, and the engineer camera. The viewer can still change camera and observed AI car.
- A visible connection/status strip explains when the host is unavailable or the phone is offline.
- Optional query settings can select laps, field size, camera, and race/qualifying pace, for example `?showcase=1&laps=10&field=8&camera=engineer`.

The app already has responsive CSS and limits normal rendering to 1.5 device pixels. It has no touch-driving controls, which is fine for a spectator-only experience. The mobile pass should focus on making the race engineer, timing tower, and camera button readable in landscape orientation.

## Private setup on this PC

Tailscale, Cloudflare Tunnel, OBS, and Sunshine are not currently installed. Windows Package Manager is available.

After installing and signing into Tailscale on the PC and phone, the host sequence would be:

```powershell
npm run build
npm run preview
tailscale serve --bg 4173
tailscale serve status
```

The existing preview command listens only on `127.0.0.1:4173`, which is appropriate: Tailscale Serve proxies that local service to the private tailnet URL. The `--bg` configuration persists across Tailscale restarts according to the current [Serve documentation](https://tailscale.com/docs/reference/tailscale-cli/serve#effects-of-rebooting-and-restarting). A project script can wrap build/start/health checks, but Tailscale authentication should remain outside the repository.

For dependable away-from-home use:

- Keep the PC on mains power, disable automatic sleep while the showcase is enabled, and use wired Ethernet if possible.
- Configure the app server to start after Windows login and verify it locally before leaving.
- Bookmark the private `https://*.ts.net/?showcase=1` address on the phone.
- Use `tailscale serve reset` when remote access is no longer wanted.

## If the exact PC-rendered picture is required

Use **Sunshine** on the PC and **Moonlight** on the phone, preferably reached over Tailscale. Sunshine is a self-hosted, low-latency streaming host that supports hardware encoding on AMD, Intel, and Nvidia GPUs; Moonlight is its mobile client. This sends the actual PC display rather than running ASTRA on the phone. See [Sunshine's official overview](https://docs.lizardbyte.dev/projects/sunshine/latest/) and the [Moonlight setup guide](https://github.com/moonlight-stream/moonlight-docs/wiki/Setup-Guide).

This route is useful if the phone cannot sustain the Three.js scene or if exact desktop visuals are the priority. It needs more setup, continuous home upload bandwidth, client pairing, and the PC display/session must stay active. The ASTRA spectator flag should still be used so the page always runs AI and ignores player controls. Moonlight recommends leaving the host awake for reliable internet access and using a wired host connection where possible.

## Other workable routes

| Route | Best use | Privacy | Main drawback |
| --- | --- | --- | --- |
| Tailscale Serve + phone-rendered showcase | Personal viewing from anywhere | Private to the tailnet | Phone must render Three.js |
| Sunshine + Moonlight + Tailscale | Exact PC video, low latency | Private to paired devices/tailnet | More software and upload bandwidth |
| Named Cloudflare Tunnel + Access | Share a browser link with selected people | Authenticated public edge | Account/domain and access-policy setup |
| Cloudflare Quick Tunnel | One-off testing | Random public URL | Officially intended only for testing |
| OBS to an unlisted streaming platform | Passive viewing by many people | Platform-controlled link | Higher latency, third-party account, continuous video upload |

Cloudflare Tunnel uses outbound connections and does not need inbound router ports. Its quick-tunnel command creates a random public URL, but Cloudflare explicitly describes Quick Tunnels as testing-only; a named tunnel plus Access authentication is the appropriate version for ongoing sharing. See the [Cloudflare Tunnel setup documentation](https://developers.cloudflare.com/tunnel/setup/).

## Proposed delivery order

1. Implement and test `?showcase=1`, automatic race cycling, input lockout, and the landscape mobile layout.
2. Add a `showcase` launch script and local health check without embedding credentials.
3. Install Tailscale on the PC and phone, sign both into the same tailnet, and publish port 4173 with Serve.
4. Test first on home Wi-Fi, then with the phone on cellular data.
5. Add Sunshine/Moonlight only if phone rendering proves too slow or exact PC video is required.

This gives the simplest secure result first and leaves a real video-streaming upgrade path without redesigning the AI simulation.
