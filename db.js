// db.js
// The "forever" JSON database for Riot-API match stats. Persists to a single JSON
// file. The core accumulator is durable across app runs:
//   • matches – map of matchId -> game, append-only + de-duplicated (the honest
//               "attempts" counter that only ever grows as you play & sync). Each
//               game also carries its performance mark and the teammates it was
//               played with, so per-champion averages and duo detection are just a
//               fold over this map.
//
// No electron import — the file path is injected so this module is unit-testable.

'use strict';

const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 2;

function emptyState() {
  return {
    schema: SCHEMA_VERSION,
    player: { region: 'eune', gameName: '', tagLine: '', profileIconId: null, iconDataUrl: null },
    riot: { apiKey: '', puuid: '', puuidFor: '' },
    ddragonVersion: null,
    lastSync: null,
    lastSyncStatus: null,
    matches: {},
    debug: {},
  };
}

class StatsDB {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = emptyState();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.state = Object.assign(emptyState(), parsed);
      // ensure the icon fields exist on players stored by older versions
      if (!this.state.player) this.state.player = emptyState().player;
      if (this.state.player.profileIconId === undefined) this.state.player.profileIconId = null;
      if (this.state.player.iconDataUrl === undefined) this.state.player.iconDataUrl = null;
    } catch {
      this.state = emptyState(); // first run / missing file
    }
    return this;
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = this.filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.filePath); // atomic-ish write
    return this;
  }

  getPlayer() { return this.state.player; }
  setPlayer(player) {
    const prev = this.state.player || {};
    const next = {
      region: String(player.region || 'eune').toLowerCase(),
      gameName: String(player.gameName || '').trim(),
      tagLine: String(player.tagLine || '').replace(/^#/, '').trim(),
      profileIconId: prev.profileIconId ?? null,
      iconDataUrl: prev.iconDataUrl ?? null,
    };
    // switching to a different Riot ID/region invalidates the cached picture
    const idChanged = next.region !== prev.region || next.gameName !== prev.gameName || next.tagLine !== prev.tagLine;
    if (idChanged) { next.profileIconId = null; next.iconDataUrl = null; }
    this.state.player = next;
    return this.state.player;
  }

  /** Store the player's summoner picture (as a data: URL) + which icon it is. */
  setIcon(dataUrl, iconId, version) {
    this.state.player.iconDataUrl = dataUrl || null;
    this.state.player.profileIconId = iconId != null ? Number(iconId) : null;
    if (version) this.state.ddragonVersion = version;
    return this.state.player;
  }

  // ---- Riot API key + cached PUUID ----
  getRiot() { return this.state.riot || (this.state.riot = { apiKey: '', puuid: '', puuidFor: '' }); }
  setRiotKey(apiKey) { this.getRiot().apiKey = String(apiKey || '').replace(/\s+/g, ''); return this.getRiot(); }
  /** Cache the PUUID against the Riot ID it belongs to, so a name change re-resolves. */
  setPuuid(puuid, forId) { const r = this.getRiot(); r.puuid = puuid || ''; r.puuidFor = forId || ''; return r; }
  playerId() { const p = this.state.player; return `${p.region}:${p.gameName}#${p.tagLine}`.toLowerCase(); }

  /**
   * Merge freshly-fetched games. New matches are added; matches we already had are
   * UPSERTED — we fill in the richer fields (mark / team / cs …) if the stored copy
   * predates them, but never touch the win/loss counts (derive recomputes those).
   * Returns { added, enriched }.
   */
  upsertGames(games) {
    let added = 0, enriched = 0;
    for (const g of games || []) {
      if (!g || g.matchId == null) continue;
      const id = String(g.matchId);
      const existing = this.state.matches[id];
      if (!existing) {
        this.state.matches[id] = normalizeGame(g);
        added++;
      } else if (existing.mark == null && g.mark != null) {
        // back-fill an old, markless record with the new richer data
        const fresh = normalizeGame(g);
        existing.mark = fresh.mark;
        existing.team = fresh.team;
        if (existing.cs == null) existing.cs = fresh.cs;
        if (existing.durationSec == null) existing.durationSec = fresh.durationSec;
        if (!existing.position) existing.position = fresh.position;
        enriched++;
      }
    }
    return { added, enriched };
  }

  /** Match IDs of stored games that still have no mark, newest first (for back-fill). */
  getEnrichIds() {
    return Object.entries(this.state.matches)
      .filter(([, m]) => m && m.mark == null)
      .sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0))
      .map(([id]) => id);
  }

  markSync(status) {
    this.state.lastSync = status && status.at ? status.at : new Date().toISOString();
    this.state.lastSyncStatus = status || null;
  }

  /**
   * Derive everything the UI needs from the stored matches:
   *   • champions – per-champion lifetime stats (record, KDA, avg mark …)
   *   • matches   – the recent match list (newest first), each tagged with its duo
   *   • summary   – overall counts, overall avg mark, the player, and top duos
   * `nameToKey` maps a champion name -> numeric key for games that only carry a name.
   */
  derive(nameToKey) {
    const byKey = {};
    const ensure = (key) => (byKey[key] || (byKey[key] = {
      key, gamesTracked: 0, wins: 0, losses: 0,
      kills: 0, deaths: 0, assists: 0,
      markSum: 0, markCount: 0, lastPlayed: null, byQueue: {},
    }));

    // flatten the match map into a newest-first array we can fold and also return
    const matchesArr = Object.entries(this.state.matches).map(([id, m]) => ({
      matchId: id,
      champKey: resolveKey(m, nameToKey),
      champName: m.champName || null,
      win: typeof m.win === 'boolean' ? m.win : null,
      kills: nn(m.kills), deaths: nn(m.deaths), assists: nn(m.assists),
      cs: m.cs != null ? nn(m.cs) : null,
      durationSec: m.durationSec != null ? nn(m.durationSec) : null,
      queue: m.queue || 'OTHER',
      createdAt: m.createdAt || null,
      position: m.position || null,
      mark: m.mark && typeof m.mark.score === 'number' ? { score: m.mark.score, grade: m.mark.grade || null } : null,
      team: Array.isArray(m.team) ? m.team : null,
    })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    // ---- per-champion fold + overall mark tally ----
    let overallMarkSum = 0, overallMarkCount = 0;
    for (const m of matchesArr) {
      if (m.mark) { overallMarkSum += m.mark.score; overallMarkCount++; }
      if (!m.champKey) continue;
      const s = ensure(m.champKey);
      s.gamesTracked++;
      if (m.win === true) s.wins++; else if (m.win === false) s.losses++;
      s.kills += m.kills; s.deaths += m.deaths; s.assists += m.assists;
      if (m.mark) { s.markSum += m.mark.score; s.markCount++; }
      if (m.createdAt && (!s.lastPlayed || m.createdAt > s.lastPlayed)) s.lastPlayed = m.createdAt;
      const qb = s.byQueue[m.queue] || (s.byQueue[m.queue] = { play: 0, win: 0, lose: 0 });
      qb.play++; if (m.win === true) qb.win++; else if (m.win === false) qb.lose++;
    }

    // ---- duo detection: who recurs on the player's side, across all games ----
    const { duos, duoByPuuid } = computeDuos(matchesArr);
    const duoPuuids = new Set(duos.map((d) => d.puuid));
    for (const m of matchesArr) {
      m.duo = null;
      if (!m.team) continue;
      let best = null, bestGames = -1;
      for (const t of m.team) {
        if (t && duoPuuids.has(t.puuid) && duoByPuuid[t.puuid].games > bestGames) {
          bestGames = duoByPuuid[t.puuid].games;
          best = { name: t.name, tag: t.tag, champName: t.champName, champKey: t.champKey };
        }
      }
      m.duo = best;
    }

    // ---- finalize champions ----
    const champions = {};
    for (const s of Object.values(byKey)) {
      const wl = s.wins + s.losses;
      const kda = s.deaths ? (s.kills + s.assists) / s.deaths : (s.kills + s.assists);
      champions[s.key] = {
        key: s.key,
        attempts: s.gamesTracked,
        gamesTracked: s.gamesTracked,
        wins: s.wins, losses: s.losses,
        winRate: wl ? Math.round((s.wins / wl) * 100) : null,
        kills: s.kills, deaths: s.deaths, assists: s.assists,
        avgKills: s.gamesTracked ? +(s.kills / s.gamesTracked).toFixed(1) : 0,
        avgDeaths: s.gamesTracked ? +(s.deaths / s.gamesTracked).toFixed(1) : 0,
        avgAssists: s.gamesTracked ? +(s.assists / s.gamesTracked).toFixed(1) : 0,
        kda: +kda.toFixed(2),
        avgMark: s.markCount ? +(s.markSum / s.markCount).toFixed(1) : null,
        markedGames: s.markCount,
        lastPlayed: s.lastPlayed,
        byQueue: s.byQueue,
      };
    }

    const played = Object.values(champions).filter((c) => c.attempts > 0).length;
    return {
      champions,
      matches: matchesArr.slice(0, 300),
      summary: {
        championsPlayed: played,
        totalGamesTracked: matchesArr.length,
        avgMark: overallMarkCount ? +(overallMarkSum / overallMarkCount).toFixed(1) : null,
        markedGames: overallMarkCount,
        lastSync: this.state.lastSync,
        lastSyncStatus: this.state.lastSyncStatus,
        player: this.state.player,
        duos,
      },
    };
  }
}

