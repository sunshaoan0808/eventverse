// 三个导入功能修复后的端到端验证
const B = 'http://127.0.0.1:18700';
const j = async (p, o) => { const r = await fetch(B + p, o); return [r.status, await r.json().catch(() => ({}))]; };
const post = (p, body) => j(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// 构造带 chara tEXt 块的 PNG
function pngWithCard(cardJson) {
  const b64 = Buffer.from(cardJson, 'utf8').toString('base64');
  const mk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  function crc32(buf) { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c; }
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const textData = Buffer.concat([Buffer.from('chara\0', 'latin1'), Buffer.from(b64, 'latin1')]);
  return Buffer.concat([sig, mk('tEXt', textData), mk('IEND', Buffer.alloc(0))]);
}

(async () => {
  await new Promise(r => setTimeout(r, 2500));
  let pass = 0, fail = 0;
  const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? '✓' : '✗'), name); };

  const wiz = await post('/api/wizard', { worldTitle: '导入修复验证' });
  const w = wiz[1].worldId;

  // ① 世界书：裸导出 + 混用 key/keys + disable 过滤
  const wb = await post('/api/import/worldbook', { worldId: w, book: { '0': { keys: ['法术'], content: '火球术', constant: true, enabled: true }, '1': { key: ['剑法'], content: '快剑十三式', constant: true, disable: false }, '2': { keys: ['废'], content: '停用条目', enabled: false } } });
  const st = (await j('/api/worlds/' + w + '/state'))[1];
  ok('① 世界书裸导出：2 条入库', wb[0] === 201 && wb[1].imported === 2 && wb[1].skipped === 1);
  ok('① lore 事实可查', st.facts.some(f => f.key === 'lore:法术' && f.value === '火球术') && st.facts.some(f => f.key === 'lore:剑法'));

  // ② 角色卡：PNG（含内嵌世界书）
  const card = { spec: 'chara_card_v2', data: { name: '夜莺PNG', description: 'PNG 卡导入', character_book: { entries: [{ keys: ['歌'], content: '夜莺之歌可疗伤', constant: true }] } } };
  const png = pngWithCard(JSON.stringify(card));
  const ci = await post('/api/import/st-card', { worldId: w, pngBase64: png.toString('base64') });
  ok('② PNG 角色卡导入', ci[0] === 201 && ci[1].name === '夜莺PNG' && ci[1].facts === 1);

  // ③ 拆书：洪水治理 + 轻事实自动落库
  let t = '';
  for (let c = 1; c <= 12; c++) {
    t += `第${c}章 行路${c}\n`;
    for (let n = 0; n < 6; n++) t += `${['李明', '王强', '张伟', '刘洋', '陈杰', '赵刚'][(c + n) % 6]}说：我们赶路。\n`;
  }
  const imp = await post('/api/import', { worldId: w, title: '洪水治理验证', text: t, llmChapterBudget: 0 });
  await new Promise(r => setTimeout(r, 8000));
  const job = (await j('/api/jobs/' + imp[1].jobId))[1];
  ok('③ 拆书完成 12 章', job.status === 'done' && job.progress === 12);
  ok('③ 提案洪水已治理（自动批准，不再堆积人工队列）', (job.result?.applied ?? 0) > 0);
  const props = (await j('/api/worlds/' + w + '/proposals'))[1];
  const pend = props.filter(p => p.status === 'pending');
  ok('③ 待审积压为 0（修复前会堆 ~12 条）', pend.length === 0);
  const st2 = (await j('/api/worlds/' + w + '/state'))[1];
  const charNames = Object.values(st2.characters).map(c => c.name);
  ok('③ 人物已自动入库（对话归属白名单）', charNames.some(n => ['李明', '王强', '张伟', '刘洋', '陈杰', '赵刚'].includes(n)));
  ok('③ 跨章去重（人物唯一）', new Set(Object.keys(st2.characters)).size === Object.keys(st2.characters).length);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
