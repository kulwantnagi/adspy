// Video download + local speech-to-text with whisper.cpp (whisper-cli) and ffmpeg.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createWriteStream, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { db, MEDIA_DIR, ROOT } from './db.js';

const run = promisify(execFile);
const MODEL = process.env.WHISPER_MODEL || join(ROOT, 'models', 'ggml-base.en.bin');

// Downloads the ad's first video to data/media/<id>.mp4 and returns the path.
export async function ensureVideo(adId) {
  const file = join(MEDIA_DIR, `${adId}.mp4`);
  if (existsSync(file)) return file;
  const ad = db.prepare('SELECT media FROM ads WHERE id = ?').get(adId);
  const url = JSON.parse(ad?.media || '[]').find(m => m.video)?.video;
  if (!url) throw new Error('This ad has no video.');
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error('Video link has expired. Refresh the brand to get a new one.');
  await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
  return file;
}

export async function transcribe(adId) {
  const cached = db.prepare('SELECT text FROM transcripts WHERE ad_id = ?').get(adId);
  if (cached) return cached.text;
  if (!existsSync(MODEL)) throw new Error(`Whisper model not found at ${MODEL}`);
  const video = await ensureVideo(adId);
  const wav = join(MEDIA_DIR, `${adId}.wav`);
  const out = join(MEDIA_DIR, `${adId}.transcript`);
  try {
    await run('ffmpeg', ['-v', 'error', '-y', '-i', video, '-ar', '16000', '-ac', '1', wav]);
    await run('whisper-cli', ['-m', MODEL, '-f', wav, '-otxt', '-of', out, '-np'], { maxBuffer: 1 << 24 });
    const text = readFileSync(`${out}.txt`, 'utf8').replace(/\s+/g, ' ').trim();
    db.prepare('INSERT OR REPLACE INTO transcripts (ad_id, text, created_at) VALUES (?, ?, ?)').run(adId, text, Date.now());
    return text;
  } finally {
    rmSync(wav, { force: true });
    rmSync(`${out}.txt`, { force: true });
  }
}
