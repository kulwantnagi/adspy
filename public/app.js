// ---------- helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const app = $('#app');
const h = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// Scraped links go into href/src, so only allow http(s) (blocks javascript: URLs).
const safeUrl = u => /^https?:\/\//i.test(u || '') ? h(u) : '#';
const num = n => n == null ? '–' : n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K` : String(n);
const money = n => n == null ? '–' : `$${num(n)}`;
const date = ts => ts ? new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '–';
const ago = ms => {
  if (!ms) return 'never';
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};
const initial = s => h((s || '?').trim()[0]?.toUpperCase());
const avatar = (src, name, cls = '') => src ? `<img class="avatar ${cls}" src="${h(src)}" alt="">` : `<span class="avatar ${cls}">${initial(name)}</span>`;

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, { headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 3000);
}

function route() {
  const [path, qs] = location.hash.slice(1).split('?');
  return { parts: (path || '/').split('/').filter(Boolean), q: Object.fromEntries(new URLSearchParams(qs || '')) };
}
const go = (brandId, tab, q = {}) => {
  const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== '' && v != null)).toString();
  location.hash = `#/brand/${brandId}/${tab}${qs ? `?${qs}` : ''}`;
};

// ---------- modal ----------
function openModal(html, cls = '') {
  $('#modal-root').innerHTML = `<div class="overlay"><div class="modal ${cls}">${html}</div></div>`;
  const ov = $('#modal-root .overlay');
  ov.addEventListener('click', e => { if (e.target === ov || e.target.closest('[data-close]')) closeModal(); });
  return $('.modal', ov);
}
const closeModal = () => { $('#modal-root').innerHTML = ''; };
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

// ---------- competitors ----------
let pollTimer;
function pollWhile(cond, fn) {
  clearTimeout(pollTimer);
  if (cond) pollTimer = setTimeout(fn, 5000);
}

async function renderCompetitors() {
  const brands = await api('/brands');
  app.innerHTML = `
    <div class="page-head">
      <div><h1>Ad Spy</h1><div class="muted">Track competitor brands and see which of their ads Meta is scaling.</div></div>
      <button class="btn primary" id="track">+ Track a brand</button>
    </div>
    <div class="panel">
      ${brands.length ? `<table class="table">
        <thead><tr><th>Brand</th><th>Tracked ads</th><th>New in 7 days</th><th class="hide-sm">EU/UK reach · est. spend</th><th class="hide-sm">Updated</th><th></th></tr></thead>
        <tbody>${brands.map(b => {
          const max = Math.max(...brands.map(x => x.spend || 0), 1);
          const busy = b.status === 'running' || b.status === 'queued';
          return `<tr class="click" data-id="${b.id}">
            <td><div class="brand-cell">${avatar(b.logo, b.name)}<div><b>${h(b.name || 'New brand')}</b>
              <div class="small muted">${h(b.domain || b.source_url)} · ${b.pages_count} Facebook page${b.pages_count === 1 ? '' : 's'}</div></div></div></td>
            <td><b>${b.tracked}</b></td>
            <td><span class="pill">${b.new_7d}</span></td>
            <td class="hide-sm" style="min-width:170px"><div class="small"><b>${num(b.reach)}</b> · ${money(b.spend)}</div><div class="bar"><i style="width:${Math.round(100 * (b.spend || 0) / max)}%"></i></div></td>
            <td class="hide-sm small">${busy ? `<span class="spin"></span> ${h(b.status_msg || 'Queued')}` : b.status === 'error' ? `<span class="pill red" title="${h(b.status_msg)}">Error</span>` : ago(b.last_refreshed_at)}</td>
            <td style="text-align:right;white-space:nowrap">
              <button class="icon-btn" data-refresh="${b.id}" title="Refresh now">↻</button>
              <button class="icon-btn" data-del="${b.id}" title="Stop tracking">✕</button></td>
          </tr>`;
        }).join('')}</tbody></table>`
      : `<div class="empty"><h2>No brands yet</h2><p>Click <b>Track a brand</b> and paste a competitor's Facebook page URL.</p></div>`}
    </div>
    <p class="small muted">We track each brand's top 500 active ads by Meta impressions, plus ads from other pages that send traffic to its store. Brands refresh automatically every day while AdSpy is running.</p>`;

  $('#track').onclick = trackModal;
  app.querySelectorAll('tr[data-id]').forEach(tr => tr.onclick = e => {
    if (e.target.closest('button')) return;
    location.hash = `#/brand/${tr.dataset.id}/overview`;
  });
  app.querySelectorAll('[data-refresh]').forEach(b => b.onclick = async () => { await api(`/brands/${b.dataset.refresh}/refresh`, { method: 'POST' }); renderCompetitors(); });
  app.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!confirm('Stop tracking this brand? Its saved ads will be deleted.')) return;
    await api(`/brands/${b.dataset.del}`, { method: 'DELETE' }); renderCompetitors();
  });
  pollWhile(brands.some(b => b.status === 'running' || b.status === 'queued') && route().parts.length === 0, renderCompetitors);
}

