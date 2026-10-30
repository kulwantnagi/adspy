// Import an Apify dataset JSON file as a brand, without running a new scrape.
// Usage: npm run import-sample -- data/sample-zapier.json https://www.facebook.com/ZapierApp
import { readFileSync } from 'node:fs';
import { db } from '../lib/db.js';
import { deriveBrandInfo, ingestItems, cacheImages } from '../lib/ingest.js';

const [file, url] = process.argv.slice(2);
if (!file || !url) {
  console.error('Usage: npm run import-sample -- <dataset.json> <facebook page url>');
  process.exit(1);
}
const items = JSON.parse(readFileSync(file, 'utf8'));
let brand = db.prepare('SELECT * FROM brands WHERE source_url = ?').get(url);
if (!brand) {
  const { lastInsertRowid } = db.prepare('INSERT INTO brands (source_url, created_at, status) VALUES (?, ?, ?)').run(url, Date.now(), 'ready');
  brand = db.prepare('SELECT * FROM brands WHERE id = ?').get(lastInsertRowid);
}
deriveBrandInfo(brand, items);
ingestItems(brand, items, []);
await cacheImages(db.prepare('SELECT id, media, page_logo, page_id FROM ads WHERE brand_id = ?').all(brand.id));
db.prepare('UPDATE brands SET status = ?, last_refreshed_at = ? WHERE id = ?').run('ready', Date.now(), brand.id);
console.log(`Imported ${items.length} ads into "${brand.name}" (brand #${brand.id}).`);
