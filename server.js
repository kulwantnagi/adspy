import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize as normPath } from 'node:path';
import { db, ROOT, MEDIA_DIR, getSettings, saveSettings } from './lib/db.js';
import { refreshBrand, isRefreshing } from './lib/ingest.js';
import { brandAds, brandSummary, filterAds, overview, ranking, landingPages, launches, hooks, filterOptions } from './lib/queries.js';
import { analyzeAd, enqueueAnalyses, queueSize } from './lib/ai.js';
import { transcribe, ensureVideo } from './lib/transcribe.js';

try { process.loadEnvFile(join(ROOT, '.env')); } catch {}

const PORT = +process.env.PORT || 4321;
const PUBLIC = join(ROOT, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.mp4': 'video/mp4' };

const json = (res, data, code = 200) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
};

async function body(req) {
  let s = '';
  for await (const c of req) s += c;
  return s ? JSON.parse(s) : {};
}

function serveFile(req, res, file) {
  if (!existsSync(file) || !statSync(file).isFile()) return json(res, { error: 'Not found' }, 404);
  const size = statSync(file).size;
  const type = TYPES[extname(file)] || 'application/octet-stream';
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    const start = +range[1] || 0, end = range[2] ? +range[2] : size - 1;
    res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
    return createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Cache-Control': type.startsWith('image') ? 'max-age=86400' : 'no-cache' });
  createReadStream(file).pipe(res);
}

// Only files directly inside a folder; blocks ../ tricks.
const safeJoin = (dir, name) => {
  const p = normPath(join(dir, name));
  return p.startsWith(dir) ? p : null;
};

function getBrand(id) {
  const b = db.prepare('SELECT * FROM brands WHERE id = ?').get(id);
  if (!b) throw Object.assign(new Error('Brand not found'), { code: 404 });
  return { ...b, refreshing: isRefreshing(b.id) };
}

function validTrackUrl(url) {
  try {
    const u = new URL(url);
    return /(^|\.)facebook\.com$/.test(u.hostname) && u.pathname.length > 1;
  } catch { return false; }
}

