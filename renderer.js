// renderer.js — UI layer. Talks to main only through window.lol (see preload.js).
// Champion list comes from champions-data.js (window.CHAMP_DATA); per-champion
// stats + the match history come from the JSON DB via IPC. No network happens here.

const DONE_KEY = 'lol-champ-tracker:done';
const api = window.lol || null; // the preload bridge; null outside Electron (graceful)

const el = (id) => document.getElementById(id);
const grid = el('grid');
const search = el('search');
const emptyEl = el('empty');
const syncBtn = el('sync');
const syncStatus = el('sync-status');

let champions = [];        // [{id, key, name, title}]
let keyToChamp = {};       // numeric key -> {id, name, title}
let statsByKey = {};       // numeric key -> derived stat
let matches = [];          // recent games (newest first)
let duos = [];             // recurring teammates
let doneSet = loadDone();
let state = { view: 'champions', filter: 'all', sort: 'name', q: '' };
let playerCache = null;

// A-to-Z challenge mode: won-with champions get a ✓ + games-played count.
// Persisted so it stays on/off across launches until the user toggles it again.
const AZ_KEY = 'lol-champ-tracker:azmode';
let azMode = localStorage.getItem(AZ_KEY) === '1';

function loadDone() {
  try { return new Set(JSON.parse(localStorage.getItem(DONE_KEY) || '[]')); } catch { return new Set(); }
}
function saveDone() { localStorage.setItem(DONE_KEY, JSON.stringify([...doneSet])); }

// ------------------------------------------------------------------ helpers
function statOf(c) { return statsByKey[Number(c.key)] || null; }
function isPlayed(c) { const s = statOf(c); return !!(s && s.attempts > 0); }
function champById(key) { return keyToChamp[Number(key)] || null; }
function champIcon(key) { const c = champById(key); return c ? `assets/champions/${c.id}.png` : 'assets/champions/_unknown.png'; }
function gradeClass(grade) {
  return 'grade-' + String(grade || '').toLowerCase().replace('+', 'plus').replace(/[^a-z0-9]/g, '') || 'grade-c';
}
function markClassFromScore(score) {
  if (score >= 9) return 'grade-splus';
  if (score >= 8) return 'grade-s';
  if (score >= 7) return 'grade-a';
  if (score >= 5.8) return 'grade-b';
  if (score >= 4.2) return 'grade-c';
  return 'grade-d';
}

// ------------------------------------------------------------------ champion cards
function cardHTML(c) {
  const s = statOf(c);
  const played = s && s.attempts > 0;
  const done = doneSet.has(c.id);
  const markPill = (played && s.avgMark != null)
    ? `<span class="mark-pill ${markClassFromScore(s.avgMark)}" title="Average mark">${s.avgMark}</span>` : '';
  const doneTick = done ? '<span class="done-tick" title="Marked done">✓</span>' : '';

  // ---- A-to-Z challenge mode: ✓ + games-played for champs you've won with ----
  if (azMode) {
    const won = played && s.wins > 0;
    let line = '<div class="card-stat muted">—</div>';
    if (played) {
      const g = s.attempts;
      const check = won ? '<span class="az-win-ico">✓</span>' : '';
      line = `<div class="az-line${won ? '' : ' pending'}">${check}<span class="az-games">${g} game${g === 1 ? '' : 's'}</span></div>`;
    }
    return `
      <div class="portrait">
        <img src="assets/champions/${c.id}.png" alt="${c.name}" loading="lazy" />
        ${won ? '<span class="az-tick" title="Won — challenge complete">✓</span>' : ''}
        ${markPill}
        ${doneTick}
      </div>
      <div class="name">${c.name}</div>
      ${line}`;
  }

  // ---- normal mode ----
  let badge = '';
  let line = '<div class="card-stat muted">—</div>';
  if (played) {
    badge = `<span class="attempts-badge" title="${s.attempts} game(s) tracked">${s.attempts}</span>`;
    if (s.winRate != null) {
      const cls = s.winRate >= 50 ? 'win-good' : 'win-bad';
      line = `<div class="card-stat"><span class="${cls}">${s.winRate}%</span>` +
             `<span class="wl">${s.wins}W ${s.losses}L</span></div>`;
    } else {
      line = `<div class="card-stat"><span class="wl">${s.attempts} game(s)</span></div>`;
    }
  }
  return `
    <div class="portrait">
      <img src="assets/champions/${c.id}.png" alt="${c.name}" loading="lazy" />
      ${badge}
      ${markPill}
      ${doneTick}
    </div>
    <div class="name">${c.name}</div>
    ${line}`;
}

