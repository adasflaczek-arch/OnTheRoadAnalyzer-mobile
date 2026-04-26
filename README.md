# On The Road Analyzer — DeX Edition

A browser-based PWA port of your PyQt6 desktop analyzer. Designed to install to
your Samsung Tab A11+ home screen and run in DeX mode like a native app.

## What it does (V0.1)

- Multi-CSV import from your Tuner (`t_ms, afr, rpm, tps_deg`)
- Three vertically stacked, X-linked plots (AFR, RPM, TPS%)
- Per-session: visibility toggle, color cycle, time offset, TPS calibration
  (with modular wraparound for the 0/360° crossing case)
- AFR / λ display toggle
- Drag-to-select a time range on any plot → opens floating
  TPS→λ and RPM→λ transfer plot windows with binned averages
- CSV + PNG export from the transfer windows
- PNG export of the main 3-plot stack
- Offline-capable PWA (works on the tablet without WiFi after first install)

## File list

```
index.html       Main page
styles.css       AEM-style dark/orange theme
app.js           All app logic
manifest.json    PWA manifest (install metadata)
sw.js            Service worker (offline cache)
icon.svg         Vector icon
icon-192.png     PWA icon
icon-512.png     PWA icon
```

## Hosting options

Pick whichever you prefer. The app is fully static — no backend needed.

### Option A — GitHub Pages (recommended)

1. Push these files to a public GitHub repo
2. Settings → Pages → Source: `main` / root
3. Open `https://YOUR_USERNAME.github.io/REPO/` on the Tab A11+

### Option B — Local quick test

```
cd dex-analyzer
python3 -m http.server 8080
```

Then open `http://YOUR_PC_IP:8080/` from the tablet on the same WiFi.

### Option C — Serve from the ESP32

Service workers and PWA install require **HTTPS or localhost**. The ESP32 AP
gives you `http://192.168.4.1`, which most browsers treat as insecure → the
PWA install banner will not appear and the service worker will not register.
The app itself still works as a regular page, but you lose offline + home-screen
install. Stick with GitHub Pages for the proper PWA experience.

## Installing to DeX

1. On the Tab A11+, open Chrome and navigate to your hosted URL
2. Tap the ⋮ menu → "Install app" (or "Add to Home screen")
3. Switch to DeX mode (HDMI to monitor or DeX-capable dock)
4. The "OTR Analyzer" icon is now on the DeX desktop
5. Double-click → opens in its own standalone window, no browser chrome

## Workflow

1. After a session, connect tablet to `OnTheRoadTuner` AP
2. In Chrome, go to `http://192.168.4.1/log/full.csv?clear=1`
   (downloads + atomically wipes the ESP32 log)
3. Reconnect tablet to your normal WiFi (or stay on the AP — the PWA is cached)
4. Open OTR Analyzer → IMPORT CSV → pick the file
5. Calibrate TPS (CAL button on the session) — set "Closed" to the angle you
   see when the throttle is at idle, "WOT" to the angle at full throttle
6. Drag-select a range on any plot → transfer plot windows pop up
7. Export PNG / CSV as needed

## TPS calibration notes

The calibration uses modular arithmetic, so closed=300° and WOT=40° (crossing
0/360°) is handled correctly. Overshoot and undershoot are intentionally
unclamped so you can see when the magnet position drifts past your reference
points.

## Differences from the desktop app

Same logic, slightly different ergonomics:

- Range select uses **drag-to-select** (uPlot's native gesture) instead of
  two-click. Faster on a touchscreen too.
- Transfer windows are draggable + resizable floating panels rather than
  separate top-level OS windows.
- No "align to cursor" tool yet — let me know if you want it back.

## Tech stack

- Plain HTML + CSS + vanilla JS (no build step)
- [uPlot](https://github.com/leeoniya/uPlot) — fast canvas charting
- [PapaParse](https://www.papaparse.com/) — CSV parsing
- Service Worker for offline cache

Total payload (gzipped, after first load): ~80KB.

## Known limitations / TODO

- No "align to cursor" tool yet
- No persistent saved state across reloads (calibrations are per-session)
- Range-select shaded band is not drawn persistently on the plots
- Bin tolerances (±0.5 % TPS, ±50 RPM, min 3 samples) are hard-coded — should
  be configurable in a settings drawer eventually
- No Lambda/AFR redline shading on the AFR plot yet
