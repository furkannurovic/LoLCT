<p align="center">
  <img src="https://raw.githubusercontent.com/furkannurovic/LoLCT/main/.github/social-preview.png" alt="LoL Champ Tracker — every game you've played, graded" width="100%">
</p>

# LoL Champ Tracker

A local-first League of Legends match tracker. It pulls your match history straight from the
**official Riot Games API**, grades every game against the nine other players who were actually
in that lobby, finds who you duo with, and stores the lot in a JSON file on your own disk.

No account, no server, no scraping. Your API key and your data never leave your machine.

![Electron](https://img.shields.io/badge/Electron-33-2b2a27) ![Riot API](https://img.shields.io/badge/data-Riot%20API%20only-d97757) [![Download](https://img.shields.io/badge/download-v1.2.0%20Windows-d97757)](https://github.com/furkannurovic/lolChampTracker/releases/latest)

## What it does

- **Per-game mark** — a 0–10 score and a letter grade (S+ → D). Seven metrics (KDA, kill
  participation, champion damage, gold, CS, vision, objective damage) are percentile-ranked
  *within that lobby*, so a support and a mid laner are judged on their own terms and no
  external "average player" data is needed.
- **Duo detection** — Riot exposes no party endpoint, so teammates are tallied across your
  whole history. Anyone on your side in two or more games is a real premade; randoms never repeat.
- **A-to-Z challenge mode** — flip a switch and the grid counts champions *won with* instead of
  played, with a tick per conquered champion.
- **Champion library** — all 173 champions with win rate, KDA, average mark and recent games.
- **Matches view** — every game with queue, role, KDA, CS, duration, duo tag and its mark.

## Install

Prebuilt Windows binary: **[latest release](https://github.com/furkannurovic/lolChampTracker/releases/latest)**
· Full setup docs: **[the website](https://lolchamptracker.pages.dev/)**
(or run it from source below).

You need your own free Riot API key. Sign in at [developer.riotgames.com](https://developer.riotgames.com)
with the account you play on, click **Register Product**, choose **Personal**, and describe what
you're building — that gets you a key that never expires. Then in the app hit **Change**, enter your
Riot ID + region, paste the `RGAPI-…` key, press **Test**, then **Sync**.

> Personal applications are reviewed by hand and can take days. In the meantime your dashboard
> already carries a **development key** that works immediately — it just expires every 24 hours,
> and the moment you regenerate it. A 403 on a dev key almost always means "get a fresh one".
>
> Both key types have the same rate limit (20 req/sec, 100 req/2 min). A personal key buys you
> no extra headroom — only the end of the daily expiry.

## Run from source

Requires Node.js LTS. Nothing native compiles.

```bash
npm install
npm start
```

## Build

```bash
npm run dist:win    # portable dist/LoL-Champ-Tracker.exe
npm run dist:mac    # dmg + zip, arm64 and x64, into dist/
```

Both targets are **unsigned** — there's no code-signing certificate behind this project, so
Windows SmartScreen and macOS Gatekeeper will warn on first launch. macOS builds must be made
on macOS; Apple's packaging tools don't cross-build.

Regenerating generated assets:

```bash
node fetch-data.js   # refresh champions.json + champions-data.js + icons from Data Dragon
npm run icons        # regenerate build/icon.ico (256) and build/icon.png (1024, for .icns)
```

## Layout

| File | Role |
|---|---|
| `main.js` | Electron main process — window, IPC, **all networking happens here** |
| `riot.js` | Every Riot API call, the mark calculation, Data Dragon fetches |
| `db.js` | The JSON database — storage, roll-ups, duo detection |
| `preload.js` | The `window.lol` context bridge — the renderer's only route out |
| `renderer.js` / `index.html` / `styles.css` | The UI. No network access of its own |
| `champions-data.js` | All champions as a global — a `file://` page can't `fetch()` local JSON |

The renderer runs under `default-src 'self'`, so every request goes through the main process.

## Your data

One JSON file, rewritten after each sync:

- **Windows** — `%APPDATA%\lol-champ-tracker\stats-db.json`
- **macOS** — `~/Library/Application Support/lol-champ-tracker/stats-db.json`

It holds your matches, your Riot ID and **your API key in plain text**. That's fine for a local
tool, but don't commit it or share it — if you ever leak a key, regenerate it on the portal,
which instantly kills the old one. Delete the file to reset the app completely.

## Notes

Riot's terms rule out sharing keys, working around rate limits, charging for access, and anything
that affects live gameplay. This app ships no bundled key and backs off on a 429.

---

LoL Champ Tracker isn't endorsed by Riot Games and doesn't reflect the views or opinions of Riot
Games or anyone officially involved in producing or managing Riot Games properties. Riot Games and
all associated properties are trademarks or registered trademarks of Riot Games, Inc.