function buildCards() {
  const list = visibleChampions();
  const frag = document.createDocumentFragment();
  for (const c of list) {
    const card = document.createElement('div');
    const played = isPlayed(c);
    const s = statOf(c);
    const azWon = azMode && !!(s && s.wins > 0);
    card.className = 'card' + (played ? ' played' : ' unplayed') + (doneSet.has(c.id) ? ' done' : '') + (azWon ? ' az-complete' : '');
    card.dataset.id = c.id;
    card.title = `${c.name} — ${c.title}`;
    card.innerHTML = cardHTML(c);
    card.addEventListener('click', () => openModal(c));
    frag.appendChild(card);
  }
  grid.innerHTML = '';
  grid.appendChild(frag);
  emptyEl.classList.toggle('hidden', list.length > 0);
}

function visibleChampions() {
  const q = state.q;
  let list = champions.filter((c) => {
    if (q && !c.name.toLowerCase().includes(q)) return false;
    if (state.filter === 'played' && !isPlayed(c)) return false;
    if (state.filter === 'unplayed' && isPlayed(c)) return false;
    return true;
  });
  const val = (c, f) => { const s = statOf(c); return s ? (s[f] || 0) : 0; };
  const cmp = {
    name: (a, b) => a.name.localeCompare(b.name),
    attempts: (a, b) => val(b, 'attempts') - val(a, 'attempts') || a.name.localeCompare(b.name),
    winrate: (a, b) => val(b, 'winRate') - val(a, 'winRate') || a.name.localeCompare(b.name),
    mark: (a, b) => val(b, 'avgMark') - val(a, 'avgMark') || a.name.localeCompare(b.name),
    kda: (a, b) => val(b, 'kda') - val(a, 'kda') || a.name.localeCompare(b.name),
    recent: (a, b) => val(b, 'lastPlayed') - val(a, 'lastPlayed') || a.name.localeCompare(b.name),
  }[state.sort];
  return list.sort(cmp);
}

function updateProgress() {
  const total = champions.length;
  // in A-to-Z mode the goal is champions WON, otherwise champions played
  const n = azMode
    ? champions.filter((c) => { const s = statOf(c); return !!(s && s.wins > 0); }).length
    : champions.filter(isPlayed).length;
  el('count').textContent = n;
  el('total').textContent = total;
  const noun = el('progress-noun'); if (noun) noun.textContent = azMode ? 'won' : 'played';
  const pct = total ? Math.round((n / total) * 100) : 0;
  el('percent').textContent = pct + '%';
  el('progress-fill').style.width = pct + '%';
}

// ------------------------------------------------------------------ matches view
function markBadge(mark, extraClass = '') {
  if (!mark || typeof mark.score !== 'number') return `<div class="mark-badge grade-none ${extraClass}">—</div>`;
  const cls = gradeClass(mark.grade) || markClassFromScore(mark.score);
  return `<div class="mark-badge ${cls} ${extraClass}"><span class="mb-score">${mark.score}</span><span class="mb-grade">${mark.grade || ''}</span></div>`;
}

