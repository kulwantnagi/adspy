// Runs the Facebook Ad Library scraper on Apify and returns its dataset items.
const ACTOR = 'curious_coder~facebook-ads-library-scraper';
const API = 'https://api.apify.com/v2';

function token() {
  const t = process.env.APIFY_TOKEN;
  if (!t) throw new Error('APIFY_TOKEN is not set. Add it to your shell or .env file.');
  return t;
}

async function api(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json', ...opts.headers },
  });
  if (!res.ok) throw new Error(`Apify ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

export async function scrapeAds(url, { limit = 500, onStatus = () => {} } = {}) {
  const input = {
    urls: [{ url }],
    count: limit,
    limitPerSource: limit,
    scrapeAdDetails: true,
    'scrapePageAds.activeStatus': 'active',
    'scrapePageAds.sortBy': 'impressions_desc',
    'scrapePageAds.countryCode': 'ALL',
  };
  // Hard cost cap per run: about $0.75 per 1,000 ads, so $3 is a generous ceiling.
  const { data: run } = await api(`/acts/${ACTOR}/runs?maxTotalChargeUsd=3`, { method: 'POST', body: JSON.stringify(input) });
  let status = run.status;
  const started = Date.now();
  while (!['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(status)) {
    await new Promise(r => setTimeout(r, 5000));
    const { data } = await api(`/actor-runs/${run.id}`);
    status = data.status;
    onStatus(`Scraping Ad Library… ${Math.round((Date.now() - started) / 1000)}s`);
  }
  if (status !== 'SUCCEEDED') throw new Error(`Apify run ${status}`);
  const items = [];
  for (let offset = 0; ; offset += 250) {
    const res = await fetch(`${API}/datasets/${run.defaultDatasetId}/items?clean=true&format=json&offset=${offset}&limit=250`, {
      headers: { Authorization: `Bearer ${token()}` },
    });
    const page = await res.json();
    items.push(...page);
    if (page.length < 250) break;
  }
  // The scraper reports problems as rows like { error: 'Ads not found', url }.
  const ads = items.filter(it => it.ad_archive_id);
  if (!ads.length && items[0]?.error) throw new Error(`${items[0].error}. Check the page URL, or paste the brand's Ad Library link instead.`);
  return ads;
}

export function keywordSearchUrl(q) {
  return `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&q=${encodeURIComponent(q)}&search_type=keyword_unordered&media_type=all`;
}
