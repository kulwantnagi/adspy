// AI breakdown of one ad. Uses the Anthropic API when ANTHROPIC_API_KEY is set,
// otherwise the local Claude Code CLI (`claude -p`), which runs on your Claude plan.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { db, MEDIA_DIR } from './db.js';

const MODEL = process.env.ADSPY_MODEL || 'claude-sonnet-5-5';

const SCHEMA = `{
  "asset_type": "Static image | Video | Carousel | UGC video | Talking head | Animation | Meme | Screenshot",
  "visual_format": "short label, e.g. Product hero, Before/after, Founder story, Fake apology, Listicle, Advertorial, Testimonial",
  "messaging_angle": "short label, e.g. Fear of missing out, Social proof, Problem/solution, Curiosity, Authority",
  "hook_tactic": "short label, e.g. Bold claim, Question, Confession, Shock statement, Callout",
  "offer_type": "short label, e.g. Percentage off, Free gift, Bundle, None",
  "hook": "the exact opening hook in a few words",
  "target_audience": "one sentence",
  "summary": "two sentences: what the ad is and why it likely works",
  "creative_breakdown": ["4-6 short bullet points describing the creative, scene by scene or element by element"],
  "why_it_works": ["3 short bullet points"],
  "remix_ideas": ["3 short ideas to make your own version for a different brand, without copying"]
}`;

function buildPrompt(ad, transcript, imagePaths) {
  return `You are a direct-response ad strategist. Break down this Facebook/Instagram ad.

Brand page: ${ad.page_name}
Format: ${ad.display_format}
Headline: ${ad.title || '-'}
CTA: ${ad.cta_text || '-'}
Landing page: ${ad.link_url || '-'}
Running since: ${ad.start_date ? new Date(ad.start_date * 1000).toDateString() : '-'}
Ad copy:
"""${ad.body || '-'}"""
${transcript ? `Video transcript:\n"""${transcript}"""` : ''}
${imagePaths.length ? `Creative image file(s) to look at: ${imagePaths.join(', ')}` : 'No image available.'}

Reply with ONLY a JSON object, no prose, in this shape:
${SCHEMA}`;
}

function extractJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('AI did not return JSON');
  return JSON.parse(m[0]);
}

function runClaudeCli(prompt) {
  return new Promise((resolve, reject) => {
    const p = spawn('claude', ['-p', prompt, '--output-format', 'json', '--model', 'sonnet', '--allowedTools', 'Read'], {
      cwd: MEDIA_DIR, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    p.stdout.on('data', d => (out += d));
    p.stderr.on('data', d => (err += d));
    p.on('error', reject);
    p.on('close', code => {
      if (code !== 0) return reject(new Error(`claude CLI failed: ${err.slice(0, 300) || out.slice(0, 300)}`));
      try { resolve(JSON.parse(out).result); } catch { resolve(out); }
    });
  });
}

async function runApi(prompt, imagePaths) {
  const content = imagePaths.slice(0, 4).map(p => ({
    type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: readFileSync(join(MEDIA_DIR, p)).toString('base64') },
  }));
  content.push({ type: 'text', text: prompt.replace(/Creative image file\(s\).*\n/, 'The creative images are attached above.\n') });
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 2000, messages: [{ role: 'user', content }] }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data.content.map(c => c.text || '').join('');
}

export async function analyzeAd(adId) {
  const ad = db.prepare('SELECT * FROM ads WHERE id = ?').get(adId);
  if (!ad) throw new Error('Ad not found');
  const transcript = db.prepare('SELECT text FROM transcripts WHERE ad_id = ?').get(adId)?.text;
  const media = JSON.parse(ad.media || '[]');
  const imagePaths = media.map((_, i) => `${adId}_${i}.jpg`).filter(f => existsSync(join(MEDIA_DIR, f))).slice(0, 4);
  const prompt = buildPrompt(ad, transcript, imagePaths);
  const text = process.env.ANTHROPIC_API_KEY ? await runApi(prompt, imagePaths) : await runClaudeCli(prompt);
  const json = extractJson(text);
  db.prepare('INSERT INTO analyses (ad_id, json, created_at) VALUES (?, ?, ?) ON CONFLICT(ad_id) DO UPDATE SET json = excluded.json, created_at = excluded.created_at')
    .run(adId, JSON.stringify(json), Date.now());
  return json;
}

// Background queue for "Auto-tag": analyzes many ads, two at a time.
const queue = [];
let active = 0;
export const queueSize = () => queue.length + active;

export function enqueueAnalyses(ids) {
  const done = new Set(db.prepare('SELECT ad_id FROM analyses').all().map(r => r.ad_id));
  for (const id of ids) if (!done.has(id) && !queue.includes(id)) queue.push(id);
  pump();
}

function pump() {
  while (active < 2 && queue.length) {
    const id = queue.shift();
    active++;
    analyzeAd(id).catch(e => console.error(`[analyze ${id}]`, e.message)).finally(() => { active--; pump(); });
  }
}
