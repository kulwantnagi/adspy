# AdSpy

Spy on your competitors' Facebook and Instagram ads. See which ads Meta is pushing hardest, where they send traffic, how often they launch new ads, and which hooks they reuse.

It's built to work like the competitor tracker in Mike Futia's video ("Cancel your $300/mo Atria & Foreplay"), but it runs on your own computer.

## Start it

```bash
cd /Volumes/Data/Claude/AdSpy
npm start
```

Then open **http://localhost:4321**.

You need:
- **Node 24 or newer** (you have Node 26)
- **APIFY_TOKEN** in your shell or in a `.env` file in this folder. This is where the ad data comes from.
- **Claude Code** installed, for the AI analysis. It runs on your Claude plan. Or set `ANTHROPIC_API_KEY` in `.env` to use the API instead.
- **ffmpeg** and **whisper-cli** for video transcripts (both already installed). The speech model is in `models/`.

No `npm install` is needed. There are zero packages.

## How to use it

1. Click **+ Track a brand**.
2. Paste the brand's Facebook page URL (like `https://www.facebook.com/ZapierApp`) or its Ad Library link.
3. Wait 2–6 minutes. The app pulls the brand's top active ads, ordered by how many impressions Meta gives them.
4. Click the brand to open it.

## What each tab shows

| Tab | What it tells you |
|-----|-------------------|
| **Overview** | Top ads, launches per week, video vs image mix, top landing pages, top buttons, and which pages run the ads |
| **Ads** | Every ad, with filters (date, days running, page type, platform, format, landing page, button, copy length, AI tags, text search) |
| **Ranking** | Ads climbing fastest in the brand's list. A big climb means Meta is putting more money behind that ad. |
| **Landing pages** | Where the ads send people, most-used first. Click **Show its ads** to see every ad pointing to that page. |
| **Launches** | A calendar of how many ads went live each day. Big spikes mean a creative test batch. |
| **Hooks and copy** | The opening lines, headlines and ad text the brand reuses most |

Click any ad to see:
- EU/UK reach, plus age and gender
- Estimated spend
- The full ad copy
- A video transcript
- A video download
- **✨ AI analysis**: format, angle, hook, offer, why it works, and ideas for your own version

## Good to know

- **Reach and spend only cover the EU and UK.** Meta only publishes reach numbers for ads shown in Europe. Spend is a guess: reach × 2.5 × $15 per 1,000 views. You can change both numbers in **Settings**.
- **Ranking needs time.** The first scrape only gives you a starting rank for each ad. Climbs show up after the next daily refresh.
- **Auto-refresh** runs once a day, but only while `npm start` is running.
- **Cost:** about $0.75 per 1,000 ads in Apify credits. Each scrape is capped at $3.
- Images are saved in `data/media/` because Facebook image links expire after a few weeks.
- Everything is stored in `data/adspy.db` (SQLite).

## Import a saved scrape (no Apify cost)

```bash
npm run import-sample -- data/sample-zapier.json https://www.facebook.com/ZapierApp
```

## Files

| File | What it does |
|------|--------------|
| `server.js` | Web server and all `/api` routes, plus the daily refresh |
| `lib/apify.js` | Runs the Ad Library scraper on Apify |
| `lib/ingest.js` | Cleans up ads, ranks them, saves them, and caches images |
| `lib/queries.js` | Filters, rankings, landing pages, launches and hooks |
| `lib/ai.js` | AI breakdown of an ad (Claude CLI or Anthropic API) |
| `lib/transcribe.js` | Video download and speech-to-text |
| `public/` | The web app (HTML, CSS, JS) |
