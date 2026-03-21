# Lucent Angular

Angular port of the **`specula/`** globe prototype: [globe.gl](https://github.com/vasturiano/globe.gl) with the same behavior as `specula/index.html`.

## Features

- Black full-viewport canvas / scene background; **lucent.earth** title (JetBrains Mono bold) top-left
- **Carto** `light_all` XYZ tiles (slippy map) when zoomed in
- **Zoom gating**: zoomed out → country fill + borders; zoomed in → map tiles, overlay hidden; **auto-rotate stops** in map mode
- **LucentApi** streams: `GET /api/streams` (via dev **proxy** to `http://localhost:5264`) → clickable **globe points** → sidebar with thumbnail + **Twitch** embed (`player.twitch.tv`)
- Natural Earth **GeoJSON** countries (excluding Antarctica) + derived border paths

## Run

1. Start **LucentApi** (default `http://localhost:5264`).
2. Frontend:

```bash
cd lucent-angular
npm install
npm start
```

`ng serve` uses `proxy.conf.json` so `/api/*` is forwarded to the API. Open the URL shown (usually `http://localhost:4200`).

**Production:** set `streamsUrl` in `src/environments/environment.ts` to your API’s `/api/streams` URL and add that origin to **CORS** in `LucentApi` (see `Program.cs`). Twitch embeds require `parent=` to include your site hostname (the sidebar adds `window.location.hostname` plus `localhost` / `127.0.0.1`).

## Build

```bash
npm run build
```

Output: `dist/lucent-angular/`. Bundle size limits in `angular.json` are raised for **Three.js** + **globe.gl** (~2 MB raw).

## Code

- `src/app/globe-view/globe-view.component.ts` — globe setup (runs inside `NgZone.runOutsideAngular` to avoid change-detection churn from the render loop), streams + point clicks
- `src/app/stream-sidebar/` — stream detail panel + Twitch iframe
- `proxy.conf.json` — dev proxy `/api` → LucentApi
- `specula/index.html` — original reference implementation