/** Tally recurring teammates across all games. Returns duos (>=2 games) + lookup. */
function computeDuos(matchesArr) {
  const tally = {};
  for (const m of matchesArr) {
    if (!Array.isArray(m.team)) continue;
    for (const t of m.team) {
      if (!t || !t.puuid) continue;
      const d = tally[t.puuid] || (tally[t.puuid] = { puuid: t.puuid, name: t.name || '', tag: t.tag || '', games: 0, wins: 0, markSum: 0, markCount: 0 });
      d.games++;
      if (m.win === true) d.wins++;
      if (m.mark) { d.markSum += m.mark.score; d.markCount++; }
      if (t.name) { d.name = t.name; d.tag = t.tag || d.tag; } // keep the latest known name
    }
  }
  const duos = Object.values(tally)
    .filter((d) => d.games >= 2)
    .sort((a, b) => b.games - a.games || b.wins - a.wins)
    .slice(0, 8)
    .map((d) => ({
      puuid: d.puuid, name: d.name, tag: d.tag,
      games: d.games, wins: d.wins, losses: d.games - d.wins,
      winRate: d.games ? Math.round((d.wins / d.games) * 100) : null,
      avgMark: d.markCount ? +(d.markSum / d.markCount).toFixed(1) : null,
    }));
  return { duos, duoByPuuid: tally };
}

