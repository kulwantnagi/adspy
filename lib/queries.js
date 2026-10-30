import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { db, MEDIA_DIR, getSettings } from './db.js';

const DAY = 86400;
const now = () => Math.floor(Date.now() / 1000);

const COLS = `id, brand_id, page_id, page_name, page_type, is_active, start_date, end_date, display_format,
  platforms, cta_text, link_url, landing_key, title, body, hook, collation_id, collation_count,
  eu_reach, uk_reach, media, current_rank, first_seen`;

const localMedia = (file, remote) => (existsSync(join(MEDIA_DIR, file)) ? `/media/${file}` : remote);

function rankHistory(brandId) {
  const since = Date.now() - 30 * DAY * 1000;
  const rows = db.prepare('SELECT ad_id, rank, captured_at FROM rank_history WHERE brand_id = ? AND captured_at >= ? ORDER BY captured_at')
    .all(brandId, since);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.ad_id)) map.set(r.ad_id, []);
    map.get(r.ad_id).push([r.captured_at, r.rank]);
  }
  return map;
}

function enrich(ad, ctx) {
  const { settings, total, history, analyses, transcripts } = ctx;
  const media = JSON.parse(ad.media || '[]').map((m, i) => ({ ...m, image: localMedia(`${ad.id}_${i}.jpg`, m.image) }));
  const days = ad.start_date ? Math.max(1, Math.round(((ad.is_active ? now() : ad.end_date || now()) - ad.start_date) / DAY)) : 0;
  const reach = (ad.eu_reach || 0) + (ad.uk_reach || 0);
  const spend = reach ? Math.round(reach * settings.frequency * settings.cpm / 1000) : null;
  const hist = history.get(ad.id) || [];
  const startRank = hist[0]?.[1] ?? ad.current_rank;
  const rankGain = ad.current_rank && startRank ? startRank - ad.current_rank : 0;
  const rankPct = ad.current_rank ? 1 - (ad.current_rank - 1) / Math.max(total, 1) : 0;
  // "Winning score": high rank, long running and many versions all signal a scaled ad.
  const score = Math.round(99 * (0.55 * rankPct + 0.3 * Math.min(days / 60, 1) + 0.15 * Math.min((ad.collation_count || 1) / 5, 1)));
  const analysis = analyses.get(ad.id) || null;
  const format = media.some(m => m.type === 'video') ? 'video' : ad.display_format === 'CAROUSEL' ? 'carousel' : ad.display_format === 'DCO' ? 'dco' : 'image';
  return {
    ...ad,
    media,
    platforms: JSON.parse(ad.platforms || '[]'),
    page_logo: localMedia(`page_${ad.page_id}.jpg`, null),
    format, days, reach, spend, spend_per_day: spend ? Math.round(spend / Math.max(days, 1)) : null,
    rank: ad.current_rank, rank_start: startRank, rank_gain: rankGain,
    rank_series: hist.map(h => h[1]), rank_first_date: hist[0]?.[0] ?? null,
    score, analysis,
    tags: analysis ? [analysis.asset_type, analysis.visual_format, analysis.messaging_angle, analysis.hook_tactic, analysis.offer_type].filter(Boolean) : [],
    transcript: transcripts.get(ad.id) || null,
    words: (ad.body || '').split(/\s+/).filter(Boolean).length,
  };
}

export function brandAds(brandId, { includeInactive = false } = {}) {
  const rows = db.prepare(`SELECT ${COLS} FROM ads WHERE brand_id = ? ${includeInactive ? '' : 'AND current_rank IS NOT NULL'}`).all(brandId);
  const ids = rows.map(r => r.id);
  const analyses = new Map(), transcripts = new Map();
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    for (const a of db.prepare(`SELECT ad_id, json FROM analyses WHERE ad_id IN (${ph})`).all(...ids)) analyses.set(a.ad_id, JSON.parse(a.json));
    for (const t of db.prepare(`SELECT ad_id, text FROM transcripts WHERE ad_id IN (${ph})`).all(...ids)) transcripts.set(t.ad_id, t.text);
  }
  const ctx = { settings: getSettings(), total: rows.filter(r => r.current_rank).length, history: rankHistory(brandId), analyses, transcripts };
  return rows.map(r => enrich(r, ctx));
}

