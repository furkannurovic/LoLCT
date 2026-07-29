// Fetches the latest League of Legends champion list + square icons from
// Riot's Data Dragon CDN and bundles them locally so the app works offline.
const fs = require('fs');
const path = require('path');
const https = require('https');

const ASSETS = path.join(__dirname, 'assets', 'champions');
fs.mkdirSync(ASSETS, { recursive: true });

function getJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(dest, () => {});
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', (err) => {
      file.close();
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

async function main() {
  const versions = await getJSON('https://ddragon.leagueoflegends.com/api/versions.json');
  const version = versions[0];
  console.log('Data Dragon version:', version);

  const champData = await getJSON(`https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/champion.json`);
  const champs = Object.values(champData.data)
    .map((c) => ({ id: c.id, key: c.key, name: c.name, title: c.title }))
    .sort((a, b) => a.name.localeCompare(b.name));

  console.log('Champions found:', champs.length);

  // Download square icons concurrently (in small batches).
  let done = 0;
  const batchSize = 12;
  for (let i = 0; i < champs.length; i += batchSize) {
    const batch = champs.slice(i, i + batchSize);
    await Promise.all(
      batch.map(async (c) => {
        const url = `https://ddragon.leagueoflegends.com/cdn/${version}/img/champion/${c.id}.png`;
        const dest = path.join(ASSETS, `${c.id}.png`);
        try {
          await download(url, dest);
          done++;
        } catch (e) {
          console.error('Failed:', c.id, e.message);
        }
      })
    );
    process.stdout.write(`\rDownloaded ${done}/${champs.length} icons`);
  }
  console.log('');

  const payload = { version, champions: champs };
  fs.writeFileSync(path.join(__dirname, 'champions.json'), JSON.stringify(payload, null, 2));
  console.log('Wrote champions.json');

  // champions-data.js is the same data wrapped for a plain <script> tag, since the
  // renderer runs under a strict CSP (no fetch of local JSON).
  fs.writeFileSync(
    path.join(__dirname, 'champions-data.js'),
    'window.CHAMP_DATA = ' + JSON.stringify(payload, null, 2) + ';\n'
  );
  console.log('Wrote champions-data.js');
  console.log('Done.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