function trackModal() {
  const m = openModal(`
    <div class="modal-head"><b>Track a brand</b><button class="icon-btn" data-close>✕</button></div>
    <form class="form">
      <label>Facebook page URL or Ad Library URL
        <input name="url" required placeholder="https://www.facebook.com/brandname" autofocus></label>
      <div class="small muted">Example: https://www.facebook.com/ZapierApp, or an Ad Library link with <code>view_all_page_id=…</code>.
        The first scrape takes 2–6 minutes and costs about $0.40 in Apify credits.</div>
      <button class="btn primary">Start tracking</button>
    </form>`, 'narrow');
  $('form', m).onsubmit = async e => {
    e.preventDefault();
    try {
      await api('/brands', { method: 'POST', body: { url: e.target.url.value } });
      closeModal(); toast('Tracking started. This takes a few minutes.'); renderCompetitors();
    } catch (err) { toast(err.message); }
  };
}

// ---------- brand page ----------
const TABS = [['overview', 'Overview'], ['ads', 'Ads'], ['ranking', 'Ranking'], ['landing', 'Landing pages'], ['launches', 'Launches'], ['hooks', 'Hooks and copy']];

async function renderBrand(id, tab, q) {
  const b = await api(`/brands/${id}`);
  const busy = b.refreshing || b.status === 'queued' || b.status === 'running';
  const pagesSel = (q.pages || '').split(',').filter(Boolean);
  app.innerHTML = `
    <a class="crumb" href="#/">← Competitors</a>
    <div class="brand-head">
      ${avatar(b.logo, b.name)}
      <h1>${h(b.name || 'Loading brand…')}</h1>
      ${b.domain ? `<a class="small" href="https://${h(b.domain)}" target="_blank" rel="noopener">${h(b.domain)} ↗</a>` : ''}
      <select id="pages-filter" title="Filter by Facebook page">
        <option value="">All pages (${b.options.pages.length})</option>
        ${b.options.pages.map(p => `<option value="${h(p.value)}" ${pagesSel.includes(p.value) ? 'selected' : ''}>${h(p.name)} · ${p.count}</option>`).join('')}
      </select>
      <span class="grow" style="flex:1"></span>
      <span class="small muted">Updated ${ago(b.last_refreshed_at)}</span>
      <button class="btn sm" id="refresh" ${busy ? 'disabled' : ''}>↻ Refresh</button>
    </div>
    ${busy ? `<div class="banner"><span class="spin"></span> ${h(b.status_msg || 'Queued for scraping…')}</div>` : ''}
    ${b.status === 'error' ? `<div class="banner err">Last refresh failed: ${h(b.status_msg)}</div>` : ''}
    <div class="stats">
      <div class="stat"><div class="k">Tracked ads</div><div class="v">${b.tracked}</div></div>
      <div class="stat"><div class="k">New in 7 days</div><div class="v">${b.new_7d}</div></div>
      <div class="stat"><div class="k">EU/UK reach</div><div class="v">${num(b.reach)}</div></div>
      <div class="stat"><div class="k">Est. EU/UK spend</div><div class="v">${money(b.spend)}</div></div>
    </div>
    <nav class="tabs">${TABS.map(([k, label]) => `<a href="#/brand/${id}/${k}${q.pages ? `?pages=${h(q.pages)}` : ''}" class="${k === tab ? 'on' : ''}">${label}</a>`).join('')}</nav>
    <div id="tab"></div>`;

  $('#refresh').onclick = async () => { await api(`/brands/${id}/refresh`, { method: 'POST' }); renderBrand(id, tab, q); };
  $('#pages-filter').onchange = e => go(id, tab === 'overview' ? 'ads' : tab, { ...q, pages: e.target.value });
  const el = $('#tab');
  if (!b.tracked && !busy) el.innerHTML = `<div class="empty">No ads yet. Click Refresh to scrape this brand.</div>`;
  else if (b.tracked) await ({ overview: tabOverview, ads: tabAds, ranking: tabRanking, landing: tabLanding, launches: tabLaunches, hooks: tabHooks }[tab] || tabOverview)(el, id, q, b);
  pollWhile(busy, () => { const r = route(); if (r.parts[1] === String(id)) renderBrand(id, tab, q); });
}

