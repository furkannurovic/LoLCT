const { app, BrowserWindow, Menu, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { StatsDB } = require('./db');
const riot = require('./riot');

// ---- persistent JSON database (lives in userData -> survives every run) ----
const DB_PATH = path.join(app.getPath('userData'), 'stats-db.json');
const db = new StatsDB(DB_PATH).load();

// champion name/id -> numeric key, for resolving games that only carry a name
const nameToKey = buildNameToKey();
function buildNameToKey() {
  const map = {};
  try {
    const { champions } = JSON.parse(fs.readFileSync(path.join(__dirname, 'champions.json'), 'utf8'));
    for (const c of champions) {
      const key = Number(c.key);
      map[norm(c.name)] = key;
      map[norm(c.id)] = key;
    }
  } catch (e) { console.error('champion map load failed:', e.message); }
  return map;
}
function norm(s) { return String(s).toLowerCase().replace(/[^a-z0-9]/g, ''); }

let mainWindow = null;
let syncing = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 480,
    minHeight: 500,
    backgroundColor: '#262624',
    title: 'LoL Match Tracker',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  Menu.setApplicationMenu(null);
  mainWindow.loadFile('index.html');
}

// ---- config shape shared with the renderer (never leaks internals) ----
function publicConfig() {
  const p = db.getPlayer();
  const r = db.getRiot();
  return {
    region: p.region, gameName: p.gameName, tagLine: p.tagLine,
    iconDataUrl: p.iconDataUrl || null, profileIconId: p.profileIconId ?? null,
    riotKey: r.apiKey || '', hasRiotKey: !!r.apiKey,
  };
}

// ---------------------------- IPC ----------------------------
ipcMain.handle('stats:get', () => db.derive(nameToKey));
ipcMain.handle('stats:get-config', () => publicConfig());

ipcMain.handle('stats:set-config', (_e, cfg) => {
  const c = cfg || {};
  db.setPlayer(c);
  if (typeof c.riotKey === 'string') db.setRiotKey(c.riotKey);
  db.save();
  return publicConfig();
});

ipcMain.handle('stats:open-data-folder', () => {
  shell.showItemInFolder(DB_PATH);
  return DB_PATH;
});

ipcMain.handle('stats:test-key', async (_e, key) => {
  const player = db.getPlayer();
  const useKey = key ? key : db.getRiot().apiKey;
  try { return await riot.testKey(useKey, player); }
  catch (e) { return { ok: false, message: e.message }; }
});

ipcMain.handle('stats:open-external', (_e, url) => {
  // only the Riot developer portal is ever linked from the app
  if (/^https:\/\/developer\.riotgames\.com(\/|$)/.test(String(url || ''))) shell.openExternal(url);
});

ipcMain.handle('stats:sync', async () => {
  if (syncing) return { ok: false, error: 'A sync is already running.', ...db.derive(nameToKey) };
  syncing = true;
  const progress = (msg) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('stats:progress', msg); };
  try {
    const player = db.getPlayer();
    if (!player.gameName || !player.tagLine) {
      return { ok: false, error: 'Set a Riot ID first (name + tag).', ...db.derive(nameToKey) };
    }

    const riotCfg = db.getRiot();
    if (!riotCfg.apiKey) {
      return { ok: false, error: 'Add your free Riot API key — hit Change and paste your RGAPI-… key.', ...db.derive(nameToKey) };
    }

    const known = new Set(Object.keys(db.state.matches));
    const enrichIds = db.getEnrichIds();
    const puuid = riotCfg.puuidFor === db.playerId() ? riotCfg.puuid : '';

    const r = await riot.sync(riotCfg.apiKey, player, known, progress, { puuid, enrichIds });
    const { added, enriched } = db.upsertGames(r.games);
    db.setPuuid(r.puuid, db.playerId());

    // refresh the player's summoner picture when it changed (or we never had one)
    if (r.latestIcon != null && (r.latestIcon !== db.getPlayer().profileIconId || !db.getPlayer().iconDataUrl)) {
      progress('Fetching summoner icon…');
      const ver = db.state.ddragonVersion || await riot.fetchLatestVersion();
      const durl = await riot.fetchProfileIconDataUrl(r.latestIcon, ver);
      if (durl) db.setIcon(durl, r.latestIcon, ver);
    }

    db.markSync({ at: new Date().toISOString(), ok: true, source: 'riot', sources: r.sources });
    db.save();

    const bits = [];
    if (added) bits.push(`+${added} new`);
    if (enriched) bits.push(`${enriched} back-filled`);
    progress(`Done — ${bits.length ? bits.join(', ') : 'no new games'} via Riot API.`);
    return { ok: true, added, enriched, newGames: added, source: 'riot', sources: r.sources, ...db.derive(nameToKey) };
  } catch (e) {
    progress('Sync error: ' + e.message);
    return { ok: false, error: e.message, ...db.derive(nameToKey) };
  } finally {
    syncing = false;
  }
});

// ---------------------------- lifecycle ----------------------------
app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