function fmtDuration(sec) {
  if (!sec) return '';
  let s = sec > 100000 ? Math.round(sec / 1000) : sec; // legacy games stored ms
  const m = Math.floor(s / 60), r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

function matchRow(m) {
  const champ = champById(m.champKey);
  const name = champ ? champ.name : (m.champName || 'Unknown');
  const winCls = m.win === true ? 'win' : (m.win === false ? 'loss' : 'neutral');
  const resultTxt = m.win === true ? 'Victory' : (m.win === false ? 'Defeat' : '—');
  const kdaRatio = m.deaths ? ((m.kills + m.assists) / m.deaths).toFixed(1) : (m.kills + m.assists).toFixed(1);
  const duo = m.duo ? `<div class="m-duo">＋ with <b>${escapeHtml(m.duo.name || 'duo')}</b>${m.duo.champName ? ` <span class="m-duo-champ">(${escapeHtml(m.duo.champName)})</span>` : ''}</div>` : '';
  const sub = [
    `<span class="m-kda"><b>${m.kills}</b> / <b class="m-deaths">${m.deaths}</b> / <b>${m.assists}</b></span>`,
    `<span class="m-kdar">${kdaRatio} KDA</span>`,
    m.cs != null ? `<span class="m-dim">${m.cs} CS</span>` : '',
    m.durationSec ? `<span class="m-dim">${fmtDuration(m.durationSec)}</span>` : '',
  ].filter(Boolean).join('<span class="m-dot">·</span>');

  return `
    <div class="match ${winCls}" data-key="${m.champKey || ''}">
      <img class="m-champ" src="${champIcon(m.champKey)}" alt="${name}" loading="lazy" />
      <div class="m-main">
        <div class="m-top">
          <span class="m-champ-name">${name}</span>
          <span class="m-queue">${prettyQueue(m.queue)}</span>
          ${m.position ? `<span class="m-pos">${prettyPos(m.position)}</span>` : ''}
        </div>
        <div class="m-sub">${sub}</div>
        ${duo}
      </div>
      <div class="m-right">
        ${markBadge(m.mark)}
        <div class="m-result ${winCls}">${resultTxt}</div>
        <div class="m-ago">${m.createdAt ? timeAgo(m.createdAt) : ''}</div>
      </div>
    </div>`;
}

function renderMatches() {
  const q = state.q;
  const list = matches.filter((m) => {
    if (!q) return true;
    const champ = champById(m.champKey);
    const nm = (champ ? champ.name : (m.champName || '')).toLowerCase();
    return nm.includes(q);
  });
  const box = el('matches');
  box.innerHTML = list.map(matchRow).join('');
  el('matches-empty').classList.toggle('hidden', list.length > 0);
  // clicking a match opens that champion's detail
  for (const row of box.children) {
    const key = row.dataset.key;
    if (!key) continue;
    row.addEventListener('click', () => {
      const c = champById(key);
      if (c) openModal(champions.find((x) => Number(x.key) === Number(key)) || c);
    });
  }
}

function renderDuos() {
  const box = el('duos');
  if (!duos.length) { box.innerHTML = ''; box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const cards = duos.map((d) => `
    <div class="duo-card">
      <div class="duo-name">${escapeHtml(d.name || 'Unknown')}${d.tag ? `<span class="duo-tag">#${escapeHtml(d.tag)}</span>` : ''}</div>
      <div class="duo-meta">
        <span>${d.games} games</span>
        ${d.winRate != null ? `<span class="${d.winRate >= 50 ? 'win-good' : 'win-bad'}">${d.winRate}% WR</span>` : ''}
        ${d.avgMark != null ? `<span class="duo-mark ${markClassFromScore(d.avgMark)}">${d.avgMark} avg</span>` : ''}
      </div>
    </div>`).join('');
  box.innerHTML = `<div class="duos-head">Duo partners <span class="duos-hint">— teammates you keep queueing with</span></div><div class="duo-cards">${cards}</div>`;
}

// ------------------------------------------------------------------ view switch
function switchView(v) {
  state.view = v;
  for (const t of el('tabs').children) t.classList.toggle('active', t.dataset.view === v);
  el('view-champions').classList.toggle('hidden', v !== 'champions');
  el('view-matches').classList.toggle('hidden', v !== 'matches');
  search.placeholder = v === 'matches' ? 'Search matches by champion…' : 'Search champions…';
  rerender();
}

function rerender() {
  if (state.view === 'champions') { buildCards(); updateProgress(); }
  else { renderDuos(); renderMatches(); }
}

// ------------------------------------------------------------------ modal
function openModal(c) {
  if (!c) return;
  const body = el('modal-body');
  try {
    body.innerHTML = buildModalBody(c);
  } catch (e) {
    body.innerHTML = `<div class="modal-empty">Couldn't render ${c.name || 'this champion'}: ${e.message}</div>`;
  }
  const chk = el('done-check');
  if (chk) chk.addEventListener('change', (e) => {
    if (e.target.checked) doneSet.add(c.id); else doneSet.delete(c.id);
    saveDone(); rerender();
  });
  el('modal').classList.remove('hidden');
}

function buildModalBody(c) {
  const s = statOf(c);
  const done = doneSet.has(c.id);
  let stats;
  if (s && s.attempts > 0) {
    const wr = s.winRate != null ? `<span class="${s.winRate >= 50 ? 'win-good' : 'win-bad'}">${s.winRate}%</span>` : '—';
    const mark = s.avgMark != null ? `<span class="${markClassFromScore(s.avgMark)}">${s.avgMark}</span>` : '—';
    stats = `
      <div class="stat-grid">
        <div class="stat-cell"><div class="sc-num">${s.attempts}</div><div class="sc-lbl">Games</div></div>
        <div class="stat-cell"><div class="sc-num">${wr}</div><div class="sc-lbl">Win rate</div></div>
        <div class="stat-cell"><div class="sc-num">${s.kda}</div><div class="sc-lbl">KDA</div></div>
        <div class="stat-cell"><div class="sc-num">${mark}</div><div class="sc-lbl">Avg mark</div></div>
      </div>
      <div class="kda-line">${s.wins}W ${s.losses}L · Avg ${s.avgKills} / ${s.avgDeaths} / ${s.avgAssists}
        ${s.lastPlayed ? ` · last played ${timeAgo(s.lastPlayed)}` : ''}</div>
      ${queueTable(s)}
      ${recentGames(c)}`;
  } else {
    stats = `<div class="modal-empty">No games tracked yet. Hit <b>Sync</b> — ${c.name} will show up once they appear in your match history.</div>`;
  }
  return `
    <div class="modal-head">
      <img class="modal-portrait" src="assets/champions/${c.id}.png" alt="${c.name}" />
      <div>
        <div class="modal-name">${c.name}</div>
        <div class="modal-title">${c.title}</div>
      </div>
    </div>
    ${stats}
    <label class="done-toggle">
      <input type="checkbox" id="done-check" ${done ? 'checked' : ''}/>
      Mark as done (personal checklist)
    </label>`;
}

function queueTable(s) {
  const qs = Object.entries(s.byQueue || {});
  if (!qs.length) return '';
  const rows = qs.sort((a, b) => b[1].play - a[1].play).map(([q, v]) => {
    const t = v.win + v.lose;
    const wr = t ? Math.round((v.win / t) * 100) : null;
    return `<tr><td>${prettyQueue(q)}</td><td>${v.play}</td><td>${v.win}W ${v.lose}L</td><td>${wr == null ? '—' : wr + '%'}</td></tr>`;
  }).join('');
  return `<div class="section-lbl">By queue (tracked games)</div>
    <table class="q-table"><thead><tr><th>Queue</th><th>Games</th><th>Record</th><th>WR</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function recentGames(c) {
  const key = Number(c.key);
  const list = matches.filter((m) => Number(m.champKey) === key).slice(0, 6);
  if (!list.length) return '';
  const rows = list.map((m) => {
    const winCls = m.win === true ? 'win' : (m.win === false ? 'loss' : 'neutral');
    return `<div class="rg-row ${winCls}">
      <span class="rg-res">${m.win === true ? 'W' : (m.win === false ? 'L' : '–')}</span>
      <span class="rg-kda">${m.kills}/${m.deaths}/${m.assists}</span>
      <span class="rg-q">${prettyQueue(m.queue)}</span>
      ${m.duo ? `<span class="rg-duo" title="Duo">＋${escapeHtml(m.duo.name || '')}</span>` : '<span></span>'}
      ${markBadge(m.mark, 'rg-mark')}
    </div>`;
  }).join('');
  return `<div class="section-lbl">Recent games on ${c.name}</div><div class="rg-list">${rows}</div>`;
}

function closeModal() { el('modal').classList.add('hidden'); }

// ------------------------------------------------------------------ sync
async function doSync() {
  if (!api) { setStatus('Sync only works in the desktop app.', 'warn'); return; }
  syncBtn.disabled = true;
  syncBtn.classList.add('spinning');
  setStatus('Starting…', 'busy');
  const unsub = api.onProgress((msg) => setStatus(msg, 'busy'));
  try {
    const res = await api.sync();
    applyStats(res);
    if (res.ok) {
      const bits = [];
      if (res.added) bits.push(`+${res.added} new`);
      if (res.enriched) bits.push(`${res.enriched} back-filled`);
      setStatus(`Synced · ${res.summary.totalGamesTracked} games${bits.length ? ` (${bits.join(', ')})` : ''}`, 'ok');
    } else {
      setStatus(res.error || 'Sync finished with no new data.', 'warn');
    }
    refreshPlayerBar(res.summary);
  } catch (e) {
    setStatus('Sync failed: ' + e.message, 'warn');
  } finally {
    unsub && unsub();
    syncBtn.disabled = false;
    syncBtn.classList.remove('spinning');
  }
}

function applyStats(res) {
  if (!res) return;
  if (res.champions) statsByKey = res.champions;
  if (Array.isArray(res.matches)) matches = res.matches;
  if (res.summary && Array.isArray(res.summary.duos)) duos = res.summary.duos;
  if (res.summary) updateAvgMark(res.summary.avgMark);
  rerender();
}

function updateAvgMark(v) {
  const chip = el('avg-mark-chip');
  el('avg-mark').textContent = v != null ? v : '—';
  chip.className = 'avg-mark-chip' + (v != null ? ' ' + markClassFromScore(v) : '');
}

function setStatus(msg, kind) {
  syncStatus.textContent = msg || '';
  syncStatus.className = 'sync-status' + (kind ? ' ' + kind : '');
}

// ------------------------------------------------------------------ player bar
function refreshPlayerBar(summary) {
  const p = (summary && summary.player) || playerCache || {};
  if (playerCache) {
    if (p.riotKey === undefined) p.riotKey = playerCache.riotKey;
    if (p.hasRiotKey === undefined) p.hasRiotKey = playerCache.hasRiotKey;
    if (p.iconDataUrl === undefined) p.iconDataUrl = playerCache.iconDataUrl;
  }
  playerCache = p;
  el('riot-name').textContent = p.gameName || '—';
  el('riot-tag').textContent = p.tagLine ? ' #' + p.tagLine : '';
  el('region-badge').textContent = (p.region || 'eune').toUpperCase();
  renderPlayerPic(p);
  const ls = summary && summary.lastSync;
  el('last-sync').textContent = ls ? 'Last synced ' + timeAgo(Math.floor(Date.parse(ls) / 1000)) : 'Not synced yet';
}

function renderPlayerPic(p) {
  const box = el('player-pic');
  if (p && p.iconDataUrl) {
    box.classList.add('has-img');
    box.innerHTML = `<img class="pic-img" src="${p.iconDataUrl}" alt="Summoner icon" />`;
  } else {
    box.classList.remove('has-img');
    box.textContent = (p && p.gameName ? p.gameName : '?').charAt(0).toUpperCase();
  }
}

function openEdit() {
  el('player-edit').classList.remove('hidden');
  el('player-view').classList.add('hidden');
  el('in-name').value = (playerCache && playerCache.gameName) || '';
  el('in-tag').value = (playerCache && playerCache.tagLine) || '';
  el('in-region').value = (playerCache && playerCache.region) || 'eune';
  el('in-key').value = (playerCache && playerCache.riotKey) || '';
  el('in-name').focus();
}
function closeEdit() {
  el('player-edit').classList.add('hidden');
  el('player-view').classList.remove('hidden');
}

// ------------------------------------------------------------------ time / labels
function timeAgo(unixSec) {
  if (!unixSec) return 'never';
  const d = Math.floor(Date.now() / 1000) - unixSec;
  if (d < 60) return 'just now';
  if (d < 3600) return Math.floor(d / 60) + 'm ago';
  if (d < 86400) return Math.floor(d / 3600) + 'h ago';
  if (d < 2592000) return Math.floor(d / 86400) + 'd ago';
  return Math.floor(d / 2592000) + 'mo ago';
}
function prettyQueue(q) {
  const map = { RANKED: 'Ranked Solo', SOLORANKED: 'Ranked Solo', FLEXRANKED: 'Ranked Flex', NORMAL: 'Normal', ARAM: 'ARAM', ARENA: 'Arena', URF: 'URF', BOT: 'Co-op vs AI', CLASH: 'Clash', CUSTOM: 'Custom', OTHER: 'Other' };
  return map[q] || (q ? q.charAt(0) + q.slice(1).toLowerCase() : 'Other');
}
function prettyPos(pos) {
  const map = { TOP: 'Top', JUNGLE: 'Jungle', MIDDLE: 'Mid', BOTTOM: 'Bot', UTILITY: 'Support' };
  return map[String(pos || '').toUpperCase()] || '';
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// ------------------------------------------------------------------ events
search.addEventListener('input', () => { state.q = search.value.trim().toLowerCase(); rerender(); });
syncBtn.addEventListener('click', doSync);
el('sort').addEventListener('change', (e) => { state.sort = e.target.value; rerender(); });
el('az-check').addEventListener('change', (e) => {
  azMode = e.target.checked;
  localStorage.setItem(AZ_KEY, azMode ? '1' : '0');
  rerender();
});
el('tabs').addEventListener('click', (e) => { const t = e.target.closest('.tab'); if (t) switchView(t.dataset.view); });
el('filter-chips').addEventListener('click', (e) => {
  const btn = e.target.closest('.chip'); if (!btn) return;
  state.filter = btn.dataset.filter;
  for (const c of el('filter-chips').children) c.classList.toggle('active', c === btn);
  rerender();
});
el('modal-close').addEventListener('click', closeModal);
el('modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeModal(); closeEdit(); } });
el('edit-id').addEventListener('click', openEdit);
el('cancel-id').addEventListener('click', closeEdit);
el('player-edit').addEventListener('submit', async (e) => {
  e.preventDefault();
  const player = {
    gameName: el('in-name').value,
    tagLine: el('in-tag').value,
    region: el('in-region').value,
    riotKey: el('in-key').value.trim(),
  };
  if (api) { const saved = await api.setConfig(player); playerCache = saved; }
  else playerCache = { gameName: player.gameName, tagLine: player.tagLine.replace(/^#/, ''), region: player.region, riotKey: player.riotKey, hasRiotKey: !!player.riotKey };
  refreshPlayerBar({ player: playerCache });
  closeEdit();
  setStatus(playerCache.hasRiotKey ? 'Saved. Hit Sync to pull your match history.' : 'Saved — but you still need a Riot API key to sync.', playerCache.hasRiotKey ? '' : 'warn');
});
el('test-key').addEventListener('click', async () => {
  if (!api) return;
  const key = el('in-key').value.trim();
  // make sure the name/tag/region being tested are the ones in the form
  await api.setConfig({ gameName: el('in-name').value, tagLine: el('in-tag').value, region: el('in-region').value, riotKey: key });
  setStatus('Testing key…', 'busy');
  const r = await api.testKey(key);
  setStatus(r.message, r.ok ? 'ok' : 'warn');
});
el('get-key').addEventListener('click', () => {
  if (api) api.openExternal('https://developer.riotgames.com/');
});

// ------------------------------------------------------------------ init
async function init() {
  el('modal').classList.add('hidden'); // safety: never start with a stray modal open
  const data = window.CHAMP_DATA;
  if (!data || !Array.isArray(data.champions)) {
    grid.innerHTML = `<p style="color:var(--text-faint)">Failed to load champion data.</p>`;
    return;
  }
  champions = data.champions;
  keyToChamp = {};
  for (const c of champions) keyToChamp[Number(c.key)] = c;
  el('az-check').checked = azMode; // reflect the remembered A-to-Z toggle state

  if (api) {
    try {
      const [cfg, stats] = await Promise.all([api.getConfig(), api.getStats()]);
      playerCache = cfg;
      statsByKey = (stats && stats.champions) || {};
      matches = (stats && stats.matches) || [];
      duos = (stats && stats.summary && stats.summary.duos) || [];
      updateAvgMark(stats && stats.summary ? stats.summary.avgMark : null);
      refreshPlayerBar(stats && stats.summary ? stats.summary : { player: cfg });
      if (stats && stats.summary && stats.summary.lastSync) {
        setStatus(`${stats.summary.championsPlayed} champs · ${stats.summary.totalGamesTracked} games tracked`, 'ok');
      } else {
        setStatus('Never synced — add your Riot key (Change) and hit Sync.', '');
      }
    } catch (e) {
      setStatus('Could not read local stats: ' + e.message, 'warn');
    }
  } else {
    refreshPlayerBar({ player: { region: 'eune' } });
    setStatus('Preview mode — open the desktop app to sync from the Riot API.', 'warn');
    syncBtn.disabled = true;
  }

  rerender();
}

init();
