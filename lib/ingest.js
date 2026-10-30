import { createWriteStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { db, tx, MEDIA_DIR, getSettings } from './db.js';
import { scrapeAds, keywordSearchUrl } from './apify.js';

// ---------- normalizing one scraped ad ----------

export function landingKey(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return (u.hostname.replace(/^www\./, '') + u.pathname).replace(/\/$/, '').toLowerCase();
  } catch { return null; }
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; }
}

export function firstLine(text) {
  if (!text) return null;
  const line = text.trim().split(/\n+/)[0].trim();
  const sentence = line.match(/^.{20,}?[.!?…](\s|$)/);
  return (sentence ? sentence[0] : line).trim().slice(0, 220) || null;
}

// Turns {{product.name}} style DCO placeholders into readable text.
const clean = s => (s || '').replace(/\{\{[^}]+\}\}/g, '').trim() || null;

function demographics(breakdowns) {
  const ages = {};
  let male = 0, female = 0, unknown = 0;
  for (const country of breakdowns || []) {
    for (const b of country.age_gender_breakdowns || []) {
      const t = (b.male || 0) + (b.female || 0) + (b.unknown || 0);
      ages[b.age_range] = (ages[b.age_range] || 0) + t;
      male += b.male || 0; female += b.female || 0; unknown += b.unknown || 0;
    }
  }
  return Object.keys(ages).length ? { ages, male, female, unknown } : null;
}

function mediaOf(s) {
  const out = [];
  for (const v of s.videos || []) {
    out.push({ type: 'video', video: v.video_hd_url || v.video_sd_url, image: v.video_preview_image_url });
  }
  for (const i of s.images || []) {
    out.push({ type: 'image', image: i.resized_image_url || i.original_image_url });
  }
  for (const c of s.cards || []) {
    const video = c.video_hd_url || c.video_sd_url;
    out.push({
      type: video ? 'video' : 'image', video,
      image: c.video_preview_image_url || c.resized_image_url || c.original_image_url,
      title: clean(c.title), body: clean(c.body), link: c.link_url,
    });
  }
  return out.filter(m => m.image || m.video);
}

export function normalize(item, brand) {
  const s = item.snapshot || {};
  const eu = item.transparency_by_location?.eu_transparency || item.aaa_info || {};
  const uk = item.transparency_by_location?.uk_transparency || {};
  const firstCard = (s.cards || [])[0] || {};
  const body = clean(s.body?.text) || clean(firstCard.body);
  const link = s.link_url || firstCard.link_url;
  const pageType = s.branded_content ? 'partnership'
    : (brand.page_id && String(item.page_id) === String(brand.page_id)) ? 'brand' : 'creator';
  const aaa = item.aaa_info || {};
  const locations = (aaa.location_audience || eu.location_audience || []).filter(l => !l.excluded).map(l => l.name);
  return {
    id: String(item.ad_archive_id),
    page_id: String(item.page_id || s.page_id || ''),
    page_name: item.page_name || s.page_name,
    page_logo: s.page_profile_picture_url,
    page_type: pageType,
    is_active: item.is_active ? 1 : 0,
    start_date: item.start_date || null,
    end_date: item.end_date || null,
    display_format: s.display_format || null,
    platforms: JSON.stringify(item.publisher_platform || []),
    cta_text: s.cta_text || firstCard.cta_text || null,
    cta_type: s.cta_type || firstCard.cta_type || null,
    link_url: link || null,
    landing_key: landingKey(link),
    title: clean(s.title) || clean(firstCard.title),
    body,
    hook: firstLine(body),
    caption: s.caption || null,
    collation_id: item.collation_id ? String(item.collation_id) : null,
    collation_count: item.collation_count || 1,
    eu_reach: eu.eu_total_reach || aaa.eu_total_reach || null,
    uk_reach: uk.total_reach || null,
    demo: JSON.stringify(demographics(eu.age_country_gender_reach_breakdown || aaa.age_country_gender_reach_breakdown)),
    targeting: JSON.stringify({
      age: aaa.age_audience || eu.age_audience || null,
      gender: aaa.gender_audience || eu.gender_audience || null,
      locations: locations.slice(0, 30),
    }),
    media: JSON.stringify(mediaOf(s)),
    raw: JSON.stringify(item),
  };
}

// ---------- media cache (Facebook CDN links expire after a few weeks) ----------

async function download(url, file) {
  if (!url || existsSync(file)) return;
  const res = await fetch(url);
  if (!res.ok || !res.body) return;
  await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
}

export async function cacheImages(ads) {
  const jobs = [];
  for (const ad of ads) {
    JSON.parse(ad.media).forEach((m, i) => {
      if (m.image) jobs.push(() => download(m.image, join(MEDIA_DIR, `${ad.id}_${i}.jpg`)));
    });
    if (ad.page_logo) jobs.push(() => download(ad.page_logo, join(MEDIA_DIR, `page_${ad.page_id}.jpg`)));
  }
  const worker = async () => { while (jobs.length) await jobs.shift()().catch(() => {}); };
  await Promise.all(Array.from({ length: 8 }, worker));
}

// ---------- saving one scrape into the database ----------