// ---------- ad card ----------
function adCard(a) {
  const m = a.media[0];
  return `<div class="card" data-ad="${a.id}">
    <div class="card-head">${avatar(a.page_logo, a.page_name, 'sm')}<span class="name">${h(a.page_name)}</span></div>
    <div class="badges">
      <span class="badge score" title="Winning score">🔥 ${a.score}</span>
      ${a.rank ? `<span class="badge rank" title="Rank by Meta impressions">#${a.rank}</span>` : '<span class="badge">inactive</span>'}
      ${a.rank_gain > 0 ? `<span class="badge up">▲${a.rank_gain}</span>` : ''}
      ${a.reach ? `<span class="badge eu">EU ${num(a.reach)}</span><span class="badge">est. ${money(a.spend)}</span>` : ''}
      ${a.collation_count > 1 ? `<span class="badge" title="Versions">⧉ ${a.collation_count}</span>` : ''}
    </div>
    <div class="thumb">${m?.image ? `<img loading="lazy" src="${h(m.image)}" alt="">` : ''}
      ${a.format === 'video' ? '<span class="play">▶ Video</span>' : ''}
      ${a.media.length > 1 ? `<span class="count">1/${a.media.length}</span>` : ''}</div>
    <div class="card-copy">${h(a.body || a.title || '')}</div>
    <div class="card-foot"><span>${a.days}d running</span><span>${h(a.cta_text || '')}</span></div>
  </div>`;
}
const bindCards = el => el.querySelectorAll('[data-ad]').forEach(c => c.onclick = () => openAd(c.dataset.ad));

// ---------- overview ----------
async function tabOverview(el, id) {
  const o = await api(`/brands/${id}/overview`);
  const i = o.insights;
  const maxW = Math.max(...o.weeks.map(w => w.count), 1);
  const colors = { video: '#6d4aff', image: '#d63384', carousel: '#1f9bd1', dco: '#f0a020' };
  const totalF = o.formats.reduce((s, f) => s + f.count, 0) || 1;
  const list = (rows, label, onClick) => {
    const max = Math.max(...rows.map(r => r.count), 1);
    return `<div class="rowlist">${rows.map(r => `<div class="r ${onClick ? 'click' : ''}" ${onClick ? `data-${onClick}="${h(r.value)}" style="cursor:pointer"` : ''}>
      <span title="${h(r.name || r.value)}">${h(label ? label(r) : r.value)}</span><b>${r.count}</b><div class="bar"><i style="width:${100 * r.count / max}%"></i></div></div>`).join('') || '<span class="muted small">No data</span>'}</div>`;
  };
  el.innerHTML = `
    <h2>Top ranked ads</h2>
    <div class="strip">${o.top_ads.map(adCard).join('')}</div>
    <div class="insights panel pad">
      <div><div class="v">${i.running}</div><div class="k">Running ads</div></div>
      <div><div class="v">${i.pages}</div><div class="k">Facebook pages</div></div>
      <div><div class="v">${i.new_7d}</div><div class="k">Launched in 7 days</div></div>
      <div><div class="v">${i.new_30d}</div><div class="k">Launched in 30 days</div></div>
      <div><div class="v">${i.median_days}d</div><div class="k">Median ad age</div></div>
      <div><div class="v">${i.video_share}%</div><div class="k">Video ads</div></div>
    </div>
    <div class="cols">
      <div class="panel pad"><h3>Running ads by launch week</h3>
        <div class="chart">${o.weeks.map(w => `<div class="col" title="Week of ${w.start}: ${w.count} ads"><span>${w.count || ''}</span><i style="height:${100 * w.count / maxW}%"></i><span>${w.start.slice(5)}</span></div>`).join('')}</div></div>
      <div class="panel pad"><h3>Format mix</h3>
        <div class="mix">${o.formats.map(f => `<i style="width:${100 * f.count / totalF}%;background:${colors[f.value]}"></i>`).join('')}</div>
        <div class="legend">${o.formats.map(f => `<span><span class="dot" style="background:${colors[f.value]}"></span>${f.value} ${Math.round(100 * f.count / totalF)}%</span>`).join('')}</div>
        <h3 style="margin-top:18px">Ad age</h3>${list(o.ages.map(a => ({ value: a.label, count: a.count })))}</div>
      <div class="panel pad"><h3>Top landing pages</h3>${list(o.landing, null, 'landing')}</div>
      <div class="panel pad"><h3>Call-to-action buttons</h3>${list(o.ctas, null, 'cta')}
        <h3 style="margin-top:18px">Facebook pages</h3>${list(o.pages, r => r.name, 'page')}</div>
    </div>`;
  bindCards(el);
  el.querySelectorAll('[data-landing]').forEach(r => r.onclick = () => go(id, 'ads', { landing: r.dataset.landing }));
  el.querySelectorAll('[data-cta]').forEach(r => r.onclick = () => go(id, 'ads', { cta: r.dataset.cta }));
  el.querySelectorAll('[data-page]').forEach(r => r.onclick = () => go(id, 'ads', { pages: r.dataset.page }));
}

// ---------- ads tab ----------
let filtersOpen = false;
const FILTER_LABELS = {
  status: 'Status', minDays: 'Min days', maxDays: 'Max days', from: 'From', to: 'To', launched: 'Launched', minScore: 'Score ≥', minGain: 'Rank gain ≥',
  pages: 'Page', pageType: 'Page type', platform: 'Platform', format: 'Format', landing: 'Landing', cta: 'CTA', copyLen: 'Copy', q: 'Text', tag: 'AI tag',
  hook: 'Hook', headline: 'Headline', copy: 'Ad copy',
};

async function tabAds(el, id, q, b) {
  const sel = (name, opts) => `<select data-f="${name}">${opts.map(([v, l]) => `<option value="${h(v)}" ${String(q[name] || '') === String(v) ? 'selected' : ''}>${h(l)}</option>`).join('')}</select>`;
  const o = b.options;
  const pageName = v => o.pages.find(p => p.value === v)?.name || v;
  const chips = Object.entries(q).filter(([k]) => FILTER_LABELS[k]).map(([k, v]) =>
    `<span class="chip">${FILTER_LABELS[k]}: ${h(k === 'pages' ? pageName(v) : String(v).slice(0, 50))}<button data-clear="${k}">✕</button></span>`).join('');
  el.innerHTML = `
    <div class="toolbar">
      <button class="btn ${filtersOpen ? 'soft' : ''}" id="ftoggle">⚲ Filters${chips ? ` (${Object.keys(q).filter(k => FILTER_LABELS[k]).length})` : ''}</button>
      ${sel('sort', [['rank', 'Top ranked'], ['score', 'Highest score'], ['climbers', 'Biggest climbers'], ['newest', 'Newest'], ['longest', 'Longest running'], ['spend', 'Est. spend']])}
      <span class="small muted" id="count"></span>
      <label class="small"><input type="checkbox" id="group" ${q.group === '1' ? 'checked' : ''}> Group versions</label>
      <span class="grow"></span>
      <button class="btn soft" id="autotag" title="Run AI analysis on the top 20 ads so you can filter by AI tags">✨ Auto-tag top 20</button>
    </div>
    <div class="panel filters" ${filtersOpen ? '' : 'hidden'}>
      <div class="row"><span class="label">Lifecycle</span>
        ${sel('status', [['', 'Active'], ['all', 'Active + stopped'], ['inactive', 'Stopped']])}
        ${sel('minDays', [['', 'Any days running'], ['7', '7+ days'], ['14', '14+ days'], ['30', '30+ days'], ['60', '60+ days'], ['90', '90+ days']])}
        <label class="small">From <input type="date" data-f="from" value="${h(q.from || '')}"></label>
        <label class="small">To <input type="date" data-f="to" value="${h(q.to || '')}"></label>
        ${sel('minScore', [['', 'Any score'], ['50', 'Score 50+'], ['70', 'Score 70+'], ['85', 'Score 85+']])}
        ${sel('minGain', [['', 'Any growth'], ['10', 'Climbed 10+ places'], ['50', 'Climbed 50+'], ['100', 'Climbed 100+']])}
      </div>
      <div class="row"><span class="label">Who ran it</span>
        ${sel('pageType', [['', 'All page types'], ['brand', 'Brand pages'], ['creator', 'Creator pages'], ['partnership', 'Partnership ads']])}
        ${sel('platform', [['', 'Any platform'], ...o.platforms.map(p => [p.value, `${p.value.toLowerCase()} (${p.count})`])])}
      </div>
      <div class="row"><span class="label">Creative</span>
        ${sel('format', [['', 'All media'], ['video', 'Video'], ['image', 'Image'], ['carousel', 'Carousel'], ['dco', 'Dynamic (DCO)']])}
        ${sel('landing', [['', 'Any landing page'], ...o.landing.map(l => [l.value, `${l.value} (${l.count})`])])}
        ${sel('cta', [['', 'Any CTA'], ...o.ctas.map(c => [c.value, `${c.value} (${c.count})`])])}
        ${sel('copyLen', [['', 'Any copy length'], ['short', 'Short (< 50 words)'], ['medium', 'Medium (50–150)'], ['long', 'Long (150+)']])}
        ${o.tags.length ? sel('tag', [['', 'AI tags'], ...o.tags.map(t => [t.value, `${t.value} (${t.count})`])]) : ''}
        <input data-f="q" placeholder="Said in the ad, e.g. doctor" value="${h(q.q || '')}" style="min-width:220px">
      </div>
    </div>
    ${chips ? `<div class="chips">${chips}<a href="#/brand/${id}/ads" class="small">Clear all</a></div>` : ''}
    <div class="grid" id="grid"></div>
    <div style="text-align:center;margin-top:16px"><button class="btn" id="more" hidden>Load more</button></div>`;

  const set = (k, v) => go(id, 'ads', { ...q, [k]: v });
  $('#ftoggle').onclick = () => { filtersOpen = !filtersOpen; $('.filters', el).hidden = !filtersOpen; $('#ftoggle').classList.toggle('soft', filtersOpen); };
  el.querySelectorAll('[data-f]').forEach(inp => inp.onchange = () => set(inp.dataset.f, inp.value));
  el.querySelectorAll('[data-clear]').forEach(b => b.onclick = () => { const n = { ...q }; delete n[b.dataset.clear]; go(id, 'ads', n); });
  $('#group').onchange = e => set('group', e.target.checked ? '1' : '');
  $('#autotag').onclick = async () => { const r = await api(`/brands/${id}/autotag`, { method: 'POST', body: { limit: 20 } }); toast(`AI is analyzing ${r.queued} ads in the background. Refresh in a few minutes.`); };

  let offset = 0;
  const load = async () => {
    const params = new URLSearchParams({ ...q, status: q.status || 'active', offset, limit: 40 });
    const r = await api(`/brands/${id}/ads?${params}`);
    $('#grid').insertAdjacentHTML('beforeend', r.ads.map(adCard).join(''));
    offset += r.ads.length;
    $('#count').textContent = `${r.total} ads`;
    $('#more').hidden = offset >= r.total;
    if (!r.total) $('#grid').innerHTML = '<div class="empty" style="grid-column:1/-1">No ads match these filters.</div>';
    bindCards($('#grid'));
  };
  $('#more').onclick = load;
  await load();
}

// ---------- ranking ----------
function sparkline(series) {
  if (series.length < 2) return '<span class="small muted">–</span>';
  const w = 100, hgt = 28, max = Math.max(...series), min = Math.min(...series), span = max - min || 1;
  // Lower rank number = better, so it is drawn higher.
  const pts = series.map((r, i) => `${(i / (series.length - 1)) * w},${((r - min) / span) * (hgt - 4) + 2}`).join(' ');
  return `<svg width="${w}" height="${hgt}"><polyline fill="none" stroke="var(--good)" stroke-width="2" points="${pts}"/></svg>`;
}

async function tabRanking(el, id, q) {
  const r = await api(`/brands/${id}/ranking`);
  const mode = q.mode || (r.climbers.length ? 'climbers' : 'top');
  const rows = mode === 'climbers' ? r.climbers : r.top;
  el.innerHTML = `
    <div class="toolbar">
      <div class="subtabs"><button data-mode="climbers" class="${mode === 'climbers' ? 'on' : ''}">Biggest climbers</button><button data-mode="top" class="${mode === 'top' ? 'on' : ''}">Top ranked now</button></div>
      <span class="small muted">Rank = position in the brand's ads, ordered by Meta impressions. Tracked over the last 30 days.</span>
    </div>
    ${r.snapshots < 2 ? `<div class="banner">Only one snapshot so far. Rank changes appear after the next daily refresh. Showing current ranks.</div>` : ''}
    <div class="panel">
      ${rows.map(a => `<div class="rank-row" data-ad="${a.id}">
        <div><div class="rank-now">#${a.rank}</div><div class="small muted">now</div></div>
        <div>${a.rank_gain > 0 ? `<span class="pill green">▲ ${a.rank_gain} places</span>` : a.rank_gain < 0 ? `<span class="pill red">▼ ${-a.rank_gain}</span>` : '<span class="pill gray">no change</span>'}
          <div class="small muted" style="margin-top:4px">from #${a.rank_start}${a.rank_first_date ? ` on ${new Date(a.rank_first_date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : ''}</div></div>
        <div class="hide-sm">${sparkline(a.rank_series)}</div>
        <img src="${h(a.media[0]?.image || '')}" alt="" loading="lazy">
        <div class="hide-sm"><div class="clamp2">${h(a.body || a.title || '')}</div><div class="small muted">${h(a.page_name)} · ${a.days}d running${a.reach ? ` · EU ${num(a.reach)}` : ''}</div></div>
      </div>`).join('') || '<div class="empty">No rank climbers yet.</div>'}
    </div>`;
  el.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => go(id, 'ranking', { ...q, mode: b.dataset.mode }));
  bindCards(el);
}

// ---------- landing pages ----------
async function tabLanding(el, id, q) {
  const pages = await api(`/brands/${id}/landing`);
  if (!pages.length) { el.innerHTML = '<div class="empty">No landing pages found.</div>'; return; }
  const cur = pages.find(p => p.key === q.lp) || pages[0];
  const total = pages.reduce((s, p) => s + p.count, 0);
  el.innerHTML = `
    <p class="small muted">Where this brand sends its ad traffic, most-used page first. ${pages.length} pages across ${total} ads.</p>
    <div class="lp">
      <div class="panel lp-list">${pages.map(p => `<div class="lp-item ${p === cur ? 'on' : ''}" data-lp="${h(p.key)}">
        <div class="t" title="${h(p.key)}">${h(p.key)}</div>
        <div class="small muted">${p.count} ads · ${Math.round(100 * p.count / total)}% · best rank #${p.best_rank}</div></div>`).join('')}</div>
      <div class="panel pad">
        <div class="toolbar"><b class="grow" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${h(cur.key)}</b>
          <a class="btn sm" href="${safeUrl(cur.url)}" target="_blank" rel="noopener">Open ↗</a>
          <button class="btn sm primary" id="show-ads">Show its ads (${cur.count})</button></div>
        <div class="small muted" style="margin-bottom:8px">Pages: ${h(cur.pages.join(', '))}</div>
        <iframe class="lp-frame" src="${safeUrl(cur.url)}" sandbox="allow-scripts allow-same-origin" loading="lazy"></iframe>
        <div class="small muted" style="margin-top:6px">Some sites block previews. If the frame is blank, use Open ↗.</div>
      </div>
    </div>`;
  el.querySelectorAll('[data-lp]').forEach(d => d.onclick = () => go(id, 'landing', { ...q, lp: d.dataset.lp }));
  $('#show-ads').onclick = () => go(id, 'ads', { landing: cur.key });
}

// ---------- launches calendar ----------
async function tabLaunches(el, id, q) {
  const byDay = await api(`/brands/${id}/launches`);
  const days = Object.keys(byDay).sort();
  const month = q.month || (days.at(-1) || new Date().toISOString()).slice(0, 7);
  const [y, m] = month.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1)), daysIn = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const shift = d => { const t = new Date(Date.UTC(y, m - 1 + d, 1)); return t.toISOString().slice(0, 7); };
  const max = Math.max(...days.filter(d => d.startsWith(month)).map(d => byDay[d]), 1);
  let cells = '';
  for (let i = 0; i < first.getUTCDay(); i++) cells += '<div class="day blank"></div>';
  for (let d = 1; d <= daysIn; d++) {
    const key = `${month}-${String(d).padStart(2, '0')}`, n = byDay[key] || 0;
    cells += `<div class="day ${n ? 'has' : ''}" ${n ? `data-day="${key}" style="background:color-mix(in srgb, var(--accent) ${Math.round(8 + 35 * n / max)}%, var(--panel))"` : ''}>${d}${n ? `<div class="n">${n}</div><div>ads</div>` : ''}</div>`;
  }
  el.innerHTML = `
    <div class="toolbar"><button class="btn sm" data-m="${shift(-1)}">←</button><h2 style="margin:0">${first.toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' })}</h2><button class="btn sm" data-m="${shift(1)}">→</button>
      <span class="small muted">How many of today's running ads launched each day. Big spikes = creative testing batches. Click a day to see its ads.</span></div>
    <div class="cal">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => `<div class="dow">${d}</div>`).join('')}${cells}</div>`;
  el.querySelectorAll('[data-m]').forEach(b => b.onclick = () => go(id, 'launches', { ...q, month: b.dataset.m }));
  el.querySelectorAll('[data-day]').forEach(d => d.onclick = () => go(id, 'ads', { launched: d.dataset.day, sort: 'rank' }));
}

// ---------- hooks & copy ----------
async function tabHooks(el, id, q) {
  const data = await api(`/brands/${id}/hooks`);
  const sub = q.sub || 'hook';
  const filterKey = { hook: 'hook', headline: 'headline', copy: 'copy', transcript: 'q' }[sub];
  const rows = data[sub];
  el.innerHTML = `
    <div class="toolbar">
      <div class="subtabs">${[['hook', 'Hook'], ['headline', 'Headline'], ['copy', 'Ad copy'], ['transcript', 'Transcript']].map(([k, l]) => `<button data-sub="${k}" class="${k === sub ? 'on' : ''}">${l}</button>`).join('')}</div>
      <span class="small muted">${rows.length} distinct · ${rows.filter(r => r.count > 1).length} used on more than one ad${sub === 'hook' ? ' · the hook is the first line of the ad text' : ''}</span>
    </div>
    <div class="panel">${rows.map((r, i) => `<div class="hook-row" data-i="${i}">
      <div class="thumbs">${r.thumbs.map(t => `<img src="${h(t)}" alt="" loading="lazy">`).join('')}</div>
      <div><div class="${sub === 'copy' || sub === 'transcript' ? 'clamp2' : ''}" style="font-size:13.5px">${h(r.text)}</div>
        <div class="small muted">${h(r.pages.slice(0, 3).join(', '))} · longest ${r.longest}d · best rank #${r.best_rank}</div></div>
      <div style="text-align:right"><span class="pill">${r.count} ad${r.count > 1 ? 's' : ''}</span></div>
    </div>`).join('') || `<div class="empty">${sub === 'transcript' ? 'No transcripts yet. Open a video ad and click View transcript.' : 'Nothing here yet.'}</div>`}</div>`;
  el.querySelectorAll('[data-sub]').forEach(b => b.onclick = () => go(id, 'hooks', { ...q, sub: b.dataset.sub }));
  el.querySelectorAll('[data-i]').forEach(d => d.onclick = () => {
    const text = rows[d.dataset.i].text;
    go(id, 'ads', { [filterKey]: filterKey === 'q' ? text.slice(0, 60) : text });
  });
}

// ---------- ad detail modal ----------
function analysisHtml(a) {
  if (!a) return '';
  const li = arr => `<ul class="tight">${(arr || []).map(x => `<li>${h(x)}</li>`).join('')}</ul>`;
  return `<div class="ai-tags">
      <span>Asset type</span><span>${h(a.asset_type)}</span><span>Visual format</span><span>${h(a.visual_format)}</span>
      <span>Messaging angle</span><span>${h(a.messaging_angle)}</span><span>Hook tactic</span><span>${h(a.hook_tactic)}</span>
      <span>Offer type</span><span>${h(a.offer_type)}</span><span>Target audience</span><span>${h(a.target_audience)}</span></div>
    <p>${h(a.summary)}</p>
    <h3>Creative breakdown</h3>${li(a.creative_breakdown)}
    <h3 style="margin-top:10px">Why it works</h3>${li(a.why_it_works)}
    <h3 style="margin-top:10px">Make your own version</h3>${li(a.remix_ideas)}`;
}

async function openAd(adId) {
  const m = openModal('<div class="pad"><span class="spin"></span> Loading ad…</div>');
  const a = await api(`/ads/${adId}`);
  const media = a.media[0];
  const isVideo = a.format === 'video';
  const demo = a.demo;
  const ageRows = demo ? Object.entries(demo.ages).filter(([k]) => k !== 'Unknown').sort() : [];
  const maxAge = Math.max(...ageRows.map(r => r[1]), 1);
  const genderTotal = demo ? demo.male + demo.female + demo.unknown || 1 : 1;
  const t = a.targeting || {};
  m.innerHTML = `
    <div class="modal-head"><b class="clamp2" style="max-width:85%">${h(a.title || a.hook || 'Ad')}</b><button class="icon-btn" data-close>✕</button></div>
    <div class="ad-detail">
      <div>
        <div class="media-box">${isVideo
          ? `<video controls preload="metadata" poster="${h(media?.image || '')}" src="/api/ads/${a.id}/video"></video>`
          : `<img src="${h(media?.image || '')}" alt="">`}</div>
        ${a.media.length > 1 ? `<div class="thumbs" style="margin-top:8px;flex-wrap:wrap">${a.media.map(x => `<img src="${h(x.image)}" alt="" data-swap="${h(x.image)}" style="cursor:pointer">`).join('')}</div>` : ''}
        <div class="media-actions">
          ${isVideo ? `<button class="btn soft" id="tx-btn">${a.transcript ? 'View transcript' : 'Get transcript'}</button>
            <a class="btn" href="/api/ads/${a.id}/video" download="${a.id}.mp4">⬇ Download video</a>` : ''}
          <a class="btn" href="https://www.facebook.com/ads/library/?id=${a.id}" target="_blank" rel="noopener">View in Ad Library ↗</a>
        </div>
        <div id="tx" class="section" ${a.transcript ? '' : 'hidden'}><h3>Video transcript</h3><div class="transcript">${h(a.transcript || '')}</div></div>
        <div class="kv"><div><div class="k">Running since</div><div class="v">${date(a.start_date)}</div></div><div><div class="k">Running for</div><div class="v">${a.days}d</div></div></div>
      </div>
      <div>
        <div style="display:flex;gap:8px;align-items:center">${avatar(a.page_logo, a.page_name, 'sm')}<b>${h(a.page_name)}</b><span class="pill gray">${h(a.page_type)}</span></div>
        <div class="small muted" style="margin:4px 0 8px">${a.rank ? `Rank #${a.rank} of ${a.rank_total} in this brand's ads, by Meta impressions${a.rank_gain > 0 ? ` · ▲ ${a.rank_gain} places in 30 days` : ''}` : 'No longer in the active top list'}</div>
        <div class="badges" style="padding:0"><span class="badge ${a.is_active ? 'up' : ''}">${a.is_active ? 'Active' : 'Stopped'}</span><span class="badge">${h(a.display_format)}</span>
          ${a.cta_text ? `<span class="badge rank">${h(a.cta_text)}</span>` : ''}${a.platforms.map(p => `<span class="badge">${h(p.toLowerCase())}</span>`).join('')}
          <span class="badge score">🔥 ${a.score}</span>${a.collation_count > 1 ? `<span class="badge">${a.collation_count} versions</span>` : ''}</div>

        <div class="reach-box">${a.reach ? `
          <div class="reach-nums"><span><b>${num(a.reach)}</b> <span class="muted">EU/UK reach</span></span><span><b>${money(a.spend)}</b> <span class="muted">est. spend · ${money(a.spend_per_day)}/day</span></span></div>
          ${demo ? `<div class="small muted" style="margin-bottom:6px">${Math.round(100 * demo.male / genderTotal)}% men · ${Math.round(100 * demo.female / genderTotal)}% women</div>
          ${ageRows.map(([age, n]) => `<div class="demo-row"><span>${h(age)}</span><div class="bar"><i style="width:${100 * n / maxAge}%"></i></div><span class="small muted">${num(n)}</span></div>`).join('')}` : ''}
          <div class="small muted" style="margin-top:8px">Targeting: ${t.age ? `ages ${t.age.min}–${t.age.max}` : ''} · ${h(t.gender || 'All')} · ${h((t.locations || []).slice(0, 6).join(', '))}${(t.locations || []).length > 6 ? '…' : ''}</div>
          <div class="small muted" style="margin-top:6px">Meta only publishes reach for ads shown in the EU/UK. Spend is an estimate: reach × ${a.settings.frequency} frequency × $${a.settings.cpm} CPM (change in Settings).</div>`
          : '<span class="small muted">No EU/UK reach data. This ad may not run in Europe, so Meta does not publish its reach.</span>'}</div>

        ${a.title ? `<h3>Headline</h3><p style="margin-top:0">${h(a.title)}</p>` : ''}
        <h3>Ad copy</h3><div class="copy">${h(a.body || '–')}</div>
        ${a.link_url ? `<p><a href="${safeUrl(a.link_url)}" target="_blank" rel="noopener" style="word-break:break-all">${h(a.link_url)}</a></p>` : ''}

        <div class="section panel pad">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><b>✨ AI analysis</b>
            <button class="btn sm primary" id="analyze">${a.analysis ? 'Re-analyze' : 'Analyze'}</button></div>
          <div id="ai">${a.analysis ? analysisHtml(a.analysis) : '<span class="small muted">One click classifies the asset, format, angle, hook and offer, then breaks down the creative.</span>'}</div>
        </div>
      </div>
    </div>`;

  m.querySelectorAll('[data-swap]').forEach(img => img.onclick = () => { const big = $('.media-box img', m); if (big) big.src = img.dataset.swap; });
  $('#analyze', m).onclick = async e => {
    e.target.disabled = true; $('#ai', m).innerHTML = '<span class="spin"></span> Analyzing… this takes 20–60 seconds.';
    try { $('#ai', m).innerHTML = analysisHtml(await api(`/ads/${a.id}/analyze`, { method: 'POST' })); }
    catch (err) { $('#ai', m).innerHTML = `<span class="small" style="color:var(--bad)">${h(err.message)}</span>`; }
    e.target.disabled = false;
  };
  const txBtn = $('#tx-btn', m);
  if (txBtn) txBtn.onclick = async () => {
    const box = $('#tx', m);
    if (a.transcript) { box.hidden = !box.hidden; return; }
    txBtn.disabled = true; txBtn.innerHTML = '<span class="spin"></span> Transcribing…';
    try {
      const r = await api(`/ads/${a.id}/transcribe`, { method: 'POST' });
      a.transcript = r.text; $('.transcript', box).textContent = r.text; box.hidden = false; txBtn.textContent = 'Hide transcript';
    } catch (err) { toast(err.message); txBtn.textContent = 'Get transcript'; }
    txBtn.disabled = false;
  };
}

// ---------- settings ----------
$('#open-settings').onclick = async () => {
  const s = await api('/settings');
  const m = openModal(`
    <div class="modal-head"><b>Settings</b><button class="icon-btn" data-close>✕</button></div>
    <form class="form">
      <label>Average frequency (times each person sees an ad)<input name="frequency" type="number" step="0.1" value="${s.frequency}"></label>
      <label>CPM in $ (cost per 1,000 impressions)<input name="cpm" type="number" step="0.5" value="${s.cpm}"></label>
      <label>Max ads tracked per brand<input name="max_ads" type="number" step="50" value="${s.max_ads}"></label>
      <label>Auto-refresh every (hours)<input name="refresh_hours" type="number" value="${s.refresh_hours}"></label>
      <div class="small muted">Spend estimate = EU/UK reach × frequency × CPM ÷ 1000.</div>
      <button class="btn primary">Save</button>
    </form>`, 'narrow');
  $('form', m).onsubmit = async e => {
    e.preventDefault();
    await api('/settings', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
    closeModal(); toast('Saved'); render();
  };
};

// ---------- router ----------
async function render() {
  const { parts, q } = route();
  document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('on', parts.length === 0 || parts[0] === 'brand'));
  try {
    if (parts[0] === 'brand' && parts[1]) await renderBrand(parts[1], parts[2] || 'overview', q);
    else await renderCompetitors();
  } catch (e) {
    app.innerHTML = `<div class="empty"><h2>Something went wrong</h2><p>${h(e.message)}</p><a href="#/">Back to competitors</a></div>`;
  }
}
window.addEventListener('hashchange', () => { closeModal(); render(); });
render();
api('/status').then(s => {
  $('#status-line').innerHTML = `Data: ${s.apify ? '✓ Apify' : '✗ APIFY_TOKEN missing'}<br>AI: ${s.ai === 'claude-cli' ? 'Claude Code CLI' : 'Anthropic API'}`;
});