function normalizeGame(g) {
  return {
    champKey: g.champKey != null ? Number(g.champKey) : null,
    champName: g.champName || null,
    win: typeof g.win === 'boolean' ? g.win : null,
    kills: nn(g.kills), deaths: nn(g.deaths), assists: nn(g.assists),
    cs: g.cs != null ? nn(g.cs) : null,
    durationSec: g.durationSec != null ? nn(g.durationSec) : null,
    queue: g.queue || null,
    createdAt: g.createdAt || null,
    position: g.position || null,
    mark: g.mark && typeof g.mark.score === 'number' ? { score: g.mark.score, grade: g.mark.grade || null } : null,
    team: Array.isArray(g.team) ? g.team.map((t) => ({
      puuid: t.puuid, name: t.name || '', tag: t.tag || '',
      champKey: t.champKey != null ? Number(t.champKey) : null, champName: t.champName || null,
    })) : null,
  };
}

function resolveKey(m, nameToKey) {
  let key = m.champKey;
  if ((key == null || key === 0) && m.champName && nameToKey) key = nameToKey[normName(m.champName)];
  return key ? Number(key) : null;
}

function nn(v) { const x = Number(v); return Number.isFinite(x) ? x : 0; }
function normName(s) { return String(s).toLowerCase().replace(/[^a-z0-9]/g, ''); }

module.exports = { StatsDB, emptyState, SCHEMA_VERSION };