const routes = [
  ['GET', /^\/api\/status$/, () => ({ ai: process.env.ANTHROPIC_API_KEY ? 'anthropic-api' : 'claude-cli', apify: !!process.env.APIFY_TOKEN, queue: queueSize() })],
  ['GET', /^\/api\/settings$/, () => getSettings()],
  ['POST', /^\/api\/settings$/, async (req) => saveSettings(await body(req))],

  ['GET', /^\/api\/brands$/, () => db.prepare('SELECT * FROM brands ORDER BY created_at DESC').all()
    .map(b => brandSummary({ ...b, refreshing: isRefreshing(b.id) }, brandAds(b.id)))],
  ['POST', /^\/api\/brands$/, async (req) => {
    const { url } = await body(req);
    if (!validTrackUrl(url)) throw Object.assign(new Error('Paste a Facebook page URL or an Ad Library URL.'), { code: 400 });
    const { lastInsertRowid: id } = db.prepare('INSERT INTO brands (source_url, created_at, status) VALUES (?, ?, ?)').run(url.trim(), Date.now(), 'queued');
    refreshBrand(Number(id));
    return getBrand(id);
  }],
  ['DELETE', /^\/api\/brands\/(\d+)$/, (req, [id]) => {
    for (const t of ['ads', 'rank_history']) db.prepare(`DELETE FROM ${t} WHERE brand_id = ?`).run(id);
    db.prepare('DELETE FROM brands WHERE id = ?').run(id);
    return { ok: true };
  }],
  ['POST', /^\/api\/brands\/(\d+)\/refresh$/, (req, [id]) => { refreshBrand(+id); return getBrand(id); }],
  ['GET', /^\/api\/brands\/(\d+)$/, (req, [id]) => {
    const ads = brandAds(id);
    return { ...brandSummary(getBrand(id), ads), options: filterOptions(ads) };
  }],
  ['GET', /^\/api\/brands\/(\d+)\/overview$/, (req, [id]) => overview(getBrand(id), brandAds(id))],
  ['GET', /^\/api\/brands\/(\d+)\/ads$/, (req, [id], q) => {
    const all = filterAds(brandAds(id), q);
    const offset = +q.offset || 0, limit = Math.min(+q.limit || 40, 200);
    return { total: all.length, ads: all.slice(offset, offset + limit) };
  }],
  ['GET', /^\/api\/brands\/(\d+)\/ranking$/, (req, [id]) => ranking(brandAds(id))],
  ['GET', /^\/api\/brands\/(\d+)\/landing$/, (req, [id]) => landingPages(brandAds(id))],
  ['GET', /^\/api\/brands\/(\d+)\/launches$/, (req, [id]) => launches(brandAds(id))],
  ['GET', /^\/api\/brands\/(\d+)\/hooks$/, (req, [id]) => hooks(brandAds(id))],
  ['POST', /^\/api\/brands\/(\d+)\/autotag$/, async (req, [id]) => {
    const { limit = 10 } = await body(req);
    const ids = brandAds(id).filter(a => a.rank).sort((a, b) => a.rank - b.rank).slice(0, Math.min(+limit, 100)).map(a => a.id);
    enqueueAnalyses(ids);
    return { queued: queueSize() };
  }],

  ['GET', /^\/api\/ads\/(\d+)$/, (req, [id]) => {
    const row = db.prepare('SELECT brand_id, demo, targeting FROM ads WHERE id = ?').get(id);
    if (!row) throw Object.assign(new Error('Ad not found'), { code: 404 });
    const ads = brandAds(row.brand_id, { includeInactive: true });
    const ad = ads.find(a => a.id === id);
    return { ...ad, demo: JSON.parse(row.demo || 'null'), targeting: JSON.parse(row.targeting || 'null'), rank_total: ads.filter(a => a.rank).length, settings: getSettings() };
  }],
  ['POST', /^\/api\/ads\/(\d+)\/analyze$/, async (req, [id]) => analyzeAd(id)],
  ['POST', /^\/api\/ads\/(\d+)\/transcribe$/, async (req, [id]) => ({ text: await transcribe(id) })],
];

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = decodeURIComponent(url.pathname);
  try {
    if (path.startsWith('/api/')) {
      // Only this app may call the API: the Host check blocks DNS rebinding, and the
      // Origin + JSON checks stop other websites from triggering paid scrapes (CSRF).
      const allowed = [`localhost:${PORT}`, `127.0.0.1:${PORT}`];
      const origin = req.headers.origin;
      const badOrigin = origin && !allowed.some(a => origin === `http://${a}`);
      const badWrite = req.method !== 'GET' && !String(req.headers['content-type']).startsWith('application/json');
      if (!allowed.includes(req.headers.host) || badOrigin || badWrite) return json(res, { error: 'Forbidden' }, 403);
      const videoMatch = req.method === 'GET' && path.match(/^\/api\/ads\/(\d+)\/video$/);
      if (videoMatch) return serveFile(req, res, await ensureVideo(videoMatch[1]));
      for (const [method, re, fn] of routes) {
        const m = req.method === method && path.match(re);
        if (m) return json(res, await fn(req, m.slice(1), Object.fromEntries(url.searchParams)));
      }
      return json(res, { error: 'Not found' }, 404);
    }
    if (path.startsWith('/media/')) {
      const f = safeJoin(MEDIA_DIR, path.slice(7));
      return f ? serveFile(req, res, f) : json(res, { error: 'Bad path' }, 400);
    }
    const f = safeJoin(PUBLIC, path === '/' ? 'index.html' : path.slice(1));
    return serveFile(req, res, f && existsSync(f) ? f : join(PUBLIC, 'index.html'));
  } catch (e) {
    if (!e.code || e.code >= 500 || typeof e.code !== 'number') console.error(e);
    json(res, { error: e.message }, typeof e.code === 'number' ? e.code : 500);
  }
});

// Daily auto-refresh while the app is running.
function scheduleRefreshes() {
  const { refresh_hours } = getSettings();
  const due = db.prepare('SELECT id FROM brands WHERE status != ? AND (last_refreshed_at IS NULL OR last_refreshed_at < ?)')
    .all('running', Date.now() - refresh_hours * 3600e3);
  (async () => { for (const b of due) await refreshBrand(b.id); })();
}
// Brands stuck in "running" from a previous session get retried.
db.prepare("UPDATE brands SET status = CASE WHEN last_refreshed_at IS NULL THEN 'queued' ELSE 'ready' END, status_msg = NULL WHERE status = 'running'").run();
setInterval(scheduleRefreshes, 3600e3);
setTimeout(scheduleRefreshes, 5000);

server.listen(PORT, '127.0.0.1', () => console.log(`AdSpy running → http://localhost:${PORT}`));
