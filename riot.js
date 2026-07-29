// riot.js
// Fetches match history from the OFFICIAL Riot Games API (main process only).
// This is the reliable, complete, all-queues source — every ranked/normal/ARAM/
// arena game, with exact per-champion K/D/A. Needs a free API key from
// https://developer.riotgames.com (paste it in the app).
//
// Flow:  Riot ID -> PUUID (account-v1)  ->  match IDs (match-v5)  ->  match detail.
// Champion is identified by numeric championId (== Data Dragon `key`).
//
// On top of the raw match we also derive, per game:
//   • mark   – a 0–10 performance score + letter grade, computed by ranking the
//              player against every other participant in that same lobby (so it
//              self-normalises across roles and needs no external data).
//   • team   – the player's teammates (name + champion), used to detect duos.
//   • icon   – the player's summoner-icon id, so the app can show their picture.

'use strict';

const https = require('https');

// LoL platform code (eune/euw/na…) -> Riot regional route for account-v1/match-v5.
const REGIONAL = {
  eune: 'europe', euw: 'europe', tr: 'europe', ru: 'europe',
  na: 'americas', br: 'americas', lan: 'americas', las: 'americas',
  oce: 'sea', kr: 'asia', jp: 'asia', vn: 'sea', ph: 'sea', sg: 'sea', th: 'sea', tw: 'sea',
};

// Common queueId -> friendly bucket name (matches the app's queue labels).
const QUEUES = {
  400: 'NORMAL', 430: 'NORMAL', 490: 'NORMAL', 420: 'SOLORANKED', 440: 'FLEXRANKED',
  450: 'ARAM', 700: 'CLASH', 720: 'ARAM', 900: 'URF', 1020: 'URF', 1900: 'URF',
  1700: 'ARENA', 1710: 'ARENA', 830: 'BOT', 840: 'BOT', 850: 'BOT', 0: 'CUSTOM',
};

function regionalOf(region) { return REGIONAL[String(region || '').toLowerCase()] || 'europe'; }
function n(v) { const x = Number(v); return Number.isFinite(x) ? x : 0; }

/** GET JSON with the Riot key header. Returns { status, data } or throws on network error. */
function getJSON(url, key) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'X-Riot-Token': key, 'Accept': 'application/json' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = body ? JSON.parse(body) : null; } catch { /* leave null */ }
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('Riot API request timed out')));
  });
}

/** GET raw bytes (no Riot key) — used for the public Data Dragon CDN (icons/versions). */
function getBuffer(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'Accept': '*/*' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('CDN request timed out')));
  });
}

function friendlyError(status, data) {
  const riot = data && data.status && data.status.message ? ` — Riot says: "${data.status.message}"` : '';
  if (status === 403) return `Riot rejected the key (403). Development keys EXPIRE every 24h and die the moment you regenerate — open developer.riotgames.com, regenerate, and paste the brand-new RGAPI-… key${riot}.`;
  if (status === 401) return `Riot got no valid key (401). Make sure you pasted the FULL development key starting with "RGAPI-"${riot}.`;
  if (status === 404) return `Riot ID not found for this region — check the name, #tag and region${riot}.`;
  if (status === 429) return 'Riot API rate limit hit — wait a minute and sync again.';
  if (status === 415 || status === 400) return `Riot rejected the request (${status})${riot}.`;
  return `Riot API error (HTTP ${status})${riot}.`;
}

function cleanKey(key) { return String(key || '').replace(/\s+/g, ''); }

