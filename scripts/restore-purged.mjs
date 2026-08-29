// 恢复被误回滚的真人物（含全文高频豁免；需先停 server）
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { isPlausibleCharName } from '../packages/engine/dist/index.js';

const fullText = new TextDecoder('gbk').decode(fs.readFileSync('C:/Users/cs14ilike/Documents/此间的少年.txt'));
const db = new DatabaseSync(new URL('../data/eventverse.db', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
const audits = db.prepare("SELECT id, payload FROM events WHERE kind='meta.rollback' AND payload LIKE '%garbage-name%'").all();
let restored = 0, kept = 0;
for (const a of audits) {
  const target = db.prepare('SELECT id, kind, payload FROM events WHERE superseded_by=?').get(a.id);
  if (!target) continue;
  const p = JSON.parse(target.payload);
  const name = String(p.name || p.id || p.from || '');
  const good = target.kind === 'relation.set'
    ? isPlausibleCharName(String(p.from || ''), fullText) && isPlausibleCharName(String(p.to || ''), fullText)
    : isPlausibleCharName(name, fullText);
  if (good) {
    db.prepare('UPDATE events SET superseded_by=NULL WHERE id=?').run(target.id);
    restored++;
    console.log('恢复:', target.kind, name);
  } else kept++;
}
console.log(`恢复 ${restored} 条 | 保留回滚 ${kept} 条`);
db.close();
