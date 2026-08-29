// 清理世界里的垃圾人物：回滚不合格的 char.create + 牵涉的 relation.set
import { execFileSync } from 'node:child_process';
const GH = 'C:\\Users\\cs14ilike\\.zcode\\workspace\\default\\tools\\ghbin\\gh.exe';
// 直接复用引擎的判定逻辑
const { isPlausibleCharName } = await import('../packages/engine/dist/index.js');

const B = 'http://127.0.0.1:18700';
const worldId = process.argv[2];
if (!worldId) { console.log('用法: node scripts/purge-garbage-chars.mjs <worldId>'); process.exit(1); }

const gh = (p) => execFileSync(GH, ['api', p.replace(B, '')], { encoding: 'utf8' }); // 占位未用

const events = (await (await fetch(`${B}/api/worlds/${worldId}/events`)).json());
const garbage = new Set();
const charEvents = [];
for (const e of events) {
  if (e.kind !== 'char.create' || e.supersededBy) continue;
  const name = e.payload?.name ?? e.payload?.id;
  if (!name) continue;
  if (!isPlausibleCharName(String(name))) { garbage.add(String(name)); charEvents.push(e); }
}
console.log('垃圾人物:', [...garbage].join('、') || '(无)');

// 牵涉垃圾人物的关系事件
const relEvents = events.filter(e => e.kind === 'relation.set' && !e.supersededBy &&
  garbage.has(String(e.payload?.from)) || garbage.has(String(e.payload?.to)));
let rolled = 0;
for (const e of [...charEvents, ...relEvents]) {
  const r = await fetch(`${B}/api/events/${e.id}/rollback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'garbage-name' }) });
  if (r.ok) rolled++;
}
console.log(`回滚 ${rolled}/${charEvents.length + relEvents.length} 条事件`);
const st = (await (await fetch(`${B}/api/worlds/${worldId}/state`)).json());
console.log('剩余人物:', Object.values(st.characters).map(c => c.name).join('、'));
console.log('剩余关系:', st.relations.map(r2 => `${r2.from}—${r2.type}→${r2.to}`).join('；'));