// ---------- filters + sort for the Ads tab ----------

const dayOf = ts => new Date(ts * 1000).toISOString().slice(0, 10);
const list = v => (v ? String(v).split(',').filter(Boolean) : []);

export function filterAds(ads, f) {
  const pages = list(f.pages), pageTypes = list(f.pageType), platforms = list(f.platform), formats = list(f.format);
  const landing = list(f.landing), ctas = list(f.cta), tags = list(f.tag);
  const q = (f.q || '').toLowerCase();
  let out = ads.filter(a => {
    if (f.status === 'active' && !a.is_active) return false;
    if (f.status === 'inactive' && a.is_active) return false;
    if (f.minDays && a.days < +f.minDays) return false;
    if (f.maxDays && a.days > +f.maxDays) return false;
    if (f.from && a.start_date && dayOf(a.start_date) < f.from) return false;
    if (f.to && a.start_date && dayOf(a.start_date) > f.to) return false;
    if (f.launched && (!a.start_date || dayOf(a.start_date) !== f.launched)) return false;
    if (f.minScore && a.score < +f.minScore) return false;
    if (f.minGain && a.rank_gain < +f.minGain) return false;
    if (pages.length && !pages.includes(a.page_id)) return false;
    if (pageTypes.length && !pageTypes.includes(a.page_type)) return false;
    if (platforms.length && !a.platforms.some(p => platforms.includes(p))) return false;
    if (formats.length && !formats.includes(a.format)) return false;
    if (landing.length && !landing.includes(a.landing_key)) return false;
    if (ctas.length && !ctas.includes(a.cta_text)) return false;
    if (tags.length && !a.tags.some(t => tags.includes(t))) return false;
    if (f.copyLen === 'short' && a.words >= 50) return false;
    if (f.copyLen === 'medium' && (a.words < 50 || a.words > 150)) return false;
    if (f.copyLen === 'long' && a.words <= 150) return false;
    if (f.hook && a.hook !== f.hook) return false;
    if (f.headline && a.title !== f.headline) return false;
    if (f.copy && a.body !== f.copy) return false;
    if (q && !`${a.body} ${a.title} ${a.transcript || ''} ${a.page_name}`.toLowerCase().includes(q)) return false;
    return true;
  });
  const sorts = {
    rank: (a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9),
    score: (a, b) => b.score - a.score,
    newest: (a, b) => (b.start_date || 0) - (a.start_date || 0),
    longest: (a, b) => b.days - a.days,
    spend: (a, b) => (b.spend || 0) - (a.spend || 0),
    climbers: (a, b) => b.rank_gain - a.rank_gain,
  };
  out.sort(sorts[f.sort] || sorts.rank);
  if (f.group === '1') {
    // Group versions: keep the best-ranked ad of each collation group.
    const seen = new Set();
    out = out.filter(a => {
      const key = a.collation_id || a.id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  return out;
}

// ---------- tabs ----------

function countBy(items, key, limit = 10) {
  const m = new Map();
  for (const it of items) {
    const k = typeof key === 'function' ? key(it) : it[key];
    if (k == null || k === '') continue;
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([value, count]) => ({ value, count }));
}

export function brandSummary(brand, ads) {
  const active = ads.filter(a => a.rank);
  const t = now();
  const reach = active.reduce((s, a) => s + a.reach, 0);
  const spend = active.reduce((s, a) => s + (a.spend || 0), 0);
  const pages = countBy(active, a => a.page_id, 999);
  return {
    ...brand,
    logo: brand.page_id ? localMedia(`page_${brand.page_id}.jpg`, brand.logo) : brand.logo,
    pages_count: pages.length,
    tracked: active.length,
    new_7d: active.filter(a => a.start_date > t - 7 * DAY).length,
    reach, spend,
  };
}

export function overview(brand, ads) {
  const active = ads.filter(a => a.rank);
  const t = now();
  const weeks = [];
  for (let w = 11; w >= 0; w--) {
    const end = t - w * 7 * DAY, start = end - 7 * DAY;
    weeks.push({ start: dayOf(start), count: active.filter(a => a.start_date > start && a.start_date <= end).length });
  }
  const ageBuckets = [['< 7d', 0, 7], ['7–30d', 7, 30], ['30–90d', 30, 90], ['90–180d', 90, 180], ['180d+', 180, 1e9]]
    .map(([label, lo, hi]) => ({ label, count: active.filter(a => a.days >= lo && a.days < hi).length }));
  const pageNames = new Map(active.map(a => [a.page_id, a.page_name]));
  const days = active.map(a => a.days).sort((a, b) => a - b);
  return {
    summary: brandSummary(brand, ads),
    insights: {
      running: active.length,
      pages: pageNames.size,
      new_7d: active.filter(a => a.start_date > t - 7 * DAY).length,
      new_30d: active.filter(a => a.start_date > t - 30 * DAY).length,
      median_days: days.length ? days[Math.floor(days.length / 2)] : 0,
      video_share: active.length ? Math.round(100 * active.filter(a => a.format === 'video').length / active.length) : 0,
    },
    top_ads: active.slice().sort((a, b) => a.rank - b.rank).slice(0, 8),
    weeks,
    formats: countBy(active, 'format'),
    landing: countBy(active, 'landing_key', 8),
    ctas: countBy(active, 'cta_text', 8),
    pages: countBy(active, 'page_id', 10).map(p => ({ ...p, name: pageNames.get(p.value) })),
    page_types: countBy(active, 'page_type'),
    ages: ageBuckets,
  };
}

export function ranking(ads) {
  const active = ads.filter(a => a.rank);
  return {
    climbers: active.filter(a => a.rank_gain > 0).sort((a, b) => b.rank_gain - a.rank_gain).slice(0, 50),
    top: active.slice().sort((a, b) => a.rank - b.rank).slice(0, 50),
    snapshots: Math.max(0, ...active.map(a => a.rank_series.length)),
  };
}

export function landingPages(ads) {
  const active = ads.filter(a => a.rank);
  const groups = new Map();
  for (const a of active) {
    if (!a.landing_key) continue;
    if (!groups.has(a.landing_key)) groups.set(a.landing_key, { key: a.landing_key, url: a.link_url, count: 0, pages: new Set(), best_rank: 1e9, sample: a });
    const g = groups.get(a.landing_key);
    g.count++; g.pages.add(a.page_name);
    if (a.rank < g.best_rank) { g.best_rank = a.rank; g.sample = a; }
  }
  return [...groups.values()].sort((a, b) => b.count - a.count)
    .map(g => ({ ...g, pages: [...g.pages], sample: { id: g.sample.id, title: g.sample.title, image: g.sample.media[0]?.image } }));
}

export function launches(ads) {
  const byDay = {};
  for (const a of ads) if (a.rank && a.start_date) byDay[dayOf(a.start_date)] = (byDay[dayOf(a.start_date)] || 0) + 1;
  return byDay;
}

export function hooks(ads) {
  const active = ads.filter(a => a.rank);
  const group = (key) => {
    const m = new Map();
    for (const a of active) {
      const k = a[key];
      if (!k) continue;
      if (!m.has(k)) m.set(k, { text: k, count: 0, pages: new Set(), best_rank: 1e9, longest: 0, thumbs: [] });
      const g = m.get(k);
      g.count++; g.pages.add(a.page_name);
      g.best_rank = Math.min(g.best_rank, a.rank); g.longest = Math.max(g.longest, a.days);
      if (g.thumbs.length < 3 && a.media[0]?.image) g.thumbs.push(a.media[0].image);
    }
    return [...m.values()].sort((a, b) => b.count - a.count || a.best_rank - b.best_rank).slice(0, 60).map(g => ({ ...g, pages: [...g.pages] }));
  };
  return { hook: group('hook'), headline: group('title'), copy: group('body'), transcript: group('transcript') };
}

export function filterOptions(ads) {
  const active = ads.filter(a => a.rank);
  const pageNames = new Map(active.map(a => [a.page_id, a.page_name]));
  return {
    pages: countBy(active, 'page_id', 999).map(p => ({ ...p, name: pageNames.get(p.value) })),
    platforms: countBy(active.flatMap(a => a.platforms.map(p => ({ p }))), 'p'),
    landing: countBy(active, 'landing_key', 50),
    ctas: countBy(active, 'cta_text', 30),
    tags: countBy(active.flatMap(a => a.tags.map(t => ({ t }))), 't', 60),
  };
}