async function resolvePuuid(key, player) {
  const regional = regionalOf(player.region);
  const name = encodeURIComponent(String(player.gameName || '').trim());
  const tag = encodeURIComponent(String(player.tagLine || '').replace(/^#/, '').trim());
  const url = `https://${regional}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${name}/${tag}`;
  const { status, data } = await getJSON(url, cleanKey(key));
  if (status !== 200 || !data || !data.puuid) throw new Error(friendlyError(status, data));
  return data.puuid;
}

async function fetchMatchIds(key, region, puuid, count = 100, start = 0) {
  const regional = regionalOf(region);
  const url = `https://${regional}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?start=${start}&count=${count}`;
  const { status, data } = await getJSON(url, cleanKey(key));
  if (status !== 200 || !Array.isArray(data)) throw new Error(friendlyError(status, data));
  return data;
}

/** Quick validation: resolve the Riot ID and report a precise result. */
async function testKey(key, player) {
  const k = cleanKey(key);
  if (!k) return { ok: false, message: 'No key entered.' };
  if (!/^RGAPI-/i.test(k)) return { ok: false, message: 'That doesn\'t look like a Riot key — it should start with "RGAPI-".' };
  if (!player.gameName || !player.tagLine) return { ok: false, message: 'Enter your Riot name and #tag too, so the key can be tested.' };
  try {
    const puuid = await resolvePuuid(k, player);
    return { ok: true, puuid, message: `Key works — ${player.gameName} #${player.tagLine} found.` };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

async function fetchMatch(key, region, matchId) {
  const regional = regionalOf(region);
  const url = `https://${regional}.api.riotgames.com/lol/match/v5/matches/${matchId}`;
  const { status, data } = await getJSON(url, cleanKey(key));
  if (status === 429) throw new Error(friendlyError(429));
  if (status !== 200 || !data || !data.info) return null; // skip unreadable match
  return data;
}

// ------------------------------------------------------------------ performance mark
// A game "mark" grades how the player did RELATIVE to everyone else in that lobby.
// For each metric we rank the player among all participants (0 = worst, 1 = best),
// take a weighted blend, nudge for win/loss and multikills, then map 0..1 -> 0..10
// and a letter grade. Because it's lobby-relative it stays fair across roles and
// needs no external "average player" data.

const MARK_WEIGHTS = { kda: 0.24, kp: 0.20, dmg: 0.18, gold: 0.12, cs: 0.10, vision: 0.10, obj: 0.06 };

function participantMetrics(p, teamKills) {
  const tk = teamKills[p.teamId] || 0;
  return {
    kda: (n(p.kills) + n(p.assists)) / Math.max(1, n(p.deaths)),
    kp: tk > 0 ? (n(p.kills) + n(p.assists)) / tk : 0,
    dmg: n(p.totalDamageDealtToChampions),
    gold: n(p.goldEarned),
    cs: n(p.totalMinionsKilled) + n(p.neutralMinionsKilled),
    vision: n(p.visionScore),
    obj: n(p.damageDealtToObjectives),
  };
}

/** Percentile rank of value v within values[] (0..1, ties share the average rank). */
function pctRank(values, v) {
  const total = values.length;
  if (total <= 1) return 0.5;
  let below = 0, equal = 0;
  for (const x of values) { if (x < v) below++; else if (x === v) equal++; }
  const rank = below + (equal - 1) / 2;
  return rank / (total - 1);
}

function gradeOf(s) {
  if (s >= 0.90) return 'S+';
  if (s >= 0.80) return 'S';
  if (s >= 0.70) return 'A';
  if (s >= 0.58) return 'B';
  if (s >= 0.42) return 'C';
  return 'D';
}

/** Compute the player's { score (0..10), grade } for a single match, or null. */
function computeMark(info, puuid) {
  const parts = (info && info.participants) || [];
  if (parts.length < 2) return null;
  const selfIdx = parts.findIndex((p) => p.puuid === puuid);
  if (selfIdx < 0) return null;

  const teamKills = {};
  for (const p of parts) teamKills[p.teamId] = (teamKills[p.teamId] || 0) + n(p.kills);
  const metrics = parts.map((p) => participantMetrics(p, teamKills));

  const cols = {};
  for (const k of Object.keys(MARK_WEIGHTS)) cols[k] = metrics.map((m) => m[k]);

  const mine = metrics[selfIdx];
  let s = 0;
  for (const k of Object.keys(MARK_WEIGHTS)) s += MARK_WEIGHTS[k] * pctRank(cols[k], mine[k]);

  const self = parts[selfIdx];
  s += self.win ? 0.05 : -0.03;                  // small win/loss nudge
  if (n(self.pentaKills) > 0) s += 0.06;         // reward multikills
  else if (n(self.quadraKills) > 0) s += 0.03;
  s = Math.max(0, Math.min(1, s));

  return { score: +(s * 10).toFixed(1), grade: gradeOf(s) };
}

// ------------------------------------------------------------------ match -> game
function toGame(match, puuid) {
  const info = match.info;
  const parts = info.participants || [];
  const p = parts.find((x) => x.puuid === puuid);
  if (!p) return null;

  // Group the player's mates: subteam for Arena (2-player squads), team otherwise.
  const isArena = info.queueId === 1700 || info.queueId === 1710;
  const groupOf = (x) => (isArena ? (x.playerSubteamId != null ? x.playerSubteamId : x.teamId) : x.teamId);
  const myGroup = groupOf(p);
  const team = [];
  for (const x of parts) {
    if (x.puuid === puuid || groupOf(x) !== myGroup) continue;
    team.push({
      puuid: x.puuid,
      name: x.riotIdGameName || x.riotIdName || x.summonerName || '',
      tag: x.riotIdTagline || '',
      champKey: x.championId,
      champName: x.championName,
    });
  }

  return {
    matchId: match.metadata.matchId,
    champKey: p.championId,
    champName: p.championName,
    win: !!p.win,
    kills: p.kills, deaths: p.deaths, assists: p.assists,
    cs: n(p.totalMinionsKilled) + n(p.neutralMinionsKilled),
    durationSec: n(info.gameDuration) || null,
    queue: QUEUES[info.queueId] || (info.queueId ? 'Q' + info.queueId : 'OTHER'),
    createdAt: Math.floor((info.gameCreation || Date.now()) / 1000),
    position: p.teamPosition || p.individualPosition || null,
    mark: computeMark(info, puuid),
    profileIcon: p.profileIcon != null ? Number(p.profileIcon) : null,
    team,
  };
}

// ------------------------------------------------------------------ Data Dragon (icons)
async function fetchLatestVersion() {
  try {
    const buf = await getBuffer('https://ddragon.leagueoflegends.com/api/versions.json');
    const arr = JSON.parse(buf.toString('utf8'));
    if (Array.isArray(arr) && arr[0]) return arr[0];
  } catch { /* offline / CDN hiccup — caller falls back */ }
  return null;
}

/** Download a summoner icon and return it as a self-contained data: URL (CSP-safe). */
async function fetchProfileIconDataUrl(iconId, version) {
  if (iconId == null) return null;
  const ver = version || '15.1.1';
  try {
    const buf = await getBuffer(`https://ddragon.leagueoflegends.com/cdn/${ver}/img/profileicon/${iconId}.png`);
    return 'data:image/png;base64,' + buf.toString('base64');
  } catch {
    try { // Community Dragon always serves the latest, no version needed
      const buf = await getBuffer(`https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/profile-icons/${iconId}.png`);
      return 'data:image/png;base64,' + buf.toString('base64');
    } catch { return null; }
  }
}

/**
 * Sync via Riot API. `knownMatchIds` is a Set of already-stored match IDs. We pull
 * NEW matches first, then spend any leftover request budget re-fetching old matches
 * that still lack a mark (opts.enrichIds) so history back-fills with the richer data.
 * Returns { ok, games, puuid, latestIcon, totalIds, newCount, fetched, sources }.
 */
async function sync(key, player, knownMatchIds = new Set(), onProgress = () => {}, opts = {}) {
  const cap = opts.cap || 90;            // stay under the dev-key 100 req / 2 min limit
  const spacingMs = opts.spacingMs || 130;
  const region = player.region;
  const enrichIds = Array.isArray(opts.enrichIds) ? opts.enrichIds : [];

  onProgress('Resolving Riot ID via Riot API…');
  let puuid = opts.puuid;
  if (!puuid) puuid = await resolvePuuid(key, player);

  onProgress('Fetching match list…');
  const ids = await fetchMatchIds(key, region, puuid, 100);
  const fresh = ids.filter((id) => !knownMatchIds.has(id));

  // new games first, then back-fill markless old games with whatever budget remains
  const toFetch = fresh.slice(0, cap);
  for (const id of enrichIds) {
    if (toFetch.length >= cap) break;
    if (!toFetch.includes(id)) toFetch.push(id);
  }

  const games = [];
  let latestIcon = null, latestAt = 0;
  for (let i = 0; i < toFetch.length; i++) {
    onProgress(`Fetching matches ${i + 1}/${toFetch.length}…`);
    try {
      const m = await fetchMatch(key, region, toFetch[i]);
      const g = m && toGame(m, puuid);
      if (g) {
        games.push(g);
        if (g.profileIcon != null && g.createdAt >= latestAt) { latestAt = g.createdAt; latestIcon = g.profileIcon; }
      }
    } catch (e) {
      if (/rate limit/i.test(e.message)) { onProgress('Rate limited — stopping early, run sync again shortly.'); break; }
    }
    if (i < toFetch.length - 1) await delay(spacingMs);
  }

  return {
    ok: true, games, puuid, latestIcon,
    totalIds: ids.length, newCount: fresh.length, fetched: games.length,
    sources: { riot: { ok: true, matchIds: ids.length, newFetched: games.length, capped: toFetch.length >= cap } },
  };
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = {
  sync, testKey, resolvePuuid, fetchMatchIds, fetchMatch, toGame, computeMark,
  fetchLatestVersion, fetchProfileIconDataUrl, regionalOf, cleanKey, REGIONAL,
};