const UPSERT = db.prepare(`
INSERT INTO ads (id, brand_id, page_id, page_name, page_logo, page_type, is_active, start_date, end_date,
  display_format, platforms, cta_text, cta_type, link_url, landing_key, title, body, hook, caption,
  collation_id, collation_count, eu_reach, uk_reach, demo, targeting, media, current_rank, first_seen, last_seen, raw)
VALUES ($id, $brand_id, $page_id, $page_name, $page_logo, $page_type, $is_active, $start_date, $end_date,
  $display_format, $platforms, $cta_text, $cta_type, $link_url, $landing_key, $title, $body, $hook, $caption,
  $collation_id, $collation_count, $eu_reach, $uk_reach, $demo, $targeting, $media, $current_rank, $now, $now, $raw)
ON CONFLICT(id) DO UPDATE SET
  page_name = excluded.page_name, page_logo = excluded.page_logo, page_type = excluded.page_type,
  is_active = excluded.is_active, end_date = excluded.end_date, platforms = excluded.platforms,
  link_url = excluded.link_url, landing_key = excluded.landing_key, media = excluded.media,
  collation_count = excluded.collation_count, eu_reach = excluded.eu_reach, uk_reach = excluded.uk_reach,
  demo = excluded.demo, targeting = excluded.targeting, current_rank = excluded.current_rank,
  last_seen = excluded.last_seen, raw = excluded.raw`);

export function saveScrape(brand, rankedAds) {
  const now = Date.now();
  tx(() => {
    // Ads that dropped out of the scrape are no longer in the active top list.
    db.prepare('UPDATE ads SET current_rank = NULL, is_active = 0 WHERE brand_id = ?').run(brand.id);
    const hist = db.prepare('INSERT INTO rank_history (ad_id, brand_id, captured_at, rank) VALUES (?, ?, ?, ?)');
    rankedAds.forEach((ad, i) => {
      UPSERT.run({ ...prefix(ad), $brand_id: brand.id, $current_rank: i + 1, $now: now });
      hist.run(ad.id, brand.id, now, i + 1);
    });
  });
}

const prefix = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [`$${k}`, v ?? null]));

// ---------- full refresh of one tracked brand ----------

const running = new Set();
export const isRefreshing = id => running.has(id);

function setStatus(id, status, msg = null) {
  db.prepare('UPDATE brands SET status = ?, status_msg = ? WHERE id = ?').run(status, msg, id);
}

export async function refreshBrand(brandId) {
  if (running.has(brandId)) return;
  running.add(brandId);
  const brand = db.prepare('SELECT * FROM brands WHERE id = ?').get(brandId);
  const { max_ads } = getSettings();
  try {
    setStatus(brandId, 'running', 'Scraping the brand page…');
    const pageItems = await scrapeAds(brand.source_url, { limit: max_ads, onStatus: m => setStatus(brandId, 'running', m) });
    if (!pageItems.length) throw new Error('No active ads found for this page.');
    deriveBrandInfo(brand, pageItems);

    // Second pass: other pages (creators, partners) sending traffic to the brand's store.
    let matching = [];
    if (brand.domain) {
      setStatus(brandId, 'running', `Finding other pages that link to ${brand.domain}…`);
      const domainItems = await scrapeAds(keywordSearchUrl(brand.domain), { limit: 300, onStatus: m => setStatus(brandId, 'running', m) })
        .catch(() => []);
      matching = domainItems.filter(it => {
        const s = it.snapshot || {};
        return hostOf(s.link_url || s.cards?.[0]?.link_url)?.endsWith(brand.domain);
      });
    }
    ingestItems(brand, pageItems, matching);
    setStatus(brandId, 'running', 'Saving images…');
    const ads = db.prepare('SELECT id, media, page_logo, page_id FROM ads WHERE brand_id = ? AND current_rank IS NOT NULL').all(brandId);
    await cacheImages(ads);
    db.prepare('UPDATE brands SET status = ?, status_msg = NULL, last_refreshed_at = ? WHERE id = ?').run('ready', Date.now(), brandId);
  } catch (e) {
    console.error(`[refresh ${brandId}]`, e);
    setStatus(brandId, 'error', e.message);
  } finally {
    running.delete(brandId);
  }
}

// Fills in the brand's page id, name, logo and store domain from its own ads.
export function deriveBrandInfo(brand, pageItems) {
  if (!brand.page_id || !brand.name) {
    const first = pageItems[0];
    brand.page_id ||= String(first.page_id);
    brand.name ||= first.page_name;
    brand.logo ||= first.snapshot?.page_profile_picture_url;
  }
  if (!brand.domain) {
    const counts = {};
    for (const it of pageItems) {
      const h = hostOf(it.snapshot?.link_url || it.snapshot?.cards?.[0]?.link_url);
      if (h && !/facebook|instagram|fb\.me|bit\.ly|linktr/.test(h)) counts[h] = (counts[h] || 0) + 1;
    }
    brand.domain = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0]?.split('.').slice(-2).join('.') || null;
  }
  db.prepare('UPDATE brands SET name = ?, page_id = ?, domain = ?, logo = ? WHERE id = ?')
    .run(brand.name ?? null, brand.page_id ?? null, brand.domain ?? null, brand.logo ?? null, brand.id);
}

// Merge page ads and domain ads into one ranked list. Each source is already
// sorted by Meta impressions, so we interleave by relative position.
export function ingestItems(brand, pageItems, extraItems) {
  const { max_ads } = getSettings();
  const seen = new Set();
  const scored = [];
  [pageItems, extraItems].forEach(list => list.forEach((it, i) => {
    const id = String(it.ad_archive_id);
    if (seen.has(id)) return;
    seen.add(id);
    scored.push({ pos: (i + 1) / list.length, ad: normalize(it, brand) });
  }));
  scored.sort((a, b) => a.pos - b.pos);
  saveScrape(brand, scored.slice(0, max_ads).map(s => s.ad));
}
