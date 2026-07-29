# League of Legends Champ Tracker

A local-first League of Legends match tracker. It pulls your match history straight from the
**official Riot Games API**, grades every game against the nine other players who were actually
in that lobby, finds who you duo with, and stores the lot in a JSON file on your own disk.

No account, no server, no scraping. Your API key and your data never leave your machine.

![Electron](https://img.shields.io/badge/Electron-33-2b2a27) ![Riot API](https://img.shields.io/badge/data-Riot%20API%20only-d97757)

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

Prebuilt Windows binary and full setup docs: **[the website](https://github.com/YOURNAME/lol-tracker-site)**
(or run it from source below).

You need a free Riot API key. Sign in at [developer.riotgames.com](https://developer.riotgames.com),
copy the `RGAPI-…` development key, then in the app hit **Change**, enter your Riot ID + region,
paste the key, press **Test**, then **Sync**.

> Development keys expire every 24 hours and die the moment you regenerate them. A 403 almost
> always means "get a fresh key". Apply for a Personal key on the portal to stop the expiry.

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
