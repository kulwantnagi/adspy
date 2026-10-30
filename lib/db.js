import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const ROOT = new URL('..', import.meta.url).pathname;
export const DATA_DIR = join(ROOT, 'data');
export const MEDIA_DIR = join(DATA_DIR, 'media');
mkdirSync(MEDIA_DIR, { recursive: true });

export const db = new DatabaseSync(join(DATA_DIR, 'adspy.db'));
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS brands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT, source_url TEXT NOT NULL, page_id TEXT, domain TEXT, logo TEXT,
  status TEXT DEFAULT 'queued', status_msg TEXT,
  created_at INTEGER, last_refreshed_at INTEGER
);
CREATE TABLE IF NOT EXISTS ads (
  id TEXT PRIMARY KEY, brand_id INTEGER NOT NULL,
  page_id TEXT, page_name TEXT, page_logo TEXT, page_type TEXT,
  is_active INTEGER, start_date INTEGER, end_date INTEGER,
  display_format TEXT, platforms TEXT, cta_text TEXT, cta_type TEXT,
  link_url TEXT, landing_key TEXT, title TEXT, body TEXT, hook TEXT, caption TEXT,
  collation_id TEXT, collation_count INTEGER,
  eu_reach INTEGER, uk_reach INTEGER, demo TEXT, targeting TEXT, media TEXT,
  current_rank INTEGER, first_seen INTEGER, last_seen INTEGER, raw TEXT
);
CREATE INDEX IF NOT EXISTS ads_brand ON ads(brand_id);
CREATE TABLE IF NOT EXISTS rank_history (
  ad_id TEXT, brand_id INTEGER, captured_at INTEGER, rank INTEGER
);
CREATE INDEX IF NOT EXISTS rank_ad ON rank_history(ad_id, captured_at);
CREATE TABLE IF NOT EXISTS analyses (ad_id TEXT PRIMARY KEY, json TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS transcripts (ad_id TEXT PRIMARY KEY, text TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`);

const DEFAULT_SETTINGS = { frequency: '2.5', cpm: '15', max_ads: '500', refresh_hours: '24' };

export function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const s = { ...DEFAULT_SETTINGS };
  for (const r of rows) s[r.key] = r.value;
  return { frequency: +s.frequency, cpm: +s.cpm, max_ads: +s.max_ads, refresh_hours: +s.refresh_hours };
}

export function saveSettings(patch) {
  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(patch)) {
    if (k in DEFAULT_SETTINGS && Number.isFinite(+v)) stmt.run(k, String(+v));
  }
  return getSettings();
}

export function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
